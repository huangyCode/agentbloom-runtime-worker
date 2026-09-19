/**
 * 一次运行的编排入口：把请求体拆成快照和消息，
 * 组装模型/工具/历史，接上插件宿主，交给 Pi 的 agentLoop。
 * worker 无状态、不查库——所有输入都来自请求体；策略（思考定档/
 * 上下文裁剪/轮数预算）全部走插件泳道，本文件只做接线。
 */
import { agentLoop } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { Snapshot, RunIdentity } from "../protocol/types.ts";
import type { PluginHost, PluginRun } from "../plugin/host.ts";
import { buildModel } from "./model.ts";
import { buildTools } from "./tools.ts";
import { splitMessages } from "./messages.ts";

export function buildRun(
  body: any,
  identity: RunIdentity,
  host: PluginHost,
) {
  const snapshot: Snapshot = body.agent ?? {};
  const permissionMode = snapshot.permissionMode ?? "ask";
  const { definitions, tools, makeToolContext } = buildTools(
    snapshot,
    identity,
    permissionMode,
    host,
  );
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
  const model = buildModel(snapshot.model, body.model ?? "unknown");

  const { history, prompts } = splitMessages(messages, model);
  const context = { systemPrompt, messages: history, tools };

  const run = (signal: AbortSignal | undefined) => {
    const pluginRun = host.createRun({
      runId: identity.runId,
      traceId: identity.traceId ?? identity.runId,
      agentNo: snapshot.agentNo,
      conversationNo: body.run?.conversationNo,
      snapshot,
      signal: signal ?? new AbortController().signal,
    });
    makeToolContext(pluginRun);

    // 每轮调模型前过插件链：消息可裁剪、reasoning 可定档（思考策略在内置插件里）。
    // 类型断言：pi 的 streamFn 签名是同步返回,但 agent-loop 实际 await 了它,
    // async 包装在运行时完全合法(实测),仅类型上需要放宽。
    const stream = (async (m: any, ctx: any, opts: any) => {
      const draft = await pluginRun.beforeModelCall({
        messages: ctx.messages,
        options: {},
      });
      return streamSimple(
        m,
        { ...ctx, messages: draft.messages },
        {
          ...opts,
          ...(draft.options.reasoning
            ? { reasoning: draft.options.reasoning }
            : {}),
        },
      );
    }) as unknown as typeof streamSimple;

    let assistantTurns = 0;
    const config = {
      model,
      getApiKey: () =>
        snapshot.model?.apiKey || process.env.VLLM_API_KEY || "EMPTY",
      tools,
      systemPrompt,
      toolExecution: "parallel" as const,
      convertToLlm: (agentMessages: any[]) => agentMessages,
      beforeToolCall: async (piCtx: any) => {
        const definition = definitionByName.get(piCtx.toolCall?.name);
        // 一期口径：ask 模式下副作用工具直接拦（对话式审批未接通前的保守默认）。
        if (definition?.sideEffect && permissionMode === "ask") {
          return { block: true, reason: "该工具有副作用，需要用户批准" };
        }
        const decision = await pluginRun.beforeToolCall({
          toolCallId: piCtx.toolCall?.id,
          toolName: piCtx.toolCall?.name,
          args: piCtx.args ?? {},
          sideEffect: definition?.sideEffect === true,
        });
        if (decision.action === "block") {
          return { block: true, reason: decision.reason };
        }
        return undefined;
      },
      afterToolCall: async (piCtx: any) => {
        const patch = await pluginRun.afterToolCall({
          toolCallId: piCtx.toolCall?.id,
          toolName: piCtx.toolCall?.name,
          isError: piCtx.isError === true,
          content: piCtx.result?.content ?? [],
        });
        return patch?.content ? { content: patch.content } : undefined;
      },
      shouldStopAfterTurn: async ({ message, toolResults }: any) => {
        if (message?.role === "assistant") assistantTurns += 1;
        return pluginRun.shouldStop({
          assistantTurns,
          hadToolCalls: (toolResults?.length ?? 0) > 0,
        });
      },
    };

    return {
      stream: agentLoop(prompts, context, config as any, signal, stream),
      pluginRun,
    };
  };

  return { run };
}
