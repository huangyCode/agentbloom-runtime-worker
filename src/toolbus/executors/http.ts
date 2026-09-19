import { createToolBusError } from "../errors.ts";
import type {
  HttpToolDefinition,
  ToolExecutor,
  ToolExecutorContext,
  ToolExecutorResult,
} from "../types.ts";

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function asRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorOptions(
  definition: HttpToolDefinition,
  context: ToolExecutorContext,
) {
  return {
    toolName: definition.name,
    kind: definition.kind,
    runId: context.runId,
    toolCallId: context.toolCallId,
    attempt: context.attempt,
  } as const;
}

export class HttpToolExecutor implements ToolExecutor<HttpToolDefinition> {
  readonly kind = "http" as const;
  private readonly fetchFn: FetchLike;

  constructor(fetchFn: FetchLike = globalThis.fetch) {
    this.fetchFn = fetchFn;
  }

  async execute(
    definition: HttpToolDefinition,
    args: Record<string, unknown>,
    context: ToolExecutorContext,
  ): Promise<ToolExecutorResult> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Trace-Id": context.traceId,
    };
    if (definition.sideEffect && context.idempotencyKey) {
      headers["X-Idempotency-Key"] = context.idempotencyKey;
    }

    let response: Response;
    try {
      response = await this.fetchFn(definition.endpoint, {
        method: definition.method,
        headers,
        body: JSON.stringify({ arguments: args }),
        signal: context.signal,
      });
    } catch (error) {
      if (context.signal.aborted) throw error;
      throw createToolBusError(
        "connection_failed",
        `无法连接工具 ${definition.name}`,
        {
          ...errorOptions(definition, context),
          source: "transport",
          phase: "connect",
          retryable: true,
          details: error instanceof Error ? error.message : String(error),
        },
      );
    }

    if (![200, 500].includes(response.status)) {
      const retryable = [502, 503, 504].includes(response.status);
      try {
        await response.body?.cancel();
      } catch {
        // 状态码已足够判定失败，释放响应体失败不覆盖主错误。
      }
      throw createToolBusError(
        "unexpected_http_status",
        `工具 ${definition.name} 返回未约定的 HTTP ${response.status}`,
        {
          ...errorOptions(definition, context),
          source: "protocol",
          phase: "decode",
          retryable,
          details: { status: response.status },
        },
      );
    }

    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      if (context.signal.aborted) throw error;
      throw createToolBusError(
        "invalid_response",
        `读取工具 ${definition.name} 响应失败`,
        {
          ...errorOptions(definition, context),
          source: "protocol",
          phase: "decode",
          details: error instanceof Error ? error.message : String(error),
        },
      );
    }

    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw createToolBusError(
        "invalid_response",
        `工具 ${definition.name} 返回非 JSON 响应`,
        {
          ...errorOptions(definition, context),
          source: "protocol",
          phase: "decode",
          details: {
            status: response.status,
            contentType: response.headers.get("content-type"),
          },
        },
      );
    }

    if (!asRecord(data) || typeof data.ok !== "boolean") {
      throw createToolBusError(
        "invalid_response",
        `工具 ${definition.name} 返回的 envelope 缺少 boolean ok`,
        {
          ...errorOptions(definition, context),
          source: "protocol",
          phase: "decode",
        },
      );
    }

    if (response.status === 500 && data.ok) {
      throw createToolBusError(
        "invalid_response",
        `工具 ${definition.name} 在 HTTP 500 返回 ok=true`,
        {
          ...errorOptions(definition, context),
          source: "protocol",
          phase: "decode",
        },
      );
    }

    if (!data.ok) {
      if (!asRecord(data.error)) {
        throw createToolBusError(
          "invalid_response",
          `工具 ${definition.name} 的错误响应缺少 error 对象`,
          {
            ...errorOptions(definition, context),
            source: "protocol",
            phase: "decode",
          },
        );
      }
      const extraError = data.error;
      if (
        typeof extraError.code !== "string" ||
        typeof extraError.message !== "string" ||
        typeof extraError.retryable !== "boolean"
      ) {
        throw createToolBusError(
          "invalid_response",
          `工具 ${definition.name} 的 error 字段不完整`,
          {
            ...errorOptions(definition, context),
            source: "protocol",
            phase: "decode",
          },
        );
      }
      throw createToolBusError(extraError.code, extraError.message, {
        ...errorOptions(definition, context),
        source: "extra",
        phase: "execute",
        retryable: extraError.retryable,
        modelPayload: extraError,
        details: extraError,
      });
    }

    if (!("result" in data)) {
      throw createToolBusError(
        "invalid_response",
        `工具 ${definition.name} 的成功响应缺少 result`,
        {
          ...errorOptions(definition, context),
          source: "protocol",
          phase: "decode",
        },
      );
    }
    let resultText: string;
    try {
      resultText =
        typeof data.result === "string"
          ? data.result
          : JSON.stringify(data.result);
    } catch (error) {
      throw createToolBusError(
        "result_serialize_failed",
        `工具 ${definition.name} 的 result 无法序列化`,
        {
          ...errorOptions(definition, context),
          source: "protocol",
          phase: "finalize",
          details: error instanceof Error ? error.message : String(error),
        },
      );
    }
    if (resultText === undefined) {
      throw createToolBusError(
        "result_serialize_failed",
        `工具 ${definition.name} 的 result 序列化为空`,
        {
          ...errorOptions(definition, context),
          source: "protocol",
          phase: "finalize",
        },
      );
    }

    const contentType = response.headers.get("content-type") ?? "";
    const contentTypeWarning =
      contentType === "" ||
      (!contentType.includes("application/json") && !contentType.includes("+json"));
    return {
      content: [{ type: "text", text: resultText }],
      details: contentTypeWarning ? { contentTypeWarning: true } : {},
    };
  }
}
