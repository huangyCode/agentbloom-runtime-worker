import { createHash } from "node:crypto";
import { createToolBusError } from "../errors.ts";
import type {
  BuiltinToolDefinition,
  SkillObjectStore,
  SkillSnapshot,
  ToolExecutor,
  ToolExecutorContext,
  ToolExecutorResult,
} from "../types.ts";

/** 进程内正文缓存上限。键含 sha256（内容寻址），命中永不脏。 */
const CONTENT_CACHE_MAX_ENTRIES = 50;
/** 进程级 LRU（executor 每次运行新建，缓存要跨运行活）：Map 插入序当访问序，命中删了重插。 */
const contentCache = new Map<string, string>();

export class BuiltinToolExecutor
  implements ToolExecutor<BuiltinToolDefinition>
{
  readonly kind = "builtin" as const;
  private readonly skills: ReadonlyMap<string, SkillSnapshot>;
  private readonly objectStore?: SkillObjectStore;

  constructor(
    skills: readonly SkillSnapshot[],
    objectStore?: SkillObjectStore,
  ) {
    this.skills = new Map(skills.map((skill) => [skill.name, skill]));
    this.objectStore = objectStore;
  }

  async execute(
    definition: BuiltinToolDefinition,
    args: Record<string, unknown>,
    context: ToolExecutorContext,
  ): Promise<ToolExecutorResult> {
    const errorOptions = {
      source: "builtin",
      toolName: definition.name,
      kind: definition.kind,
      runId: context.runId,
      toolCallId: context.toolCallId,
      attempt: context.attempt,
    } as const;
    if (definition.builtinName !== "read_skill") {
      throw createToolBusError(
        "builtin_not_supported",
        `不支持内置工具 ${definition.builtinName}`,
        errorOptions,
      );
    }
    const name = args.name;
    const skill = typeof name === "string" ? this.skills.get(name) : undefined;
    if (!skill) {
      const available = [...this.skills.keys()].join(", ");
      throw createToolBusError(
        "skill_not_found",
        `技能不存在: ${String(name)}。可用: ${available}`,
        errorOptions,
      );
    }
    const content =
      skill.content !== undefined
        ? // 迁移期回退：快照仍内联正文时照旧直接返回。
          skill.content
        : await this.fetchContent(skill, errorOptions);
    return {
      content: [{ type: "text", text: content }],
      details: { skillName: skill.name, skillVersion: skill.version },
    };
  }

  /** 按快照提货单（objectKey + sha256）去对象存储取正文并校验。 */
  private async fetchContent(
    skill: SkillSnapshot,
    errorOptions: Parameters<typeof createToolBusError>[2],
  ): Promise<string> {
    const { objectKey, sha256 } = skill;
    if (!objectKey || !sha256 || !this.objectStore) {
      throw createToolBusError(
        "skill_config_invalid",
        `技能 ${skill.name} 既没有内联正文也没有完整的对象存储提货单（objectKey + sha256）`,
        { ...errorOptions, phase: "prepare" },
      );
    }
    const cacheKey = `${objectKey}:${sha256}`;
    const cached = contentCache.get(cacheKey);
    if (cached !== undefined) {
      // 命中刷新访问序：删了重插，让它回到 Map 尾部。
      contentCache.delete(cacheKey);
      contentCache.set(cacheKey, cached);
      return cached;
    }

    let raw: Buffer;
    try {
      raw = await this.objectStore.getSkillObject(objectKey);
    } catch (error) {
      throw createToolBusError(
        "skill_fetch_failed",
        `技能 ${skill.name} 正文拉取失败（对象 ${objectKey}）`,
        {
          ...errorOptions,
          phase: "connect",
          retryable: true,
          details: error instanceof Error ? error.message : String(error),
        },
      );
    }

    const actualSha256 = createHash("sha256").update(raw).digest("hex");
    if (actualSha256 !== sha256) {
      throw createToolBusError(
        "skill_corrupted",
        `技能 ${skill.name} 正文校验不一致：期望 sha256 ${sha256.slice(0, 12)}…，实际 ${actualSha256.slice(0, 12)}…`,
        { ...errorOptions, phase: "decode", retryable: false },
      );
    }

    const content = raw.toString("utf8");
    contentCache.set(cacheKey, content);
    if (contentCache.size > CONTENT_CACHE_MAX_ENTRIES) {
      // 超上限淘汰最久未访问项（Map 头部）。
      const oldest = contentCache.keys().next().value;
      if (oldest !== undefined) contentCache.delete(oldest);
    }
    return content;
  }
}
