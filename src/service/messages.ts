/**
 * OpenAI messages → Pi 循环的输入切分与历史还原。
 */
import type { BuiltModel } from "./model.ts";

/**
 * 多轮对话的关键切分：**只有最后一条 user 消息是本轮输入**（prompts），
 * 之前的历史（含 assistant 回复）全部放进 context.messages 当上下文。
 * 把历史当输入塞给循环，assistant 消息会让循环直接空转结束（实测踩过）。
 */
export function splitMessages(messages: any[], model: BuiltModel) {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  // 历史消息要还原成 Pi 的合法消息形状：user 简单；assistant 必须带 api/provider/
  // model/usage/stopReason 这些元数据（缺了循环会静默空转，实测踩过）。
  const zeroUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const history = messages
    .filter((_: any, index: number) => index !== lastUserIdx)
    .map((message: any) =>
      message.role === "assistant"
        ? {
            role: "assistant" as const,
            content: [
              { type: "text" as const, text: String(message.content ?? "") },
            ],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: { ...zeroUsage },
            stopReason: "stop" as const,
            timestamp: Date.now(),
          }
        : {
            role: "user" as const,
            content: String(message.content ?? ""),
            timestamp: Date.now(),
          },
    );
  const prompts =
    lastUserIdx >= 0
      ? [{ ...messages[lastUserIdx], timestamp: Date.now() }]
      : [];
  return { history, prompts };
}
