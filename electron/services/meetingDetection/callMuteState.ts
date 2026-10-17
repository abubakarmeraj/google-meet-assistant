/**
 * Is the user muted in the meeting app? Read from what the app shows, never
 * by touching it: the user's own video tile (Zoom labels every tile
 * "<Name>, Computer audio muted" / "… unmuted") or the app's microphone
 * control, whose label names what pressing it would do ("Unmute" while muted,
 * "Mute" while live; Meet's "Turn on microphone" / "Turn off microphone").
 *
 * Answers true, false or null. Null (nothing readable, or two signals that
 * disagree) counts as NOT muted wherever this is used: Natively never drops
 * the user's audio on a guess (meeting/MeetingMuteSync.ts).
 *
 * The control grammar lives in muteLabels.ts, which has no dependencies, so
 * the Companion extension's Meet reader (natively-browser/src/meet-dom.ts)
 * uses the same one.
 *
 * UNVERIFIED (2026-10-15): Zoom's tile phrases (and their translations below)
 * are Zoom's own wording as other tools read it; the control labels are the
 * apps' published accessibility labels. No recorded tree pins either yet:
 * check on a real call per app and OS (NATIVELY_DUMP_CALL_TREE=1).
 */
import { muteStateOfControlLabel } from './muteLabels';
import { normalizeName, plausibleName, SELF_TAG, splitOutsideBrackets, type CallTree, type CallTreeNode, type DesktopCallApp } from './callTreeSolvers';

/** Zoom's tile phrase for the person's audio, per language: [muted, unmuted]. */
export const ZOOM_TILE_AUDIO_PHRASES: ReadonlyArray<readonly [string, string | null]> = [
    ['Computer audio muted', 'Computer audio unmuted'],
    ['Bei Computeraudio Stummschaltung aktiviert', 'Bei Computeraudio Stummschaltung deaktiviert'],
    ['Audio de la computadora silenciado', 'Audio de la computadora no silenciado'],
    ['Ordinateur mis en sourdine', null],
    ['Audio komputer dibisukan', 'Audio komputer dibunyikan'],
    ['Audio computer disattivato', 'Audio computer attivato'],
    ['Computeraudio gedempt', 'Computeraudio ingeschakeld'],
    ['Datorljudet inaktiverades', 'Datorljudet aktiverades'],
];

const TILE_PHRASE = new Map<string, boolean>();
for (const [muted, unmuted] of ZOOM_TILE_AUDIO_PHRASES) {
    TILE_PHRASE.set(muted.toLowerCase(), true);
    if (unmuted) TILE_PHRASE.set(unmuted.toLowerCase(), false);
}
// The short forms a tile or a row can carry on its own.
const SHORT_STATE = new Map<string, boolean>([
    ['muted', true], ['unmuted', false], ['mic off', true], ['mic on', false],
    ['microphone off', true], ['microphone on', false], ['microphone muted', true], ['microphone unmuted', false],
]);

/** A tile part ("Computer audio muted", "Muted") as a mute state, or null. */
function tilePartState(part: string): boolean | null {
    const key = part.trim().toLowerCase();
    if (TILE_PHRASE.has(key)) return TILE_PHRASE.get(key)!;
    if (SHORT_STATE.has(key)) return SHORT_STATE.get(key)!;
    return null;
}

const CONTROL_ROLE = /button|checkbox|toggle/i;
const isMenu = (role: string) => /menu/i.test(role);
const fieldsOf = (n: CallTreeNode) => [n.name, n.description, n.value].filter((f): f is string => !!f && !!f.trim());

/** The user's own tile, read for its audio phrase: true / false, or null when this label is not theirs. */
function selfTileState(label: string, self: Set<string>): boolean | null {
    const parts = splitOutsideBrackets(label);
    if (parts.length < 2 || parts.length > 8) return null;
    let state: boolean | null = null;
    let mine = false;
    let named = false;
    for (const part of parts) {
        const s = tilePartState(part);
        if (s !== null) {
            state = s;
            continue;
        }
        if (named) continue;
        let tagged = false;
        const bare = part.replace(/\s*[(（]([^)）]*)[)）]\s*/g, (_m, inner: string) => {
            if (inner.split(/\s*[,;]\s*/).some((t) => SELF_TAG.test(t.trim()))) tagged = true;
            return ' ';
        });
        const name = plausibleName(bare);
        if (!name) continue;
        named = true;
        mine = tagged || self.has(normalizeName(name));
    }
    return mine ? state : null;
}

export { muteStateOfControlLabel };

export interface SelfMuteReading {
    muted: boolean | null;
    /** Which signal answered, for the logs. */
    via: 'self-tile' | 'control' | null;
}

/**
 * The user's mute state as `app`'s window shows it. `selfNames`: the user's
 * names (calendar account, names the app tagged "(me)"); without one the
 * Zoom tile can't be told apart from the others and only the control counts.
 */
export function selfMuteFromTree(app: DesktopCallApp, tree: CallTree | null | undefined, selfNames: readonly string[] = []): SelfMuteReading {
    void app; // Both apps share the grammar today; per-app rules go here once recorded trees differ.
    if (!tree || !tree.trusted) return { muted: null, via: null };
    const self = new Set(selfNames.map(normalizeName).filter(Boolean));
    const tile = new Set<boolean>();
    const control = new Set<boolean>();
    const micButton = new Set<boolean>();
    for (const window of tree.windows) {
        for (const node of window.nodes) {
            if (isMenu(node.role)) continue;
            const fields = fieldsOf(node);
            if (self.size > 0 || fields.some((f) => /[(（]/.test(f))) {
                for (const f of fields) {
                    const s = selfTileState(f, self);
                    if (s !== null) tile.add(s);
                }
            }
            if (!CONTROL_ROLE.test(node.role)) continue;
            for (const f of fields) {
                const s = muteStateOfControlLabel(f);
                if (s === null) continue;
                // Teams names its microphone control by element id: that one decides.
                if (/^microphone-button$/i.test(node.id)) micButton.add(s);
                else control.add(s);
            }
        }
    }
    const one = (set: Set<boolean>) => (set.size === 1 ? [...set][0] : null);
    if (tile.size > 0) return { muted: one(tile), via: tile.size === 1 ? 'self-tile' : null };
    if (micButton.size > 0) return { muted: one(micButton), via: micButton.size === 1 ? 'control' : null };
    // Several controls that disagree (a host's per-person rows): nothing is known.
    return { muted: one(control), via: control.size === 1 ? 'control' : null };
}
