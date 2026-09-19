import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  BuiltinToolExecutor,
  createReadSkillDefinition,
  createToolBusError,
  DefaultToolBus,
  isToolBusError,
  normalizeSnapshotTool,
  ToolBusError,
  ToolExecutorRegistry,
  type HttpToolDefinition,
  type ToolBusConfig,
  type ToolBusEvent,
  type ToolBusRequest,
  type ToolExecutor,
  type ToolExecutorContext,
  type ToolExecutorResult,
} from "../src/toolbus/index.ts";

const baseConfig: ToolBusConfig = {
  defaultTimeoutMs: 1_000,
  maxAttempts: 2,
  retryBaseDelayMs: 1,
  maxResultBytes: 32 * 1024,
};

function definition(sideEffect = false, timeoutMs = 1_000) {
  const normalized = normalizeSnapshotTool(
    {
      name: "demo_tool",
      description: "demo",
      type: "http",
      endpoint: "http://127.0.0.1:8200/invoke/demo_tool",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      sideEffect,
    },
    timeoutMs,
  );
  return normalized;
}

function request(
  def: HttpToolDefinition,
  overrides: Partial<ToolBusRequest["context"]> = {},
): ToolBusRequest {
  return {
    definition: def,
    arguments: { value: "ok" },
    context: {
      runId: "run-1",
      toolCallId: "call-1",
      permissionMode: "auto",
      ...overrides,
    },
  };
}

class FakeExecutor implements ToolExecutor<HttpToolDefinition> {
  readonly kind = "http" as const;
  calls: ToolExecutorContext[] = [];
  executeImpl: (
    definition: HttpToolDefinition,
    args: Record<string, unknown>,
    context: ToolExecutorContext,
  ) => Promise<ToolExecutorResult> = async () => ({
    content: [{ type: "text", text: "ok" }],
  });

  async execute(
    def: HttpToolDefinition,
    args: Record<string, unknown>,
    context: ToolExecutorContext,
  ): Promise<ToolExecutorResult> {
    this.calls.push(context);
    return this.executeImpl(def, args, context);
  }
}

function busWith(
  executor: ToolExecutor<any>,
  options: Partial<ToolBusConfig> = {},
  events: ToolBusEvent[] = [],
) {
  const registry = new ToolExecutorRegistry();
  registry.register(executor);
  return new DefaultToolBus({
    registry,
    config: { ...baseConfig, ...options },
    random: () => 0,
    eventSink: {
      emit: (event) => {
        events.push(event);
      },
    },
  });
}

test("normalizeSnapshotTool validates config and reserves MCP", () => {
  assert.equal(definition().kind, "http");
  assert.throws(
    () =>
      normalizeSnapshotTool(
        {
          name: "mcp_demo",
          description: "mcp",
          type: "mcp",
          inputSchema: { type: "object" },
          sideEffect: false,
        },
        1_000,
      ),
    (error) =>
      error instanceof ToolBusError &&
      error.toolError.code === "tool_kind_not_enabled",
  );
  assert.throws(
    () =>
      normalizeSnapshotTool(
        {
          name: "bad",
          description: "bad",
          type: "http",
          endpoint: "file:///tmp/tool",
          inputSchema: { type: "object" },
          sideEffect: false,
        },
        1_000,
      ),
    (error) =>
      error instanceof ToolBusError &&
      error.toolError.code === "tool_config_invalid",
  );
});

test("ToolBus validates arguments before invoking executor", async () => {
  const executor = new FakeExecutor();
  const bus = busWith(executor);
  const invalid = request(definition());
  invalid.arguments = { value: 1 };
  await assert.rejects(
    bus.execute(invalid),
    (error) =>
      error instanceof ToolBusError &&
      error.toolError.code === "arguments_schema_invalid" &&
      Array.isArray(error.toolError.details),
  );
  assert.equal(executor.calls.length, 0);
});

test("ToolBus retries only retryable side-effect-free calls", async () => {
  const executor = new FakeExecutor();
  let attempts = 0;
  executor.executeImpl = async (def, _args, context) => {
    attempts += 1;
    if (attempts === 1) {
      throw createToolBusError("tidb_unavailable", "temporary", {
        retryable: true,
        source: "extra",
        toolName: def.name,
        kind: def.kind,
        attempt: context.attempt,
      });
    }
    return { content: [{ type: "text", text: "recovered" }] };
  };
  const events: ToolBusEvent[] = [];
  const bus = busWith(executor, {}, events);
  const result = await bus.execute(request(definition()));
  assert.equal(result.content[0].text, "recovered");
  assert.equal(executor.calls.length, 2);
  assert.equal(result.details.attempt, 2);
  assert.ok(events.some((event) => event.type === "retry"));
});

test("side-effect calls are sequential, not retried, and use stable keys", async () => {
  const def = definition(true);
  assert.equal(def.executionMode, "sequential");
  const executor = new FakeExecutor();
  const bus = busWith(executor);
  await bus.execute(request(def));
  await bus.execute(request(def));
  assert.equal(executor.calls.length, 2);
  assert.match(executor.calls[0].idempotencyKey ?? "", /^idem_[a-f0-9]{32}$/);
  assert.equal(
    executor.calls[0].idempotencyKey,
    executor.calls[1].idempotencyKey,
  );

  const failing = new FakeExecutor();
  failing.executeImpl = async () => {
    throw createToolBusError("temporary", "temporary", { retryable: true });
  };
  await assert.rejects(busWith(failing).execute(request(def)));
  assert.equal(failing.calls.length, 1);
});

test("ToolBus distinguishes cancellation from deadline", async () => {
  const waiting = new FakeExecutor();
  waiting.executeImpl = async (_def, _args, context) =>
    new Promise((_resolve, reject) => {
      context.signal.addEventListener(
        "abort",
        () => reject(context.signal.reason),
        { once: true },
      );
    });

  const controller = new AbortController();
  const canceled = busWith(waiting, { maxAttempts: 1 }).execute(
    request(definition(false, 500), { signal: controller.signal }),
  );
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(
    canceled,
    (error) =>
      error instanceof ToolBusError && error.toolError.code === "canceled",
  );

  const timedOut = busWith(waiting, { maxAttempts: 1 }).execute(
    request(definition(false, 15)),
  );
  await assert.rejects(
    timedOut,
    (error) =>
      error instanceof ToolBusError &&
      error.toolError.code === "upstream_timeout",
  );
});

test("ToolBus truncates UTF-8 results within the byte limit", async () => {
  const executor = new FakeExecutor();
  executor.executeImpl = async () => ({
    content: [{ type: "text", text: "观山🙂".repeat(100) }],
  });
  const result = await busWith(executor, { maxResultBytes: 128 }).execute(
    request(definition()),
  );
  assert.equal(result.details.truncated, true);
  assert.ok(Buffer.byteLength(result.content[0].text, "utf8") <= 128);
  assert.doesNotMatch(result.content[0].text, /�/);
});

test("ToolBus enforces readonly policy for side-effect tools", async () => {
  const executor = new FakeExecutor();
  await assert.rejects(
    busWith(executor).execute(
      request(definition(true), { permissionMode: "readonly" }),
    ),
    (error) =>
      error instanceof ToolBusError &&
      error.toolError.code === "permission_denied",
  );
  assert.equal(executor.calls.length, 0);
});

test("read_skill uses snapshot whitelist and shares result governance", async () => {
  const registry = new ToolExecutorRegistry();
  registry.register(
    new BuiltinToolExecutor([
      {
        name: "sql_review",
        description: "SQL review",
        version: "v1",
        content: "review rules",
      },
    ]),
  );
  const bus = new DefaultToolBus({ registry, config: baseConfig });
  const def = createReadSkillDefinition();
  const context = {
    runId: "run-skill",
    toolCallId: "call-skill",
    permissionMode: "auto" as const,
  };
  const result = await bus.execute({
    definition: def,
    arguments: { name: "sql_review" },
    context,
  });
  assert.equal(result.content[0].text, "review rules");
  await assert.rejects(
    bus.execute({
      definition: def,
      arguments: { name: "not_bound" },
      context,
    }),
    (error) =>
      error instanceof ToolBusError &&
      error.toolError.code === "skill_not_found",
  );
});

function skillBus(executor: BuiltinToolExecutor) {
  const registry = new ToolExecutorRegistry();
  registry.register(executor);
  return new DefaultToolBus({
    registry,
    config: { ...baseConfig, maxAttempts: 1 },
  });
}

function skillRequest(name: string): ToolBusRequest {
  return {
    definition: createReadSkillDefinition(),
    arguments: { name },
    context: {
      runId: "run-skill",
      toolCallId: "call-skill",
      permissionMode: "auto" as const,
    },
  };
}

test("read_skill prefers inline content and never touches the object store", async () => {
  const store = {
    getSkillObject: async (): Promise<Buffer> => {
      throw new Error("不该发生对象存储访问");
    },
  };
  const bus = skillBus(
    new BuiltinToolExecutor(
      [
        {
          name: "sql_review",
          description: "SQL review",
          version: "v1",
          content: "inline rules",
          objectKey: "SK001/v1.md",
          sha256: "deadbeef",
        },
      ],
      store,
    ),
  );
  const result = await bus.execute(skillRequest("sql_review"));
  assert.equal(result.content[0].text, "inline rules");
});

test("read_skill lazily fetches by objectKey, verifies sha256, and caches", async () => {
  const body = Buffer.from("# 远端技能正文\n观山", "utf8");
  const sha256 = createHash("sha256").update(body).digest("hex");
  let fetches = 0;
  const store = {
    getSkillObject: async (objectKey: string): Promise<Buffer> => {
      fetches += 1;
      assert.equal(objectKey, "SK001/v2.md");
      return body;
    },
  };
  const bus = skillBus(
    new BuiltinToolExecutor(
      [
        {
          name: "sql_review",
          description: "SQL review",
          version: "v2",
          objectKey: "SK001/v2.md",
          sha256,
          sizeBytes: body.byteLength,
        },
      ],
      store,
    ),
  );
  const first = await bus.execute(skillRequest("sql_review"));
  assert.equal(first.content[0].text, body.toString("utf8"));
  const second = await bus.execute(skillRequest("sql_review"));
  assert.equal(second.content[0].text, body.toString("utf8"));
  assert.equal(fetches, 1);
});

test("read_skill rejects sha256 mismatch as non-retryable skill_corrupted", async () => {
  const store = {
    getSkillObject: async (): Promise<Buffer> =>
      Buffer.from("被篡改的正文", "utf8"),
  };
  const bus = skillBus(
    new BuiltinToolExecutor(
      [
        {
          name: "sql_review",
          description: "SQL review",
          version: "v3",
          objectKey: "SK001/v3.md",
          sha256: "0".repeat(64),
        },
      ],
      store,
    ),
  );
  await bus.execute(skillRequest("sql_review")).then(
    () => assert.fail("sha 不一致必须抛错"),
    (error) => {
      assert.ok(isToolBusError(error));
      assert.equal(error.toolError.code, "skill_corrupted");
      assert.equal(error.toolError.retryable, false);
      assert.match(error.toolError.message, /期望 sha256 000000000000/);
    },
  );
});
