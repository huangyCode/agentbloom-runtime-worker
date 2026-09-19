/**
 * 快照 model 信息 → Pi 的模型配置。OpenAI 兼容端点的坑集中在这一个文件里。
 */
import type { ModelInfo } from "../protocol/types.ts";

const FALLBACK_BASE_URL =
  process.env.VLLM_BASE_URL ?? "http://127.0.0.1:11434/v1";

export function buildModel(modelInfo: ModelInfo | undefined, fallbackId: string) {
  return {
    id: modelInfo?.modelId ?? fallbackId,
    name: modelInfo?.modelId ?? fallbackId,
    api: "openai-completions" as const,
    provider: "platform-gateway",
    baseUrl: modelInfo?.baseUrl ?? FALLBACK_BASE_URL,
    reasoning: true,
    // Ollama 的 OpenAI 端点默认思考开，关思考只认显式 reasoning_effort:"none"
    //（chat_template_kwargs / think:false / "/no_think" 实测都不生效）。
    // 不设 thinkingFormat → 走 Pi 的默认 OpenAI 分支：开=发档位，关=发 thinkingLevelMap.off。
    // vLLM 若换回来：qwen-chat-template + chat_template_kwargs.enable_thinking 那套。
    thinkingLevelMap: { off: "none" },
    // 部分模板不认识 role:"developer"，Pi 默认会这么发，导致思考静默失效（vLLM 实测踩过）。
    compat: {
      supportsReasoningEffort: true,
      supportsDeveloperRole: false,
    },
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: modelInfo?.contextWindow ?? 128_000,
    maxTokens: modelInfo?.maxTokens ?? 4096,
  };
}

export type BuiltModel = ReturnType<typeof buildModel>;
