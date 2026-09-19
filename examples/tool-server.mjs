/**
 * 示例工具服务（零依赖，Node 18+）：演示 worker 的 HTTP 工具协议。
 *   GET  /tools           工具清单（注册到平台/快照时照抄字段）
 *   POST /invoke/{name}   统一调用入口，body: {"arguments": {...}}
 *                         返回 {"ok":true,"result":...} 或
 *                              {"ok":false,"error":{code,message,retryable}}
 * 真实部署中，这个角色由你的工具服务承担（连数据库、调内部 API 等）；
 * 协议保持一致，worker 侧零改动。
 *
 * 运行：node examples/tool-server.mjs   # :8200
 */
import http from "node:http";

const TOOLS = {
  now: {
    manifest: {
      name: "now",
      description: "获取当前日期时间（ISO 8601，含时区偏移）。",
      inputSchema: { type: "object", properties: {}, required: [] },
      sideEffect: false,
    },
    invoke: () => ({ iso: new Date().toISOString(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone }),
  },
  calc: {
    manifest: {
      name: "calc",
      description: "计算一个四则运算表达式，支持 + - * / ( ) 与小数。",
      inputSchema: {
        type: "object",
        properties: { expression: { type: "string", description: "如 (31000+29500+33000)/3" } },
        required: ["expression"],
      },
      sideEffect: false,
    },
    invoke: ({ expression }) => {
      if (typeof expression !== "string" || !/^[\d\s+\-*/().]+$/.test(expression)) {
        const err = new Error("表达式只允许数字与 + - * / ( )");
        err.code = "invalid_expression";
        throw err;
      }
      const value = Function(`"use strict"; return (${expression});`)();
      if (!Number.isFinite(value)) {
        const err = new Error("表达式未得出有限数值");
        err.code = "invalid_expression";
        throw err;
      }
      return { expression, value };
    },
  },
};

const PORT = Number(process.env.PORT ?? 8200);

http.createServer(async (req, res) => {
  const reply = (status, body) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "GET" && req.url === "/tools") {
    return reply(200, { items: Object.values(TOOLS).map((t) => t.manifest) });
  }
  const m = req.url?.match(/^\/invoke\/([\w-]+)$/);
  if (req.method === "POST" && m) {
    const tool = TOOLS[m[1]];
    if (!tool) return reply(200, { ok: false, error: { code: "tool_not_found", message: `工具不存在: ${m[1]}`, retryable: false } });
    let raw = "";
    for await (const chunk of req) raw += chunk;
    try {
      const args = (raw ? JSON.parse(raw) : {}).arguments ?? {};
      return reply(200, { ok: true, result: tool.invoke(args) });
    } catch (e) {
      return reply(200, { ok: false, error: { code: e.code ?? "internal", message: e.message, retryable: false } });
    }
  }
  reply(404, { ok: false, error: { code: "not_found", message: "GET /tools 或 POST /invoke/{name}", retryable: false } });
}).listen(PORT, () => console.log(`example tool server on :${PORT}`));
