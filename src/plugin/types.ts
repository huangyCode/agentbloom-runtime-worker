/**
 * 插件契约（对外公开 API，改动须升 apiVersion）。
 *
 * 两类钩子，纪律不同，混用是错误：
 * - Observer（onEvent）：只读订阅，异步、无序、**失败绝不影响运行**（异常吞掉记日志）。
 *   落库/监控/审计写这条道。
 * - Interceptor（beforeModelCall / beforeToolCall / afterToolCall / shouldStop）：
 *   进入关键路径，按注册序成链，单钩子硬超时；**异常 = 显式失败**
 *   （工具钩子异常等价 block，模型钩子异常放行原稿并记日志）。
 *
 * 状态约定：ctx.state 是「本插件 × 本次运行」的私有状态袋，运行结束即焚。
 * 任何要跨运行存活的状态，必须通过 onEvent 流出到插件自己的存储——
 * 插件没有写库的默认权限，worker 本体保持无状态。
 */
import type { Snapshot } from "../protocol/types.ts";
import type { ToolDefinition, ToolExecutor } from "../toolbus/types.ts";

export const PLUGIN_API_VERSION = 1 as const;

/** 每次运行、每个插件独立的上下文。 */
export interface RunContext {
  runId: string;
  traceId: string;
  agentNo?: string;
  conversationNo?: string;
  /** 本次运行的快照（只读参考：thinking 开关、budgets、model 等）。 */
  snapshot: Readonly<Snapshot>;
  signal: AbortSignal;
  /** 本插件 × 本次运行的私有状态袋，运行结束即焚。 */
  state: Map<string, unknown>;
  log: (message: string, fields?: Record<string, unknown>) => void;
}

/** Observer（观察者）收到的事件：Pi 循环事件 + ToolBus 执行事件，统一信封。 */
export interface RunEvent {
  /** 循环事件为 Pi 原名（message_end / tool_execution_start …）；
   *  ToolBus 事件加前缀 toolbus_（toolbus_retry / toolbus_failure …）。 */
  type: string;
  /** 原始事件负载，字段随 type 而定（类型见 pi-agent-core / toolbus/types）。 */
  payload: unknown;
  ts: number;
}

/** beforeModelCall 的可改写稿：本轮即将发给模型的消息与选项。 */
export interface ModelCallDraft {
  /** 即将发送的消息数组（可整体替换；置换而非原地改）。 */
  messages: any[];
  /** 附加选项；reasoning 缺省表示按 thinkingLevelMap.off 关思考。 */
  options: { reasoning?: "minimal" | "low" | "medium" | "high" };
}

export interface ToolCallDraft {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  sideEffect: boolean;
}

/** 工具拦截裁决：不返回 = allow。 */
export type ToolDecision =
  | { action: "allow" }
  | { action: "block"; reason: string };

export interface ToolOutcome {
  toolCallId: string;
  toolName: string;
  isError: boolean;
  /** 模型将看到的结果 content 块。 */
  content: unknown[];
}

/** afterToolCall 的补丁：只允许替换模型可见 content。不返回 = 不动。 */
export interface ToolResultPatch {
  content?: unknown[];
}

export interface TurnSummary {
  /** 本次运行内已完成的 assistant 轮数（含当前这轮）。 */
  assistantTurns: number;
  /** 当前轮是否发起了工具调用。 */
  hadToolCalls: boolean;
}

/** setup 阶段可用的装配 API：实现替换类插槽。 */
export interface WorkerApi {
  /** 注册自定义工具执行通道（kind 与快照 toolSpecs[].type 对应）。 */
  registerExecutor(executor: ToolExecutor): void;
  /** 替换技能正文对象存储（默认 MinIO）。 */
  provideSkillStore(store: {
    getSkillObject(objectKey: string): Promise<Buffer>;
  }): void;
}

export interface WorkerPlugin {
  name: string;
  apiVersion: typeof PLUGIN_API_VERSION;

  /** Observer：只读事件订阅。 */
  onEvent?(ev: RunEvent, ctx: RunContext): void | Promise<void>;

  /** Interceptor：本轮调模型前，可改写消息与 reasoning 选项。 */
  beforeModelCall?(
    draft: ModelCallDraft,
    ctx: RunContext,
  ): ModelCallDraft | void | Promise<ModelCallDraft | void>;

  /** Interceptor：工具执行前放行/拦截。异常等价 block。 */
  beforeToolCall?(
    call: ToolCallDraft,
    ctx: RunContext,
  ): ToolDecision | void | Promise<ToolDecision | void>;

  /** Interceptor：工具结果喂回模型前的补丁。 */
  afterToolCall?(
    outcome: ToolOutcome,
    ctx: RunContext,
  ): ToolResultPatch | void | Promise<ToolResultPatch | void>;

  /** Interceptor：每轮结束后判断是否停止循环（true = 停）。 */
  shouldStop?(
    turn: TurnSummary,
    ctx: RunContext,
  ): boolean | void | Promise<boolean | void>;

  /** 装配期一次性注入：自定义执行器 / 存储实现。 */
  setup?(api: WorkerApi): void;
}
