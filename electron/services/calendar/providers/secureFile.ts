/**
 * A small JSON secret in userData, encrypted with Electron's safeStorage: the
 * same storage Google Calendar's tokens use (CalendarManager, calendar_tokens.enc).
 * safeStorage is Keychain-backed on macOS and DPAPI-backed on Windows, so the
 * file is unreadable off this user account on both.
 *
 * Written to a temp file and renamed, so a crash mid-write never leaves half a
 * file. Without encryption (a Linux box with no keyring) nothing is saved: the
 * secret then lives for this session only, as Google's tokens do.
 */
import fs from 'fs';
import path from 'path';
import type { CalendarProviderDeps } from './types';

type Storage = Pick<CalendarProviderDeps, 'userDataDir' | 'safeStorage'>;

export function saveSecretJson(deps: Storage, fileName: string, value: unknown): boolean {
    if (!deps.safeStorage.isEncryptionAvailable()) {
        console.warn(`[Calendar] Encryption not available, ${fileName} kept for this session only`);
        return false;
    }
    const target = path.join(deps.userDataDir, fileName);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, deps.safeStorage.encryptString(JSON.stringify(value)));
    fs.renameSync(tmp, target);
    return true;
}

export function loadSecretJson<T>(deps: Storage, fileName: string): T | null {
    const target = path.join(deps.userDataDir, fileName);
    try {
        if (!fs.existsSync(target) || !deps.safeStorage.isEncryptionAvailable()) return null;
        return JSON.parse(deps.safeStorage.decryptString(fs.readFileSync(target))) as T;
    } catch (error) {
        console.error(`[Calendar] Could not read ${fileName}:`, error);
        return null;
    }
}

export function removeSecretFile(deps: Storage, fileName: string): void {
    const target = path.join(deps.userDataDir, fileName);
    try {
        if (fs.existsSync(target)) fs.unlinkSync(target);
    } catch (error) {
        console.error(`[Calendar] Could not remove ${fileName}:`, error);
    }
}
