/**
 * Is someone sharing their screen in the call, and is it the user? Read from
 * the meeting app's window tree (call_tree.rs), never by touching the app.
 *
 *   self   the user is presenting: the app shows its share toolbar ("Stop
 *          Share", "Pause Share", "Stop presenting", "You're presenting").
 *          Wins over everything: Natively never takes a picture then.
 *   other  someone else's screen is on show: "You are viewing Ana's screen",
 *          "Ana is presenting", a share's own controls ("View Options" in
 *          Zoom; "Zoom in", "Zoom out", "Open in new window" in Teams,
 *          "Request control").
 *   none   neither.
 *
 * `windowTitle` is the window the share is shown in, for the picture
 * (meeting/ScreenShareContext.ts). Pure: no I/O; the tests run it.
 *
 * UNVERIFIED (2026-10-15): wording from the apps' published labels and from
 * what other tools look for; no recorded tree yet. English only. Check on a
 * real call per app and OS, sharing and viewing (NATIVELY_DUMP_CALL_TREE=1).
 */
import { plausibleName, type CallTree, type CallTreeNode, type DesktopCallApp } from './callTreeSolvers';

export type ShareState = 'none' | 'self' | 'other';

export interface ScreenShareReading {
    state: ShareState;
    /** The window showing someone else's share. */
    windowTitle?: string;
    /** Whose screen it is, when the app says. */
    sharerName?: string;
}

// The user presenting: a window or a control only the presenter has.
const SELF_WINDOW = /^(?:zoom share toolbar window|zoom share statusbar window|screen-share-toolbar-window|screen-share-presenter-window)$/i;
const SELF_TEXT = /^(?:you(?:'re| are) (?:screen sharing|sharing(?: your screen| a window| content)?|presenting)|stop share|stop sharing(?: screen)?|stop presenting|pause share|resume share|new share)$/i;
const SELF_ID = /^(?:ZMMTToolbarContentIdentifierPauseShare|stop-sharing-button|stop-presenting-button)$/;

// Someone else's screen on show.
const OTHER_TEXT: RegExp[] = [
    /^you(?:'re| are) viewing (.+?)['’]s? (?:screen|shared screen|window|content)$/i,
    /^viewing (.+?)['’]s? (?:screen|shared screen|window|content)$/i,
    /^(.+?) is (?:presenting|sharing(?: (?:their|a|the))?(?: screen| window| content)?)$/i,
    /^(.+?)['’]s? (?:screen|shared screen)$/i,
];
const OTHER_CONTROL = /^(?:view options|request control|take control|request remote control)$/i;
const TEAMS_VIEWER_CONTROLS = /^(?:zoom in|zoom out|open in new window|pop out)$/i;

const texts = (n: CallTreeNode) => [n.name, n.description, n.value].map((f) => (f ?? '').trim()).filter(Boolean);

export function screenShareFromTree(app: DesktopCallApp, tree: CallTree | null | undefined): ScreenShareReading {
    void app; // One grammar for both apps until recorded trees show a difference.
    if (!tree || !tree.trusted) return { state: 'none' };
    let other: ScreenShareReading | null = null;
    for (const window of tree.windows) {
        if (SELF_WINDOW.test(window.title.trim())) return { state: 'self' };
        let viewerControls = 0;
        for (const node of window.nodes) {
            if (SELF_ID.test(node.id)) return { state: 'self' };
            for (const t of texts(node)) {
                if (SELF_TEXT.test(t)) return { state: 'self' };
                if (other && other.sharerName) continue;
                for (const re of OTHER_TEXT) {
                    const m = re.exec(t);
                    if (!m) continue;
                    const who = plausibleName(m[1]);
                    // "You are presenting" is the user's own share, never someone else's.
                    if (who && !/^(?:you|i)$/i.test(who)) {
                        other = { state: 'other', windowTitle: window.title, sharerName: who };
                        break;
                    }
                }
                if (!other && /button/i.test(node.role) && OTHER_CONTROL.test(t)) other = { state: 'other', windowTitle: window.title };
                if (/button/i.test(node.role) && TEAMS_VIEWER_CONTROLS.test(t)) viewerControls++;
            }
        }
        // Teams puts its zoom and pop-out controls on a share it is showing.
        if (!other && viewerControls >= 2) other = { state: 'other', windowTitle: window.title };
    }
    return other ?? { state: 'none' };
}
