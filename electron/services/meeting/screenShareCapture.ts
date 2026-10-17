/**
 * The Electron side of "Snapshot shared screens" (ScreenShareContext.ts):
 * a picture of the meeting window through Natively's screenshot path
 * (ScreenshotHelper.captureWindowThumbnail, same permission gate as every
 * screenshot), reduced to a brightness grid for the change check, and written
 * to disk only when it is kept. Pictures live in userData/screen-share-frames
 * just long enough to be described, then are deleted; the folder is emptied
 * at each meeting start in case a crash left one behind.
 *
 * Same code on macOS and Windows: desktopCapturer window sources exist on
 * both, and both name a window source by its title, which is what the call
 * reader saw (AXTitle / GetWindowTextW).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { GRID_H, GRID_W, lumaOf } from './screenShareFrames';
import type { ShareFrame } from './ScreenShareContext';

/** Granola-sized ceiling: a bigger picture is not worth sending. */
const MAX_JPEG_BYTES = 4_700_000;

export function screenShareFramesDir(userDataDir: string): string {
    return path.join(userDataDir, 'screen-share-frames');
}

/** Empties the frames folder (leftovers from a crash). Never throws. */
export function clearScreenShareFrames(userDataDir: string): void {
    try {
        fs.rmSync(screenShareFramesDir(userDataDir), { recursive: true, force: true });
    } catch { /* nothing to clear */ }
}

interface ImageLike {
    getSize(): { width: number; height: number };
    resize(options: { width: number; height: number; quality?: string }): ImageLike;
    toBitmap(): Buffer;
    toJPEG(quality: number): Buffer;
}

/** A captured window as a ShareFrame; `image` is an Electron NativeImage. */
export function frameOfImage(image: ImageLike, userDataDir: string): ShareFrame {
    const { width, height } = image.getSize();
    const small = image.resize({ width: GRID_W, height: GRID_H, quality: 'good' });
    const luma = lumaOf(small.toBitmap(), GRID_W, GRID_H);
    return {
        fingerprint: { width, height, luma },
        async save() {
            const jpeg = image.toJPEG(85);
            if (jpeg.length === 0 || jpeg.length > MAX_JPEG_BYTES) return null;
            const dir = screenShareFramesDir(userDataDir);
            await fs.promises.mkdir(dir, { recursive: true });
            const file = path.join(dir, `${crypto.randomUUID()}.jpg`);
            await fs.promises.writeFile(file, jpeg);
            return file;
        },
    };
}

/** The window titled `title`, as a ShareFrame, or null when it isn't on screen. */
export async function captureShareFrame(title: string, userDataDir: string): Promise<ShareFrame | null> {
    if (!title.trim()) return null;
    const { captureWindowThumbnail } = require('../../ScreenshotHelper') as typeof import('../../ScreenshotHelper');
    const image = await captureWindowThumbnail([title], 1600);
    return image ? frameOfImage(image as unknown as ImageLike, userDataDir) : null;
}
