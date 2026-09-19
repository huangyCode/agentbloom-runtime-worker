/**
 * 公共日志方法。全仓统一从这里出日志，别在各层散落 console。
 */
import type { ToolBusEvent } from "../toolbus/types.ts";

export function logToolBusEvent(event: ToolBusEvent): void {
  if (!["retry", "failure", "canceled"].includes(event.type)) return;
  // 只记录标识和错误码；不记录参数、结果、Token 或密钥。
  console.warn(JSON.stringify({ component: "toolbus", ...event }));
}

/** 通用结构化日志（插件宿主等使用）。同样纪律：不落参数/结果/密钥。 */
export function log(fields: Record<string, unknown>): void {
  console.warn(JSON.stringify(fields));
}
