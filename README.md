# agent-worker

智能体平台的 Runtime Worker，**独立项目**（TypeScript / Node 24，循环内芯用 Pi 的
`@earendil-works/pi-agent-core`）。worker 是契约后面的黑盒——对外只有 HTTP/SSE
与契约格式，平台其余部分（网关/消费者/沙箱/文档）仍在 `agent-platform`（Python）。

## 结构

分层同 backend 的 api/service 习惯：接口层只管收发，服务层只管一次运行怎么跑，
协议层是纯类型和纯函数，toolbus 是垂直的领域模块。依赖方向单向：
`http → service → protocol`，`toolbus` 被 service 引用，`common` 谁都能用。

```
src/
├── http/        # 接口层
│   ├── server.ts    # 路由：/v1/chat/completions、/healthz、并发上限 503、取消=断连
│   └── sse.ts       # 请求体读取、SSE 响应头、心跳帧
├── service/     # 服务层：一次运行的组装
│   ├── run.ts       # buildRun 编排入口：快照+messages → Pi agentLoop
│   ├── model.ts     # 快照 model → Pi 模型配置（vLLM 兼容坑集中在这）
│   ├── messages.ts  # 历史消息还原、最后一条 user 切分、上下文压缩
│   ├── tools.ts     # 快照 toolSpecs/skills → ToolBus 装配
│   └── thinking.ts  # 思考开关的 stream 包装（每轮生效）
├── protocol/    # 协议层：纯类型 + 纯函数，不依赖上层
│   ├── types.ts     # 快照契约类型（对齐 PROTOCOL.md）
│   └── openai.ts    # Pi AgentEvent → OpenAI chat.completion.chunk（step 走扩展字段）
├── toolbus/     # 领域模块（观山）：HTTP/Builtin Executor、错误、重试、幂等、截断
└── common/      # 公共方法：日志
```

两条评审纪律（来自 Pi 的设计，别破）：OpenAI 帧格式只存在于 protocol 层，
service 内部只讲快照和 Pi 事件；领域逻辑垂直进 toolbus 这类模块，不摊平进三层。

## 运行（Node 24 直接跑 TS，无需构建；必须无代理）

```bash
npm install
env -u http_proxy -u https_proxy -u all_proxy node src/http/server.ts
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
# 真实 Extra 可用时：
EXTRA_URL=http://127.0.0.1:8200 npm run test:contract
```

已实测：直连真模型流式 ✓；全链路（网关 token 鉴权+快照组装 → 本服务
Pi 循环 → 上游 OpenAI 兼容模型服务）✓。

## 快照契约（对齐 agent-platform-backend / 前端 service 层）

**网关对接看 [PROTOCOL.md](./PROTOCOL.md)（定稿，含完整字段表与网关开发对照清单），
联调样例 `examples/snapshot.json` 可直接 curl。** 下面是摘要：

网关下发的 `agent` 快照（camelCase）：`agentNo` / `model`（三级取值结果：modelId/baseUrl/apiKey/contextWindow）/
`systemPrompt`（**网关编译后的最终 system**，含技能清单、子智能体清单等分段——运行时不认识技能）/
`permissionMode` / `budgets` / `toolSpecs` / `skills`（正文随快照下发）/ `multiAgent` + `subAgents` / `callDepth`。

一期内置工具注入条件：绑了技能 → `read_skill`（已实现，从快照取正文）。
`run_skill`、`call_agent` 和 MCP 本期不注册，避免“未接通”被模型误认为工具调用成功。

注册工具和 `read_skill` 都通过统一的 ToolBus → PiToolAdapter 进入 Pi Loop。HTTP Tool
由 ToolBus 调 Extra `POST /invoke/{name}`；Extra `ok:false` 会以结构化错误反馈模型，
同时 Pi/SSE 标记为 `fail`。详细设计见 [docs/ToolBus一期详细设计.md](./docs/ToolBus一期详细设计.md)。

已实测：技能链路端到端——模型按 system 里的技能清单调 read_skill 取说明书，
输出严格遵循技能规程（三段式/标注/示例声明）。

## 构建与部署

```bash
docker build --network host -t agent-worker:local .
docker run --rm -p 8100:8100 agent-worker:local
curl http://127.0.0.1:8100/healthz
```

CI 建议两阶段：verify（`npm ci` + 类型检查 + 单测）→ build（构建并推送镜像）。
发布 tag 使用 commit SHA，生产回滚同样按 SHA，避免依赖可漂移的 `latest`。

## Roadmap

- 工具审批的对话式放行、执行上限（token/时间）、流尾补 usage
- run_skill 脚本沙箱通道；大结果从"截断"升级为写 /workspace + 产出登记
- ToolBus 增加 MCP Executor、连接管理和错误映射
- 事件上报通路（运行记录/断点恢复账本）
- 版本纪律：pi-agent-core 钉 0.84.2，升级须过回归
