import type { ToolExecutorResult } from "./types.ts";

export interface LimitedResult {
  content: ToolExecutorResult["content"];
  truncated: boolean;
  originalBytes: number;
  returnedBytes: number;
}

function utf8Prefix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const source = Buffer.from(text, "utf8");
  if (source.byteLength <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (source[end] & 0b1100_0000) === 0b1000_0000) end -= 1;
  return source.subarray(0, end).toString("utf8");
}

export function limitToolResult(
  result: ToolExecutorResult,
  maxBytes: number,
): LimitedResult {
  const joined = result.content.map((item) => item.text).join("\n");
  const originalBytes = Buffer.byteLength(joined, "utf8");
  if (originalBytes <= maxBytes) {
    return {
      content: result.content,
      truncated: false,
      originalBytes,
      returnedBytes: originalBytes,
    };
  }

  let marker = `[ToolBus: result truncated; originalBytes=${originalBytes}; limitBytes=${maxBytes}]\n`;
  if (Buffer.byteLength(marker, "utf8") > maxBytes) {
    marker = utf8Prefix(marker, maxBytes);
  }
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const text = marker + utf8Prefix(joined, maxBytes - markerBytes);
  return {
    content: [{ type: "text", text }],
    truncated: true,
    originalBytes,
    returnedBytes: Buffer.byteLength(text, "utf8"),
  };
}
