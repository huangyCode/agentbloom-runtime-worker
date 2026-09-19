# 插件开发指南（Plugin API v1）

runtime 的策略层是开放的：思考定档、上下文裁剪、轮数预算这些**内置能力本身就是插件**
（`src/plugin/builtin/`，每个不到 50 行，是最好的示例代码）。你可以用同一套 API
挂自己的事件处理与状态逻辑。

## 心智模型：两条泳道 + 一排插槽

| 泳道 | 钩子 | 能力 | 纪律 |
|---|---|---|---|
| **Observer** | `onEvent` | 只读订阅全部事件 | 异步、无序、**异常被吞掉记日志，绝不影响运行** |
| **Interceptor** | `beforeModelCall` / `beforeToolCall` / `afterToolCall` / `shouldStop` | 改写请求、否决工具、裁剪上下文、停止循环 | 按注册序成链、单钩子硬超时（默认 5s，`PLUGIN_INTERCEPTOR_TIMEOUT_MS`）、失败语义见下表 |
| **插槽** | `setup(api)` | 注册自定义工具执行器、替换技能对象存储 | 进程启动时执行一次 |

**只想看，写 Observer；想要管，写 Interceptor 并接受它的纪律。**

## 钩子契约

| 钩子 | 触发时刻 | 入参 | 返回值 | 失败/超时语义 |
|---|---|---|---|---|
| `onEvent` | 循环每个事件 + ToolBus 事件（`toolbus_` 前缀） | `RunEvent`, `RunContext` | 无 | 吞掉记日志，继续 |
| `beforeModelCall` | 每轮调模型前 | `ModelCallDraft`（messages + options.reasoning） | 新稿或不返回 | **跳过该插件**，放行当前稿 |
| `beforeToolCall` | 工具执行前 | `ToolCallDraft`（含 args、sideEffect） | `{action:"block",reason}` 或不返回=放行 | **等价 block**——审批类插件失败必须显式可见，绝不静默放行 |
| `afterToolCall` | 工具结果喂回模型前 | `ToolOutcome` | `{content}` 补丁或不返回 | 跳过该插件 |
| `shouldStop` | 每轮结束后 | `TurnSummary`（assistantTurns/hadToolCalls） | `true`=停止循环 | 视为不停，记日志 |

## 状态怎么放（重要约定）

`ctx.state` 是**本插件 × 本次运行**的私有 `Map`，运行结束即焚，插件之间互不可见。
审批插件存"待确认的调用"、限额插件存"已耗 token"，都放这里。

**要跨运行存活的状态，必须通过 `onEvent` 流出到你自己的存储。**
插件拿不到写库的默认权限——worker 本体保持无状态，这是本项目的底线设计，
也是断点恢复能成立的前提。

## 示例：一个审计插件（Observer）+ 一个预算插件（Interceptor）

```ts
import type { WorkerPlugin } from "../src/plugin/types.ts";

/** 把每次工具执行发到自己的收集端；失败不影响对话。 */
export const auditPlugin: WorkerPlugin = {
  name: "audit",
  apiVersion: 1,
  onEvent(ev, ctx) {
    if (ev.type !== "tool_execution_end") return;
    void fetch("http://my-collector/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId: ctx.runId, ...ev }),
    }).catch(() => {}); // 可靠投递自己攒批重试,Observer 不保证
  },
};

/** 单次运行最多调 5 次副作用工具。 */
export const sideEffectBudget: WorkerPlugin = {
  name: "side-effect-budget",
  apiVersion: 1,
  beforeToolCall(call, ctx) {
    if (!call.sideEffect) return;
    const used = (ctx.state.get("n") as number ?? 0) + 1;
    ctx.state.set("n", used);
    if (used > 5) return { action: "block", reason: "本次运行副作用工具调用已达上限(5)" };
  },
};
```

注册（`src/http/server.ts`，数组序 = 拦截链序）：

```ts
const host = new PluginHost([thinkingPolicy, contextTrimmer, roundBudget,
                             auditPlugin, sideEffectBudget]);
```

## 插槽：自定义执行通道 / 存储

```ts
export const grpcTools: WorkerPlugin = {
  name: "grpc-executor",
  apiVersion: 1,
  setup(api) {
    api.registerExecutor(new MyGrpcExecutor());   // kind 对应快照 toolSpecs[].type
    api.provideSkillStore({ getSkillObject: (key) => myS3.get(key) }); // 换掉 MinIO
  },
};
```

## 事件类型速查

循环事件（Pi 原名）：`agent_start` `turn_start` `message_start` `message_update`
`message_end` `tool_execution_start` `tool_execution_update` `tool_execution_end`
`turn_end` `agent_end`。ToolBus 事件：`toolbus_start` `toolbus_success`
`toolbus_retry` `toolbus_failure` `toolbus_canceled`。

契约测试见 `test/plugin-host.test.ts` —— 隔离、超时、链序、状态袋的行为都有断言钉住。
