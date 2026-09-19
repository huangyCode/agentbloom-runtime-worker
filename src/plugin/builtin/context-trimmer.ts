/**
 * 上下文自保（内置插件）：估算体积超过窗口七成时，把较早的工具结果挖空，
 * 只保留最近 KEEP_RECENT 条完整。不删除消息、不断 toolCall/toolResult 配对，
 * 只掏空内容——每轮从完整原文重算，是只读视图不是破坏性修改。
 */
import type { WorkerPlugin } from "../types.ts";

const CONTEXT_SOFT_RATIO = 0.7;
const KEEP_RECENT = 3;
const FALLBACK_CONTEXT_WINDOW = 128_000;

export const contextTrimmer: WorkerPlugin = {
  name: "builtin:context-trimmer",
  apiVersion: 1,
  beforeModelCall(draft, ctx) {
    const contextWindow =
      ctx.snapshot.model?.contextWindow ?? FALLBACK_CONTEXT_WINDOW;
    const size = draft.messages.reduce(
      (total, message) => total + JSON.stringify(message).length,
      0,
    );
    if (size / 1.6 < contextWindow * CONTEXT_SOFT_RATIO) return;

    const toolIndexes = draft.messages
      .map((message, index) => (message.role === "toolResult" ? index : -1))
      .filter((index) => index >= 0);
    const clearable = new Set(
      toolIndexes.slice(0, Math.max(0, toolIndexes.length - KEEP_RECENT)),
    );
    return {
      ...draft,
      messages: draft.messages.map((message, index) =>
        clearable.has(index)
          ? {
              ...message,
              content: [
                { type: "text", text: "[较早的工具结果已归档，如需请重新调用工具]" },
              ],
            }
          : message,
      ),
    };
  },
};
