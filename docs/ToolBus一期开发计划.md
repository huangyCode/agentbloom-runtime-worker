# 观山一期 ToolBus 开发计划

> 计划版本：v1.0  
> 负责人：观山  
> 计划周期：10 个工作日（以一期整体联调节奏为准）  
> 设计依据：[`ToolBus一期详细设计.md`](./ToolBus一期详细设计.md)
> 更新时间：2026-08-25
> 实施状态：Worker 侧代码、类型检查、单元测试和本地 Extra 契约测试已完成；真实四服务验收等待其他仓库提供可运行服务

## 1. 本期任务结论

观山本期主责是 `agent-platform-work` 内部工具执行通道。统一抽象正式命名为 **ToolBus**。

本期必须交付：

1. ToolBus 核心类型、错误、Registry 和执行门面；
2. HTTP Tool Executor，对接众安 Extra；
3. Pi Tool Adapter，使 Pi Agent Loop 统一调用 ToolBus；
4. `read_skill` 内置工具接入 ToolBus；
5. 超时、取消、重试、幂等、权限、顺序和 UTF-8 截断；
6. 单元测试、Worker—Extra 契约测试、四服务联调；
7. Worker/Extra 两侧协议文档对齐。

本期不实现 MCP。只保证未来新增 MCP Executor 时不修改 Pi Loop 和 ToolBus 主接口。

## 2. 交付物

| 编号 | 交付物 | 仓库/位置 | 验收方式 |
|---|---|---|---|
| D-01 | ToolBus 详细设计 | `docs/观山一期ToolBus详细设计.md` | 观山/众安/玄策评审 |
| D-02 | ToolBus 核心实现 | `src/toolbus/` | 单测、类型检查 |
| D-03 | HTTP Executor | `src/toolbus/executors/http.ts` | HTTP 测试、Extra 契约测试 |
| D-04 | Builtin Executor | `src/toolbus/executors/builtin.ts` | read_skill 测试 |
| D-05 | Pi Tool Adapter | `src/toolbus/pi-tool-adapter.ts` | Pi 事件测试 |
| D-06 | Loop/Server 接线 | `src/loop.ts`、`src/server.ts` | 真实模型与断连测试 |
| D-07 | 自动化测试 | `test/` | `npm test` 全绿 |
| D-08 | 对接协议更新 | `PROTOCOL.md`、`README.md` | 与众安文档逐项对拍 |
| D-09 | 联调记录 | `docs/ToolBus一期联调记录.md` | 记录环境、用例、结果、问题 |
| D-10 | 验收报告 | 合并到联调记录末尾 | SQL 审查完整演示 |

## 3. 开发范围

### 3.1 P0：一期主链路必须完成

- ToolBus 核心接口和错误模型；
- HTTP Executor；
- Extra envelope 校验；
- Pi Tool Adapter；
- 取消和 30 秒总 deadline；
- 安全重试；
- 稳定幂等键；
- 32 KiB UTF-8 截断；
- 业务失败正确映射为 Pi `isError=true`；
- read_skill 接入；
- 单元测试、契约测试、端到端验收。

### 3.2 P1：不阻塞主链路但建议一期完成

- ToolBus 结构化日志 EventSink；
- `npm run typecheck`；
- 配置集中化与旧环境变量兼容；
- README/PROTOCOL 详细同步；
- 测试覆盖率报告；
- endpoint 基础安全校验。

### 3.3 明确不做

- MCP 真实连接；
- `run_skill`；
- `call_agent`；
- 文件页和大结果落盘；
- MQ 和监控事件落库；
- Extra 沙箱实现；
- Backend/Web 业务代码代开发。

## 4. 协作边界

### 4.1 RACI

| 事项 | 观山 | 众安 | 玄策 | Backend | Web/部署 |
|---|---|---|---|---|---|
| ToolBus 接口设计 | A/R | C | C | I | I |
| HTTP Executor | A/R | C | C | I | I |
| Extra `/invoke` | C | A/R | I | I | I |
| Extra error/retryable | C | A/R | I | I | I |
| Pi Tool Adapter | A/R | I | C | I | I |
| Worker Loop/SSE 总体 | C | I | A/R | C | C |
| Gateway 快照 | I | I | C | A/R | I |
| 断连全链路 | R | I | R | R | C |
| 调试页 step 展示 | C | I | C | C | A/R |
| 四服务部署 | C | C | C | C | A/R |
| Worker—Extra 契约测试 | A/R | R | I | I | I |

说明：A=最终负责，R=执行，C=协作评审，I=知会。

### 4.2 观山与众安的接口边界

观山负责到 HTTP 客户端边界：

- 构造 `POST /invoke/{name}`；
- 发送 `{arguments}`；
- 发送幂等键；
- 处理 deadline、取消和重试；
- 校验 HTTP 和 JSON envelope；
- 将 Extra 错误转换成 Pi Tool Error。

众安负责 HTTP 服务端边界：

- endpoint 和工具路由存在；
- `ok/result/error` 格式稳定；
- `error.code/message/retryable` 准确；
- Extra 内部超时和幂等缓存；
- sql_query/web_search 真实可执行；
- sandbox 分流对调用方透明。

双方共同负责：

- 冻结协议样例；
- 错误码对拍；
- 超时和重试场景；
- 幂等行为；
- 契约测试通过；
- Work/Extra 文档一致。

### 4.3 观山与玄策的代码边界

观山可修改：

- `src/toolbus/**`；
- `src/loop.ts` 中工具构造和 ToolBus 接线；
- `src/server.ts` 中把 `runId/traceId` 传给 `buildRun` 的最小改动；
- ToolBus 相关测试和文档。

以下内容需要玄策 Review：

- `agentLoop` config；
- `beforeToolCall/afterToolCall`；
- SSE 事件映射；
- `maxRounds`、token/时间预算；
- Worker HTTP 生命周期和并发控制。

观山不应在 ToolBus MR 中顺带重写 Worker Server 或 Gateway 快照逻辑。

## 5. 开工前必须冻结的协议

### 5.1 Worker → Extra 请求

```http
POST <toolSpecs.endpoint>
Content-Type: application/json
X-Idempotency-Key: idem_xxx  # sideEffect=true
```

```json
{"arguments":{}}
```

### 5.2 Extra → Worker 响应

```json
{"ok":true,"result":{}}
```

```json
{"ok":false,"error":{"code":"...","message":"...","retryable":false}}
```

### 5.3 待共同确认清单

在进入 HTTP Executor 合并前，观山和众安逐项确认：

- [ ] Extra 所有响应是否设置 JSON Content-Type；
- [ ] HTTP 500 是否始终返回合法 `ok:false` envelope；
- [ ] Extra 是否会返回 400/404/502/503/504；
- [ ] `result` 是否允许 null、string、number、array；
- [ ] `error.details` 是否可能存在，Worker是否原样保留；
- [ ] `X-Idempotency-Key` 是否校验格式；
- [ ] 幂等缓存只缓存成功还是也缓存确定性业务失败；
- [ ] Extra 断开客户端连接后能否停止内部 handler；
- [ ] `INVOKE_TIMEOUT_S=30` 是否包含沙箱拉起时间；
- [x] sql_query 范围以 Extra 为准：仅支持单条 SELECT；表结构通过 information_schema 查询。

如果众安实现与当前对接文档不一致，先改文档或实现再联调，不能让 Worker 用猜测兼容多个版本。

## 6. 工作分解

## TB-01：协议冻结与基线测试

**优先级：P0　预计：0.5 人日　依赖：众安可沟通**

### 工作内容

1. 将众安《对接文档》的 `/invoke` 请求、响应、超时、错误码整理为契约用例；
2. 确认 Worker endpoint 使用快照绝对 URL；
3. 对拍 `sql_query`、`web_search` 正常和失败响应；
4. 确认 `ok:false` 必须映射为 Pi `isError=true`；
5. 冻结默认 30 秒、32 KiB、最大 2 attempts；
6. 在联调记录中写明 Extra 版本/commit 和环境地址。

### 输出

- 协议评审结论；
- Extra 响应 fixture；
- 待确认项关闭记录。

### 验收

- 观山和众安对相同请求给出相同预期；
- 协议中没有“实现后再说”的关键字段；
- 正常/业务失败/实现失败至少各有一个 JSON 样例。

## TB-02：工程测试和类型检查基线

**优先级：P0　预计：0.5 人日　依赖：无**

### 工作内容

1. 把当前固定失败的 `npm test` 替换成真实测试命令；
2. 使用 Node 24 `node:test`，避免引入大型测试框架；
3. 增加 `npm run typecheck`；
4. 增加 TypeScript 和 Node 类型开发依赖；
5. 增加固定版本的 TypeBox Compiler 作为 JSON Schema 运行时校验依赖；
6. 将 Pi 依赖从 `^0.84.2` 钉死为 `0.84.2`，与 README 版本纪律一致；
7. 建立 `test/fixtures` 和测试辅助 HTTP Server。

### 建议脚本

```json
{
  "scripts": {
    "test": "node --test test/**/*.test.ts",
    "typecheck": "tsc --noEmit"
  }
}
```

实际 glob 是否由 Node 直接展开需在当前 shell/CI 验证；必要时改为 Node 支持的目录参数，不依赖 zsh 特性。

### 验收

- 空测试基线也能稳定退出 0；
- 新增失败用例时 `npm test` 能退出非 0；
- `npm run typecheck` 可执行；
- 不升级 Pi Agent Core。

## TB-03：ToolBus 类型、错误和配置

**优先级：P0　预计：0.75 人日　依赖：TB-02**

### 工作内容

1. 建立 `src/toolbus/types.ts`；
2. 定义 ToolDefinition 判别联合；
3. 定义 ToolCallContext、ToolBusRequest、ToolBusResult；
4. 建立 `ToolBusError` 和 ToolErrorData；
5. 建立集中配置解析；
6. 实现外部 ToolSpec → 内部定义的 Normalizer；
7. 使用 `typebox/compile` 在工具装配时编译并缓存参数 validator；
8. 校验 name、schema、sideEffect、endpoint；
9. 一期 MCP 返回 `tool_kind_not_enabled`。

### 测试

- 合法 HTTP spec；
- 缺 endpoint；
- endpoint 非绝对地址或非法协议；
- 缺 sideEffect；
- inputSchema 非对象；
- type=mcp；
- 错误序列化不泄漏 token/endpoint credentials。

### 验收

- `loop.ts` 不再定义重复 ToolSpec 类型；
- 所有错误有 code/message/retryable/source/phase；
- 外部快照格式没有变化。

## TB-04：Registry 和 DefaultToolBus

**优先级：P0　预计：1 人日　依赖：TB-03**

### 工作内容

1. 实现 ToolExecutorRegistry；
2. 实现 DefaultToolBus 执行流程；
3. 接入定义和参数检查；
4. 接入 permission 二次校验；
5. 生成 deadline 和组合 signal；
6. 注入 clock、eventSink、keyFactory 便于测试；
7. 统一捕获未知异常为 internal；
8. 保证 canceled 不被转换成 timeout。

### 测试

- Registry 注册、重复注册、未找到；
- readonly/ask/auto；
- parent signal 先触发；
- deadline 先触发；
- 参数不符合 JSON Schema；
- 未知错误归一化；
- 事件 start/success/failure/canceled 顺序。

### 验收

- ToolBus 不依赖 Pi 类型；
- ToolBus 不依赖真实 Extra；
- 单测可以注入 Fake Executor 跑完所有分支。

## TB-05：HTTP Tool Executor

**优先级：P0　预计：1 人日　依赖：TB-01、TB-04**

### 工作内容

1. 实现 Extra POST 请求；
2. body 固定为 `{arguments}`；
3. 有副作用时发送幂等键；
4. 传递 `X-Trace-Id`；
5. 使用 ToolBus 组合 signal；
6. 校验 HTTP 状态、JSON 和 envelope；
7. `ok=true` 序列化 result；
8. `ok=false` 保留 Extra error code/message/retryable；
9. 网络错误和协议错误准确分类；
10. 禁止把错误变成普通成功 content。

### 测试矩阵

| 用例 | 预期 |
|---|---|
| 200 + ok true object | 成功 JSON 文本 |
| 200 + ok true string | 成功原字符串 |
| 200 + ok true null | 成功 `null` |
| 200 + ok false | 抛 Extra code ToolBusError |
| 500 + ok false | 按 envelope 处理 |
| 500 + ok true | invalid_response |
| 502/503/504 | retryable HTTP 错误 |
| 404 | unexpected_http_status，不重试 |
| HTML | invalid_response |
| 空 body | invalid_response |
| 字段类型错误 | invalid_response |
| 延迟响应 | timeout/canceled 正确区分 |

### 验收

- HTTP Executor 不包含重试循环；
- HTTP Executor 不读取全局环境变量；
- 对接众安样例全部通过。

## TB-06：重试、幂等和结果策略

**优先级：P0　预计：1 人日　依赖：TB-04、TB-05**

### 工作内容

1. 实现最大 2 attempts；
2. 仅无副作用且 retryable 才重试；
3. 重试共享总 deadline；
4. 实现可取消退避；
5. 实现 `runId+toolCallId` 派生幂等键；
6. 所有 attempt 复用幂等键；
7. 实现 UTF-8 字节截断；
8. details 记录 attempt/duration/truncated/originalBytes；
9. 兼容旧 `MAX_RESULT_BYTES` 环境变量。

### 测试

- 第一次失败第二次成功；
- 两次失败返回最后错误；
- retryable=false 不重试；
- sideEffect=true 不重试；
- 退避期间取消；
- 剩余 deadline 不足不重试；
- 同一调用 Key 稳定、不同调用 Key 不同；
- 中文、emoji、混合字符严格不超过上限；
- 截断标记计入上限。

### 验收

- 没有一次逻辑调用超过总 30 秒；
- 没有副作用工具自动重试；
- 截断后文本仍是合法 UTF-8。

## TB-07：Pi Tool Adapter

**优先级：P0　预计：0.75 人日　依赖：TB-04、TB-06**

### 工作内容

1. 实现 `toPiTool()`；
2. 传入 Pi toolCallId；
3. 透传 Pi AbortSignal；
4. 映射 name/label/description/parameters；
5. sideEffect 工具设置 sequential；
6. ToolBusError 直接抛给 Pi；
7. 验证 Pi 产生正确 `isError`；
8. 不在 Adapter 里写 HTTP 逻辑。

### 关键测试

使用 Pi Agent Core 的工具执行路径或最小 Fake Stream：

- ToolBus 成功 → `tool_execution_end.isError=false`；
- Extra `ok:false` → `tool_execution_end.isError=true`；
- 模型可见错误文本是 Extra error JSON；
- `src/openai.ts` 输出 `status=ok/fail` 正确；
- signal 和 toolCallId 未丢失。

### 验收

- Pi Loop 对所有工具只使用统一 Adapter；
- 页面工具状态不再把失败显示为成功。

## TB-08：迁移 loop.ts 和 server.ts

**优先级：P0　预计：1 人日　依赖：TB-07　协作：玄策 Review**

### 工作内容

1. 从 `loop.ts` 删除 `buildHttpTool()`；
2. 删除 HTTP fetch、随机 UUID 和截断实现；
3. 创建/注入 ToolBus 和执行器；
4. 将快照工具标准化后交给 PiToolAdapter；
5. 迁移 read_skill 到 Builtin Executor；
6. 对 run_skill/call_agent 一期不注册；
7. type=mcp 明确失败，不创建占位成功工具；
8. `server.ts` 把 chat completion ID 作为 runId 传给 buildRun；
9. 保持 `/v1/chat/completions`、`/healthz` 和 SSE 格式不变；
10. 保持 systemPrompt、model、context transform 行为不变。

### 回归检查

- 纯聊天仍能流式输出；
- 无 toolSpecs 时正常；
- 有 skills 时生成 read_skill；
- readonly 过滤副作用工具；
- tool_execution 事件仍由 Pi 输出；
- 客户端断连能取消当前 run；
- 并发上限行为不变。

### 验收

- `loop.ts` 只负责快照到 Loop 配置和工具装配；
- ToolBus 改动不影响模型连接和 SSE 文本帧；
- 玄策完成 Review。

## TB-09：Builtin read_skill

**优先级：P0　预计：0.5 人日　依赖：TB-08**

### 工作内容

1. 建立 BuiltinToolExecutor；
2. 从当前 run 快照读取绑定技能正文；
3. 只允许读取快照中的技能；
4. 找不到技能时抛 `skill_not_found`；
5. 不访问 Gateway、Extra 或数据库；
6. 与 HTTP Tool 共用 PiToolAdapter 和事件语义。

### 测试

- 一个技能正常读取；
- 多技能按 name 精确读取；
- 未绑定技能拒绝；
- 空 skills 不注入 read_skill；
- 大技能正文走统一结果大小治理。

### 验收

- 一期演示中模型能读取 sql_review；
- 技能不存在时页面显示 fail；
- read_skill 不产生网络请求。

## TB-10：Worker—Extra 契约测试

**优先级：P0　预计：0.75 人日　依赖：TB-05～TB-09　协作：众安**

### 工作内容

1. 设计可通过环境变量启用的集成测试；
2. 测试 Extra `/healthz`；
3. 测试 `sql_query` 单条 SELECT 成功，并验证 SHOW/DDL 返回 `readonly_only`；
4. 测试 ALTER 的 readonly_only；
5. 测试 web_search 正常和空 query；
6. 测试不存在工具；
7. 测试 Extra 停止/不可达；
8. 能控制 Extra 延迟时测试 timeout/cancel；
9. 将实际响应与 fixture 对拍。

### 运行建议

```bash
EXTRA_URL=http://127.0.0.1:8200 npm run test:contract
```

默认 `npm test` 不依赖联调机，契约测试单独运行，避免离线开发全部失败。

### 验收

- 众安文档中所有一期错误 envelope 能被 Worker 正确识别；
- Extra 业务错误不会变成 success；
- 联调结果记录 Extra commit、Worker commit 和环境地址。

## TB-11：四服务端到端联调

**优先级：P0　预计：1 人日　依赖：Backend/Extra/Web/部署可用**

### 环境前置

- Backend `:8080`；
- Worker `:8100` 或统一部署端口；
- Extra `:8200`；
- Web 构建产物；
- 三服务互访绕开代理；
- 演示模型、工具、技能、智能体种子数据已创建。

### 主验收用例

调试页发送：

```sql
ALTER TABLE ads_daily DROP COLUMN conversions
```

验证：

1. Gateway 鉴权成功并组装合法快照；
2. Worker 注册 read_skill/sql_query/web_search；
3. 模型调用 read_skill；
4. 模型按技能调用查询和搜索工具；
5. ToolBus 正确调用 Extra；
6. 页面逐步显示 start/ok/fail；
7. 最终报告包含【风险等级】【依据】【建议】；
8. 最终风险符合技能红线；
9. Worker/Extra 日志可通过 runId/toolCallId 对齐；
10. 不出现 API Key/token 明文日志。

### 失败用例

- Extra 停止；
- Extra 返回业务错误；
- 错误 endpoint；
- 参数 schema 不匹配；
- 工具执行超过 deadline；
- 调试页中途停止/关闭；
- Worker 并发满；
- 一期误配 MCP 工具。

### 验收

- 成功和失败状态都与真实执行一致；
- 客户端断连后 Extra 调用被取消；
- 失败信息足够模型纠正，也足够开发人员定位。

## TB-12：文档、清理和交付

**优先级：P0　预计：0.75 人日　依赖：前述任务完成**

### 工作内容

1. 更新 `README.md`，将观山职责改为 ToolBus，而不是仅 MCP；
2. 更新 `PROTOCOL.md` 中工具超时、错误、重试、幂等、截断规则；
3. 更新 `examples/snapshot.json`，只保留一期真实字段；
4. 与众安对接文档逐项核对；
5. 补充本地启动、测试、契约测试命令；
6. 清理已失效 TODO 和占位成功实现；
7. 编写联调记录和验收结论；
8. 在 MR 描述中列出范围外任务和后续 MCP 接入点。

### 验收

- 新成员只看 README/PROTOCOL/ToolBus 文档即可完成调用；
- 文档与代码无已知冲突；
- 所有命令在干净环境中验证；
- MR 无无关改动。

## 7. 10 个工作日安排

### Day 1：协议冻结和测试基线

- 完成 TB-01；
- 完成 TB-02；
- 与众安过一遍 `/invoke`；
- 建立 fixture 和联调记录；
- 提交 MR-1 初稿。

**日终标准：** `npm test/typecheck` 可跑，协议待确认项有负责人和结论时间。

### Day 2：类型、错误和 Registry

- 完成 TB-03；
- 完成 Registry；
- 建立 ToolBus Fake Executor 测试；
- 固化错误码和模型可见 JSON。

**日终标准：** 核心抽象可独立单测，不依赖 Pi 和 Extra。

### Day 3：DefaultToolBus 执行管线

- 完成 TB-04；
- 完成权限、deadline、signal 和事件；
- 验证 canceled/timeout 区分；
- Review ToolBus API 是否足以容纳后续 MCP。

**日终标准：** Fake Executor 下成功/失败/取消全绿。

### Day 4：HTTP Executor

- 完成 TB-05；
- 本地临时 HTTP Server 跑响应矩阵；
- 与众安真实 Extra 对拍成功和业务失败；
- 关闭协议剩余问题。

**日终标准：** `/invoke` 正常和主要错误均能准确分类。

### Day 5：治理策略

- 完成 TB-06；
- 重试、幂等、UTF-8 截断测试；
- 确认 30 秒为总 deadline；
- 提交 MR-2。

**日终标准：** HTTP Executor + ToolBus 在不接 Pi 时可完整运行。

### Day 6：Pi 接线和 Loop 迁移

- 完成 TB-07；
- 开始 TB-08；
- 与玄策 Review runId 和 signal 接线；
- 验证 Pi `isError` 和 SSE `fail`。

**日终标准：** Pi 能通过 ToolBus 调本地 Fake Extra，失败不再显示成功。

### Day 7：read_skill 和真实 Extra 契约测试

- 完成 TB-08；
- 完成 TB-09；
- 完成 TB-10 主体；
- 真实模型跑技能 + 两工具循环。

**日终标准：** Worker + Extra + 模型链路独立跑通。

### Day 8：四服务联调和失败回归

- 完成 TB-11 主链路；
- 与 Backend 对拍快照；
- 与 Web 对拍工具步骤；
- 跑断连、Extra 停止、错误 endpoint 等失败用例；
- 提交 MR-3。

**日终标准：** 调试页能完成真实 SQL 审查并正确展示工具状态。

### Day 9：正式验收和文档收口

- 执行完整验收演示；
- 完成 TB-12；
- Work/Extra 文档最终对拍；
- 固化测试日志和验收证据；
- 处理 Review 意见。

**日终标准：** P0 验收清单全部关闭。

### Day 10：缓冲和交付

- 修复联调遗留问题；
- 全量回归；
- 清理临时代码和调试日志；
- 合并 MR；
- 建立 MCP 后续任务，不在本期继续扩展。

**日终标准：** 代码、测试、文档、联调记录全部进入可维护状态。

## 8. MR 拆分

### MR-1：ToolBus 基础和工程基线

包含：

- package scripts 和类型检查；
- Pi 版本钉死；
- ToolBus types/errors/config/normalize/registry；
- Fake Executor 单元测试；
- 设计文档。

不包含 Loop 行为变化，便于先评审抽象。

### MR-2：HTTP Executor 和执行治理

包含：

- DefaultToolBus；
- HTTP Executor；
- timeout/cancel/retry/idempotency/truncation；
- HTTP 和策略单元测试；
- Worker—Extra fixture。

评审人至少包含众安。

### MR-3：Pi/Loop 接线和端到端

包含：

- PiToolAdapter；
- loop/server 最小接线；
- read_skill Builtin Executor；
- Pi 事件和契约测试；
- README/PROTOCOL/示例/联调记录。

评审人至少包含玄策和众安。

禁止把三个 MR 合成一次大提交，也不要在 ToolBus MR 中混入无关格式化。

## 9. 测试分层和命令目标

| 层级 | 是否依赖外部服务 | 目标命令 | 合并门槛 |
|---|---|---|---|
| 类型检查 | 否 | `npm run typecheck` | 必须通过 |
| 单元测试 | 否 | `npm test` | 必须通过 |
| Extra 契约 | 是 | `npm run test:contract` | 联调环境必须通过 |
| Worker 冒烟 | 模型/可选 Extra | `npm run test:smoke` | 正式验收前通过 |
| 四服务 E2E | 是 | 手工脚本+记录 | 一期验收必须通过 |

### 9.1 单元测试最低覆盖

- ToolBus 正常路径；
- 所有自有错误码分支；
- Extra 成功/业务失败/协议失败；
- retryable + sideEffect 组合；
- timeout/cancel race；
- 幂等键；
- UTF-8 截断；
- Pi success/fail 事件；
- read_skill 白名单。

### 9.2 不允许的测试方式

- 单测依赖真实 `10.x` 联调地址；
- 用长时间 `sleep` 模拟超时；
- 只断言文本包含“失败”而不检查 code/isError；
- 忽略取消后的实际请求是否结束；
- 为通过测试而把 Extra 多种响应都吞成普通文本。

## 10. 阶段门禁

### G0：协议门禁

- Worker—Extra 请求/响应样例冻结；
- 超时、重试、幂等、截断口径一致；
- 观山和众安确认。

未通过 G0，不合并 HTTP Executor。

### G1：核心门禁

- typecheck 通过；
- ToolBus 单测通过；
- HTTP 响应矩阵通过；
- Pi 版本未变化。

未通过 G1，不迁移 Loop。

### G2：接线门禁

- Pi signal/callId 正确传递；
- `ok:false` → `isError=true`；
- SSE fail 正确；
- 玄策 Review 完成。

未通过 G2，不进入四服务验收。

### G3：交付门禁

- Extra 契约测试通过；
- SQL 审查 E2E 通过；
- 断连测试通过；
- 文档对拍完成；
- P0 问题归零。

## 11. 验收清单

### 11.1 架构

- [ ] 工具统一通过 ToolBus；
- [ ] Pi Loop 不包含具体 HTTP/MCP 实现；
- [ ] Executor 可独立替换和测试；
- [ ] 外部快照协议保持兼容；
- [ ] 一期 MCP 明确不启用。

### 11.2 HTTP/Extra

- [ ] 请求 body 为 `{arguments}`；
- [ ] 正确使用绝对 endpoint；
- [ ] `ok:true` 成功；
- [ ] `ok:false` 保留 error 对象并标记失败；
- [ ] HTTP 500 合法 envelope 正确处理；
- [ ] 非 JSON/非法 envelope 不伪装成功；
- [ ] Extra 错误码原样保留。

### 11.3 治理

- [ ] Pi signal 透传到 fetch；
- [ ] 上层取消与 timeout 区分；
- [ ] 总 deadline 为 30 秒；
- [ ] 仅无副作用且 retryable 才重试；
- [ ] 最大 attempts 为 2；
- [ ] 副作用工具串行且不自动重试；
- [ ] 同一次调用幂等键稳定；
- [ ] 结果按 UTF-8 bytes 截断；
- [ ] 敏感信息不写日志。

### 11.4 Pi 和 SSE

- [ ] 所有 Tool 通过 PiToolAdapter；
- [ ] 成功事件 status=ok；
- [ ] 失败事件 status=fail；
- [ ] 模型能看到结构化错误并继续推理；
- [ ] runId/toolCallId 可关联日志；
- [ ] 纯聊天和无工具场景无回归。

### 11.5 技能和端到端

- [ ] read_skill 从快照读取，不访问 Extra；
- [ ] 未绑定技能不可读取；
- [ ] sql_review 能指导模型按步骤执行；
- [ ] sql_query/web_search 真实调用 Extra；
- [ ] 最终报告格式符合技能要求；
- [ ] 页面断开后工具停止执行。

### 11.6 工程质量

- [ ] `npm test` 通过；
- [ ] `npm run typecheck` 通过；
- [ ] 契约测试通过；
- [ ] 文档与代码一致；
- [ ] MR 拆分清晰且 Review 完成；
- [ ] 无无关文件和调试输出。

## 12. 风险和应对

| 风险 | 概率/影响 | 应对 |
|---|---|---|
| Extra 实现与文档不一致 | 中/高 | Day 1 对拍真实响应，fixture 绑定 commit |
| Pi 错误文本被改变 | 中/高 | Pi 0.84.2 钉死，增加模型可见错误和 isError 测试 |
| AbortSignal 只停 Loop 不停 fetch | 中/高 | Adapter 和 HTTP Server 延迟用例验证真实取消 |
| 重试导致总时长翻倍 | 中/中 | 使用总 deadline，不为每次 attempt 重置 30 秒 |
| 副作用重复执行 | 低/高 | 不自动重试、稳定幂等键、默认 sequential |
| 中文截断超过 32 KiB | 中/中 | Buffer byteLength + emoji 测试 |
| ToolBus 设计过度 | 中/中 | 一期只实现显式管线和两个 Executor，不引入插件框架 |
| ToolBus 改动影响 Loop | 中/高 | 三个 MR、小步迁移、玄策 Review、纯聊天回归 |
| MCP 范围膨胀 | 中/中 | 只保留类型和 Registry 扩展点，不创建连接实现 |
| 联调环境不稳定 | 中/高 | 单测不依赖环境；契约测试单独；记录 commit 和地址 |

## 13. 阻塞升级规则

以下问题若当天不能解决，应在日终联调记录中标红并指定决策人：

- Extra envelope 与文档冲突；
- Backend 未下发 endpoint/inputSchema/sideEffect；
- Pi signal 无法到达 execute；
- `ok:false` 无法形成 `isError=true`；
- Extra 无法提供可联调服务；
- Web 将 fail 事件错误显示为成功；
- 部署代理导致 Worker 无法访问 Extra。

观山应先用本地 Fake Extra 继续推进可独立工作，不能因联调环境暂时不可用停止 ToolBus 核心开发。

## 14. 后续 MCP 衔接任务

一期验收后另建 Epic，不混入本期 MR：

1. MCP 快照协议和凭证模型；
2. McpConnectionManager；
3. MCP `tools/list` 和 schema 缓存；
4. McpToolExecutor；
5. MCP 错误映射；
6. 连接复用、取消、重连和熔断；
7. 多租户隔离；
8. MCP 契约与端到端测试。

由于 Pi Loop 已统一调用 ToolBus，后续 MCP 工作只增加 Definition 解析、Executor 和连接管理，不重写 Loop。

## 15. 完成定义

观山一期任务完成必须是一个可运行、可测试、可联调、可维护的结果，而不是只提交接口骨架：

- ToolBus 在 Worker 中成为唯一工具执行入口；
- HTTP/Extra 真实调用通过；
- 错误、取消、重试、幂等、截断符合协议；
- read_skill 和 HTTP Tool 都由 Pi 统一调用；
- 一期完整 SQL 审查流程通过；
- 自动化测试和类型检查通过；
- 对接文档、代码和验收记录一致；
- MCP 扩展点清晰，但一期没有越界实现。

## 16. 每日工作原则

> 先冻结边界，再写执行器；先让错误可观察，再跑成功演示；每个行为都用测试固定，避免联调时靠日志猜协议。
