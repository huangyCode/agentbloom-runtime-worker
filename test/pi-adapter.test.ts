import assert from "node:assert/strict";
import { test } from "node:test";
import { agentLoop } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import { mapEvent } from "../src/protocol/openai.ts";
import {
  createToolBusError,
  DefaultToolBus,
  normalizeSnapshotTool,
  toPiTool,
  ToolExecutorRegistry,
  type HttpToolDefinition,
  type ToolExecutor,
} from "../src/toolbus/index.ts";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "test-provider",
    model: "test-model",
    usage,
    stopReason,
    timestamp: Date.now(),
  };
}

test("PiToolAdapter forwards call id and AbortSignal", async () => {
  const def = normalizeSnapshotTool(
    {
      name: "probe",
      description: "probe",
      type: "http",
      endpoint: "http://127.0.0.1:8200/invoke/probe",
      inputSchema: { type: "object" },
      sideEffect: false,
    },
    1_000,
  );
  let seenCallId = "";
  let seenSignal: AbortSignal | undefined;
  const bus = {
    execute: async (request: any) => {
      seenCallId = request.context.toolCallId;
      seenSignal = request.context.signal;
      return {
        content: [{ type: "text" as const, text: "ok" }],
        details: {},
      };
    },
  };
  const tool = toPiTool(def, bus as any, {
    runId: "run-pi",
    permissionMode: "auto",
  });
  const controller = new AbortController();
  await tool.execute("call-pi", {}, controller.signal, undefined);
  assert.equal(seenCallId, "call-pi");
  assert.equal(seenSignal, controller.signal);
});

test("Pi marks ToolBus failures as isError and OpenAI mapping emits fail", async () => {
  const def = normalizeSnapshotTool(
    {
      name: "sql_query",
      description: "query",
      type: "http",
      endpoint: "http://127.0.0.1:8200/invoke/sql_query",
      inputSchema: {
        type: "object",
        properties: { sql: { type: "string" } },
        required: ["sql"],
      },
      sideEffect: false,
    },
    1_000,
  );
  const executor: ToolExecutor<HttpToolDefinition> = {
    kind: "http",
    execute: async () => {
      const payload = {
        code: "readonly_only",
        message: "只允许 SELECT",
        retryable: false,
      };
      throw createToolBusError(payload.code, payload.message, {
        source: "extra",
        modelPayload: payload,
      });
    },
  };
  const registry = new ToolExecutorRegistry();
  registry.register(executor);
  const bus = new DefaultToolBus({
    registry,
    config: {
      defaultTimeoutMs: 1_000,
      maxAttempts: 2,
      retryBaseDelayMs: 1,
      maxResultBytes: 32 * 1024,
    },
  });
  const tool = toPiTool(def, bus, {
    runId: "run-agent-loop",
    permissionMode: "auto",
  });

  let streamCall = 0;
  const streamFn = () => {
    const stream = createAssistantMessageEventStream();
    streamCall += 1;
    const message =
      streamCall === 1
        ? assistant(
            [
              {
                type: "toolCall",
                id: "call-readonly",
                name: "sql_query",
                arguments: { sql: "ALTER TABLE t DROP COLUMN c" },
              },
            ],
            "toolUse",
          )
        : assistant([{ type: "text", text: "已改用只读方案" }], "stop");
    stream.push({ type: "start", partial: message });
    stream.push({
      type: "done",
      reason: streamCall === 1 ? "toolUse" : "stop",
      message,
    });
    return stream;
  };

  const events: any[] = [];
  const model = {
    id: "test-model",
    name: "test-model",
    api: "openai-completions",
    provider: "test-provider",
    baseUrl: "http://127.0.0.1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_000,
    maxTokens: 1_000,
  };
  const run = agentLoop(
    [{ role: "user", content: "review", timestamp: Date.now() }],
    { systemPrompt: "test", messages: [], tools: [tool] },
    { model: model as any, convertToLlm: (messages) => messages as any },
    undefined,
    streamFn as any,
  );
  for await (const event of run) events.push(event);

  const end = events.find((event) => event.type === "tool_execution_end");
  assert.ok(end);
  assert.equal(end.isError, true);
  assert.deepEqual(JSON.parse(end.result.content[0].text), {
    code: "readonly_only",
    message: "只允许 SELECT",
    retryable: false,
  });
  const sse = mapEvent(end, "chatcmpl-test", "test-model");
  assert.match(sse ?? "", /"status":"fail"/);
});
