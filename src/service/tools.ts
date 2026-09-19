/**
 * 快照 toolSpecs/skills → ToolBus 装配。
 * 插件插槽在这生效：setup 注册的自定义执行器并入 registry，
 * provideSkillStore 可替换技能对象存储；ToolBus 事件同时喂日志与插件 Observer。
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
import type { PluginHost, PluginRun } from "../plugin/host.ts";
import { logToolBusEvent } from "../common/log.ts";
import { getSkillObject } from "../common/objectstore.ts";

export function buildTools(
  snapshot: Snapshot,
  identity: RunIdentity,
  permissionMode: PermissionMode,
  host: PluginHost,
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
  // 对象存储在装配处注入，toolbus 不感知 SDK；插件可整体替换存储实现。
  if (skills.length > 0) {
    registry.register(
      new BuiltinToolExecutor(skills, host.skillStore ?? { getSkillObject }),
    );
  }
  for (const executor of host.extraExecutors) {
    registry.register(executor);
  }

  // ToolBus 事件双路：结构化日志照旧;运行开始后另发一份给插件 Observer 泳道。
  let activeRun: PluginRun | undefined;
  const toolBus = new DefaultToolBus({
    registry,
    config: toolBusConfig,
    eventSink: {
      emit: (event) => {
        logToolBusEvent(event);
        activeRun?.dispatchEvent(`toolbus_${event.type}`, event);
      },
    },
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
    /** run(signal) 建好 PluginRun 后回填，让 ToolBus 事件找到 Observer。 */
    makeToolContext: (pluginRun: PluginRun) => {
      activeRun = pluginRun;
    },
  };
}
