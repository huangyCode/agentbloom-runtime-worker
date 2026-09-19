/**
 * HTTP 层的公共小件：请求体读取、SSE 响应头、心跳。
 * 帧的内容格式归协议层（protocol/openai.ts），这里只管"怎么收和怎么写"。
 */
import type http from "node:http";

export function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => {
      try {
        resolve(s ? JSON.parse(s) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

export function writeSseHead(res: http.ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
  });
}

/** 每 15 秒一条注释行心跳，防中间层断开空闲连接。返回值交给 clearInterval。 */
export function startHeartbeat(res: http.ServerResponse): NodeJS.Timeout {
  return setInterval(() => res.write(": ping\n\n"), 15_000);
}
