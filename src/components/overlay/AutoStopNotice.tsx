import React, { useCallback, useEffect, useState } from 'react';
import { Timer } from 'lucide-react';
import { OverlayBanner, OverlayBannerButton } from '../ui/OverlayBanner';
import { useT } from '../../i18n';
import '../ui/OverlayBanner.css';

/**
 * The meeting's automatic stop, as the overlay sees it (main:
 * services/meeting/MeetingEndDetector.ts).
 *
 *  - When nothing has been said for a while, main asks for the notice: Natively
 *    stops in a minute unless something is said or the user picks Keep going.
 *    Main clears it as soon as anyone speaks, and when the meeting ends.
 *  - Typing anywhere in the overlay tells main, at most every 5 s, so a stop
 *    never lands while the user is writing a question.
 *
 * Same banner as the trial's "almost over" (OverlayBanner, warning, Timer).
 */
const TYPING_REPORT_MS = 5_000;

export interface MeetingAutoStopNotice {
  stopsAt: number | null;
  keepGoing: () => void;
}

export function useMeetingAutoStopNotice(): MeetingAutoStopNotice {
  const [stopsAt, setStopsAt] = useState<number | null>(null);

  useEffect(() => {
    const api = window.electronAPI;
    const offNotice = api?.onMeetingAutoStopNotice?.((data) => setStopsAt(typeof data?.stopsAt === 'number' ? data.stopsAt : null));
    const offState = api?.onMeetingStateChanged?.((data) => { if (!data?.isActive) setStopsAt(null); });
    return () => { offNotice?.(); offState?.(); };
  }, []);

  // Keystrokes in the overlay: no stop under the user's hands.
  useEffect(() => {
    let last = 0;
    const onKey = () => {
      const now = Date.now();
      if (now - last < TYPING_REPORT_MS) return;
      last = now;
      try { window.electronAPI?.meetingAutoStopTyping?.(); } catch { /* best-effort */ }
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('input', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('input', onKey, true);
    };
  }, []);

  const keepGoing = useCallback(() => {
    setStopsAt(null);
    window.electronAPI?.meetingAutoStopKeepGoing?.()?.catch?.(() => {});
  }, []);

  return { stopsAt, keepGoing };
}

export const AutoStopNoticeBanner: React.FC<{ notice: MeetingAutoStopNotice }> = ({ notice }) => {
  const t = useT();
  if (notice.stopsAt === null) return null;
  return (
    <OverlayBanner
      className="mx-4"
      tone="warning"
      icon={<Timer strokeWidth={2.2} />}
      message={t('Natively stops in 1 minute because nothing has been said.')}
      actions={
        <OverlayBannerButton variant="primary" onClick={notice.keepGoing}>
          {t('Keep going')}
        </OverlayBannerButton>
      }
    />
  );
};
