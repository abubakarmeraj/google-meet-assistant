/**
 * A meeting app's microphone control, read for the state its label reveals.
 * No imports, no Node or browser API: the desktop reader (callMuteState.ts)
 * and the Companion extension's Meet reader (natively-browser/src/meet-dom.ts)
 * share it.
 */

/**
 * A microphone control's label as the state it reveals: true when the control
 * would unmute (so the user is muted), false when it would mute, null for any
 * other label. Shortcut hints ("Mute (⌘⇧A)", "Turn off microphone (ctrl + d)")
 * are ignored. Labels about other people ("Mute all", "Ask to unmute",
 * "Mute Ana") are not the user's control and never match.
 */
export function muteStateOfControlLabel(label: string | null | undefined): boolean | null {
    if (typeof label !== 'string') return null;
    const text = label
        .replace(/\s*[(（][^)）]*[)）]\s*$/u, '')
        .replace(/\s*[,–—-]\s*(?:keyboard shortcut|shortcut|hotkey)\b.*$/i, '')
        .replace(/[….]+$/u, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
    if (!text || text.length > 60) return null;
    if (/^unmute(?: (?:my|your))?(?: (?:audio|microphone|mic))?$/.test(text)) return true;
    if (/^mute(?: (?:my|your))?(?: (?:audio|microphone|mic))?$/.test(text)) return false;
    if (/^turn on (?:your |the )?(?:microphone|mic)$/.test(text)) return true;
    if (/^turn off (?:your |the )?(?:microphone|mic)$/.test(text)) return false;
    return null;
}
