# agentbloom-runtime-worker

**A minimal, stateless agent runtime.** Feed it a *snapshot* (model + system prompt +
tools + skills as one JSON contract), it runs the ReAct loop — think → call tools →
observe → answer — and streams OpenAI-compatible SSE back. No database, no auth,
no business concepts inside: everything it needs arrives with the request, so any
instance can serve any request and a crashed run can be rebuilt from records kept
elsewhere.

Built on [`pi-agent-core`](https://www.npmjs.com/package/@earendil-works/pi-agent-core)
as the inner loop (inversion of control: the loop owns *when*, this runtime owns *how* —
model config, tool execution, context trimming, thinking policy are all injected).

**Highlights**

- **Snapshot contract** — the gateway/platform compiles agent config into one JSON;
  the runtime is a pure function of it. See [PROTOCOL.md](./PROTOCOL.md).
- **ToolBus** — unified tool execution with per-call deadline, bounded retry
  (side-effect-free only), idempotency keys for side-effect tools, structured errors
  fed back to the model, and a 32KB result cap. HTTP tools speak one endpoint:
  `POST /invoke/{name}`.
- **Lazy skills** — skills ship in the snapshot as a *claim ticket*
  (`objectKey + sha256 + size`); the runtime downloads the skill body from object
  storage only when the model actually calls `read_skill`, verifies the hash, and
  caches it (LRU). Bind ten skills, pay for the one you read.
- **Per-turn thinking policy** — reasoning effort is decided per loop turn from the
  shape of the context (planning turn vs. continuation-after-tool turn), which fixes
  two real-world failure modes of reasoning models (answers swallowed into the
  thinking block; deterministic empty output). Battle-tested against a local
  qwen3:14b via a 20-question regression benchmark.
- **Pluggable by design** — a two-lane plugin API: *observers* subscribe to every
  loop/tool event (isolated, can never break a run — persistence, metrics, audit),
  *interceptors* join the critical path in registration order (approval flows,
  custom compaction, budgets). The built-in thinking policy, context trimmer and
  round budget are themselves plugins (<50 lines each). See [docs/PLUGIN.md](./docs/PLUGIN.md).
- **OpenAI-compatible streaming** — `delta.content` / `delta.reasoning` frames plus a
  small `agent_event` extension for tool-step progress; standard SDKs just work.

**Quick start** (three terminals + one curl; needs Node ≥ 22 and any
OpenAI-compatible model endpoint — the example uses local [Ollama](https://ollama.com)):

```bash
ollama pull qwen3:14b && ollama serve          # 1. a model, any OpenAI-compatible endpoint
node examples/tool-server.mjs                  # 2. example tool service on :8200 (zero deps)
npm install && node src/http/server.ts         # 3. the runtime on :8100

curl -N http://127.0.0.1:8100/v1/chat/completions \
  -H 'Content-Type: application/json' -d @examples/snapshot.json
```

You'll watch the model read the bundled skill, do arithmetic through the `calc`
tool (it is forbidden to do mental math by the skill's SOP), and stream a
three-section report — the full think–act–observe loop, self-contained.

---

## 中文说明

智能体平台的 Runtime Worker，也可**独立使用**：输入一份快照（模型/提示词/工具/
技能的 JSON 契约），跑"思考-调工具-再思考"循环，流式输出 OpenAI 兼容帧。
worker 无状态、不做鉴权、不认识平台业务概念——对外只有 HTTP/SSE 与契约格式。

### 结构

分层习惯：接口层只管收发，服务层只管一次运行怎么跑，协议层是纯类型和纯函数，
toolbus 是垂直的领域模块。依赖方向单向：`http → service → protocol`，
`toolbus` 被 service 引用，`common` 谁都能用。

```
src/
├── http/        # 接口层
│   ├── server.ts    # 路由：/v1/chat/completions、/healthz、并发上限 503、取消=断连
│   └── sse.ts       # 请求体读取、SSE 响应头、心跳帧
├── service/     # 服务层：一次运行的组装
│   ├── run.ts       # buildRun 编排入口：快照+messages → Pi agentLoop
│   ├── model.ts     # 快照 model → Pi 模型配置（OpenAI 兼容端点的适配坑集中在这）
│   ├── messages.ts  # 历史消息还原、最后一条 user 切分、上下文压缩
│   └── tools.ts     # 快照 toolSpecs/skills → ToolBus 装配(插槽在此生效)
├── protocol/    # 协议层：纯类型 + 纯函数，不依赖上层
│   ├── types.ts     # 快照契约类型（对齐 PROTOCOL.md）
│   └── openai.ts    # Pi AgentEvent → OpenAI chat.completion.chunk（step 走扩展字段）
├── plugin/      # 插件宿主：观察者/拦截器两类钩子+插槽,内置策略也是插件
├── toolbus/     # 领域模块：HTTP/Builtin Executor、错误、重试、幂等、截断
└── common/      # 公共方法：日志、对象存储
```

两条评审纪律（来自 Pi 的设计，别破）：OpenAI 帧格式只存在于 protocol 层，
service 内部只讲快照和 Pi 事件；领域逻辑垂直进 toolbus 这类模块，不摊平进三层。

### 运行（Node ≥ 22 直接跑 TS，无需构建）

```bash
npm install
node src/http/server.ts
# 环境变量：PORT=8100 · MAX_CONCURRENCY=8 · VLLM_BASE_URL=http://127.0.0.1:11434/v1（默认本地 Ollama）
```

ToolBus 可选配置：

| 环境变量 | 默认值 | 说明 |
|---|---:|---|
| `TOOLBUS_DEFAULT_TIMEOUT_MS` | 30000 | 一次逻辑工具调用的总 deadline |
| `TOOLBUS_MAX_ATTEMPTS` | 2 | 无副作用工具最大尝试次数 |
| `TOOLBUS_RETRY_BASE_DELAY_MS` | 200 | 自动重试基础退避 |
| `TOOLBUS_MAX_RESULT_BYTES` | 32768 | 模型可见工具结果 UTF-8 字节上限 |

MinIO 对象存储（read_skill 懒加载技能正文用，快照内联 content 时不会连）：

| 环境变量 | 默认值 | 说明 |
|---|---:|---|
| `MINIO_ENDPOINT` | 127.0.0.1 | MinIO 主机（minio 包的 endPoint 不带端口） |
| `MINIO_PORT` | 9000 | S3 API 端口 |
| `MINIO_ACCESS_KEY` | local_dev | 访问密钥 |
| `MINIO_SECRET_KEY` | local_dev_2026 | 私密密钥 |
| `MINIO_USE_SSL` | false | 是否走 HTTPS |
| `MINIO_SKILL_BUCKET` | ap-skills | 技能正文桶，对象 key 规则 `{skill_no}/{version}.md` |

```bash
npm run typecheck
npm test
```

### 插件

策略层全部走插件 API：事件订阅(Observer,隔离异步)、关键路径拦截(Interceptor,
链式+超时)、执行器/存储插槽(setup)。内置的思考按轮定档、上下文裁剪、轮数预算
就是三个插件范例(`src/plugin/builtin/`,各不到 50 行)。契约、失败语义与示例见
**[docs/PLUGIN.md](./docs/PLUGIN.md)**;行为由 `test/plugin-host.test.ts` 钉住。

### 快照契约

**完整字段表与网关开发对照清单见 [PROTOCOL.md](./PROTOCOL.md)，
联调样例 `examples/snapshot.json` 可直接 curl。**摘要：

`agent` 快照（camelCase）：`agentNo` / `model`（modelId/baseUrl/apiKey/contextWindow）/
`systemPrompt`（**编译后的最终 system**，含技能清单等分段——运行时不认识技能）/
`permissionMode` / `budgets` / `toolSpecs` / `skills`（提货单或内联正文）/
`thinking`（enabled 管模型思考，expose 管思考流是否下发）。

内置工具注入条件：绑了技能 → `read_skill`。`run_skill`、`call_agent` 和 MCP
当前不注册——**没接通的能力绝不暴露给模型**，避免"未接通"被误认为调用成功。

注册工具和 `read_skill` 都通过统一的 ToolBus 进入循环。HTTP 工具由 ToolBus 调
`POST /invoke/{name}`（协议见 `examples/tool-server.mjs` 的注释）；`ok:false`
会以结构化错误反馈模型，模型可据此自愈重试。详细设计见
[docs/ToolBus一期详细设计.md](./docs/ToolBus一期详细设计.md)。

### 构建与部署

```bash
docker build --network host -t agentbloom-runtime-worker:local .
docker run --rm -p 8100:8100 agentbloom-runtime-worker:local
curl http://127.0.0.1:8100/healthz
```

CI 建议两阶段：verify（`npm ci` + 类型检查 + 单测）→ build（构建并推送镜像）。
发布 tag 使用 commit SHA，生产回滚同样按 SHA，避免依赖可漂移的 `latest`。

### Roadmap

- 工具审批的对话式放行、执行上限（token/时间）、流尾补 usage
- run_skill 脚本沙箱通道；大结果从"截断"升级为写 /workspace + 产出登记
- ToolBus 增加 MCP Executor、连接管理和错误映射
- 事件上报通路（运行记录/断点恢复账本）
- 版本纪律：pi-agent-core 钉 0.84.2，升级须过回归

## License

[Apache-2.0](./LICENSE)
