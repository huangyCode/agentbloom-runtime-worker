/**
 * 轮数预算（内置插件）：本次运行 assistant 轮数达到 budgets.maxRounds 即停，
 * 防模型死循环调工具烧穿。pi-agent-core 不认识 maxTurns 字段，
 * 上限必须靠 shouldStop 自己数——这是实测发现的坑，别删。
 */
import type { WorkerPlugin } from "../types.ts";

const DEFAULT_MAX_ROUNDS = 30;

export const roundBudget: WorkerPlugin = {
  name: "builtin:round-budget",
  apiVersion: 1,
  shouldStop(turn, ctx) {
    const maxRounds = ctx.snapshot.budgets?.maxRounds ?? DEFAULT_MAX_ROUNDS;
    return turn.assistantTurns >= maxRounds;
  },
};
