/**
 * Pi 的 AgentEvent → 标准 OpenAI chat.completion.chunk（主笔：玄策）。
 * 工具过程以扩展字段 agent_event 附在 chunk 上（标准 SDK 自动忽略）。
 */
export function chunkLine(id: string, model: string, delta: object,
                          finish: string | null = null, extra: object = {}): string {
  return "data: " + JSON.stringify({
    id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000),
    model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra,
  }) + "\n\n";
}

export function mapEvent(ev: any, id: string, model: string,
                         exposeThinking = false): string | null {
  if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") {
    return chunkLine(id, model, { content: ev.assistantMessageEvent.delta });
  }
  // 思考增量：按 vLLM 惯例放 delta.reasoning。仅 expose 时下发；
  // thinking_start / thinking_end 不发帧。
  if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "thinking_delta") {
    if (!exposeThinking) return null;
    return chunkLine(id, model, { reasoning: ev.assistantMessageEvent.delta });
  }
  if (ev.type === "tool_execution_start") {
    return chunkLine(id, model, {}, null,
      { agent_event: { type: "step", tool: ev.toolName, status: "start" } });
  }
  if (ev.type === "tool_execution_end") {
    return chunkLine(id, model, {}, null,
      { agent_event: { type: "step", tool: ev.toolName, status: ev.isError ? "fail" : "ok" } });
  }
  if (ev.type === "agent_end") {
    return chunkLine(id, model, {}, "stop") + "data: [DONE]\n\n";
  }
  return null;
}
