// src/lib/assistRefresh.mjs
//
// When the launcher's assist lists (assist/AssistToday.tsx) read again on
// their own, so "Coming up today", "Overdue" and an expired catch-up never sit
// stale on a launcher left open:
//
//   - just after local midnight (the day changed: a new "today", new overdue
//     items), on this machine's clock, daylight-saving days included
//   - every 5 minutes while the window is visible
//   - when the window becomes visible again
//
// Pure, no DOM, so the tests run it directly.

/** How often the lists read again while the launcher is visible. */
export const ASSIST_REFRESH_MS = 5 * 60 * 1000;

/** A second past midnight, so the read lands on the new day. */
const PAST_MIDNIGHT_MS = 1000;

/**
 * Milliseconds from `nowMs` to just after the next local midnight. `startOfDay`
 * maps a time to the start of its local day (injected by tests to pin a time
 * zone; the machine's clock otherwise).
 * @param {number} nowMs
 * @param {(ms: number, addDays: number) => number} [startOfDay]
 * @returns {number}
 */
export function msUntilNextLocalMidnight(nowMs, startOfDay = localStartOfDay) {
  const next = startOfDay(nowMs, 1);
  return Math.max(PAST_MIDNIGHT_MS, next - nowMs + PAST_MIDNIGHT_MS);
}

/**
 * The start of the local day `addDays` after the one `ms` falls in.
 * @param {number} ms
 * @param {number} addDays
 */
export function localStartOfDay(ms, addDays) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + addDays).getTime();
}

/**
 * Ticks the server has not caught up with are kept; a tick made BEFORE a read
 * whose answer still lists the item open is dropped: that item was raised
 * again in a later meeting (owedItems: a tick hides it only until then), so it
 * must show open again, not crossed out. Returns the same object when nothing
 * changes.
 * @param {Record<string, number>} ticked  key -> when it was ticked here
 * @param {Array<{ key: string }>} openItems  what the read returned as open
 * @param {number} requestedAt  when that read was asked for
 * @returns {Record<string, number>}
 */
export function clearReopenedTicks(ticked, openItems, requestedAt) {
  let out = ticked;
  for (const item of Array.isArray(openItems) ? openItems : []) {
    const at = ticked[item?.key];
    if (typeof at === 'number' && at < requestedAt) {
      if (out === ticked) out = { ...ticked };
      delete out[item.key];
    }
  }
  return out;
}
