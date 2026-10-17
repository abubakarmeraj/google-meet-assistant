/**
 * Who is in a desktop call and who is speaking, read from the meeting app's
 * own window: the flattened accessibility tree the native module returns
 * (native-module/src/call_tree.rs: macOS AX, Windows UI Automation).
 *
 * The apps label their participant rows and video tiles for screen readers,
 * as a short list: "Ana Lopez (Host), Computer audio unmuted, Video on",
 * "Ana Lopez, Speaking", "Ana Lopez (You)". So a node counts as a person only
 * when its text has a name AND at least one call-state word (muted, video,
 * host, speaking …): a chat list's "Ana Lopez, Available" or a button's
 * "Participants" never does. A tile whose speaking mark is a separate node
 * (an icon described "Speaking") is matched to the one name in its tile.
 *
 * The user's own tile is left out: the microphone channel is already "me".
 * Own is a "(me)" / "(You)" tag, or a name the caller already knows is the
 * user's (and one learned from a tag earlier in the call).
 *
 * UNVERIFIED (2026-10-15): the wording and tree shapes are taken from the
 * apps' published accessibility labels, not from a recorded call. Each app and
 * OS needs a recorded tree (NATIVELY_DUMP_CALL_TREE=1) pinned as a fixture in
 * electron/services/__tests__/fixtures/ before this is trusted, and again on
 * each app update. Pure: platform is passed in.
 */
import type { PersonReport } from './callRoster';

export type DesktopCallApp = 'zoom' | 'teams';

export interface CallTreeNode {
    depth: number;
    role: string;
    name: string;
    description: string;
    value: string;
    id: string;
    /** A link's address (AXURL / a Hyperlink's Value); absent from older native builds. */
    url?: string;
}

export interface CallTreeWindow {
    title: string;
    nodes: CallTreeNode[];
}

export interface CallTree {
    trusted: boolean;
    truncated: boolean;
    windows: CallTreeWindow[];
    elapsedMs?: number;
}

export interface SolvedCall {
    /** Everyone else in the call, as callRoster takes them. */
    people: PersonReport[];
    /** Names the tree marked as the user's own ("(me)", "(You)"). */
    selfNames: string[];
    selfSpeaking: boolean;
}

// Words in a label that say "speaking", alone or with the name ("Ana is speaking").
const SPEAKING = [
    'speaking', 'is speaking', 'talking', 'is talking', 'currently speaking', 'active speaker',
    'spricht', 'parle', 'en train de parler', 'hablando', 'está hablando', 'falando', 'está falando',
    'sta parlando', 'spreekt', 'aan het woord', '発言中', '話しています', '正在讲话', '正在说话', '말하는 중',
];
const SPEAKING_PART = new RegExp(`^(?:${SPEAKING.map(escapeRe).join('|')})$`, 'i');
const NAME_THEN_SPEAKING = /^(.+?)\s+(?:is\s+(?:speaking|talking)|spricht|parle|est en train de parler|está hablando|está falando|sta parlando|spreekt)$/i;
const SPEAKING_THEN_NAME = /^(?:speaking|talking|active speaker|now speaking)\s*:\s*(.+)$/i;
const SELF_SPEAKING = /^(?:you(?:'re| are) (?:speaking|talking)|du sprichst|vous parlez|estás hablando)$/i;

// Call-state words that make a label a participant's.
const STATE_PART = new RegExp(
    '^(?:'
    + [
        '(?:computer |phone |)audio (?:muted|unmuted|connected|disconnected|off|on)',
        '(?:un)?muted', 'mic(?:rophone)? (?:on|off|muted|unmuted|is on|is off)',
        '(?:video|camera) (?:on|off|is on|is off|started|stopped)',
        '(?:co-?)?host', 'organi[sz]er', 'co-organi[sz]er', 'presenter', 'attendee', 'panelist', 'guest', 'external',
        'hand raised', 'raised hand', 'pinned', 'spotlighted', 'spotlight', 'screen sharing', 'sharing screen', 'is presenting',
        'in the lobby', 'waiting', 'not connected', 'unverified',
        'stummgeschaltet', 'stummschaltung aufgehoben', 'gastgeber', 'micro coupé', 'muet', 'organisateur', 'hôte',
        'silenciado', 'anfitrión', 'organizador', 'sem áudio', 'mudo', 'disattivato', 'gedempt',
        // Zoom's self/participant tile phrase in its other languages (see callMuteState.ts).
        'bei computeraudio stummschaltung (?:aktiviert|deaktiviert)', 'audio de la computadora (?:no )?silenciado',
        'ordinateur mis en sourdine', 'audio komputer (?:dibunyikan|dibisukan)', 'audio computer (?:attivato|disattivato)',
        'computeraudio (?:ingeschakeld|gedempt)', 'datorljudet (?:aktiverades|inaktiverades)',
    ].join('|')
    + ')$',
    'i',
);
export const SELF_TAG = /^(?:me|you|myself|ich|moi|yo|eu|io|ik|我|自分|나)$/i;
// Labels of the apps' own controls and panes, never a person.
const UI_WORDS = /^(?:mute|unmute|start video|stop video|participants?|people|chat|share(?: screen)?|more|leave|end|record(?:ing)?|reactions?|apps|security|view|gallery(?: view)?|speaker(?: view)?|close|minimize|maximize|zoom(?: meeting| workplace| webinar)?|microsoft teams|meeting|call|camera|mic(?:rophone)?|audio|video|settings|invite|raise hand|lower hand|you|me|host|guest|in this meeting|in the meeting|attendees|search|send|options|copy|join|admit|deny|remove|rename|pin|spotlight|everyone|waiting room|lobby)$/i;

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** For comparing names: case, spacing and punctuation don't matter. */
export function normalizeName(name: string): string {
    return name.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

export function plausibleName(raw: string): string | null {
    const name = raw.replace(/\s+/g, ' ').trim();
    if (name.length < 1 || name.length > 60) return null;
    if (!/\p{L}/u.test(name)) return null;
    if (name.split(' ').length > 6) return null;
    if (UI_WORDS.test(name) || SPEAKING_PART.test(name) || STATE_PART.test(name)) return null;
    if (/^\d|[:@/\\]|https?/i.test(name)) return null;
    return name;
}

/** "Ana (Host, me), Muted" → ["Ana (Host, me)", "Muted"]: separators inside brackets stay. */
export function splitOutsideBrackets(text: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let current = '';
    for (const ch of text) {
        if (ch === '(' || ch === '（') depth++;
        else if ((ch === ')' || ch === '）') && depth > 0) depth--;
        if (depth === 0 && /[,;|•·]/.test(ch)) {
            parts.push(current);
            current = '';
        } else {
            current += ch;
        }
    }
    parts.push(current);
    return parts.map((p) => p.trim()).filter(Boolean);
}

interface Person {
    name: string;
    speaking: boolean;
    self: boolean;
}

/**
 * One label as a person: a name with call state, or null. Tags in brackets
 * ("(Host, me)") are read and taken off the name.
 */
export function readPersonLabel(text: string): Person | null {
    const raw = text.trim();
    if (!raw) return null;
    if (SELF_SPEAKING.test(raw)) return null;
    const parts = splitOutsideBrackets(raw);
    if (parts.length === 0 || parts.length > 8) return null;
    let name: string | null = null;
    let speaking = false;
    let evidence = false;
    for (const part of parts) {
        if (SPEAKING_PART.test(part)) {
            speaking = true;
            evidence = true;
            continue;
        }
        if (STATE_PART.test(part)) {
            evidence = true;
            continue;
        }
        const named = NAME_THEN_SPEAKING.exec(part) ?? SPEAKING_THEN_NAME.exec(part);
        if (named && name === null) {
            name = named[1];
            speaking = true;
            evidence = true;
            continue;
        }
        // A second free-text part: a sentence or a status ("Available"), not a tile.
        if (name !== null) return null;
        name = part;
    }
    if (name === null) return null;
    let self = false;
    const bare = name.replace(/\s*[(（]([^)）]*)[)）]\s*/g, (_m, inner: string) => {
        for (const tag of inner.split(/\s*[,;]\s*/)) {
            const t = tag.trim();
            if (SELF_TAG.test(t)) {
                self = true;
                evidence = true;
            } else if (SPEAKING_PART.test(t)) {
                speaking = true;
                evidence = true;
            } else if (STATE_PART.test(t)) {
                evidence = true;
            }
        }
        return ' ';
    });
    const clean = plausibleName(bare);
    if (!clean || !evidence) return null;
    return { name: clean, speaking, self };
}

function readNode(node: CallTreeNode): Person | null {
    const fields = [node.name, node.description, node.value].filter(Boolean);
    for (const f of fields) {
        const p = readPersonLabel(f);
        if (p) return p;
    }
    // Name in one field, state in another ("Ana Lopez" + "Speaking").
    return fields.length > 1 ? readPersonLabel(fields.join(', ')) : null;
}

const isMenu = (role: string) => /menu/i.test(role);
const markerOnly = (node: CallTreeNode) => [node.name, node.description, node.value].some((f) => SPEAKING_PART.test(f.trim()));

/** The tile's person: its own label, else the one plausible bare name in its subtree; or null. */
function soleNameUnder(nodes: CallTreeNode[], parent: number, skip: number): string | null {
    const own = readNode(nodes[parent]);
    if (own) return own.self ? null : own.name;
    const depth = nodes[parent].depth;
    let found: string | null = null;
    for (let i = parent + 1; i < nodes.length && nodes[i].depth > depth; i++) {
        if (i === skip || isMenu(nodes[i].role)) continue;
        for (const f of [nodes[i].name, nodes[i].description, nodes[i].value]) {
            const n = f ? plausibleName(f.replace(/\s*[(（][^)）]*[)）]\s*/g, ' ')) : null;
            if (!n) continue;
            if (found !== null && normalizeName(found) !== normalizeName(n)) return null;
            found = n;
        }
    }
    return found;
}

function parentOf(nodes: CallTreeNode[], index: number): number {
    for (let j = index - 1; j >= 0; j--) if (nodes[j].depth < nodes[index].depth) return j;
    return -1;
}

/**
 * The call as `app`'s window shows it. `knownSelf`: names already known to be
 * the user's (the calendar account's name, ones learned earlier in the call).
 */
export function solveCallTree(app: DesktopCallApp, tree: CallTree | null | undefined, knownSelf: string[] = []): SolvedCall {
    void app; // Both apps share the label grammar today; per-app rules go here once recorded trees show a difference.
    const out: SolvedCall = { people: [], selfNames: [], selfSpeaking: false };
    if (!tree || !tree.trusted) return out;
    const self = new Set(knownSelf.map(normalizeName).filter(Boolean));
    const byName = new Map<string, Person>();
    const add = (p: Person) => {
        const key = normalizeName(p.name);
        if (!key) return;
        const prev = byName.get(key);
        if (prev) {
            prev.speaking ||= p.speaking;
            prev.self ||= p.self;
        } else {
            byName.set(key, { ...p });
        }
    };
    for (const window of tree.windows) {
        const nodes = window.nodes;
        nodes.forEach((node, i) => {
            if (isMenu(node.role)) return;
            if ([node.name, node.description, node.value].some((f) => SELF_SPEAKING.test(f.trim()))) {
                out.selfSpeaking = true;
                return;
            }
            const person = readNode(node);
            if (person) {
                add(person);
                return;
            }
            // A speaking mark of its own: the person is the one name in its tile.
            if (markerOnly(node)) {
                let parent = parentOf(nodes, i);
                for (let level = 0; level < 2 && parent >= 0; level++) {
                    const name = soleNameUnder(nodes, parent, i);
                    if (name) {
                        add({ name, speaking: true, self: false });
                        return;
                    }
                    parent = parentOf(nodes, parent);
                }
            }
        });
    }
    for (const [key, p] of byName) {
        if (p.self) {
            out.selfNames.push(p.name);
            self.add(key);
        }
    }
    for (const [key, p] of byName) {
        if (self.has(key)) {
            if (p.speaking) out.selfSpeaking = true;
            continue;
        }
        out.people.push({ name: p.name, speaking: p.speaking });
    }
    return out;
}
