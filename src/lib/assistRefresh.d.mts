export const ASSIST_REFRESH_MS: number;
export function msUntilNextLocalMidnight(nowMs: number, startOfDay?: (ms: number, addDays: number) => number): number;
export function localStartOfDay(ms: number, addDays: number): number;
export function clearReopenedTicks(ticked: Record<string, number>, openItems: Array<{ key: string }>, requestedAt: number): Record<string, number>;
