export type ToolKind = "http" | "builtin" | "mcp" | "sandbox" | "agent";
export type PermissionMode = "auto" | "ask" | "readonly";
export type ToolExecutionMode = "parallel" | "sequential";

export interface ValidationIssue {
  keyword: string;
  instancePath: string;
  message: string;
}

export interface ArgumentValidator {
  check(value: unknown): boolean;
  errors(value: unknown): ValidationIssue[];
}

export interface BaseToolDefinition {
  name: string;
  label: string;
  description: string;
  inputSchema: Record<string, unknown>;
  argumentValidator: ArgumentValidator;
  kind: ToolKind;
  sideEffect: boolean;
  timeoutMs: number;
  executionMode: ToolExecutionMode;
}

export interface HttpToolDefinition extends BaseToolDefinition {
  kind: "http";
  endpoint: string;
  method: "POST";
}

export interface BuiltinToolDefinition extends BaseToolDefinition {
  kind: "builtin";
  builtinName: "read_skill";
}

export interface McpToolDefinition extends BaseToolDefinition {
  kind: "mcp";
  serverRef: string;
  remoteToolName: string;
}

export type ToolDefinition =
  | HttpToolDefinition
  | BuiltinToolDefinition
  | McpToolDefinition;

export interface SnapshotToolSpec {
  name: string;
  description: string;
  type: "http" | "mcp";
  endpoint?: string;
  inputSchema?: Record<string, unknown>;
  sideEffect?: boolean;
  env?: string;
}

export interface SkillSnapshot {
  name: string;
  description: string;
  version: string;
  /** 迁移期回退：仍内联正文时直接用它，不走对象存储。 */
  content?: string;
  /** 懒加载提货单：对象 key（{skill_no}/{version}.md），与 sha256 成对出现。 */
  objectKey?: string;
  /** 正文的 sha256 hex，取回后必须校验一致。 */
  sha256?: string;
  /** 正文字节数，仅供展示/预算参考，不参与校验。 */
  sizeBytes?: number;
  hasScript?: boolean;
  script?: string;
}

/** 技能正文对象存储的最小接口；实现由装配处注入，toolbus 不依赖具体 SDK。 */
export interface SkillObjectStore {
  getSkillObject(objectKey: string): Promise<Buffer>;
}

export interface ToolCallContext {
  runId: string;
  toolCallId: string;
  agentNo?: string;
  traceId?: string;
  permissionMode: PermissionMode;
  approvalGranted?: boolean;
  signal?: AbortSignal;
}

export interface ToolBusRequest {
  definition: ToolDefinition;
  arguments: Record<string, unknown>;
  context: ToolCallContext;
}

export interface ToolExecutionDetails extends Record<string, unknown> {
  runId: string;
  toolCallId: string;
  toolName: string;
  kind: ToolKind;
  attempt: number;
  durationMs: number;
  truncated: boolean;
  originalBytes?: number;
  returnedBytes?: number;
}

export interface ToolBusResult {
  content: Array<{ type: "text"; text: string }>;
  details: ToolExecutionDetails;
}

export interface ToolExecutorContext {
  runId: string;
  toolCallId: string;
  agentNo?: string;
  traceId: string;
  attempt: number;
  idempotencyKey?: string;
  deadlineAt: number;
  signal: AbortSignal;
}

export interface ToolExecutorResult {
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
}

export interface ToolExecutor<T extends ToolDefinition = ToolDefinition> {
  readonly kind: T["kind"];
  execute(
    definition: T,
    args: Record<string, unknown>,
    context: ToolExecutorContext,
  ): Promise<ToolExecutorResult>;
}

export type ToolBusEvent =
  | {
      type: "start";
      runId: string;
      toolCallId: string;
      toolName: string;
      kind: ToolKind;
      attempt: number;
    }
  | {
      type: "retry";
      runId: string;
      toolCallId: string;
      toolName: string;
      code: string;
      nextAttempt: number;
    }
  | {
      type: "success";
      runId: string;
      toolCallId: string;
      toolName: string;
      durationMs: number;
      truncated: boolean;
    }
  | {
      type: "failure" | "canceled";
      runId: string;
      toolCallId: string;
      toolName: string;
      code: string;
      durationMs: number;
    };

export interface ToolBusEventSink {
  emit(event: ToolBusEvent): void | Promise<void>;
}

export interface ToolBus {
  execute(request: ToolBusRequest): Promise<ToolBusResult>;
}

export interface ToolBusConfig {
  defaultTimeoutMs: number;
  maxAttempts: number;
  retryBaseDelayMs: number;
  maxResultBytes: number;
}
