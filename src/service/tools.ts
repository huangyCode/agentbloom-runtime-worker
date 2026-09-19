/**
 * 快照 toolSpecs/skills → ToolBus 装配（ToolBus 本体归观山的 toolbus 模块）。
 * 一期支持 HTTP（Extra /invoke）和内置 read_skill，MCP 等通道只保留扩展点。
 */
import {
  BuiltinToolExecutor,
  createReadSkillDefinition,
  DefaultToolBus,
  HttpToolExecutor,
  loadToolBusConfig,
  normalizeSnapshotTool,
  toPiTool,
  ToolExecutorRegistry,
  type ToolDefinition,
} from "../toolbus/index.ts";
import type {
  PermissionMode,
  RunIdentity,
  Snapshot,
} from "../protocol/types.ts";
import { logToolBusEvent } from "../common/log.ts";
import { getSkillObject } from "../common/objectstore.ts";

export function buildTools(
  snapshot: Snapshot,
  identity: RunIdentity,
  permissionMode: PermissionMode,
) {
  const toolBusConfig = loadToolBusConfig();
  const rawSpecs = snapshot.toolSpecs ?? [];
  const visibleSpecs = rawSpecs.filter(
    (spec) => !(permissionMode === "readonly" && spec.sideEffect === true),
  );
  const definitions: ToolDefinition[] = visibleSpecs.map((spec) =>
    normalizeSnapshotTool(spec, toolBusConfig.defaultTimeoutMs),
  );
  const skills = snapshot.skills ?? [];
  if (skills.length > 0) definitions.push(createReadSkillDefinition());

  const registry = new ToolExecutorRegistry();
  registry.register(new HttpToolExecutor());
  // 对象存储在装配处注入，toolbus 不感知 MinIO SDK，保持可单测。
  if (skills.length > 0) {
    registry.register(new BuiltinToolExecutor(skills, { getSkillObject }));
  }

  const toolBus = new DefaultToolBus({
    registry,
    config: toolBusConfig,
    eventSink: { emit: logToolBusEvent },
  });
  const runContext = {
    runId: identity.runId,
    traceId: identity.traceId ?? identity.runId,
    agentNo: snapshot.agentNo,
    permissionMode,
  };
  return {
    definitions,
    tools: definitions.map((definition) =>
      toPiTool(definition, toolBus, runContext),
    ),
  };
}
