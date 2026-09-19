import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DefaultToolBus,
  HttpToolExecutor,
  normalizeSnapshotTool,
  ToolBusError,
  ToolExecutorRegistry,
} from "../../src/toolbus/index.ts";

const extraUrl = process.env.EXTRA_URL;

function createBus() {
  const registry = new ToolExecutorRegistry();
  registry.register(new HttpToolExecutor());
  return new DefaultToolBus({
    registry,
    config: {
      defaultTimeoutMs: 30_000,
      maxAttempts: 2,
      retryBaseDelayMs: 200,
      maxResultBytes: 32 * 1024,
    },
  });
}

test(
  "real Extra conforms to health, sql_query and web_search contracts",
  { skip: !extraUrl },
  async () => {
    assert.ok(extraUrl);
    const health = await fetch(`${extraUrl}/healthz`);
    assert.equal(health.status, 200);
    const healthBody = await health.json();
    assert.equal((healthBody as any).status, "ok");

    const bus = createBus();
    const sql = normalizeSnapshotTool(
      {
        name: "sql_query",
        description: "query",
        type: "http",
        endpoint: `${extraUrl}/invoke/sql_query`,
        inputSchema: {
          type: "object",
          properties: { sql: { type: "string" } },
          required: ["sql"],
        },
        sideEffect: false,
      },
      30_000,
    );
    const web = normalizeSnapshotTool(
      {
        name: "web_search",
        description: "search",
        type: "http",
        endpoint: `${extraUrl}/invoke/web_search`,
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            top_n: { type: "integer" },
          },
          required: ["query"],
        },
        sideEffect: false,
      },
      30_000,
    );
    const baseContext = {
      runId: "contract-run",
      permissionMode: "auto" as const,
    };
    const sqlResult = await bus.execute({
      definition: sql,
      arguments: {
        sql: "SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_name",
      },
      context: { ...baseContext, toolCallId: "sql-success" },
    });
    assert.ok(sqlResult.content[0].text.length > 0);

    await assert.rejects(
      bus.execute({
        definition: sql,
        arguments: { sql: "SHOW TABLES" },
        context: { ...baseContext, toolCallId: "sql-show-readonly" },
      }),
      (error) =>
        error instanceof ToolBusError &&
        error.toolError.code === "readonly_only",
    );

    await assert.rejects(
      bus.execute({
        definition: sql,
        arguments: { sql: "ALTER TABLE ads_daily DROP COLUMN conversions" },
        context: { ...baseContext, toolCallId: "sql-readonly" },
      }),
      (error) =>
        error instanceof ToolBusError &&
        error.toolError.code === "readonly_only",
    );

    await assert.rejects(
      bus.execute({
        definition: sql,
        arguments: { sql: "SELECT 1; SELECT 2" },
        context: { ...baseContext, toolCallId: "sql-multi-statement" },
      }),
      (error) =>
        error instanceof ToolBusError &&
        error.toolError.code === "sql_error" &&
        error.toolError.retryable === false,
    );

    const webResult = await bus.execute({
      definition: web,
      arguments: { query: "DROP COLUMN risk", top_n: 1 },
      context: { ...baseContext, toolCallId: "web-success" },
    });
    assert.ok(webResult.content[0].text.length > 0);

    await assert.rejects(
      bus.execute({
        definition: web,
        arguments: { query: "" },
        context: { ...baseContext, toolCallId: "web-empty" },
      }),
      (error) =>
        error instanceof ToolBusError &&
        error.toolError.code === "empty_query" &&
        error.toolError.retryable === false,
    );
  },
);
