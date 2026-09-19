import type { ToolKind } from "./types.ts";

export type ToolErrorSource =
  | "toolbus"
  | "policy"
  | "transport"
  | "extra"
  | "protocol"
  | "builtin";

export type ToolErrorPhase =
  | "prepare"
  | "connect"
  | "execute"
  | "decode"
  | "finalize";

export interface ToolErrorData {
  code: string;
  message: string;
  retryable: boolean;
  source: ToolErrorSource;
  phase: ToolErrorPhase;
  toolName: string;
  kind: ToolKind;
  runId: string;
  toolCallId: string;
  attempt: number;
  modelPayload?: Record<string, unknown>;
  details?: unknown;
}

export interface ToolErrorOptions
  extends Partial<Omit<ToolErrorData, "code" | "message" | "retryable">> {
  retryable?: boolean;
}

export class ToolBusError extends Error {
  readonly toolError: ToolErrorData;

  constructor(toolError: ToolErrorData) {
    const modelPayload = toolError.modelPayload ?? {
      code: toolError.code,
      message: toolError.message,
      retryable: toolError.retryable,
    };
    super(JSON.stringify(modelPayload));
    this.name = "ToolBusError";
    this.toolError = toolError;
  }
}

export function createToolBusError(
  code: string,
  message: string,
  options: ToolErrorOptions = {},
): ToolBusError {
  return new ToolBusError({
    code,
    message,
    retryable: options.retryable ?? false,
    source: options.source ?? "toolbus",
    phase: options.phase ?? "execute",
    toolName: options.toolName ?? "unknown",
    kind: options.kind ?? "http",
    runId: options.runId ?? "unknown",
    toolCallId: options.toolCallId ?? "unknown",
    attempt: options.attempt ?? 0,
    modelPayload: options.modelPayload,
    details: options.details,
  });
}

export function isToolBusError(error: unknown): error is ToolBusError {
  return error instanceof ToolBusError;
}
