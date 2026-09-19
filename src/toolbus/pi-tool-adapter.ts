import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolBus, ToolDefinition, PermissionMode } from "./types.ts";

export interface ToolRunContext {
  runId: string;
  agentNo?: string;
  traceId?: string;
  permissionMode: PermissionMode;
  approvalGranted?: boolean;
}

export function toPiTool(
  definition: ToolDefinition,
  toolBus: ToolBus,
  runContext: ToolRunContext,
): AgentTool<any, Record<string, unknown>> {
  return {
    name: definition.name,
    label: definition.label,
    description: definition.description,
    parameters: definition.inputSchema as any,
    executionMode: definition.executionMode,
    execute: async (toolCallId, params, signal) =>
      toolBus.execute({
        definition,
        arguments: params as Record<string, unknown>,
        context: {
          runId: runContext.runId,
          agentNo: runContext.agentNo,
          traceId: runContext.traceId,
          permissionMode: runContext.permissionMode,
          approvalGranted: runContext.approvalGranted,
          toolCallId,
          signal,
        },
      }),
  };
}
