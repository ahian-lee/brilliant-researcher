/**
 * 兼容入口：实现已移到宿主中立的 `integrations/lib/waitRuns.mjs`（CLI 与 MCP 共用同一份）。
 * 保留本文件是为了不打断既有引用（含 tests/waitRuns.mjs 与已安装的旧路径）。
 */
export { waitRuns } from '../../../../lib/waitRuns.mjs';
