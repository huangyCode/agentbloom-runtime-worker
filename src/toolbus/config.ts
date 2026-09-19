import type { ToolBusConfig } from "./types.ts";

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadToolBusConfig(
  env: NodeJS.ProcessEnv = process.env,
): ToolBusConfig {
  return {
    defaultTimeoutMs: positiveInteger(
      env.TOOLBUS_DEFAULT_TIMEOUT_MS,
      30_000,
    ),
    maxAttempts: positiveInteger(env.TOOLBUS_MAX_ATTEMPTS, 2),
    retryBaseDelayMs: positiveInteger(
      env.TOOLBUS_RETRY_BASE_DELAY_MS,
      200,
    ),
    maxResultBytes: positiveInteger(
      env.TOOLBUS_MAX_RESULT_BYTES ?? env.MAX_RESULT_BYTES,
      32 * 1024,
    ),
  };
}
