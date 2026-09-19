import { Compile } from "typebox/compile";
import { createToolBusError } from "./errors.ts";
import type {
  ArgumentValidator,
  BuiltinToolDefinition,
  HttpToolDefinition,
  SnapshotToolSpec,
  ValidationIssue,
} from "./types.ts";

const TOOL_NAME = /^[A-Za-z0-9_]+$/;

function asRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compileValidator(
  schema: Record<string, unknown>,
  toolName: string,
): ArgumentValidator {
  try {
    const validator = Compile(schema as never);
    return {
      check: (value) => validator.Check(value),
      errors: (value) =>
        [...validator.Errors(value)].map(
          (error): ValidationIssue => ({
            keyword: error.keyword,
            instancePath: error.instancePath,
            message: error.message,
          }),
        ),
    };
  } catch (error) {
    throw createToolBusError(
      "tool_config_invalid",
      `工具 ${toolName} 的 inputSchema 无法编译`,
      {
        phase: "prepare",
        toolName,
        details: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

function validateCommon(spec: SnapshotToolSpec): void {
  if (!spec.name || !TOOL_NAME.test(spec.name)) {
    throw createToolBusError(
      "tool_config_invalid",
      "工具 name 必须只包含字母、数字和下划线",
      { phase: "prepare", toolName: spec.name || "unknown" },
    );
  }
  if (typeof spec.description !== "string" || spec.description.trim() === "") {
    throw createToolBusError(
      "tool_config_invalid",
      `工具 ${spec.name} 缺少 description`,
      { phase: "prepare", toolName: spec.name },
    );
  }
  if (!asRecord(spec.inputSchema) || spec.inputSchema.type !== "object") {
    throw createToolBusError(
      "tool_config_invalid",
      `工具 ${spec.name} 的 inputSchema 必须是 object schema`,
      { phase: "prepare", toolName: spec.name },
    );
  }
  if (typeof spec.sideEffect !== "boolean") {
    throw createToolBusError(
      "tool_config_invalid",
      `工具 ${spec.name} 缺少 sideEffect`,
      { phase: "prepare", toolName: spec.name },
    );
  }
}

export function normalizeSnapshotTool(
  spec: SnapshotToolSpec,
  defaultTimeoutMs: number,
): HttpToolDefinition {
  validateCommon(spec);
  if (spec.type !== "http") {
    throw createToolBusError(
      "tool_kind_not_enabled",
      `一期未启用工具类型 ${spec.type}`,
      {
        phase: "prepare",
        toolName: spec.name,
        kind: spec.type,
      },
    );
  }
  if (!spec.endpoint) {
    throw createToolBusError(
      "tool_config_invalid",
      `HTTP 工具 ${spec.name} 缺少 endpoint`,
      { phase: "prepare", toolName: spec.name },
    );
  }
  let endpoint: URL;
  try {
    endpoint = new URL(spec.endpoint);
  } catch {
    throw createToolBusError(
      "tool_config_invalid",
      `HTTP 工具 ${spec.name} 的 endpoint 不是绝对 URL`,
      { phase: "prepare", toolName: spec.name },
    );
  }
  if (!["http:", "https:"].includes(endpoint.protocol)) {
    throw createToolBusError(
      "tool_config_invalid",
      `HTTP 工具 ${spec.name} 的 endpoint 只允许 http/https`,
      { phase: "prepare", toolName: spec.name },
    );
  }
  if (endpoint.username || endpoint.password) {
    throw createToolBusError(
      "tool_config_invalid",
      `HTTP 工具 ${spec.name} 的 endpoint 不允许携带 userinfo`,
      { phase: "prepare", toolName: spec.name },
    );
  }

  return {
    name: spec.name,
    label: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema!,
    argumentValidator: compileValidator(spec.inputSchema!, spec.name),
    kind: "http",
    sideEffect: spec.sideEffect!,
    timeoutMs: defaultTimeoutMs,
    executionMode: spec.sideEffect ? "sequential" : "parallel",
    endpoint: endpoint.toString(),
    method: "POST",
  };
}

export function createReadSkillDefinition(
  timeoutMs = 1_000,
): BuiltinToolDefinition {
  const inputSchema = {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
    additionalProperties: false,
  };
  return {
    name: "read_skill",
    label: "read_skill",
    description: "读取某个技能的完整说明书。只在任务与该技能的描述匹配时调用。",
    inputSchema,
    argumentValidator: compileValidator(inputSchema, "read_skill"),
    kind: "builtin",
    builtinName: "read_skill",
    sideEffect: false,
    timeoutMs,
    executionMode: "parallel",
  };
}
