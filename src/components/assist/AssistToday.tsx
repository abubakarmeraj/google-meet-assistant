import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, ChevronDown, Copy, Mail, RefreshCw, X } from 'lucide-react';
import { useT } from '../../i18n';
import { buildReminderDraft, clipboardText, mailtoUrl, reminderGmailUrl, type ReminderDraft, type ReminderKind } from '../../lib/reminderDrafts.mjs';
import { ASSIST_REFRESH_MS, clearReopenedTicks, msUntilNextLocalMidnight } from '../../lib/assistRefresh.mjs';
import type { AssistCatchUp, AssistDailyBrief, AssistEvent, AssistMeetingBrief, AssistOwedItem, AssistSender } from '../../types/assist';

/**
 * The launcher's assist sections (main: electron/services/assist):
 *
 *   Coming up today   today's remaining meetings in order, one line of
 *                     context each (last time, last met, first meeting).
 *                     "Brief me" opens the pre-meeting brief under the row;
 *                     the mail button drafts "running late", "are you
 *                     joining?" or "can we move it?" for the user to send.
 *   You owe           the user's open action items across recent meetings,
 *                     overdue first; ticking one is kept on this computer
 *                     only; the text opens its meeting.
 *   Catch up          after back-to-back meetings: what was decided and what
 *                     the user took on, across them (Settings › Calendar).
 *
 * Everything shown is read from local notes. The one model call (the brief's
 * talking points) runs only on "Brief me". Rows reuse the meetings list's own
 * row, heading and pill styles below them in the Launcher.
 */

const ROW = 'group relative flex items-center justify-between gap-3 px-3 py-2 rounded-lg bg-transparent hover:bg-bg-elevated transition-colors';
const HEADING = 'text-[13px] font-medium text-text-secondary mb-3 pl-1';
const PILL = 'bg-bg-elevated text-text-secondary text-[9px] px-1.5 py-0.5 rounded-full font-medium tracking-wide whitespace-nowrap';
const SMALL_BUTTON = 'inline-flex items-center gap-1.5 text-[12px] font-medium px-2.5 h-7 rounded-md text-text-primary transition-colors';

const timeOf = (iso: string) => {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).toLowerCase() : '';
};
const dayOf = (ms: number) => new Date(ms).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

interface AssistTodayProps {
  /** The launcher's upcoming events (CalendarManager). */
  events: AssistEvent[];
  isLight: boolean;
  isMeetingActive: boolean;
  onOpenMeeting: (meetingId: string) => void;
  /** A draft to open (the calendar reminder's "Running late"); a new `seq` is a new request. */
  draftRequest?: { event: AssistEvent; kind: ReminderKind; seq: number } | null;
}

export const AssistToday: React.FC<AssistTodayProps> = ({ events, isLight, isMeetingActive, onOpenMeeting, draftRequest }) => {
  const t = useT();
  const api = window.electronAPI;
  const [brief, setBrief] = useState<AssistDailyBrief | null>(null);
  const [catchUp, setCatchUp] = useState<AssistCatchUp | null>(null);
  const [owedAll, setOwedAll] = useState<AssistOwedItem[] | null>(null);
  // Ticked here: key -> when (cleared when a later read lists the item open again).
  const [ticked, setTicked] = useState<Record<string, number>>({});
  const [openBrief, setOpenBrief] = useState<string | null>(null);
  const [draftFor, setDraftFor] = useState<{ eventId: string; kind: ReminderKind; event?: AssistEvent } | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [sender, setSender] = useState<AssistSender | null>(null);
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const hover = isLight ? 'bg-black/[0.05] hover:bg-black/[0.09]' : 'bg-white/[0.06] hover:bg-white/[0.1]';

  // "Show all" expanded: the full list reads again with the rest.
  const owedExpandedRef = useRef(false);
  owedExpandedRef.current = owedAll !== null;
  const refresh = useCallback(() => {
    const requestedAt = Date.now();
    api?.assistGetDailyBrief?.(eventsRef.current ?? []).then((b) => {
      setBrief(b ?? null);
      if (b?.owed) setTicked((prev) => clearReopenedTicks(prev, b.owed, requestedAt));
    }).catch(() => {});
    api?.assistGetCatchUp?.().then((c) => setCatchUp(c ?? null)).catch(() => {});
    if (owedExpandedRef.current) {
      api?.assistGetOwed?.().then((all) => {
        if (!owedExpandedRef.current) return;
        const list = Array.isArray(all) ? all : [];
        setOwedAll(list);
        setTicked((prev) => clearReopenedTicks(prev, list, requestedAt));
      }).catch(() => {});
    }
  }, [api]);

  // A launcher left open: read again just after local midnight (a new
  // "today", new overdue items), every 5 minutes while visible, and when the
  // window comes back into view (src/lib/assistRefresh.mjs).
  useEffect(() => {
    let midnight: ReturnType<typeof setTimeout> | null = null;
    const armMidnight = () => {
      midnight = setTimeout(() => { refresh(); armMidnight(); }, msUntilNextLocalMidnight(Date.now()));
    };
    armMidnight();
    const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
    const every = setInterval(() => { if (visible()) refresh(); }, ASSIST_REFRESH_MS);
    const onVisibility = () => { if (visible()) refresh(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      if (midnight) clearTimeout(midnight);
      clearInterval(every);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refresh]);

  // Events change every minute (the launcher's poll); the lists are local reads.
  const eventsKey = useMemo(() => (events ?? []).map((e) => `${e.id}@${e.startTime}`).join('|'), [events]);
  useEffect(() => { refresh(); }, [eventsKey, isMeetingActive, refresh]);
  useEffect(() => {
    const off = api?.onMeetingsUpdated?.(() => refresh());
    return () => { off?.(); };
  }, [api, refresh]);
  useEffect(() => {
    api?.assistGetSender?.().then((s) => setSender(s ?? null)).catch(() => {});
  }, [api]);

  // The calendar reminder's "Running late": App receives it (always mounted)
  // and the Launcher hands it down here, back on its list.
  const handledDraft = useRef(draftRequest?.seq ?? 0);
  useEffect(() => {
    if (!draftRequest || draftRequest.seq === handledDraft.current) return;
    handledDraft.current = draftRequest.seq;
    setDraftFor({ eventId: draftRequest.event.id, kind: draftRequest.kind, event: draftRequest.event });
    setOpenBrief(null);
    setMenuFor(null);
  }, [draftRequest]);

  const eventById = useCallback((id: string) => (events ?? []).find((e) => e.id === id), [events]);

  const setTick = (key: string, on: boolean) => setTicked((prev) => {
    const next = { ...prev };
    if (on) next[key] = Date.now();
    else delete next[key];
    return next;
  });
  const toggleOwed = (item: AssistOwedItem) => {
    const next = !(item.key in ticked);
    setTick(item.key, next);
    api?.assistSetOwedDone?.(item.key, next)
      .then((r) => { if (!r?.ok) setTick(item.key, !next); })
      .catch(() => setTick(item.key, !next));
  };

  const owed = owedAll ?? brief?.owed ?? [];
  const owedTotal = owedAll ? owedAll.length : brief?.owedTotal ?? 0;
  const todays = brief?.meetings ?? [];

  // A draft asked for from the calendar reminder for an event not listed here.
  const orphanDraft = draftFor && !todays.some((m) => m.eventId === draftFor.eventId) ? (eventById(draftFor.eventId) ?? draftFor.event ?? null) : null;

  if (todays.length === 0 && owed.length === 0 && !catchUp && !orphanDraft) return null;

  return (
    <div className="space-y-8">
      {orphanDraft && draftFor && (
        <section>
          <h3 className={HEADING}>{orphanDraft.title || t('Meeting')}</h3>
          <ReminderDraftPanel event={orphanDraft} kind={draftFor.kind} sender={sender} isLight={isLight} onClose={() => setDraftFor(null)} />
        </section>
      )}
      {catchUp && (
        <section>
          <div className="flex items-center justify-between mb-3 pl-1">
            <h3 className="text-[13px] font-medium text-text-secondary">{t('Catch up')}</h3>
            <button
              type="button"
              aria-label={t('Dismiss')}
              onClick={() => { api?.assistDismissCatchUp?.(catchUp.key)?.catch?.(() => {}); setCatchUp(null); }}
              className="p-1.5 text-text-tertiary hover:text-text-primary transition-colors"
            >
              <X size={14} />
            </button>
          </div>
          <div className="px-3 space-y-3">
            <p className="text-[13px] text-text-secondary leading-snug">
              {t('After your back-to-back meetings:')} {catchUp.meetings.map((m) => m.title).join(', ')}
            </p>
            {catchUp.decisions.length > 0 && (
              <div>
                <div className="text-[12px] font-medium text-text-secondary mb-1">{t('Decided')}</div>
                <ul className="space-y-1">
                  {catchUp.decisions.map((d, i) => (
                    <li key={`d${i}`} className="text-[13px] text-text-primary leading-snug">
                      <button type="button" className="text-left hover:underline underline-offset-2" onClick={() => onOpenMeeting(d.meetingId)}>{d.text}</button>
                      <span className="text-text-tertiary"> · {d.meetingTitle}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {catchUp.yourActions.length > 0 && (
              <div>
                <div className="text-[12px] font-medium text-text-secondary mb-1">{t('Yours to do')}</div>
                <ul className="space-y-1">
                  {catchUp.yourActions.map((a, i) => (
                    <li key={`a${i}`} className="text-[13px] text-text-primary leading-snug">
                      <button type="button" className="text-left hover:underline underline-offset-2" onClick={() => onOpenMeeting(a.meetingId)}>{a.text}</button>
                      <span className="text-text-tertiary"> · {a.deadline ? `${a.deadline} · ` : ''}{a.meetingTitle}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </section>
      )}

      {todays.length > 0 && (
        <section>
          <h3 className={HEADING}>{t('Coming up today')}</h3>
          <div className="space-y-1">
            {todays.map((m) => {
              const ev = eventById(m.eventId);
              return (
                <div key={m.eventId}>
                  <div className={ROW}>
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-[14px] text-text-primary truncate">{m.title}</div>
                      {m.context && (
                        m.contextMeetingId ? (
                          <button type="button" onClick={() => onOpenMeeting(m.contextMeetingId!)} className="block max-w-full text-left text-[12px] text-text-secondary truncate hover:text-text-primary transition-colors">
                            {m.context}
                          </button>
                        ) : (
                          <div className="text-[12px] text-text-secondary truncate">{m.context}</div>
                        )
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {ev && (
                        <button
                          type="button"
                          onClick={() => { setOpenBrief(openBrief === m.eventId ? null : m.eventId); setDraftFor(null); }}
                          className={`${SMALL_BUTTON} ${hover}`}
                          aria-expanded={openBrief === m.eventId}
                        >
                          {t('Brief me')}
                          <ChevronDown size={12} className={`transition-transform ${openBrief === m.eventId ? 'rotate-180' : ''}`} />
                        </button>
                      )}
                      {ev && (ev.attendees?.length ?? 0) > 0 && (
                        <div className="relative">
                          <button
                            type="button"
                            aria-label={t('Draft a note to the attendees')}
                            title={t('Draft a note to the attendees')}
                            onClick={() => setMenuFor(menuFor === m.eventId ? null : m.eventId)}
                            className="p-1.5 text-text-secondary hover:text-text-primary transition-colors"
                          >
                            <Mail size={15} />
                          </button>
                          <AnimatePresence>
                            {menuFor === m.eventId && (
                              <motion.div
                                key="menu"
                                initial={{ opacity: 0, scale: 0.95, y: 6 }}
                                animate={{ opacity: 1, scale: 1, y: 0 }}
                                exit={{ opacity: 0, scale: 0.95, y: 4 }}
                                transition={{ duration: 0.1 }}
                                className={`absolute right-0 top-full mt-1 w-[180px] backdrop-blur-xl rounded-lg shadow-2xl z-50 overflow-hidden border ${isLight ? 'bg-bg-elevated border-border-muted shadow-[0_8px_24px_rgba(0,0,0,0.12)]' : 'bg-[#1E1E1E]/80 border-white/10'}`}
                                onMouseLeave={() => setMenuFor(null)}
                              >
                                <div className="p-1 flex flex-col gap-0.5">
                                  {([
                                    ['running_late', t('Running late')],
                                    ['no_show', t('Are you joining?')],
                                    ['reschedule', t('Can we move it?')],
                                  ] as Array<[ReminderKind, string]>).map(([kind, label]) => (
                                    <button
                                      key={kind}
                                      type="button"
                                      className={`w-full px-3 py-1.5 text-[12px] text-text-primary rounded-lg transition-colors text-left ${isLight ? 'hover:bg-bg-item-surface' : 'hover:bg-white/10'}`}
                                      onClick={() => { setMenuFor(null); setOpenBrief(null); setDraftFor({ eventId: m.eventId, kind }); }}
                                    >
                                      {label}
                                    </button>
                                  ))}
                                </div>
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </div>
                      )}
                      <span className="text-[13px] text-text-secondary font-medium min-w-[60px] text-right">{timeOf(m.startTime)}</span>
                    </div>
                  </div>
                  {openBrief === m.eventId && ev && (
                    <MeetingBriefPanel event={ev} onOpenMeeting={onOpenMeeting} />
                  )}
                  {draftFor?.eventId === m.eventId && ev && (
                    <ReminderDraftPanel event={ev} kind={draftFor.kind} sender={sender} isLight={isLight} onClose={() => setDraftFor(null)} />
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {owed.length > 0 && (
        <section>
          <h3 className={HEADING}>{t('You owe')}</h3>
          <div className="space-y-1">
            {owed.map((item) => {
              const done = item.key in ticked;
              return (
                <div key={item.key} className={ROW}>
                  <div className="flex items-start gap-2.5 min-w-0 flex-1">
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={done}
                      aria-label={done ? t('Mark as not done') : t('Mark as done')}
                      onClick={() => toggleOwed(item)}
                      className={`mt-[3px] w-[14px] h-[14px] shrink-0 rounded-full border flex items-center justify-center transition-colors ${done ? 'bg-text-secondary border-text-secondary' : 'border-text-tertiary hover:border-text-secondary'}`}
                    >
                      {done && <Check size={10} strokeWidth={3} className={isLight ? 'text-white' : 'text-black'} />}
                    </button>
                    <button type="button" onClick={() => onOpenMeeting(item.meetingId)} className="min-w-0 text-left">
                      <div className={`text-[14px] leading-snug ${done ? 'text-text-tertiary line-through' : 'text-text-primary'}`}>{item.text}</div>
                      <div className="text-[12px] text-text-secondary truncate">
                        {item.meetingTitle} · {dayOf(item.meetingStartMs)}
                      </div>
                    </button>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {item.overdue && !done ? (
                      <span className="bg-red-500/10 text-red-400 text-[9px] px-1.5 py-0.5 rounded-full font-medium tracking-wide whitespace-nowrap">{t('Overdue')}</span>
                    ) : item.deadline ? (
                      <span className={PILL}>{item.deadline}</span>
                    ) : null}
                  </div>
                </div>
              );
            })}
            {!owedAll && owedTotal > owed.length && (
              <button
                type="button"
                onClick={() => api?.assistGetOwed?.().then((all) => setOwedAll(Array.isArray(all) ? all : null)).catch(() => {})}
                className="px-3 py-1.5 text-[12px] font-medium text-text-secondary hover:text-text-primary transition-colors"
              >
                {t('Show all')} ({owedTotal})
              </button>
            )}
          </div>
        </section>
      )}
    </div>
  );
};

/** The brief under an upcoming meeting's row. */
const MeetingBriefPanel: React.FC<{ event: AssistEvent; onOpenMeeting: (id: string) => void }> = ({ event, onOpenMeeting }) => {
  const t = useT();
  const [brief, setBrief] = useState<AssistMeetingBrief | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback((refresh: boolean) => {
    setLoading(true);
    setError(null);
    window.electronAPI?.assistGetMeetingBrief?.(event, { refresh })
      .then((r) => {
        if (r && r.ok) setBrief(r.brief);
        else setError((r as any)?.error ?? t('The brief could not be put together for this event.'));
      })
      .catch(() => setError(t('The brief could not be put together for this event.')))
      .finally(() => setLoading(false));
  }, [event, t]);
  useEffect(() => { load(false); }, [load]);

  return (
    <div className="mx-3 mb-2 mt-1 pl-3 space-y-3">
      {loading && !brief && <p className="text-[12px] text-text-secondary">{t('Putting your brief together…')}</p>}
      {error && <p className="text-[12px] text-text-secondary">{error}</p>}
      {brief && (
        <>
          {brief.people.length > 0 && (
            <div>
              <div className="text-[12px] font-medium text-text-secondary mb-1">{t('Who is coming')}</div>
              <ul className="space-y-1.5">
                {brief.people.map((p) => (
                  <li key={p.email} className="text-[13px] leading-snug">
                    <span className="text-text-primary font-medium">{p.name}</span>
                    {p.lastMet ? (
                      <>
                        <span className="text-text-secondary"> · {t('last met')} </span>
                        <button type="button" onClick={() => onOpenMeeting(p.lastMet!.meetingId)} className="text-text-secondary hover:text-text-primary hover:underline underline-offset-2">
                          {dayOf(p.lastMet.startMs)}, {p.lastMet.title}
                        </button>
                      </>
                    ) : (
                      <span className="text-text-secondary"> · {t('no earlier meeting saved')}</span>
                    )}
                    {p.theirOpenItems.length > 0 && (
                      <ul className="mt-0.5 space-y-0.5">
                        {p.theirOpenItems.map((it, i) => (
                          <li key={i} className="text-[12px] text-text-secondary">{t('Still owes:')} {it.text}{it.deadline ? ` (${it.deadline})` : ''}</li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {brief.lastTime && (
            <div>
              <button type="button" onClick={() => onOpenMeeting(brief.lastTime!.meetingId)} className="text-[12px] font-medium text-text-secondary mb-1 hover:text-text-primary">
                {brief.lastTime.title}
              </button>
              <ul className="space-y-0.5">
                {brief.lastTime.bullets.map((b, i) => <li key={i} className="text-[13px] text-text-primary leading-snug">{`• ${b}`}</li>)}
              </ul>
            </div>
          )}
          {brief.yourOpenItems.length > 0 && (
            <div>
              <div className="text-[12px] font-medium text-text-secondary mb-1">{t('You still owe them')}</div>
              <ul className="space-y-0.5">
                {brief.yourOpenItems.map((it) => (
                  <li key={it.key} className="text-[13px] text-text-primary leading-snug">
                    {`• ${it.text}`}{it.deadline ? <span className="text-text-secondary">{` (${it.deadline})`}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {brief.talkingPoints.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[12px] font-medium text-text-secondary">{t('Worth raising')}</span>
                {brief.talkingPointsFrom === 'model' && (
                  <button type="button" onClick={() => load(true)} aria-label={t('Write again')} title={t('Write again')} className="p-0.5 text-text-tertiary hover:text-text-primary transition-colors">
                    <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
                  </button>
                )}
              </div>
              <ul className="space-y-0.5">
                {brief.talkingPoints.map((p, i) => <li key={i} className="text-[13px] text-text-primary leading-snug">{`• ${p}`}</li>)}
              </ul>
              {brief.modelSkipped === 'privacy' && (
                <p className="mt-1 text-[11px] text-text-tertiary">{t('From your notes only: meeting notes are kept from cloud models in Settings › AI Providers.')}</p>
              )}
            </div>
          )}
          {brief.people.length === 0 && !brief.lastTime && brief.yourOpenItems.length === 0 && brief.talkingPoints.length === 0 && (
            <p className="text-[12px] text-text-secondary">{t('Nothing saved yet about this meeting or the people on it.')}</p>
          )}
        </>
      )}
    </div>
  );
};

/** A reminder draft under an upcoming meeting's row: copy it, or open it in a mail app. Never sent by Natively. */
const ReminderDraftPanel: React.FC<{ event: AssistEvent; kind: ReminderKind; sender: AssistSender | null; isLight: boolean; onClose: () => void }> = ({ event, kind, sender, isLight, onClose }) => {
  const t = useT();
  const [minutes, setMinutes] = useState(5);
  const [note, setNote] = useState<string | null>(null);
  const draft: ReminderDraft = useMemo(
    () => buildReminderDraft({ kind, event, senderName: sender?.name ?? null, minutesLate: minutes }),
    [kind, event, sender?.name, minutes],
  );
  const hover = isLight ? 'bg-black/[0.05] hover:bg-black/[0.09]' : 'bg-white/[0.06] hover:bg-white/[0.1]';

  const copy = async (): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(clipboardText(draft));
      setNote(t('Copied. Paste it into your email or chat.'));
      return true;
    } catch {
      setNote(t('Could not copy. Select the text and copy it instead.'));
      return false;
    }
  };
  const openMail = async () => {
    const url = mailtoUrl(draft);
    if (!url) { await copy(); return; }
    const r = await window.electronAPI?.assistOpenMailDraft?.(url).catch(() => null);
    if (!r?.ok) {
      await copy();
      setNote(r?.error ?? t('No mail app opened. The draft is on your clipboard instead.'));
    }
  };
  const openGmail = () => {
    void window.electronAPI?.openExternal?.(reminderGmailUrl(draft, sender?.email ?? undefined));
  };

  return (
    <div className="mx-3 mb-2 mt-1 pl-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[12px] font-medium text-text-secondary truncate">{t('To')}: {draft.to.join(', ')}</div>
        <button type="button" aria-label={t('Close')} onClick={onClose} className="p-1 text-text-tertiary hover:text-text-primary transition-colors"><X size={13} /></button>
      </div>
      {kind === 'running_late' && (
        <div className="flex items-center gap-1.5">
          {[5, 10, 15].map((n) => (
            <button key={n} type="button" onClick={() => setMinutes(n)} className={`${SMALL_BUTTON} h-6 ${minutes === n ? (isLight ? 'bg-black/[0.12]' : 'bg-white/[0.16]') : hover}`}>
              {n} {t('min')}
            </button>
          ))}
        </div>
      )}
      <div className="text-[13px] text-text-primary font-medium select-text">{draft.subject}</div>
      <pre className="whitespace-pre-wrap font-sans text-[13px] leading-relaxed text-text-primary select-text">{draft.body}</pre>
      <div className="flex flex-wrap items-center gap-1.5 pt-1">
        <button type="button" onClick={() => { void copy(); }} className={`${SMALL_BUTTON} ${hover}`}><Copy size={12} />{t('Copy')}</button>
        <button type="button" onClick={() => { void openMail(); }} className={`${SMALL_BUTTON} ${hover}`}><Mail size={12} />{t('Open in mail app')}</button>
        {sender?.google && (
          <button type="button" onClick={openGmail} className={`${SMALL_BUTTON} ${hover}`}>{t('Open in Gmail')}</button>
        )}
      </div>
      {note && <p className="text-[12px] text-text-secondary">{note}</p>}
    </div>
  );
};

export default AssistToday;
