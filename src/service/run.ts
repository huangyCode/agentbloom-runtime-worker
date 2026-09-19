/**
 * 一次运行的编排入口：把请求体拆成快照和消息，
 * 组装模型/工具/历史/思考开关，交给 Pi 的 agentLoop。
 * worker 无状态、不查库——所有输入都来自网关下发的快照和全量 messages。
 */
import { randomUUID } from "node:crypto";
import { agentLoop } from "@earendil-works/pi-agent-core";
import type { Snapshot, RunIdentity } from "../protocol/types.ts";
import { buildModel } from "./model.ts";
import { buildTools } from "./tools.ts";
import { splitMessages, createContextTrimmer } from "./messages.ts";
import { wrapStreamWithThinking } from "./thinking.ts";

export function buildRun(
  body: any,
  identity: RunIdentity = { runId: `local-${randomUUID()}` },
) {
  const snapshot: Snapshot = body.agent ?? {};
  const permissionMode = snapshot.permissionMode ?? "ask";
  const { definitions, tools } = buildTools(snapshot, identity, permissionMode);
  const definitionByName = new Map(
    definitions.map((definition) => [definition.name, definition]),
  );

  const messages = (body.messages ?? []).filter(
    (message: any) => message.role !== "system",
  );
  const systemPrompt =
    snapshot.systemPrompt ??
    (body.messages ?? []).find((message: any) => message.role === "system")
      ?.content ??
    "你是一个助手";
  const model = buildModel(
    snapshot.model,
    body.model ?? "deepseek-v4-flash-0731",
  );

  const maxRounds = snapshot.budgets?.maxRounds ?? 30;
  const config = {
    model,
    getApiKey: () =>
      snapshot.model?.apiKey || process.env.VLLM_API_KEY || "EMPTY",
    tools,
    systemPrompt,
    toolExecution: "parallel" as const,
    // pi-agent-core 不认识 maxTurns 字段，轮数上限要靠 shouldStopAfterTurn 自己数：
    // 本次运行新增的 assistant 消息数达到 maxRounds 即停，防模型死循环调工具烧穿。
    shouldStopAfterTurn: async ({ newMessages }: { newMessages: any[] }) => {
      const rounds = newMessages.filter(
        (message) => message.role === "assistant",
      ).length;
      return rounds >= maxRounds;
    },
    convertToLlm: (agentMessages: any[]) => agentMessages,
    transformContext: createContextTrimmer(model.contextWindow),
    beforeToolCall: async (context: any) => {
      const definition = definitionByName.get(context.toolCall?.name);
      if (definition?.sideEffect && permissionMode === "ask") {
        // 对话式审批由玄策负责；一期网关固定传 auto。
        return { block: true, reason: "该工具有副作用，需要用户批准" };
      }
      return undefined;
    },
  };

  const { history, prompts } = splitMessages(messages, model);
  const context = { systemPrompt, messages: history, tools };
  const stream = wrapStreamWithThinking(snapshot.thinking?.enabled === true);
  return {
    run: (signal: AbortSignal | undefined) =>
      agentLoop(prompts, context, config as any, signal, stream),
  };
}
