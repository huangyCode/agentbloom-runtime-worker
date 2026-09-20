# HTTP 工具协议（Tool Protocol v1）

worker 与工具服务之间的**唯一线协议**。任何语言实现本文两个端点，即可把
自己的能力注册为工具；worker 侧的治理（超时/重试/幂等/截断/错误反馈）自动生效，
工具实现方一行不用写。参考实现：[`examples/tool-server.mjs`](../examples/tool-server.mjs)（约 80 行，零依赖）。

进程内接入（本地函数 / gRPC / 自定义通道）不走本协议，走插件插槽的
`ToolExecutor` 接口，见 [PLUGIN.md](./PLUGIN.md)。

## 1. 端点

### `GET /tools` — 工具清单（注册/导入用）

```json
{ "items": [ {
    "name": "calc",
    "description": "计算一个四则运算表达式，支持 + - * / ( ) 与小数。",
    "inputSchema": { "type": "object", "properties": { "expression": { "type": "string" } }, "required": ["expression"] },
    "sideEffect": false
} ] }
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | ✓ | `[A-Za-z0-9_-]+`，全服务内唯一，就是 `/invoke/{name}` 的 name |
| `description` | ✓ | **写"什么时候用"**——它是模型选择工具的唯一依据，质量直接决定调用准确率 |
| `inputSchema` | ✓ | JSON Schema（object 型）。worker 在调用前按它校验参数，非法参数不会到达你的服务 |
| `sideEffect` | ✓ | 是否修改外部数据。`true` 的工具：不自动重试、调用带幂等键、可被审批/只读模式拦截 |

### `POST /invoke/{name}` — 统一调用入口

**请求**：

```
Content-Type: application/json
X-Trace-Id: <一次运行的追踪ID,原样打日志即可>
X-Idempotency-Key: <仅 sideEffect:true 时携带,见 §3>

{ "arguments": { "expression": "(31000+29500+33000)/3" } }
```

**响应**：HTTP 状态码**恒为 200**（服务自身崩溃除外），业务成败放信封里：

```json
{ "ok": true,  "result": <任意可 JSON 序列化的值> }
{ "ok": false, "error": { "code": "sql_error", "message": "Unknown column 'ctiy'", "retryable": false } }
```

## 2. 错误契约

| 字段 | 语义 |
|---|---|
| `code` | 机器可读短码（snake_case）。自定义随意，但见下表保留码 |
| `message` | **写给模型看的**。模型会读着它自我修正（改参数重试、换工具），所以要具体：说清错在哪、期望什么，别只写 "error" |
| `retryable` | 唯一驱动 worker 自动重试的开关：`true` 且工具无副作用 → worker 原参重试（默认最多 2 次，指数退避）。参数错这类重试也没用的场景**必须** `false` |

保留错误码（worker/参考实现已使用，语义请保持一致）：

| code | 含义 | retryable 建议 |
|---|---|---|
| `tool_not_found` | name 不存在 | false |
| `invalid_json` / `schema_invalid` | 请求体/参数不合法 | false |
| `timeout` | 工具自身执行超时 | true |
| `internal` | 实现未捕获异常 | true |

失败不是异常路径的终点：worker 把整个 error 对象包装成结构化文本喂回模型，
模型看着 `message` 决定下一步——**一条好的错误信息等于一次免费的自我修复**。

## 3. 副作用与幂等（sideEffect:true 必读）

- worker 对副作用工具**绝不自动重试**，每次调用附带
  `X-Idempotency-Key`（内容为 `idem_` + sha256(runId:toolCallId) 前 32 位，同一逻辑调用重放时键不变）；
- **按键去重是工具服务的责任**：见过的键直接返回上次的成功结果，别再执行。
  这是断点恢复后安全重放的前提——键存内存重启即失，生产建议落 Redis 并设
  TTL（参考 24h）；
- 只对**成功**结果做幂等缓存；失败结果不缓存（调用方可能修复环境后用同键重试）。

## 4. 时序与体积预期

| 约束 | 值（worker 默认） | 说明 |
|---|---|---|
| 单次逻辑调用总 deadline | 30s（`TOOLBUS_DEFAULT_TIMEOUT_MS`） | 含重试在内共享一个钟；长任务请改造成"提交+查询"两个工具 |
| 结果体积 | 32KB（UTF-8 字节，`TOOLBUS_MAX_RESULT_BYTES`） | 超出被截断并打标；大结果返回摘要+可再查询的引用,别硬塞全文 |
| 并发 | 无协议级约束 | worker 可能并行调用同服务的多个工具（模型一轮多调用） |

## 5. 合规自检清单

- [ ] `GET /tools` 返回全部工具，字段齐全，`description` 写的是"什么时候用"
- [ ] `POST /invoke/{name}` 对未知 name 返回 `tool_not_found` 信封（而不是 404 裸文本）
- [ ] 一切业务失败都走 `{ok:false, error}` 信封，HTTP 200
- [ ] `retryable` 语义诚实：参数错/权限错 false，网络抖动/超时 true
- [ ] `message` 对模型友好：具体、含期望值、可指导修正
- [ ] 副作用工具实现了按 `X-Idempotency-Key` 去重，且只缓存成功结果
- [ ] 30s 内返回；返回体控制在 32KB 内
- [ ] 凭证（数据库密码等）只存在于工具服务自己的配置，绝不出现在 manifest、结果或错误信息里

## 6. 版本

本文为 v1。信封结构（`ok/result/error{code,message,retryable}`）与两个端点路径是
稳定承诺；新增能力只做**加字段**式演进，不破坏既有实现。
