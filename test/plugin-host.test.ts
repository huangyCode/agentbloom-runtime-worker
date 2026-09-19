import assert from "node:assert/strict";
import { test } from "node:test";
import { PluginHost } from "../src/plugin/host.ts";
import type { WorkerPlugin } from "../src/plugin/types.ts";

const seed = () => ({
  runId: "run-test",
  traceId: "trace-test",
  snapshot: { thinking: { enabled: true } } as any,
  signal: new AbortController().signal,
});

test("Observer 异常被隔离,不影响运行也不影响其他插件", async () => {
  const seen: string[] = [];
  const bad: WorkerPlugin = {
    name: "bad", apiVersion: 1,
    onEvent() { throw new Error("boom"); },
  };
  const good: WorkerPlugin = {
    name: "good", apiVersion: 1,
    onEvent(ev) { seen.push(ev.type); },
  };
  const run = new PluginHost([bad, good]).createRun(seed());
  run.dispatchEvent("message_end", {});
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(seen, ["message_end"]);
});

test("beforeModelCall 按注册序成链,异常插件被跳过", async () => {
  const a: WorkerPlugin = {
    name: "a", apiVersion: 1,
    beforeModelCall: (d) => ({ ...d, options: { reasoning: "low" } }),
  };
  const crash: WorkerPlugin = {
    name: "crash", apiVersion: 1,
    beforeModelCall: () => { throw new Error("boom"); },
  };
  const b: WorkerPlugin = {
    name: "b", apiVersion: 1,
    beforeModelCall: (d) => ({ ...d, options: { reasoning: "high" } }),
  };
  const run = new PluginHost([a, crash, b]).createRun(seed());
  const out = await run.beforeModelCall({ messages: [], options: {} });
  assert.equal(out.options.reasoning, "high"); // a 生效 → crash 跳过 → b 覆盖
});

test("beforeToolCall 异常等价 block,失败显式可见", async () => {
  const crash: WorkerPlugin = {
    name: "approval", apiVersion: 1,
    beforeToolCall: () => { throw new Error("审批服务不可达"); },
  };
  const run = new PluginHost([crash]).createRun(seed());
  const decision = await run.beforeToolCall({
    toolCallId: "c1", toolName: "t", args: {}, sideEffect: true,
  });
  assert.equal(decision.action, "block");
  assert.match((decision as any).reason, /approval/);
});

test("shouldStop 任一插件返回 true 即停", async () => {
  const never: WorkerPlugin = { name: "n", apiVersion: 1, shouldStop: () => false };
  const stopAt2: WorkerPlugin = {
    name: "s", apiVersion: 1,
    shouldStop: (turn) => turn.assistantTurns >= 2,
  };
  const run = new PluginHost([never, stopAt2]).createRun(seed());
  assert.equal(await run.shouldStop({ assistantTurns: 1, hadToolCalls: true }), false);
  assert.equal(await run.shouldStop({ assistantTurns: 2, hadToolCalls: false }), true);
});

test("setup 插槽:自定义执行器与技能存储被收集", () => {
  const exec = { kind: "grpc", execute: async () => ({ content: [] }) } as any;
  const store = { getSkillObject: async () => Buffer.from("x") };
  const plugin: WorkerPlugin = {
    name: "slots", apiVersion: 1,
    setup(api) { api.registerExecutor(exec); api.provideSkillStore(store); },
  };
  const host = new PluginHost([plugin]);
  assert.equal(host.extraExecutors.length, 1);
  assert.equal(host.skillStore, store);
});

test("状态袋按插件隔离,互不可见", async () => {
  const writer: WorkerPlugin = {
    name: "w", apiVersion: 1,
    beforeModelCall(d, ctx) { ctx.state.set("k", 1); },
  };
  let readerSaw: unknown = "unset";
  const reader: WorkerPlugin = {
    name: "r", apiVersion: 1,
    beforeModelCall(d, ctx) { readerSaw = ctx.state.get("k"); },
  };
  const run = new PluginHost([writer, reader]).createRun(seed());
  await run.beforeModelCall({ messages: [], options: {} });
  assert.equal(readerSaw, undefined);
});
