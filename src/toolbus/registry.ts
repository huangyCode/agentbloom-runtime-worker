import { createToolBusError } from "./errors.ts";
import type { ToolDefinition, ToolExecutor, ToolKind } from "./types.ts";

export class ToolExecutorRegistry {
  private readonly executors = new Map<ToolKind, ToolExecutor>();

  register(executor: ToolExecutor): void {
    if (this.executors.has(executor.kind)) {
      throw createToolBusError(
        "tool_executor_duplicate",
        `工具执行器 ${executor.kind} 已注册`,
        { phase: "prepare", kind: executor.kind },
      );
    }
    this.executors.set(executor.kind, executor);
  }

  get(definition: ToolDefinition): ToolExecutor {
    const executor = this.executors.get(definition.kind);
    if (!executor) {
      throw createToolBusError(
        "tool_executor_not_found",
        `未注册工具执行器 ${definition.kind}`,
        {
          phase: "prepare",
          toolName: definition.name,
          kind: definition.kind,
        },
      );
    }
    return executor;
  }
}
