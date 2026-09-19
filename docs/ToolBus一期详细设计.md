# 观山一期 ToolBus 详细设计

> 文档状态：一期实施基线（待观山、众安、玄策共同评审）  
> 负责人：观山  
> 协作人：众安（Extra 执行侧）、玄策（Worker/Pi Loop 与网关侧）  
> 适用仓库：`agent-platform-work`  
> 更新时间：2026-08-25

## 1. 文档目的

本文定义 `agent-platform-work` 内部统一工具执行基础设施 **ToolBus**。ToolBus 向上为 Pi Agent Loop 提供统一工具接口，向下适配 HTTP、内置工具及未来的 MCP、沙箱脚本、子智能体等执行方式。

一期只交付以下能力：

1. ToolBus 核心抽象和执行管线；
2. HTTP Tool Executor；
3. Worker 与 Extra 的 `/invoke/{name}` 对接；
4. Pi Agent Tool 适配；
5. 超时、取消、重试、幂等、结果截断、错误和事件规范；
6. 单元测试、Worker—Extra 契约测试和一期端到端验收。

MCP 本期只保留扩展接口和明确的“不支持”错误，不实现 MCP 连接、工具发现和 `tools/call`。

## 2. 依据和口径优先级

本设计综合以下事实来源：

1. `../../dev-plan/智能体平台 一期需求明细.md`：一期范围和职责分工；
2. `../../dev-plan/对接文档.md`：众安给出的 Extra 一期接口契约；
3. `../PROTOCOL.md`：Backend 网关向 Worker 下发快照及 Worker SSE 契约；
4. `../src/loop.ts`：当前 Pi Agent Loop、HTTP Tool 和内置工具接线；
5. `@earendil-works/pi-agent-core@0.84.2`：Pi 工具执行、取消和错误语义。

如文档之间存在冲突，按以下规则处理：

- 一期范围以一期需求为准：一期只有 HTTP Tool，不接 MCP；
- Worker—Extra 请求响应以众安《对接文档》为联调基线；
- Pi Tool 的成功失败标记以 Pi Agent Core 的真实接口行为为准；
- 对外快照字段以 `PROTOCOL.md` 为准，ToolBus 内部模型不得反向污染网关协议；
- 未冻结项由观山和众安先对拍，再同步更新 Work 与 Extra 两侧文档。

## 3. 核心结论

观山本期负责的不是单独写一个 `fetch()`，而是建立 Worker 内统一的工具执行通道：

> Pi Agent Loop 只认识统一的 Pi Tool；ToolBus 负责选择执行器、执行治理和结果归一化；HTTP 是一期第一个正式执行器，MCP 是后续执行器。

ToolBus 是 Worker 进程内的调用总线和门面，不是消息队列，不引入 MQ，也不负责跨进程任务调度。

## 4. 目标与非目标

### 4.1 设计目标

- Pi Loop 不感知 HTTP、MCP、沙箱等底层差异；
- 新增工具通道时不修改 Pi Loop 主流程；
- 所有工具共用一致的权限、取消、超时、重试、幂等和截断规则；
- Extra 的业务错误既能让模型看到完整错误信息，又能让 Pi/SSE 标记为失败；
- 一次工具调用具备稳定的 `toolCallId`、`runId`、幂等键和可排查事件；
- 外部快照协议一期保持兼容，Backend 不因内部重构返工；
- 核心逻辑可脱离真实模型和真实 Extra 做自动化测试。

### 4.2 本期非目标

- 不实现 MCP Client、连接池、`initialize`、`tools/list`、`tools/call`；
- 不实现 `run_skill` 和沙箱通道；
- 不实现 `call_agent` 和 Multi-Agent；
- 不实现监控事件落库和 MQ 上报；
- 不实现大结果写文件或对象存储，一期只截断；
- 不改变 Extra 内部进程内执行或 gVisor 分流；
- 不让 Worker 查询平台数据库或主动拉取工具定义；
- 不做工具自动导入，平台工具仍由 `GET /tools` 手工录入。

## 5. 当前实现问题

当前 `src/loop.ts` 中 `buildHttpTool()` 同时承担工具定义、HTTP 请求、幂等、超时、错误转换和截断，存在以下问题：

| 问题 | 当前表现 | 风险 |
|---|---|---|
| Pi 与通道耦合 | HTTP/MCP/内置工具直接在 `loop.ts` 拼对象 | 后续每加一种通道都要改 Loop |
| 取消未透传 | `execute()` 没接收 Pi 的 `AbortSignal` | 浏览器断连后 Extra 仍可能继续执行 |
| 错误被伪装成功 | `ok:false` 和网络异常被转成普通文本返回 | `tool_execution_end.isError=false`，页面显示成功 |
| 幂等键不稳定 | 每次执行随机生成 | 同一次调用重试无法复用 Key |
| 响应缺少校验 | 不检查状态码、Content-Type 和 envelope | 非 JSON、网关错误页可能被错误处理 |
| 截断口径错误 | 用 JavaScript 字符长度冒充字节数 | 中文和 emoji 结果可能超过 32 KiB |
| 执行顺序不明确 | Pi 默认并行调用 | 有副作用工具可能并发执行 |
| 测试缺失 | `npm test` 固定失败 | 协议变化无法回归 |

ToolBus 用统一模型解决这些问题，同时保持现有业务链路不变。

## 6. 总体架构

```text
Backend 快照 toolSpecs[] / Worker 内置工具
                    │
                    ▼
             ToolSpecNormalizer
      外部协议模型 → ToolBus 内部定义
                    │
                    ▼
              PiToolAdapter
   Pi AgentTool.execute(id, args, signal)
                    │
                    ▼
                 ToolBus
     定义检查 / 权限 / 幂等 / deadline
        重试 / 事件 / 截断 / 错误归一
                    │
                    ▼
            ToolExecutorRegistry
          ┌─────────┼──────────┐
          ▼         ▼          ▼
     HTTP Executor  Builtin   MCP Executor
       一期实现      一期仅     后续实现
                    read_skill
          │
          ▼
 Extra POST /invoke/{name}
```

### 6.1 分层职责

| 层 | 职责 | 不负责 |
|---|---|---|
| `ToolSpecNormalizer` | 将快照字段转成内部定义，做配置校验 | 不执行工具 |
| `PiToolAdapter` | 把 ToolBus 工具变成 Pi `AgentTool`，传递 callId/signal | 不写 HTTP/MCP 逻辑 |
| `ToolBus` | 执行编排、策略、错误和事件 | 不实现具体协议 |
| `ToolExecutorRegistry` | 按 `kind` 查找执行器 | 不做业务选择 |
| `HttpToolExecutor` | Extra HTTP 请求与 envelope 解码 | 不决定权限和重试次数 |
| `BuiltinToolExecutor` | 本地内置工具，如 `read_skill` | 不访问 Extra |
| `McpToolExecutor` | 后续 MCP 生命周期和 `tools/call` | 一期不启用 |

## 7. 外部协议与内部模型

### 7.1 外部快照保持不变

一期 Backend 继续下发：

```json
{
  "name": "sql_query",
  "description": "只读查询数据仓库",
  "type": "http",
  "endpoint": "http://127.0.0.1:8200/invoke/sql_query",
  "inputSchema": {
    "type": "object",
    "properties": { "sql": { "type": "string" } },
    "required": ["sql"]
  },
  "sideEffect": false
}
```

不要求 Backend 在一期把 `type` 改成 `kind`，也不新增 MCP 字段。

### 7.2 ToolBus 内部工具定义

```ts
export type ToolKind = "http" | "builtin" | "mcp" | "sandbox" | "agent";

export interface BaseToolDefinition {
  name: string;
  label: string;
  description: string;
  inputSchema: Record<string, unknown>;
  kind: ToolKind;
  sideEffect: boolean;
  timeoutMs: number;
  executionMode: "parallel" | "sequential";
}

export interface HttpToolDefinition extends BaseToolDefinition {
  kind: "http";
  endpoint: string;
  method: "POST";
}

export interface BuiltinToolDefinition extends BaseToolDefinition {
  kind: "builtin";
  builtinName: "read_skill";
}

export interface McpToolDefinition extends BaseToolDefinition {
  kind: "mcp";
  serverRef: string;
  remoteToolName: string;
}

export type ToolDefinition =
  | HttpToolDefinition
  | BuiltinToolDefinition
  | McpToolDefinition;
```

一期规范化规则：

- `type=http` → `kind=http`；
- `endpoint` 必须是合法的 `http:` 或 `https:` 绝对 URL；
- `sideEffect` 必填，缺失时拒绝加载，不能静默按 `false`；
- `inputSchema` 必须是 JSON Object Schema；
- `timeoutMs` 默认 `30_000`；
- `sideEffect=true` 默认 `executionMode=sequential`；
- 无副作用工具默认 `parallel`，允许由后续配置覆盖；
- 一期收到 `type=mcp` 时抛出 `tool_kind_not_enabled`，不得返回伪成功文本。

参数 Schema 在工具装配时使用固定版本的 `typebox/compile` 编译并缓存 validator，不能在每次调用时重复编译。Pi Agent Core 会先做一次参数校验，ToolBus 再做边界校验是为了保证 ToolBus 可被 Pi 之外的调用方复用，也防止未来 Adapter 变更绕过约束。Schema 本身无法编译时按 `tool_config_invalid` 处理；实际参数不匹配时按 `arguments_schema_invalid` 处理，错误中只保留字段路径和校验关键字，不原样记录可能敏感的参数值。

### 7.3 为什么不直接修改快照协议

ToolBus 是 Worker 内部重构，外部网关已经按 `PROTOCOL.md` 组装 `toolSpecs`。一期变更快照字段会同时影响 Backend、样例、联调脚本和验收，收益不足。因此采用“边界兼容、内部标准化”的方式。

未来正式开放 MCP 时，再为快照协议新增带版本的判别联合字段，并保留 `type=http` 的兼容解析。

## 8. ToolBus 核心接口

### 8.1 执行请求

```ts
export interface ToolCallContext {
  runId: string;
  toolCallId: string;
  agentNo?: string;
  traceId?: string;
  permissionMode: "auto" | "ask" | "readonly";
  approvalGranted?: boolean;
  signal?: AbortSignal;
}

export interface ToolBusRequest {
  definition: ToolDefinition;
  arguments: Record<string, unknown>;
  context: ToolCallContext;
}
```

字段说明：

| 字段 | 来源 | 用途 |
|---|---|---|
| `runId` | Worker 当前 `chatcmpl-*` ID | 日志、幂等键隔离 |
| `toolCallId` | Pi `execute` 第一个参数 | 单次工具调用唯一标识 |
| `agentNo` | 快照 | 排查和审计 |
| `traceId` | 有则透传，无则使用 `runId` | 跨服务关联 |
| `permissionMode` | 快照 | 只读和副作用控制 |
| `approvalGranted` | Worker 审批流程 | ask 模式下是否已批准；一期 auto 模式不使用 |
| `signal` | Pi/Worker | 浏览器断连或上层取消 |

### 8.2 成功结果

```ts
export interface ToolBusResult {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  details: ToolExecutionDetails;
}

export interface ToolExecutionDetails {
  runId: string;
  toolCallId: string;
  toolName: string;
  kind: ToolKind;
  attempt: number;
  durationMs: number;
  truncated: boolean;
  originalBytes?: number;
}
```

`ToolBus.execute()` 只在成功时返回 `ToolBusResult`。失败统一抛出 `ToolBusError`，由 Pi 捕获后生成 `isError=true` 的 Tool Result。

### 8.3 执行器接口

```ts
export interface ToolExecutor<T extends ToolDefinition = ToolDefinition> {
  readonly kind: T["kind"];

  execute(
    definition: T,
    args: Record<string, unknown>,
    context: ToolExecutorContext
  ): Promise<ToolExecutorResult>;
}

export interface ToolExecutorContext {
  runId: string;
  toolCallId: string;
  agentNo?: string;
  traceId: string;
  attempt: number;
  idempotencyKey?: string;
  deadlineAt: number;
  signal: AbortSignal;
}

export interface ToolExecutorResult {
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
}
```

执行器不得自行决定是否重试，也不得吞掉异常返回普通成功文本。

### 8.4 ToolBus 门面

```ts
export interface ToolBus {
  execute(request: ToolBusRequest): Promise<ToolBusResult>;
}
```

一期实现类建议命名为 `DefaultToolBus`，构造依赖通过参数注入：

```ts
new DefaultToolBus({
  registry,
  eventSink,
  clock,
  idempotencyKeyFactory,
  config
});
```

依赖注入便于测试超时、重试、时间和幂等行为，禁止在核心逻辑里到处直接读取环境变量。

## 9. Pi Agent Core 适配

### 9.1 适配器职责

`PiToolAdapter` 是 ToolBus 与 Pi Agent Core 的唯一边界：

```ts
export function toPiTool(
  definition: ToolDefinition,
  toolBus: ToolBus,
  runContext: RunContext
) {
  return {
    name: definition.name,
    label: definition.label,
    description: definition.description,
    parameters: definition.inputSchema,
    executionMode: definition.executionMode,

    execute: async (
      toolCallId: string,
      params: Record<string, unknown>,
      signal?: AbortSignal
    ) => toolBus.execute({
      definition,
      arguments: params,
      context: {
        runId: runContext.runId,
        agentNo: runContext.agentNo,
        traceId: runContext.traceId,
        permissionMode: runContext.permissionMode,
        toolCallId,
        signal
      }
    })
  };
}
```

Pi Agent Core 0.84.2 会捕获 `execute()` 抛出的错误，把 `error.message` 放进模型可见的 Tool Result，并设置 `isError=true`。因此 ToolBus 不需要伪造 Pi 事件。

### 9.2 业务失败的双重要求

众安文档要求 Extra 的 `ok:false`：

1. 完整 `error` 对象要反馈给模型，让模型判断是否纠正参数或换策略；
2. 前端工具步骤应显示 `fail`，不能显示 `ok`。

ToolBus 的处理方式：

```ts
const toolError = new ToolBusError({
  code: extra.error.code,
  message: extra.error.message,
  retryable: extra.error.retryable,
  source: "extra",
  modelPayload: extra.error,
  details: extra.error
});
throw toolError;
```

结果是：

- 模型看到 `{"code":"readonly_only",...}`；
- Pi Tool Result 的 `isError=true`；
- `src/openai.ts` 将 `tool_execution_end` 映射为 `status=fail`；
- ToolBus 结构化元数据仍保留在 `ToolBusError.toolError` 中供日志和测试使用。

### 9.3 runId 接线

当前 `server.ts` 先生成 `chatcmpl-*` ID，再调用 `buildRun(body)`。实施时改为：

```ts
const { run } = buildRun(body, { runId: id, traceId: id });
```

这是 ToolBus 与 Worker 薄壳的最小交互变更，需要玄策 Review，不改变 HTTP/SSE 对外协议。

## 10. ToolBus 执行管线

每次执行严格按以下顺序：

```text
1. definition 配置校验
2. arguments JSON Schema 校验
3. permissionMode / sideEffect 检查
4. 创建整次调用 deadline
5. 生成本次调用稳定幂等键
6. Registry 选择 Executor
7. 发出 start 事件
8. 执行 attempt
9. 失败分类并判断是否安全重试
10. 成功结果按 UTF-8 字节截断
11. 发出 success / failure / canceled 事件
12. 返回结果或抛 ToolBusError
```

建议核心代码保持显式流程，不为一期引入复杂的通用中间件框架。各步骤可以拆成可测试函数；当后续通道增多时再演进为 middleware 链。

## 11. HTTP Executor 与 Extra 契约

### 11.1 请求

```http
POST /invoke/{name}
Content-Type: application/json
X-Idempotency-Key: idem_<stable-value>  # 仅 sideEffect=true
X-Trace-Id: <traceId>                   # Extra 可暂时忽略
```

```json
{
  "arguments": {
    "sql": "SELECT table_name, column_name, column_type FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'ads_daily' ORDER BY ordinal_position"
  }
}
```

规则：

- endpoint 直接使用快照中的绝对 URL；
- body 根节点只有 `arguments`；
- 不携带平台 API Key；
- Extra 在内网，不由 ToolBus 做用户鉴权；
- `sideEffect=false` 不发送幂等头；
- `sideEffect=true` 在一次逻辑调用和其所有重试中复用同一个 Key。

### 11.2 响应 envelope

成功：

```json
{"ok":true,"result":{}}
```

业务失败：

```json
{
  "ok": false,
  "error": {
    "code": "readonly_only",
    "message": "只允许 SELECT 查询，DDL/DML 请走变更单流程",
    "retryable": false
  }
}
```

实现异常可以为 HTTP 500，但 body 仍必须是 `ok:false` envelope。

### 11.3 响应校验

HTTP Executor 必须完成：

1. 检查 HTTP 状态；
2. 检查响应体可解析为 JSON；
3. 检查根节点为对象且 `ok` 为 boolean；
4. `ok=true` 时必须存在 `result` 字段，允许 `result=null`；
5. `ok=false` 时必须存在 `error.code/message/retryable`；
6. HTTP 200 允许 `ok=true` 或 `ok=false`；
7. HTTP 500 只接受 `ok=false`，否则视为 `invalid_response`；
8. 其他 HTTP 状态即使有 JSON 也归一为 `unexpected_http_status`；
9. HTML、空响应、204、字段类型错误均归为协议错误；
10. 响应读取也受同一个 30 秒 deadline 和取消信号控制。

Content-Type 校验采用兼容模式：

- `application/json`、`application/*+json` 正常解析；
- Extra 在一期若漏 Content-Type，但 body 是合法 envelope，可解析但记录 warning；
- body 非合法 JSON 必须失败，不得返回给模型当普通成功内容。

### 11.4 成功结果序列化

- `result` 为字符串：直接作为文本；
- 其他 JSON 值：使用 `JSON.stringify(result)`；
- `undefined` 不可能通过 envelope 校验；
- JSON 序列化失败归为 `invalid_response`；
- ToolBus 最终返回 Pi `content: [{type:"text", text}]`。

## 12. 错误模型

### 12.1 统一错误结构

```ts
export type ToolErrorSource =
  | "toolbus"
  | "policy"
  | "transport"
  | "extra"
  | "protocol";

export interface ToolErrorData {
  code: string;
  message: string;
  retryable: boolean;
  source: ToolErrorSource;
  phase: "prepare" | "connect" | "execute" | "decode" | "finalize";
  toolName: string;
  kind: ToolKind;
  runId: string;
  toolCallId: string;
  attempt: number;
  /** 原样反馈给模型的安全 payload；Extra 业务失败时就是 Extra error 对象。 */
  modelPayload?: Record<string, unknown>;
  details?: unknown;
}

export class ToolBusError extends Error {
  constructor(public readonly toolError: ToolErrorData) {
    super(JSON.stringify(toolError.modelPayload ?? {
      code: toolError.code,
      message: toolError.message,
      retryable: toolError.retryable
    }));
  }
}
```

对 Extra `ok:false`，模型可见 payload 保持 Extra 的 `error` 三字段原样；ToolBus 的 `source/phase/runId` 等只用于内部 details 和日志，不泄漏到模型上下文。

### 12.2 ToolBus 自有错误码

| code | source | retryable | 含义 |
|---|---|---:|---|
| `tool_config_invalid` | toolbus | false | 工具定义缺字段或 endpoint 非法 |
| `tool_kind_not_enabled` | toolbus | false | 例如一期收到 MCP 工具 |
| `tool_executor_not_found` | toolbus | false | Registry 未注册对应执行器 |
| `arguments_schema_invalid` | policy | false | 参数未通过 ToolBus 入参校验 |
| `permission_denied` | policy | false | readonly 调用副作用工具 |
| `approval_required` | policy | false | ask 模式未获得批准 |
| `connection_failed` | transport | true | DNS、拒绝连接、连接重置 |
| `upstream_timeout` | transport | true | ToolBus 总 deadline 到期 |
| `canceled` | transport | false | 上层主动取消或客户端断连 |
| `unexpected_http_status` | protocol | 视状态 | 非约定 HTTP 状态 |
| `invalid_response` | protocol | false | 非 JSON 或 envelope 不合法 |
| `result_serialize_failed` | protocol | false | result 不能序列化 |
| `internal` | toolbus | false | 未分类的 ToolBus 缺陷 |

Extra 已定义的 `tool_not_found`、`schema_invalid`、`readonly_only`、`tidb_unavailable`、`timeout`、`sandbox_timeout` 等 code 不改名，按响应原样保留。

### 12.3 取消与超时的区别

- 上层 `signal` 先触发：`canceled`，不重试；
- ToolBus deadline 先触发：`upstream_timeout`，仅无副作用工具可进入重试判断；
- Extra 返回 `{"code":"timeout","retryable":true}`：保留 Extra code `timeout`；
- Extra 返回 `sandbox_timeout`：保留 `sandbox_timeout`；
- 不允许把所有 `AbortError` 都笼统映射成 timeout。

## 13. 超时和取消

### 13.1 总 deadline

一期默认一次逻辑工具调用总预算为 30 秒，包括：

- 建立连接；
- Extra 执行；
- 读取响应；
- 自动重试和退避等待。

不是“每次尝试各 30 秒”。否则一次重试可能把工具调用拉长到 60 秒以上。

### 13.2 信号组合

ToolBus 创建 deadline signal，并与 Pi 传入的 signal 合并：

```ts
const timeoutSignal = AbortSignal.timeout(remainingMs);
const combinedSignal = AbortSignal.any(
  parentSignal ? [parentSignal, timeoutSignal] : [timeoutSignal]
);
```

每次 attempt 使用剩余预算重新计算 timeout。所有退避等待也必须可被 parent signal 取消。

### 13.3 断连链路

```text
浏览器断开
  → Backend 取消 Worker HTTP 请求
  → Worker req.close
  → server AbortController.abort()
  → agentLoop signal
  → Pi Tool execute(signal)
  → PiToolAdapter
  → ToolBus combinedSignal
  → fetch 立即中止
```

契约测试必须覆盖“Extra 延迟返回，客户端取消后 fetch 被中止”。

## 14. 重试策略

### 14.1 基本规则

- 默认 `maxAttempts=2`，即首次执行加最多一次自动重试；
- `sideEffect=true`：一期永不自动重试；
- `sideEffect=false`：只有错误 `retryable=true` 才允许重试；
- `canceled`、配置错误、Schema 错误、权限错误永不重试；
- 所有尝试共享 30 秒总 deadline；
- 重试使用相同 `runId/toolCallId/traceId`；
- 有幂等键时必须复用相同 Key；
- 第二次尝试前等待 `200ms + 0~100ms jitter`；
- 剩余预算不足以完成退避时不重试，直接返回最后错误。

### 14.2 HTTP 错误建议

| 场景 | retryable |
|---|---:|
| Extra `ok:false` 明确给出 `retryable` | 原样 |
| 连接拒绝、连接重置 | true |
| ToolBus deadline | true，但受总 deadline 限制，通常无预算重试 |
| HTTP 502/503/504 | true |
| HTTP 400/404 | false |
| HTTP 500 且 envelope 有 `retryable` | 按 envelope |
| 非 JSON / envelope 非法 | false |
| 上层取消 | false |

自动重试发生时必须发出 `retry` 事件，禁止静默重试。

## 15. 幂等策略

### 15.1 生成规则

对 `sideEffect=true` 的工具：

```text
X-Idempotency-Key = "idem_" + SHA-256(runId + ":" + toolCallId) 前 32 个十六进制字符
```

性质：

- 同一 Pi 工具调用的所有 attempt 一致；
- 不同 run 隔离；
- 不暴露参数、agent token 或 API Key；
- 可由单元测试稳定断言。

### 15.2 责任边界

| Worker/ToolBus | Extra |
|---|---|
| 生成和发送 Key | 识别 Key |
| 同一逻辑调用复用 Key | 缓存并复用成功结果 |
| 一期不自动重试副作用工具 | 避免同 Key 重复执行副作用 |
| 不持久化幂等结果 | 决定缓存时间和容量 |

即使存在幂等键，一期仍不自动重试副作用工具；幂等用于调用方或网络层可能发生的重复保护，而不是放宽安全策略。

## 16. 结果大小治理

### 16.1 限制

- 默认上限：`32 * 1024` UTF-8 bytes；
- 使用 `Buffer.byteLength(text, "utf8")`，不能使用 `text.length`；
- 截断后必须保证字符串仍是合法 UTF-8；
- 截断标记本身也计入 32 KiB；
- 保留结果头部，便于模型识别数据结构；
- details 记录 `truncated/originalBytes/returnedBytes`。

### 16.2 模型可见格式

```text
[ToolBus: result truncated; originalBytes=45678; limitBytes=32768]
<在限制内保留的结果头部>
```

一期不写 `/workspace`，不生成文件链接。未来接文件页时只替换 Result Policy，不修改 HTTP Executor 和 Pi Loop。

## 17. 权限和执行顺序

### 17.1 permissionMode

| 模式 | 无副作用工具 | 有副作用工具 |
|---|---|---|
| `auto` | 允许 | 允许 |
| `readonly` | 允许 | 不进入 Pi 工具清单，并在 ToolBus 二次拒绝 |
| `ask` | 允许 | 未收到批准标记时拒绝 `approval_required` |

一期网关固定传 `auto`，但 ToolBus 必须保留二次校验，不能只依赖工具清单过滤。
`ask` 的对话式批准状态由玄策负责的 Worker 审批流程提供给 `ToolCallContext.approvalGranted`；ToolBus 只消费最终布尔结果，不解析对话内容。

### 17.2 并发规则

Pi 默认并行执行同一 assistant message 中的多个 Tool Call：

- `sideEffect=false` → `executionMode=parallel`；
- `sideEffect=true` → `executionMode=sequential`；
- 内置 `read_skill` → `parallel`；
- 后续 MCP 工具根据 MCP Server 能力和 sideEffect 决定。

ToolBus 本期不做跨会话全局串行化。资源侧并发保护由 Extra 自己负责。

## 18. 内置工具接入

### 18.1 read_skill

`read_skill` 应通过同一个 PiToolAdapter，但底层使用 `BuiltinToolExecutor`：

```text
Pi Loop → PiToolAdapter → ToolBus → BuiltinToolExecutor → snapshot.skills
```

它不访问 Extra，不需要幂等键，默认 1 秒 timeout，允许并行。

找不到技能时应抛出：

```json
{
  "code": "skill_not_found",
  "message": "技能不存在: xxx。可用: sql_review",
  "retryable": false
}
```

这样调试页能正确显示失败，而不是把“不存在”标记为成功。

### 18.2 后续内置工具

- `run_skill`：后续由 Sandbox Executor 执行；
- `call_agent`：后续由 Agent Executor 回调网关；
- 两者不在一期注册，不能用占位成功文本欺骗模型。

## 19. MCP 兼容设计

### 19.1 一期只保留什么

- `ToolKind` 预留 `mcp`；
- `McpToolDefinition` 预留 `serverRef/remoteToolName`；
- Registry 支持未来注册 `McpToolExecutor`；
- 未注册时统一报 `tool_kind_not_enabled`；
- PiToolAdapter 和 ToolBus 接口不因 MCP 改动。

### 19.2 后续 MCP Executor 内部结构

```text
McpToolExecutor
    │
    ├── McpConnectionManager
    │     ├── initialize
    │     ├── session cache
    │     ├── keepalive
    │     └── reconnect / close
    │
    ├── tools/list cache
    └── tools/call
```

MCP 与 HTTP 只统一上层调用语义，不强行统一底层生命周期。MCP 的连接、能力协商和工具发现必须封装在 MCP Executor/ConnectionManager 内，不能进入 Pi Loop。

### 19.3 正式开放 MCP 前必须另行定稿

- MCP Server 凭证由谁解析和下发；
- Worker 是否长期持有连接；
- `tools/list` 是注册时发现还是运行时发现；
- schema 变更与缓存失效；
- stdio、SSE、Streamable HTTP 支持范围；
- 多租户连接隔离；
- MCP 错误到 ToolBus 错误码的映射；
- MCP Server 不可用时的熔断和重连。

这些问题不进入一期编码。

## 20. 事件和可观测性

### 20.1 ToolBus 内部事件

```ts
export type ToolBusEvent =
  | { type: "start"; runId: string; toolCallId: string; toolName: string; kind: ToolKind; attempt: number }
  | { type: "retry"; runId: string; toolCallId: string; toolName: string; code: string; nextAttempt: number }
  | { type: "success"; runId: string; toolCallId: string; toolName: string; durationMs: number; truncated: boolean }
  | { type: "failure"; runId: string; toolCallId: string; toolName: string; code: string; durationMs: number }
  | { type: "canceled"; runId: string; toolCallId: string; toolName: string; durationMs: number };
```

一期 `ToolBusEventSink` 只写结构化日志或使用测试内存 Sink，不落库、不发 MQ。

禁止记录：

- 模型 API Key；
- 智能体 token；
- 完整工具参数中的敏感字段；
- Extra 返回的完整大结果。

### 20.2 对外 SSE 事件

对外仍使用现有 Pi 事件映射：

```json
{"agent_event":{"type":"step","tool":"sql_query","status":"start"}}
{"agent_event":{"type":"step","tool":"sql_query","status":"ok"}}
{"agent_event":{"type":"step","tool":"sql_query","status":"fail"}}
```

ToolBus 不自行写 SSE，避免重复事件；`src/openai.ts` 根据 Pi `tool_execution_start/end` 输出。

Pi 事件表示一次逻辑 ToolBus 调用：内部第一次 attempt 失败、自动重试后成功时，对外仍是一组 `start → ok`；每次 attempt 和 retry 只进入 ToolBus 内部事件与日志。只有最终失败才输出 `start → fail`。

一期不扩展前端必需字段。内部日志可包含 code、attempt、durationMs。

## 21. 配置

建议集中解析成 `ToolBusConfig`：

| 环境变量 | 默认值 | 含义 |
|---|---:|---|
| `TOOLBUS_DEFAULT_TIMEOUT_MS` | 30000 | 一次逻辑调用总 deadline |
| `TOOLBUS_MAX_ATTEMPTS` | 2 | 无副作用工具最大尝试次数 |
| `TOOLBUS_RETRY_BASE_DELAY_MS` | 200 | 重试基础退避 |
| `TOOLBUS_MAX_RESULT_BYTES` | 32768 | 模型可见结果最大字节数 |

兼容当前 `MAX_RESULT_BYTES` 一个版本周期，若新变量未配置可回退读取旧变量，并在日志提示迁移。禁止让每个 Executor 自行读取不同环境变量。

## 22. 建议代码结构

```text
src/
├── server.ts
├── loop.ts
├── openai.ts
└── toolbus/
    ├── index.ts
    ├── types.ts
    ├── errors.ts
    ├── config.ts
    ├── normalize.ts
    ├── registry.ts
    ├── tool-bus.ts
    ├── pi-tool-adapter.ts
    ├── events.ts
    ├── policies/
    │   ├── permission.ts
    │   ├── retry.ts
    │   ├── idempotency.ts
    │   ├── deadline.ts
    │   └── result-limit.ts
    └── executors/
        ├── http.ts
        └── builtin.ts

test/
├── toolbus/
│   ├── normalize.test.ts
│   ├── tool-bus.test.ts
│   ├── http-executor.test.ts
│   ├── pi-tool-adapter.test.ts
│   └── result-limit.test.ts
├── contract/
│   └── extra-invoke.contract.test.ts
└── fixtures/
    ├── extra-success.json
    └── extra-errors.json
```

一期不创建空的 `mcp.ts` 假实现；用类型和未注册错误表达扩展点即可。正式开发 MCP 时再新增文件。

## 23. HTTP 调用时序

```text
模型            Pi Agent Loop       PiToolAdapter       ToolBus        HTTP Executor       Extra
 │ tool_call          │                   │                 │                 │                │
 ├───────────────────>│                   │                 │                 │                │
 │                    │ execute(id,args,signal)             │                 │                │
 │                    ├──────────────────>│                 │                 │                │
 │                    │                   │ execute(request)│                 │                │
 │                    │                   ├────────────────>│                 │                │
 │                    │                   │                 │ validate/policy │                │
 │                    │                   │                 ├────────────────>│                │
 │                    │                   │                 │                 │ POST /invoke   │
 │                    │                   │                 │                 ├───────────────>│
 │                    │                   │                 │                 │<───────────────┤
 │                    │                   │                 │ decode/retry    │                │
 │                    │                   │<────────────────┤                 │                │
 │                    │<──────────────────┤ success or throw│                 │                │
 │<───────────────────┤ toolResult(isError)                │                 │                │
```

## 24. 典型场景

### 24.1 sql_query 成功

1. Pi 调用 `sql_query`；
2. ToolBus 校验无副作用，允许并行；
3. HTTP Executor POST Extra；
4. Extra 返回 `ok:true`；
5. ToolBus 序列化、按字节限制结果；
6. Pi 收到正常 result，SSE 输出 `status=ok`；
7. 模型基于查询结果继续下一轮。

### 24.2 Extra 业务拒绝

Extra 返回：

```json
{"ok":false,"error":{"code":"readonly_only","message":"只允许 SELECT","retryable":false}}
```

ToolBus 不重试，抛 `ToolBusError`。Pi 生成 `isError=true` 的 Tool Result，模型看到完整错误 JSON，页面显示 `fail`，模型应改用单条 `SELECT`；查询表结构时使用 `information_schema`。

### 24.3 TiDB 暂时不可用

Extra 返回 `tidb_unavailable/retryable=true`：

- `sql_query.sideEffect=false`，ToolBus 在剩余 deadline 内重试一次；
- 发出 retry 内部事件；
- 第二次成功则页面最终显示成功；
- 第二次仍失败则 Pi/SSE 显示失败，模型看到最后一次错误。

### 24.4 客户端断连

- 断连信号传入 ToolBus；
- 正在进行的 fetch 立即取消；
- 不重试；
- 记录 canceled 事件；
- Worker 结束该 run，不继续下一轮模型调用。

### 24.5 误下发 MCP

- Normalizer 识别 `type=mcp`；
- 一期直接报 `tool_kind_not_enabled`；
- 不生成返回“通道尚未接通”的假成功 Tool；
- 通过日志定位 Backend 配置越界。

## 25. 测试设计

### 25.1 单元测试

至少覆盖：

- HTTP spec 正常标准化；
- endpoint 非绝对 URL、Schema 缺失、sideEffect 缺失；
- Registry 找不到执行器；
- readonly 拦截副作用工具；
- ask 模式未批准；
- 同一 call 多 attempt 幂等键一致；
- 不同 run/call 幂等键不同；
- 无副作用 retryable 错误只重试一次；
- 副作用工具不重试；
- canceled 不重试；
- parent signal 能终止 fetch 和退避；
- deadline 是总预算；
- UTF-8 中文/emoji 截断不超过 32 KiB；
- PiAdapter 传递 toolCallId/signal；
- ToolBusError 使 Pi 事件 `isError=true`；
- `read_skill` 成功与 skill_not_found。

### 25.2 HTTP Executor 测试

使用本地临时 HTTP Server，不依赖真实 Extra：

- 200 + `ok:true`；
- 200 + `ok:false`；
- 500 + 合法错误 envelope；
- 502/503/504；
- 200 + HTML；
- JSON 缺 `ok`；
- `ok=false` 缺 error 字段；
- 响应延迟导致 timeout；
- 请求过程中取消；
- 验证 body 只有 `arguments`；
- 验证副作用工具幂等头。

### 25.3 Worker—Extra 契约测试

在 Extra 可用时运行真实契约用例：

| 用例 | 期望 |
|---|---|
| `sql_query` 单条 SELECT | `ok:true`，ToolBus success |
| `sql_query` SHOW/DESCRIBE/EXPLAIN | `readonly_only`，Pi `isError=true` |
| `sql_query` ALTER | `readonly_only`，Pi `isError=true` |
| `web_search` 正常 query | `ok:true` |
| `web_search` 空 query | `empty_query`，不重试 |
| 不存在工具 | `tool_not_found` |
| 参数不符合 Schema | `schema_invalid` |
| Extra 停止 | `connection_failed` |
| Extra 延迟并取消 | fetch 终止，无第二次执行 |

### 25.4 端到端测试

一期验收例：

```text
ALTER TABLE ads_daily DROP COLUMN conversions
```

必须看到：

1. 模型先调用 `read_skill(sql_review)`；
2. 模型调用 `sql_query` 获取表和字段事实；
3. 需要时调用 `web_search`；
4. 工具事件 start/ok/fail 与真实结果一致；
5. 最终输出【风险等级】【依据】【建议】；
6. 任一 Extra `ok:false` 不会在页面显示成成功；
7. 断开页面连接会取消正在执行的工具。

## 26. 性能和资源约束

- ToolBus 本身无状态，不跨请求保存会话；
- Registry 和 Executor 可在 Worker 启动时创建并复用；
- 每个 run 的 context、deadline、idempotency key 只在内存存在；
- HTTP Executor 使用 Node 全局 fetch/连接池；
- 不把整个大结果复制多份，截断实现需控制临时内存；
- Worker 并发上限仍由 `server.ts` 管理；
- ToolBus 不改变 `/healthz` 的 running/capacity 语义。

## 27. 安全约束

- endpoint 仅允许 `http/https`；
- 不把 URL 中的 userinfo、API Key、智能体 token 写日志；
- Extra 仅部署内网，不暴露公网；
- Worker 信任 Backend 下发的快照，但仍做结构校验；
- 工具参数日志默认只记录字段名和字节数；
- 幂等键不包含明文参数；
- 一期不扩大为完整 SSRF 防护，正式多租户上线前需增加目标网段白名单。

## 28. 与其他成员的边界

### 28.1 观山

- ToolBus 详细设计和代码实现；
- HTTP/Builtin Executor；
- PiToolAdapter 和 `loop.ts` 工具构建迁移；
- Worker 侧错误、取消、重试、幂等、截断；
- 单元测试、契约测试和全链路工具问题定位；
- 与众安共同维护 Worker—Extra 协议。

### 28.2 众安

- Extra `/invoke/{name}` 和固定 envelope；
- Extra 错误码、`retryable` 准确性；
- Extra 30 秒超时；
- 副作用工具的幂等缓存；
- `sql_query/web_search` 实现；
- Extra 内部 sandbox 分流。

### 28.3 玄策

- Worker HTTP/SSE 薄壳和 Pi Loop 总体控制；
- Gateway—Worker 快照协议；
- `runId` 传入 `buildRun` 的 Review；
- Agent Loop 预算、审批整体流程；
- Pi 版本升级决策。

### 28.4 Backend/Web/部署

- Backend 保证 `toolSpecs` 完整、endpoint 为绝对 URL；
- Web 只消费网关 SSE，不直接调用 Extra；
- 部署保证 Worker 能绕代理访问 Extra；
- ToolBus 不承担 CORS、反向代理和服务常驻。

## 29. 兼容和迁移策略

迁移应采用小步方式：

1. 先建立 ToolBus 类型、Registry 和测试，不接 Loop；
2. 实现 HTTP Executor，与当前 Extra 契约对拍；
3. 用 PiToolAdapter 替换 `buildHttpTool()`；
4. 再迁移 `read_skill`；
5. 删除 MCP/`run_skill`/`call_agent` 的占位成功实现；
6. 保持快照和 SSE 格式不变；
7. 更新 `PROTOCOL.md`、README 和示例；
8. 完成四服务回归后合并。

迁移期间不保留两套 HTTP 执行路径，避免行为分叉。

## 30. 完成定义

ToolBus 一期设计完成并可交付，必须同时满足：

- `loop.ts` 不再包含 HTTP fetch 和 Extra envelope 解析；
- 所有 Pi 工具通过统一适配器构造；
- HTTP Tool 使用 ToolBus 执行且协议与众安文档一致；
- `ok:false` 对模型可见并在 SSE 标记 fail；
- 取消能传到正在执行的 fetch；
- 重试、幂等、截断符合本文规则；
- MCP 本期不会被误执行或伪装成功；
- `npm test` 可执行且通过；
- Worker—Extra 契约测试通过；
- 一期 SQL 审查演示全链路通过；
- Work 与 Extra 对接文档描述一致。

## 31. 一句话原则

> ToolBus 统一的是“工具调用的语义和治理”，不是把 HTTP、MCP、沙箱的底层实现强行写成一种协议。
