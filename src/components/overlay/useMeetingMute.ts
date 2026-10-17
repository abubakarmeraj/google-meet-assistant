import { useEffect, useState } from 'react';

/**
 * The meeting app's mute, as main follows it ("Follow the meeting app's mute";
 * main: services/meeting/MeetingMuteSync.ts). While `muted`, the mic channel
 * is transcribed as silence; the overlay says so with a small pill. Cleared
 * when the meeting ends.
 */
export interface MeetingMute {
  muted: boolean;
  /** "Zoom", "Teams", "Google Meet", or null when unknown. */
  app: string | null;
}

export function useMeetingMute(): MeetingMute {
  const [state, setState] = useState<MeetingMute>({ muted: false, app: null });
  useEffect(() => {
    const api = window.electronAPI;
    let live = true;
    api?.getMeetingMuteState?.()
      .then((s) => { if (live && s) setState({ muted: s.muted === true, app: s.app ?? null }); })
      .catch(() => { /* the pill stays hidden */ });
    const offMute = api?.onMeetingMuteChanged?.((s) => setState({ muted: s.muted === true, app: s.app ?? null }));
    const offState = api?.onMeetingStateChanged?.((data) => { if (!data?.isActive) setState({ muted: false, app: null }); });
    return () => { live = false; offMute?.(); offState?.(); };
  }, []);
  return state;
}
