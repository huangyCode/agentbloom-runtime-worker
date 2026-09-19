# worker 对网关协议（定稿）

这份文档是网关（agent-platform-backend）调用 worker 的**唯一依据**。文档里写的就是代码做的，
改代码必须同步改这里。联调对拍用 `examples/snapshot.json`，可直接照抄。

## 0. 三条原则

1. **worker 无状态**：一次对话 = 一个 POST，网关每次带全量 messages。worker 不存会话、不查库。
2. **worker 不鉴权**：只部署在内网，信任网关。鉴权、查智能体、编译提示词全在网关做完。
3. **worker 不认识平台概念**：没有"技能/模型注册/绑定"这些词，只认快照里的字段。
   网关把平台概念**编译**成快照，worker 照着执行。

## 1. 端点

| 端点 | 用途 |
|---|---|
| `GET /healthz` | 存活探针 + 容量。返回 `{"status":"ok","version":"0.1.0","engine":"pi-agent-core","running":0,"capacity":8}`，running 是正在跑的对话数，capacity 是并发上限 |
| `POST /v1/chat/completions` | 唯一的业务入口。请求 = OpenAI 标准字段 + `agent` 扩展字段（快照），响应 = SSE 流 |

## 2. 请求格式

```
POST /v1/chat/completions
Content-Type: application/json
```

顶层是 OpenAI 标准字段 + 一个扩展字段 `agent`：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `messages` | array | 是 | 全量对话历史。**role=system 的消息会被忽略**，系统提示词以 `agent.systemPrompt` 为准 |
| `stream` | bool | 是 | 一律传 true。worker 只有流式一种返回 |
| `model` | string | 否 | 忽略（只做日志展示兜底）。真正的模型在 `agent.model` 里 |
| `agent` | object | 是 | 快照，见下表 |

`agent` 快照字段（camelCase）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `agentNo` | string | 是 | 智能体编号，日志与排查用 |
| `model` | object | 是 | **三级取值的最终结果**（请求 model → 智能体默认 → 平台默认），连接信息全部由网关下发 |
| `model.modelId` | string | 是 | 供应商侧的真实模型名，发给推理服务的就是它 |
| `model.baseUrl` | string | 是 | 模型接口地址（模型注册表里的 endpoint） |
| `model.apiKey` | string | 是 | 明文密钥；没有密钥的内网服务填 `"EMPTY"` |
| `model.contextWindow` | number | 是 | 上下文窗口。worker 的超限清理按它算，传错会导致过早丢工具结果或爆上下文 |
| `model.maxTokens` | number | 否 | 单轮输出上限，缺省 4096 |
| `systemPrompt` | string | 是 | **网关编译后的最终系统提示词**。智能体配置的提示词 + 技能清单段（见第 4 节） |
| `permissionMode` | string | 一期必传 `"auto"` | auto / ask / readonly。**不传默认 ask**——ask 会拦截一切有副作用的工具等待确认，所以一期网关固定传 auto |
| `budgets.maxRounds` | number | 否 | 思考-执行循环的轮数上限，缺省 30 |
| `toolSpecs` | array | 否 | 工具清单，见下表。不传 = 纯对话 |
| `skills` | array | 否 | 绑定技能的**全部内容**（含正文）随快照下发，见第 4 节 |
| `thinking` | object | 否 | 思考链开关 `{enabled, expose}`，缺省都 false = 不思考。`enabled` 控制模型是否思考；`expose` 控制思考流是否下发为 `delta.reasoning` 帧 |
| `multiAgent` / `subAgents` / `callDepth` | - | 一期不传 | 多智能体调度，下期开放 |

`toolSpecs[]` 每项：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string | 是 | 函数名（字母数字下划线），模型看到的就是它 |
| `description` | string | 是 | 给模型看的功能说明 |
| `type` | string | 是 | 一期只有 `"http"`（`"mcp"` 通道下期接） |
| `endpoint` | string | 是 | 工具调用地址（工具注册表里的 endpoint，指向 extra） |
| `inputSchema` | object | 是 | JSON Schema，模型按它构造参数 |
| `sideEffect` | bool | 是 | 有无副作用。决定要不要带幂等键、readonly 下要不要过滤、失败能不能自动重试 |

`skills[]` 每项：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string | 是 | 技能名（frontmatter 里的） |
| `description` | string | 是 | 什么时候用 |
| `version` | string | 是 | 锁定的版本 |
| `content` | string | 否 | SKILL.md 全文内联。**迁移期回退**：带了 content 就直接用它，不走对象存储 |
| `objectKey` | string | 否 | 技能正文在对象存储的 key，规则固定 `{skill_no}/{version}.md`（桶 `ap-skills`）。**新链路以它为准**：不内联 content，worker 的 read_skill 首次用到时按它去 MinIO 懒加载 |
| `sha256` | string | 否 | 正文的 sha256 hex。走 objectKey 时必传，worker 取回后逐字节校验，不一致报 `skill_corrupted` |
| `sizeBytes` | number | 否 | 正文字节数，仅供展示/预算参考，不参与校验 |
| `hasScript` | bool | 否 | 一期一律 false（带脚本技能等沙箱通道） |

content 与 `objectKey`+`sha256` 至少给一组：content 存在 → 照旧直接返回（迁移期回退）；
否则按 objectKey 拉取并校验 sha256。两组都缺是非法快照（报 `skill_config_invalid`）。
拉取失败（MinIO 连不上/对象不存在）报 `skill_fetch_failed`（retryable）。
worker 进程内按 `objectKey:sha256` 做内容寻址缓存，命中免拉取。

## 3. worker 自动做的事（网关不用做、也不要做）

- `skills` 非空 → worker **自动生成 read_skill 工具**给模型，正文从快照本地取。
  网关**不要**把 read_skill 写进 toolSpecs，也不需要提供任何技能查询接口
- readonly 模式 → 有副作用的工具直接不进模型的工具清单
- 所有工具统一经过 ToolBus；参数在 Worker 边界按 `inputSchema` 再校验一次
- `sideEffect: true` 的工具调用自动带稳定的 `X-Idempotency-Key` 请求头，同一 Tool Call 始终相同
- 一次逻辑工具调用总 deadline 为 30 秒（包含连接、执行、读取、重试和退避）
- 仅 `sideEffect=false` 且错误 `retryable=true` 时自动重试一次；副作用工具不自动重试
- 工具结果超过 32 KiB 时按 UTF-8 字节截断并标注，中文/emoji 不会被切成非法字符
- 调用方断连时，Pi 的 AbortSignal 会穿过 ToolBus 立即取消正在进行的 Extra fetch
- 上下文超过窗口 70% 时，把最老的工具结果换成占位符（永远保留最近 3 条）

### 3.1 Worker → Extra 固定协议

一期 `type=http` 工具统一执行：

```http
POST <toolSpecs.endpoint>
Content-Type: application/json
X-Idempotency-Key: idem_xxx  # 仅 sideEffect=true
```

```json
{"arguments":{"sql":"SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_name"}}
```

Extra 响应必须是以下固定 envelope：

```json
{"ok":true,"result":{}}
{"ok":false,"error":{"code":"readonly_only","message":"只允许 SELECT","retryable":false}}
```

- HTTP 200 可以是成功或业务失败；HTTP 500 必须是 `ok:false`；
- `ok:false` 的 `error` 对象原样作为模型可见工具错误，不额外包装；
- Pi 将其标为 `isError=true`，调试页收到最终 `status=fail`，模型仍可读取错误并继续纠正；
- 连接、状态码、JSON 或 envelope 非法由 ToolBus 映射为统一通道错误；
- ToolBus 内部重试成功时，对外逻辑事件是 `start → ok`；最终失败才是 `start → fail`。

完整实现规则见 [`docs/ToolBus一期详细设计.md`](./docs/ToolBus一期详细设计.md)。

## 4. systemPrompt 的技能清单怎么拼（网关编译规则）

绑了技能时，网关在智能体自己的系统提示词后面追加一段，格式建议：

```
# 可用技能
以下技能与当前任务匹配时，先调用 read_skill 工具（参数 name 填技能名）获取完整规程，再按规程执行。
- sql_review — 审查 SQL 变更单、评估 DDL 风险时使用
```

一行一个技能：`名称 — 描述`。描述直接用技能表里的 description，不要改写。

## 5. 返回格式（SSE）

`Content-Type: text/event-stream`，每帧一行 `data: {...}`，格式是标准 OpenAI
`chat.completion.chunk`。**网关逐行原样透传，不解析不改写**。帧类型：

| 帧 | 长相 | 说明 |
|---|---|---|
| 首帧 | `delta: {"role":"assistant"}` | 流开始 |
| 文字帧 | `delta: {"content":"…"}` | 回复文字增量，逐帧拼接 |
| 思考帧 | `delta: {"reasoning":"…"}` | 思考链文字增量，仅 `agent.thinking.expose=true` 时出现。标准 OpenAI SDK 自动忽略这个非标准 delta 字段 |
| 工具帧 | `delta: {}` + 顶层多一个 `"agent_event":{"type":"step","tool":"sql_query","status":"start"}` | 工具过程事件，status 取值 start / ok / fail。标准 OpenAI SDK 会自动忽略这个多出来的字段，调试页专门消费它 |
| 结束帧 | `finish_reason:"stop"`，随后一行 `data: [DONE]` | 流结束 |
| 心跳 | `: ping` | 每 15 秒一行 SSE 注释，防中间层断连。SSE 解析器天然忽略，网关透传即可 |
| 错误帧 | `data: {"error":{"message":"…","type":"server_error","code":"internal"}}` | 循环中途出错。透传给调用方后流就结束了 |

## 6. 状态码与网关的处理约定

| 情况 | worker 行为 | 网关应该 |
|---|---|---|
| 并发满 | HTTP 503，`code: "no_capacity"` | 一期单实例：把 503 透传给调用方（提示稍后再试）。多副本后：换一个实例重试 |
| 请求体非法 JSON | HTTP 400 | 不应该发生（网关自己拼的），发生了记日志排查 |
| 调用方断开 | —— | **网关跟着断开对 worker 的连接**，worker 检测到断连立即中止循环（含正在跑的工具调用）。取消就是断连，没有别的取消接口 |
| 流中途出错 | 发错误帧后正常结束流 | 原样透传 |

## 7. 网关开发对照清单

按顺序做完这 8 件事，链路就是通的：

1. Bearer token 查智能体（查不到 401；stopped 403）
2. 定模型：请求 model → 智能体默认 → 平台默认，结果必须已注册且启用
3. 拼 systemPrompt：智能体提示词 + 技能清单段（第 4 节）
4. 拼 toolSpecs：绑定且启用的工具逐个转换（第 2 节字段表），模型不支持工具调用则不传
5. 拼 skills：绑定技能连正文一起放进快照
6. `permissionMode` 传 `"auto"`，`budgets.maxRounds` 传 30
7. POST 到 worker，SSE 逐行透传
8. 调用方断连 → 断开对 worker 的连接

## 8. 联调方法

```bash
# 起服务（必须绕代理）
env -u http_proxy -u https_proxy -u all_proxy node src/server.ts

# 直打 worker（不经网关），快照样例可改
curl -N --noproxy '*' http://127.0.0.1:8100/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d @examples/snapshot.json
```

`examples/snapshot.json` 就是一份合法快照：绑 sql_review 技能 + sql_query / web_search
两个工具（指向 extra 的 8200），网关拼出来的东西和它长得一样即为正确。
