/**
 * OpenAI messages → Pi 循环的输入切分与历史还原，外加上下文压缩。
 */
import type { BuiltModel } from "./model.ts";

const CONTEXT_SOFT_RATIO = 0.7;
const KEEP_RECENT = 3;

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

/**
 * 上下文压缩：估算体积超过窗口七成时，把较早的工具结果挖空，只保留最近几条。
 * 挂在 Pi 循环的 transformContext 钩子上，每轮调模型前都会过一遍。
 */
export function createContextTrimmer(contextWindow: number) {
  return async (agentMessages: any[]) => {
    const size = agentMessages.reduce(
      (total, message) => total + JSON.stringify(message).length,
      0,
    );
    if (size / 1.6 < contextWindow * CONTEXT_SOFT_RATIO) {
      return agentMessages;
    }
    const toolIndexes = agentMessages
      .map((message, index) => (message.role === "toolResult" ? index : -1))
      .filter((index) => index >= 0);
    const clearable = new Set(
      toolIndexes.slice(0, Math.max(0, toolIndexes.length - KEEP_RECENT)),
    );
    return agentMessages.map((message, index) =>
      clearable.has(index)
        ? {
            ...message,
            content: [
              {
                type: "text",
                text: "[较早的工具结果已归档，如需请重新调用工具]",
              },
            ],
          }
        : message,
    );
  };
}
