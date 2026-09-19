/**
 * PluginHost：两条泳道的执行纪律都在这，插件作者不用自己处理隔离与超时。
 * - Observer：异步派发，异常吞掉记日志，绝不影响运行；
 * - Interceptor：按注册序成链，单钩子硬超时 INTERCEPTOR_TIMEOUT_MS；
 *   beforeToolCall 异常/超时 = block（失败必须显式可见）；
 *   其余拦截钩子异常/超时 = 跳过该插件放行原稿并记日志。
 */
import { log } from "../common/log.ts";
import type {
  ModelCallDraft,
  RunContext,
  RunEvent,
  ToolCallDraft,
  ToolDecision,
  ToolOutcome,
  ToolResultPatch,
  TurnSummary,
  WorkerPlugin,
} from "./types.ts";

const INTERCEPTOR_TIMEOUT_MS = Number(
  process.env.PLUGIN_INTERCEPTOR_TIMEOUT_MS ?? 5000,
);

function withTimeout<T>(value: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`插件钩子超时 ${ms}ms: ${label}`)),
      ms,
    );
    value.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export interface RunIdentitySeed {
  runId: string;
  traceId: string;
  agentNo?: string;
  conversationNo?: string;
  snapshot: RunContext["snapshot"];
  signal: AbortSignal;
}

export class PluginHost {
  private readonly plugins: WorkerPlugin[];
  /** setup 阶段注册的自定义执行器（装配 ToolBus 时并入）。 */
  readonly extraExecutors: import("../toolbus/types.ts").ToolExecutor[] = [];
  /** setup 阶段替换的技能对象存储（缺省用内置 MinIO）。 */
  skillStore?: { getSkillObject(objectKey: string): Promise<Buffer> };

  constructor(plugins: WorkerPlugin[]) {
    this.plugins = plugins;
    for (const plugin of plugins) {
      plugin.setup?.({
        registerExecutor: (executor) => this.extraExecutors.push(executor),
        provideSkillStore: (store) => { this.skillStore = store; },
      });
    }
  }

  /** 每次运行为每个插件建独立 ctx（state 袋互不可见，运行结束即焚）。 */
  createRun(seed: RunIdentitySeed): PluginRun {
    const contexts = new Map<WorkerPlugin, RunContext>();
    for (const plugin of this.plugins) {
      contexts.set(plugin, {
        runId: seed.runId,
        traceId: seed.traceId,
        agentNo: seed.agentNo,
        conversationNo: seed.conversationNo,
        snapshot: seed.snapshot,
        signal: seed.signal,
        state: new Map(),
        log: (message, fields) =>
          log({ component: "plugin", plugin: plugin.name, message, ...fields }),
      });
    }
    return new PluginRun(this.plugins, contexts);
  }
}

export class PluginRun {
  private readonly plugins: WorkerPlugin[];
  private readonly contexts: Map<WorkerPlugin, RunContext>;

  constructor(plugins: WorkerPlugin[], contexts: Map<WorkerPlugin, RunContext>) {
    this.plugins = plugins;
    this.contexts = contexts;
  }

  /** Observer 泳道：fire-and-forget，异常隔离。 */
  dispatchEvent(type: string, payload: unknown): void {
    const ev: RunEvent = { type, payload, ts: Date.now() };
    for (const plugin of this.plugins) {
      if (!plugin.onEvent) continue;
      try {
        Promise.resolve(plugin.onEvent(ev, this.contexts.get(plugin)!)).catch(
          (e) =>
            log({ component: "plugin", plugin: plugin.name, lane: "observer",
                  error: String(e), event: type }),
        );
      } catch (e) {
        log({ component: "plugin", plugin: plugin.name, lane: "observer",
              error: String(e), event: type });
      }
    }
  }

  /** 链式改稿：异常/超时 = 跳过该插件，放行当前稿。 */
  async beforeModelCall(draft: ModelCallDraft): Promise<ModelCallDraft> {
    let current = draft;
    for (const plugin of this.plugins) {
      if (!plugin.beforeModelCall) continue;
      try {
        const out = await withTimeout(
          Promise.resolve(plugin.beforeModelCall(current, this.contexts.get(plugin)!)),
          INTERCEPTOR_TIMEOUT_MS,
          `${plugin.name}.beforeModelCall`,
        );
        if (out) current = out;
      } catch (e) {
        log({ component: "plugin", plugin: plugin.name, hook: "beforeModelCall",
              error: String(e), action: "skipped" });
      }
    }
    return current;
  }

  /** 工具拦截：第一个 block 即短路；异常/超时 = block（显式失败）。 */
  async beforeToolCall(call: ToolCallDraft): Promise<ToolDecision> {
    for (const plugin of this.plugins) {
      if (!plugin.beforeToolCall) continue;
      try {
        const out = await withTimeout(
          Promise.resolve(plugin.beforeToolCall(call, this.contexts.get(plugin)!)),
          INTERCEPTOR_TIMEOUT_MS,
          `${plugin.name}.beforeToolCall`,
        );
        if (out && out.action === "block") return out;
      } catch (e) {
        return {
          action: "block",
          reason: `插件 ${plugin.name} 拦截钩子失败: ${String(e)}`,
        };
      }
    }
    return { action: "allow" };
  }

  /** 结果补丁链：异常/超时 = 跳过该插件。 */
  async afterToolCall(outcome: ToolOutcome): Promise<ToolResultPatch | undefined> {
    let patch: ToolResultPatch | undefined;
    let current = outcome;
    for (const plugin of this.plugins) {
      if (!plugin.afterToolCall) continue;
      try {
        const out = await withTimeout(
          Promise.resolve(plugin.afterToolCall(current, this.contexts.get(plugin)!)),
          INTERCEPTOR_TIMEOUT_MS,
          `${plugin.name}.afterToolCall`,
        );
        if (out?.content) {
          patch = { content: out.content };
          current = { ...current, content: out.content };
        }
      } catch (e) {
        log({ component: "plugin", plugin: plugin.name, hook: "afterToolCall",
              error: String(e), action: "skipped" });
      }
    }
    return patch;
  }

  /** 任一插件说停就停；异常/超时 = 不停（记日志）。 */
  async shouldStop(turn: TurnSummary): Promise<boolean> {
    for (const plugin of this.plugins) {
      if (!plugin.shouldStop) continue;
      try {
        const out = await withTimeout(
          Promise.resolve(plugin.shouldStop(turn, this.contexts.get(plugin)!)),
          INTERCEPTOR_TIMEOUT_MS,
          `${plugin.name}.shouldStop`,
        );
        if (out === true) return true;
      } catch (e) {
        log({ component: "plugin", plugin: plugin.name, hook: "shouldStop",
              error: String(e), action: "ignored" });
      }
    }
    return false;
  }
}
