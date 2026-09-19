import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import {
  HttpToolExecutor,
  normalizeSnapshotTool,
  ToolBusError,
  type ToolExecutorContext,
} from "../src/toolbus/index.ts";

let server: http.Server;
let baseUrl = "";
let lastRequest: {
  body: unknown;
  idempotencyKey?: string;
  traceId?: string;
};

before(async () => {
  server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const bodyText = Buffer.concat(chunks).toString("utf8");
    lastRequest = {
      body: bodyText ? JSON.parse(bodyText) : undefined,
      idempotencyKey: request.headers["x-idempotency-key"] as string,
      traceId: request.headers["x-trace-id"] as string,
    };
    const path = request.url ?? "/";
    response.setHeader("Content-Type", "application/json");
    if (path === "/success") {
      response.end(JSON.stringify({ ok: true, result: { value: 1 } }));
    } else if (path === "/business-error") {
      response.end(
        JSON.stringify({
          ok: false,
          error: {
            code: "readonly_only",
            message: "只允许 SELECT",
            retryable: false,
            details: { rule: "select-only" },
          },
        }),
      );
    } else if (path === "/internal") {
      response.statusCode = 500;
      response.end(
        JSON.stringify({
          ok: false,
          error: { code: "internal", message: "extra failed", retryable: true },
        }),
      );
    } else if (path === "/invalid-envelope") {
      response.end(JSON.stringify({ result: 1 }));
    } else if (path === "/bad-status") {
      response.statusCode = 503;
      response.end(JSON.stringify({ message: "unavailable" }));
    } else {
      response.statusCode = 404;
      response.end(JSON.stringify({ message: "not found" }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", onError);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

function definition(path: string, sideEffect = false) {
  return normalizeSnapshotTool(
    {
      name: "remote_tool",
      description: "remote",
      type: "http",
      endpoint: `${baseUrl}${path}`,
      inputSchema: { type: "object" },
      sideEffect,
    },
    1_000,
  );
}

function context(): ToolExecutorContext {
  return {
    runId: "run-http",
    toolCallId: "call-http",
    traceId: "trace-http",
    attempt: 1,
    idempotencyKey: "idem_fixed",
    deadlineAt: Date.now() + 1_000,
    signal: AbortSignal.timeout(1_000),
  };
}

test("HTTP executor sends Extra request shape and decodes success", async () => {
  const result = await new HttpToolExecutor().execute(
    definition("/success", true),
    { value: "x" },
    context(),
  );
  assert.equal(result.content[0].text, '{"value":1}');
  assert.deepEqual(lastRequest.body, { arguments: { value: "x" } });
  assert.equal(lastRequest.idempotencyKey, "idem_fixed");
  assert.equal(lastRequest.traceId, "trace-http");
});

test("HTTP executor preserves the complete Extra error for the model", async () => {
  await assert.rejects(
    new HttpToolExecutor().execute(
      definition("/business-error"),
      {},
      context(),
    ),
    (error) => {
      assert.ok(error instanceof ToolBusError);
      assert.equal(error.toolError.code, "readonly_only");
      assert.equal(error.toolError.source, "extra");
      assert.deepEqual(JSON.parse(error.message), {
        code: "readonly_only",
        message: "只允许 SELECT",
        retryable: false,
        details: { rule: "select-only" },
      });
      return true;
    },
  );
});

test("HTTP 500 with Extra error envelope remains a retryable Extra error", async () => {
  await assert.rejects(
    new HttpToolExecutor().execute(definition("/internal"), {}, context()),
    (error) =>
      error instanceof ToolBusError &&
      error.toolError.code === "internal" &&
      error.toolError.retryable,
  );
});

test("HTTP executor rejects malformed envelopes and unexpected status", async () => {
  await assert.rejects(
    new HttpToolExecutor().execute(
      definition("/invalid-envelope"),
      {},
      context(),
    ),
    (error) =>
      error instanceof ToolBusError &&
      error.toolError.code === "invalid_response",
  );
  await assert.rejects(
    new HttpToolExecutor().execute(definition("/bad-status"), {}, context()),
    (error) =>
      error instanceof ToolBusError &&
      error.toolError.code === "unexpected_http_status" &&
      error.toolError.retryable,
  );
});
