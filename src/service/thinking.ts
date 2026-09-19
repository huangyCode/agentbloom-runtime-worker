/**
 * 思考开关：按轮定档，循环每轮调模型都走这层包装。策略表（2026-09-10 实测定）：
 *
 *              规划轮（首轮/用户消息后）   续答轮（末条是 toolResult）
 *   thinking on        medium                    关（none）
 *   thinking off       low                       关（none）
 *
 * 两条实测约束，改前先看：
 * 1. 续答轮必须关——qwen3:14b 拿到工具结果后约 40% 概率把最终答案写进
 *    思考块（不吐 </think>、content 空），关思考让它直接作答；
 * 2. 规划轮不能发 reasoning_effort:"none"——qwen3:14b + Ollama 对技能路由类
 *    system prompt 会确定性输出全空（无 content 无 tool_calls 直接 stop），
 *    所以 off 档规划轮发 low 兜底（expose=false 时思考帧不外流，用户无感）。
 * 不传 reasoning 时 Pi 对 reasoning 模型发 thinkingLevelMap.off 的值
 * （即 "none"），这正是续答轮想要的。
 */
import { streamSimple } from "@earendil-works/pi-ai/compat";

export function wrapStreamWithThinking(
  thinkingEnabled: boolean,
): typeof streamSimple {
  return (model, ctx, opts) => {
    const last = ctx.messages[ctx.messages.length - 1];
    const isContinuationAfterTool = last?.role === "toolResult";
    return streamSimple(model, ctx, {
      ...opts,
      ...(isContinuationAfterTool
        ? {}
        : { reasoning: thinkingEnabled ? ("medium" as const) : ("low" as const) }),
    });
  };
}
