/**
 * Did the shared screen change? Each picture is reduced to a small grid of
 * brightness values (GRID_W x GRID_H) and compared with the last one.
 *
 *   changedVisibly  a new slide, a scrolled page, a different window: the
 *                   picture's size moved by more than 5%, or the average cell
 *                   moved by MEAN_CHANGED levels, or CELL_CHANGED_FRACTION of
 *                   the cells moved by CELL_LEVEL levels or more. A video
 *                   strip of faces beside the share moves a few cells and
 *                   stays under these, so it doesn't make every frame "new".
 *   nearDuplicate   the same screen as before (cursor, a blinking caret):
 *                   no new description is worth paying for.
 *
 * Pure (typed arrays only), so the tests feed it synthetic frames. The
 * thresholds are Natively's own, set coarser than "any pixel moved" so a
 * long share does not cost a vision call every 10 s. Not tuned against a
 * real share yet.
 */

export const GRID_W = 64;
export const GRID_H = 36;
const MEAN_CHANGED = 2;
const CELL_LEVEL = 16;
const CELL_CHANGED_FRACTION = 0.04;
const SIZE_CHANGED = 0.05;

export interface FrameFingerprint {
    /** The picture's own size, before it was reduced. */
    width: number;
    height: number;
    /** GRID_W x GRID_H brightness values, row by row. */
    luma: Uint8Array;
}

/**
 * Brightness of a 4-bytes-per-pixel bitmap (BGRA or RGBA: red and blue weigh
 * the same here, so the byte order does not matter).
 */
export function lumaOf(bitmap: Uint8Array, width: number, height: number): Uint8Array {
    const out = new Uint8Array(width * height);
    for (let i = 0, p = 0; i < out.length && p + 2 < bitmap.length; i++, p += 4) {
        out[i] = (bitmap[p] + 2 * bitmap[p + 1] + bitmap[p + 2]) >> 2;
    }
    return out;
}

export interface FrameDiff {
    sizeChanged: boolean;
    meanDiff: number;
    changedFraction: number;
}

export function compareFrames(a: FrameFingerprint, b: FrameFingerprint): FrameDiff {
    const rel = (x: number, y: number) => (Math.max(x, y) === 0 ? 0 : Math.abs(x - y) / Math.max(x, y));
    const sizeChanged = rel(a.width, b.width) > SIZE_CHANGED || rel(a.height, b.height) > SIZE_CHANGED;
    const n = Math.min(a.luma.length, b.luma.length);
    if (n === 0 || a.luma.length !== b.luma.length) return { sizeChanged: true, meanDiff: 255, changedFraction: 1 };
    let sum = 0;
    let changed = 0;
    for (let i = 0; i < n; i++) {
        const d = Math.abs(a.luma[i] - b.luma[i]);
        sum += d;
        if (d >= CELL_LEVEL) changed++;
    }
    return { sizeChanged, meanDiff: sum / n, changedFraction: changed / n };
}

export function changedVisibly(previous: FrameFingerprint | null, next: FrameFingerprint): boolean {
    if (!previous) return true;
    const d = compareFrames(previous, next);
    return d.sizeChanged || d.meanDiff >= MEAN_CHANGED || d.changedFraction >= CELL_CHANGED_FRACTION;
}

export function nearDuplicate(previous: FrameFingerprint | null, next: FrameFingerprint): boolean {
    if (!previous) return false;
    const d = compareFrames(previous, next);
    return !d.sizeChanged && d.meanDiff < 1 && d.changedFraction < 0.01;
}
