/**
 * 思考按轮定档（内置插件）。策略表（实测定，改前先看下面两条铁律）：
 *
 *              规划轮（末条=user）        续答轮（末条=toolResult）
 *   thinking on        medium                    关（不传）
 *   thinking off       low                       关（不传）
 *
 * 1. 续答轮必须关——qwen3:14b 拿到工具结果后约 40% 概率把最终答案写进
 *    思考块（不吐 </think>、content 空），关思考让它直接作答；
 * 2. 规划轮不能发 reasoning_effort:"none"——qwen3:14b + Ollama 对技能路由类
 *    system prompt 会确定性输出全空，off 档规划轮发 low 兜底
 *    （expose=false 时思考帧不外流，用户无感）。
 * 不传 reasoning 时 pi-ai 对 reasoning 模型发 thinkingLevelMap.off 的值
 * （即 "none"），这正是续答轮想要的。
 */
import type { WorkerPlugin } from "../types.ts";

export const thinkingPolicy: WorkerPlugin = {
  name: "builtin:thinking-policy",
  apiVersion: 1,
  beforeModelCall(draft, ctx) {
    const last = draft.messages[draft.messages.length - 1];
    if (last?.role === "toolResult") {
      const { reasoning: _drop, ...rest } = draft.options;
      return { ...draft, options: rest };
    }
    const enabled = ctx.snapshot.thinking?.enabled === true;
    return {
      ...draft,
      options: { ...draft.options, reasoning: enabled ? "medium" : "low" },
    };
  },
};
