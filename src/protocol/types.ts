/**
 * 快照契约类型（与 PROTOCOL.md 对齐，主笔：玄策）。
 *
 * 网关把平台配置编译成这份快照随请求下发；worker 只认快照、不查库。
 * 协议层只放类型和纯函数，不 import service/http；工具与技能的形状
 * 归 toolbus 模块所有，这里仅做类型引用（type-only，不引运行时代码）。
 */
import type {
  PermissionMode,
  SkillSnapshot,
  SnapshotToolSpec,
} from "../toolbus/types.ts";

export interface ModelInfo {
  modelId: string;
  baseUrl?: string;
  apiKey?: string;
  contextWindow?: number;
  maxTokens?: number;
}

export type ToolSpec = SnapshotToolSpec;
export type { SkillSnapshot, PermissionMode };

export interface SubAgent {
  agentNo: string;
  name: string;
  description: string;
}

export interface Snapshot {
  agentNo?: string;
  model?: ModelInfo;
  systemPrompt?: string;
  permissionMode?: PermissionMode;
  budgets?: { maxRounds?: number; maxTokens?: number; timeoutS?: number };
  toolSpecs?: ToolSpec[];
  skills?: SkillSnapshot[];
  multiAgent?: boolean;
  subAgents?: SubAgent[];
  callDepth?: number;
  /** 思考链开关：enabled 控制模型是否思考，expose 控制思考流是否下发。缺省都关。 */
  thinking?: { enabled?: boolean; expose?: boolean };
}

export interface RunIdentity {
  runId: string;
  traceId?: string;
}
