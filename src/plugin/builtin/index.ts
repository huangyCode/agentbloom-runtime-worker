/**
 * 内置插件：worker 自己的策略也走插件 API（dogfooding）。
 * 想写自定义插件？抄这三个，每个不到 50 行。
 */
export { thinkingPolicy } from "./thinking-policy.ts";
export { contextTrimmer } from "./context-trimmer.ts";
export { roundBudget } from "./round-budget.ts";
