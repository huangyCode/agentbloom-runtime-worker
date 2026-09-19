/**
 * Runtime Worker HTTP 服务（薄壳，主笔：玄策）。
 *
 * 协议同 agent-platform 仓库 contracts/openapi/runtime.yaml：
 *   POST /v1/chat/completions  收网关请求（含智能体快照）→ 标准 chunk 流
 *   GET  /healthz              存活探针 + running/capacity
 * 并发超上限 503（网关换实例重试）；取消 = 连接断开。
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import { buildRun } from "../service/run.ts";
import { PluginHost } from "../plugin/host.ts";
import { contextTrimmer, roundBudget, thinkingPolicy } from "../plugin/builtin/index.ts";
import { mapEvent, chunkLine } from "../protocol/openai.ts";
import { readBody, writeSseHead, startHeartbeat } from "./sse.ts";

const PORT = Number(process.env.PORT ?? 8100);
const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY ?? 8);
const running = new Set<string>();

// 插件注册处:数组序 = 拦截链序。自定义插件加在这里(或未来做成配置加载)。
const host = new PluginHost([thinkingPolicy, contextTrimmer, roundBudget]);

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", version: "0.1.0", engine: "pi-agent-core",
                             running: running.size, capacity: MAX_CONCURRENCY }));
    return;
  }
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    if (running.size >= MAX_CONCURRENCY) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "已达并发上限", type: "server_error", code: "no_capacity" } }));
      return;
    }
    let body: any;
    try { body = await readBody(req); } catch {
      res.writeHead(400).end(JSON.stringify({ error: { message: "非法 JSON" } })); return;
    }
    const id = "chatcmpl-" + randomUUID().slice(0, 12);
    const model = body.agent?.model?.modelId ?? body.model ?? "unknown";
    const ac = new AbortController();
    req.on("aborted", () => ac.abort());
    res.on("close", () => {
      if (!res.writableEnded) ac.abort();             // 取消 = 响应连接断开
    });
    running.add(id);
    writeSseHead(res);
    res.write(chunkLine(id, model, { role: "assistant" }));
    const hb = startHeartbeat(res);
    try {
      const traceHeader = req.headers["x-trace-id"];
      const traceId = Array.isArray(traceHeader) ? traceHeader[0] : traceHeader;
      const { run } = buildRun(body, { runId: id, traceId }, host);
      const exposeThinking = body.agent?.thinking?.expose === true;
      const { stream, pluginRun } = run(ac.signal);
      for await (const ev of stream) {
        pluginRun.dispatchEvent(ev.type, ev);   // Observer 泳道,隔离异步,不碰 SSE
        const line = mapEvent(ev, id, model, exposeThinking);
        if (line && !res.destroyed) res.write(line);
      }
    } catch (e) {
      if (!ac.signal.aborted && !res.destroyed) {
        res.write("data: " + JSON.stringify({ error: {
          message: (e as Error).message, type: "server_error", code: "internal" } }) + "\n\n");
      }
    } finally {
      clearInterval(hb); running.delete(id);
      if (!res.writableEnded && !res.destroyed) res.end();
    }
    return;
  }
  res.writeHead(404).end();
});

server.listen(PORT, () => console.log(`agent-worker (pi) listening on :${PORT}`));
