import { createHash } from "node:crypto";
import {
  createToolBusError,
  isToolBusError,
  ToolBusError,
} from "./errors.ts";
import { ToolExecutorRegistry } from "./registry.ts";
import { limitToolResult } from "./result-limit.ts";
import type {
  ToolBus,
  ToolBusConfig,
  ToolBusEvent,
  ToolBusEventSink,
  ToolBusRequest,
  ToolBusResult,
  ToolExecutorContext,
} from "./types.ts";

const NOOP_EVENT_SINK: ToolBusEventSink = { emit: () => undefined };

export interface DefaultToolBusOptions {
  registry: ToolExecutorRegistry;
  config: ToolBusConfig;
  eventSink?: ToolBusEventSink;
  now?: () => number;
  random?: () => number;
}

function stableIdempotencyKey(runId: string, toolCallId: string): string {
  const digest = createHash("sha256")
    .update(`${runId}:${toolCallId}`)
    .digest("hex")
    .slice(0, 32);
  return `idem_${digest}`;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", aborted, { once: true });

    function cleanup(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
    }
    function done(): void {
      cleanup();
      resolve();
    }
    function aborted(): void {
      cleanup();
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    }
  });
}

export class DefaultToolBus implements ToolBus {
  private readonly registry: ToolExecutorRegistry;
  private readonly config: ToolBusConfig;
  private readonly eventSink: ToolBusEventSink;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(options: DefaultToolBusOptions) {
    this.registry = options.registry;
    this.config = options.config;
    this.eventSink = options.eventSink ?? NOOP_EVENT_SINK;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  async execute(request: ToolBusRequest): Promise<ToolBusResult> {
    const { definition, context, arguments: args } = request;
    const startedAt = this.now();
    this.checkPolicy(request);
    this.checkArguments(request);

    const deadlineAt = startedAt + definition.timeoutMs;
    const maxAttempts = definition.sideEffect ? 1 : this.config.maxAttempts;
    const idempotencyKey = definition.sideEffect
      ? stableIdempotencyKey(context.runId, context.toolCallId)
      : undefined;
    const executor = this.registry.get(definition);
    await this.emit({
      type: "start",
      runId: context.runId,
      toolCallId: context.toolCallId,
      toolName: definition.name,
      kind: definition.kind,
      attempt: 1,
    });

    let lastError: ToolBusError | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const remainingMs = deadlineAt - this.now();
      if (remainingMs <= 0) {
        lastError = this.contextualError(
          request,
          attempt,
          "upstream_timeout",
          `工具 ${definition.name} 调用超过 ${definition.timeoutMs}ms`,
          true,
        );
        break;
      }

      const timeoutSignal = AbortSignal.timeout(remainingMs);
      const combinedSignal = context.signal
        ? AbortSignal.any([context.signal, timeoutSignal])
        : timeoutSignal;
      const executorContext: ToolExecutorContext = {
        runId: context.runId,
        toolCallId: context.toolCallId,
        agentNo: context.agentNo,
        traceId: context.traceId ?? context.runId,
        attempt,
        idempotencyKey,
        deadlineAt,
        signal: combinedSignal,
      };

      try {
        const result = await executor.execute(
          definition as never,
          args,
          executorContext,
        );
        const limited = limitToolResult(result, this.config.maxResultBytes);
        const durationMs = this.now() - startedAt;
        await this.emit({
          type: "success",
          runId: context.runId,
          toolCallId: context.toolCallId,
          toolName: definition.name,
          durationMs,
          truncated: limited.truncated,
        });
        return {
          content: limited.content,
          details: {
            ...result.details,
            runId: context.runId,
            toolCallId: context.toolCallId,
            toolName: definition.name,
            kind: definition.kind,
            attempt,
            durationMs,
            truncated: limited.truncated,
            originalBytes: limited.originalBytes,
            returnedBytes: limited.returnedBytes,
          },
        };
      } catch (error) {
        lastError = this.normalizeError(
          error,
          request,
          attempt,
          timeoutSignal,
        );
      }

      if (!this.shouldRetry(lastError, request, attempt, maxAttempts)) break;
      const jitter = Math.floor(this.random() * 101);
      const waitMs = this.config.retryBaseDelayMs + jitter;
      if (this.now() + waitMs >= deadlineAt) break;
      await this.emit({
        type: "retry",
        runId: context.runId,
        toolCallId: context.toolCallId,
        toolName: definition.name,
        code: lastError.toolError.code,
        nextAttempt: attempt + 1,
      });
      try {
        const waitSignal = context.signal
          ? AbortSignal.any([
              context.signal,
              AbortSignal.timeout(deadlineAt - this.now()),
            ])
          : AbortSignal.timeout(deadlineAt - this.now());
        await delay(waitMs, waitSignal);
      } catch (error) {
        lastError = this.normalizeError(
          error,
          request,
          attempt,
          AbortSignal.abort(),
        );
        break;
      }
    }

    const finalError = lastError ?? this.contextualError(
      request,
      0,
      "internal",
      `工具 ${definition.name} 未返回结果`,
      false,
    );
    const durationMs = this.now() - startedAt;
    await this.emit({
      type: finalError.toolError.code === "canceled" ? "canceled" : "failure",
      runId: context.runId,
      toolCallId: context.toolCallId,
      toolName: definition.name,
      code: finalError.toolError.code,
      durationMs,
    });
    throw finalError;
  }

  private checkPolicy(request: ToolBusRequest): void {
    const { definition, context } = request;
    if (!definition.sideEffect) return;
    if (context.permissionMode === "readonly") {
      throw this.contextualError(
        request,
        0,
        "permission_denied",
        `readonly 模式禁止调用有副作用工具 ${definition.name}`,
        false,
        "policy",
      );
    }
    if (context.permissionMode === "ask" && !context.approvalGranted) {
      throw this.contextualError(
        request,
        0,
        "approval_required",
        `工具 ${definition.name} 需要用户批准`,
        false,
        "policy",
      );
    }
  }

  private checkArguments(request: ToolBusRequest): void {
    const { definition, arguments: args } = request;
    if (definition.argumentValidator.check(args)) return;
    throw this.contextualError(
      request,
      0,
      "arguments_schema_invalid",
      `工具 ${definition.name} 参数不符合 inputSchema`,
      false,
      "policy",
      definition.argumentValidator.errors(args),
    );
  }

  private normalizeError(
    error: unknown,
    request: ToolBusRequest,
    attempt: number,
    timeoutSignal: AbortSignal,
  ): ToolBusError {
    if (request.context.signal?.aborted) {
      return this.contextualError(
        request,
        attempt,
        "canceled",
        `工具 ${request.definition.name} 调用已取消`,
        false,
        "transport",
      );
    }
    if (timeoutSignal.aborted) {
      return this.contextualError(
        request,
        attempt,
        "upstream_timeout",
        `工具 ${request.definition.name} 调用超过 ${request.definition.timeoutMs}ms`,
        true,
        "transport",
      );
    }
    if (isToolBusError(error)) {
      const data = error.toolError;
      return new ToolBusError({
        ...data,
        runId: request.context.runId,
        toolCallId: request.context.toolCallId,
        toolName: request.definition.name,
        kind: request.definition.kind,
        attempt,
      });
    }
    return this.contextualError(
      request,
      attempt,
      "internal",
      error instanceof Error ? error.message : String(error),
      false,
    );
  }

  private contextualError(
    request: ToolBusRequest,
    attempt: number,
    code: string,
    message: string,
    retryable: boolean,
    source: "toolbus" | "policy" | "transport" = "toolbus",
    details?: unknown,
  ): ToolBusError {
    return createToolBusError(code, message, {
      retryable,
      source,
      phase: source === "policy" ? "prepare" : "execute",
      toolName: request.definition.name,
      kind: request.definition.kind,
      runId: request.context.runId,
      toolCallId: request.context.toolCallId,
      attempt,
      details,
    });
  }

  private shouldRetry(
    error: ToolBusError,
    request: ToolBusRequest,
    attempt: number,
    maxAttempts: number,
  ): boolean {
    return (
      !request.definition.sideEffect &&
      !request.context.signal?.aborted &&
      error.toolError.retryable &&
      error.toolError.code !== "canceled" &&
      attempt < maxAttempts
    );
  }

  private async emit(event: ToolBusEvent): Promise<void> {
    try {
      await this.eventSink.emit(event);
    } catch {
      // 事件属于旁路，可观测性故障不能改变工具执行结果。
    }
  }
}
