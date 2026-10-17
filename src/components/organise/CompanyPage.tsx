// A company the user has met people from, grouped by their email domain:
// its name (from the domain until the user renames it), a short description
// the user writes or asks to have drafted from the meetings' own notes, the
// people, the meetings, what is still open, and the user's notes.

import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useT } from '../../i18n';
import { useResolvedTheme } from '../../hooks/useResolvedTheme';
import EditableTextBlock from '../EditableTextBlock';
import SwapText from '../ui/SwapText';
import { ActionItemList, Face, ListRow, MeetingRefList, NotesField, OrganisePage, SectionTitle } from './organiseUi';
import { draftFailureText, meetingsCount, personSubtitle, shortDay } from './organiseView';
import type { OrganiseCompanyDetail } from '../../types/electron';

export const CompanyPage: React.FC<{
    domain: string;
    onBack: () => void;
    onOpenMeeting: (meetingId: string) => void;
    onOpenPerson: (personId: string) => void;
}> = ({ domain, onBack, onOpenMeeting, onOpenPerson }) => {
    const t = useT();
    const isLight = useResolvedTheme() === 'light';
    const [company, setCompany] = useState<OrganiseCompanyDetail | null | undefined>(undefined);
    const [drafting, setDrafting] = useState(false);
    const [draftNote, setDraftNote] = useState<string | null>(null);
    // Bumped to remount the description editor when a draft replaces its text.
    const [descriptionKey, setDescriptionKey] = useState(0);

    const load = useCallback(() => {
        window.electronAPI?.organise?.getCompany(domain)
            .then((c) => setCompany(c))
            .catch(() => setCompany(null));
    }, [domain]);
    useEffect(() => { load(); }, [load]);

    const save = (patch: { name?: string; description?: string; descriptionSource?: 'user' | 'drafted'; notes?: string }) => {
        void window.electronAPI?.organise?.updateCompany(domain, patch).then((ok) => { if (ok) load(); });
    };

    const draft = async () => {
        if (drafting) return;
        setDrafting(true);
        setDraftNote(null);
        try {
            const res = await window.electronAPI?.organise?.draftCompanyDescription(domain);
            if (res?.text) {
                await window.electronAPI?.organise?.updateCompany(domain, { description: res.text, descriptionSource: 'drafted' });
                setDescriptionKey((k) => k + 1);
                load();
            } else {
                setDraftNote(t(draftFailureText(res?.reason)));
            }
        } catch {
            setDraftNote(t(draftFailureText('failed')));
        } finally {
            setDrafting(false);
        }
    };

    if (company === undefined) return <OrganisePage onBack={onBack}><div className="h-11" /></OrganisePage>;
    if (company === null) {
        return (
            <OrganisePage onBack={onBack}>
                <p className="pt-10 text-sm text-text-tertiary">{t('Nobody from this company is in your meetings any more.')}</p>
            </OrganisePage>
        );
    }

    const quiet = isLight ? 'bg-black/[0.05] hover:bg-black/[0.09]' : 'bg-white/[0.06] hover:bg-white/[0.1]';
    const lightPlaceholder = isLight ? 'empty:before:!text-black/30' : '';

    return (
        <OrganisePage onBack={onBack}>
            <div className="mb-8">
                <div className="text-xs text-text-tertiary font-medium mb-1">
                    {company.domain} · {company.peopleCount} {company.peopleCount === 1 ? t('person') : t('people')} · {meetingsCount(company.meetingCount)}
                    {company.lastMetAt && <> · {t('Last met')} {shortDay(company.lastMetAt)}</>}
                </div>
                <EditableTextBlock
                    initialValue={company.name}
                    onSave={(name) => save({ name })}
                    tagName="h1"
                    multiline={false}
                    className="text-3xl font-bold text-text-primary tracking-tight -ml-2 px-2 py-1 rounded-md transition-colors"
                />
            </div>

            <section className="mb-8">
                <SectionTitle
                    aside={(
                        <button
                            type="button"
                            onClick={() => { void draft(); }}
                            disabled={drafting}
                            className={`h-7 inline-flex items-center gap-1.5 text-[12px] font-medium px-2.5 rounded-md text-text-primary disabled:opacity-50 transition-[color,background-color,opacity] ${quiet}`}
                        >
                            <RefreshCw className={`w-3.5 h-3.5 shrink-0 ${drafting ? 'animate-spin' : ''}`} strokeWidth={2} />
                            <SwapText swapKey={drafting ? 'busy' : 'idle'}>
                                {drafting ? t('Drafting…') : t('Draft from meetings')}
                            </SwapText>
                        </button>
                    )}
                >
                    {t('About')}
                </SectionTitle>
                <EditableTextBlock
                    key={descriptionKey}
                    initialValue={company.description || ''}
                    onSave={(description) => save({ description, descriptionSource: 'user' })}
                    tagName="div"
                    multiline
                    placeholder={t('What this company does, in your words')}
                    className={`min-h-[44px] text-sm text-text-secondary leading-relaxed whitespace-pre-wrap -ml-2 px-2 py-1.5 rounded-md transition-colors ${lightPlaceholder}`}
                />
                {company.descriptionSource === 'drafted' && company.description && (
                    <p className="mt-1 text-[11px] text-text-tertiary">{t('Drafted from your meeting notes. Edit it to make it yours.')}</p>
                )}
                {draftNote && <p className="mt-1 text-[11px] text-text-tertiary">{draftNote}</p>}
            </section>

            <section className="mb-8">
                <SectionTitle>{t('People')}</SectionTitle>
                <div className="-mx-3 space-y-1">
                    {company.people.map((p) => (
                        <ListRow key={p.id} onClick={() => onOpenPerson(p.id)} aside={<span className="text-[13px] text-text-secondary font-medium">{shortDay(p.lastMetAt)}</span>}>
                            <Face name={p.name} email={p.email} />
                            <span className="min-w-0">
                                <span className="block font-medium text-[14px] text-text-primary truncate">{p.name}</span>
                                <span className="block text-[12px] text-text-tertiary truncate">{personSubtitle(p)}</span>
                            </span>
                        </ListRow>
                    ))}
                </div>
            </section>

            {company.openActionItems.length > 0 && (
                <section className="mb-8">
                    <SectionTitle>{t('Open action items')}</SectionTitle>
                    <ActionItemList items={company.openActionItems} onOpen={onOpenMeeting} />
                </section>
            )}

            <section className="mb-8">
                <SectionTitle>{t('Meetings')}</SectionTitle>
                <div className="-mx-3"><MeetingRefList meetings={company.meetings} onOpen={onOpenMeeting} /></div>
            </section>

            <section className="mb-8">
                <SectionTitle>{t('Your notes')}</SectionTitle>
                <NotesField value={company.notes || ''} placeholder={t('What you want to remember about this company')} onSave={(notes) => save({ notes })} />
            </section>
        </OrganisePage>
    );
};

export default CompanyPage;
