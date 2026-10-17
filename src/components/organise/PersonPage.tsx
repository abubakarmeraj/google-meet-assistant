// A person the user has met: who they are (title and company the user typed or
// accepted), every meeting together, what they still owe, when the user last
// met them and what that was about, and the user's own notes on them.
//
// Titles and companies proposed from what people said in a meeting show as
// suggestions with the words they rest on; nothing is filled in until the user
// accepts it (services/organise/personFacts.ts).

import React, { useCallback, useEffect, useState } from 'react';
import { Check, X } from 'lucide-react';
import { useT } from '../../i18n';
import { useResolvedTheme } from '../../hooks/useResolvedTheme';
import EditableTextBlock from '../EditableTextBlock';
import { ActionItemList, Face, InlineField, MeetingRefList, NotesField, OrganisePage, SectionTitle } from './organiseUi';
import { meetingsCount, shortDay } from './organiseView';
import type { OrganisePersonDetail } from '../../types/electron';

export const PersonPage: React.FC<{
    personId: string;
    onBack: () => void;
    onOpenMeeting: (meetingId: string) => void;
    onOpenCompany: (domain: string) => void;
}> = ({ personId, onBack, onOpenMeeting, onOpenCompany }) => {
    const t = useT();
    const isLight = useResolvedTheme() === 'light';
    const [person, setPerson] = useState<OrganisePersonDetail | null | undefined>(undefined);

    const load = useCallback(() => {
        window.electronAPI?.organise?.getPerson(personId)
            .then((p) => setPerson(p))
            .catch(() => setPerson(null));
    }, [personId]);
    useEffect(() => { load(); }, [load]);

    const save = (patch: { name?: string; title?: string; company?: string; notes?: string }) => {
        void window.electronAPI?.organise?.updatePerson(personId, patch).then((ok) => { if (ok) load(); });
    };
    const resolve = (factId: number, accept: boolean) => {
        void window.electronAPI?.organise?.resolveFact(factId, accept).then(() => load());
    };

    if (person === undefined) return <OrganisePage onBack={onBack}><div className="h-11" /></OrganisePage>;
    if (person === null) {
        return (
            <OrganisePage onBack={onBack}>
                <p className="pt-10 text-sm text-text-tertiary">{t('This person is no longer in your meetings.')}</p>
            </OrganisePage>
        );
    }

    const quiet = isLight ? 'bg-black/[0.05] hover:bg-black/[0.09]' : 'bg-white/[0.06] hover:bg-white/[0.1]';

    return (
        <OrganisePage onBack={onBack}>
            <div className="flex items-start gap-4 mb-8">
                <div className="pt-6"><Face name={person.name} email={person.email} size={44} /></div>
                <div className="min-w-0 flex-1">
                    <div className="text-xs text-text-tertiary font-medium mb-1 flex flex-wrap gap-x-1.5">
                        {person.email && <span>{person.email}</span>}
                        {person.companyDomain && (
                            <>
                                {person.email && <span>·</span>}
                                <button type="button" onClick={() => onOpenCompany(person.companyDomain!)} className="hover:text-text-primary transition-colors">
                                    {person.company || person.companyDomain}
                                </button>
                            </>
                        )}
                        <span>·</span>
                        <span>{meetingsCount(person.meetingCount)}</span>
                    </div>
                    <EditableTextBlock
                        initialValue={person.name}
                        onSave={(name) => { if (name) save({ name }); }}
                        tagName="h1"
                        multiline={false}
                        className="text-3xl font-bold text-text-primary tracking-tight -ml-2 px-2 py-1 rounded-md transition-colors"
                    />
                    <div className="mt-3 space-y-1">
                        <InlineField label={t('Title')} value={person.title || ''} placeholder={t('Add a title')} onSave={(title) => save({ title })} />
                        <InlineField label={t('Company')} value={person.company || ''} placeholder={t('Add a company')} onSave={(company) => save({ company })} />
                    </div>
                </div>
            </div>

            {person.suggestions.length > 0 && (
                <section className="mb-8">
                    <SectionTitle>{t('From your meetings')}</SectionTitle>
                    <ul className="space-y-3">
                        {person.suggestions.map((f) => (
                            <li key={f.id} className={`px-4 py-3 rounded-[10px] border ${isLight ? 'border-black/[0.08] bg-black/[0.015]' : 'border-white/10 bg-white/[0.02]'}`}>
                                <p className="text-sm text-text-primary">
                                    <span className="text-text-tertiary">{f.kind === 'title' ? t('Title') : t('Company')}: </span>
                                    <span className="font-medium">{f.value}</span>
                                </p>
                                <p className="text-[12.5px] text-text-secondary leading-relaxed mt-1">"{f.quote}"</p>
                                <div className="flex items-center justify-between gap-3 mt-2.5">
                                    <button type="button" onClick={() => onOpenMeeting(f.meetingId)} className="text-[11px] text-text-tertiary hover:text-text-primary transition-colors truncate">
                                        {f.meetingTitle || t('Untitled meeting')}
                                    </button>
                                    <div className="flex items-center gap-1.5 shrink-0">
                                        <button type="button" onClick={() => resolve(f.id, false)} className="h-7 inline-flex items-center gap-1 text-[12px] font-medium px-2.5 rounded-md text-text-secondary hover:text-text-primary transition-colors">
                                            <X size={13} /> {t('Dismiss')}
                                        </button>
                                        <button type="button" onClick={() => resolve(f.id, true)} className={`h-7 inline-flex items-center gap-1 text-[12px] font-medium px-2.5 rounded-md text-text-primary transition-colors ${quiet}`}>
                                            <Check size={13} /> {f.kind === 'title' ? t('Use as title') : t('Use as company')}
                                        </button>
                                    </div>
                                </div>
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            {person.lastMet && (
                <section className="mb-8">
                    <SectionTitle>{t('Last time you met')}</SectionTitle>
                    <button type="button" onClick={() => onOpenMeeting(person.lastMet!.meetingId)} className="block w-full text-left px-3 py-2 -mx-3 rounded-lg hover:bg-bg-elevated transition-colors">
                        <span className="block text-[14px] font-medium text-text-primary">
                            {person.lastMet.title || t('Untitled meeting')}
                            <span className="text-text-tertiary font-normal"> · {shortDay(person.lastMet.date)}</span>
                        </span>
                        {person.lastMet.recap && <span className="block mt-1 text-sm text-text-secondary leading-relaxed">{person.lastMet.recap}</span>}
                    </button>
                </section>
            )}

            {person.openActionItems.length > 0 && (
                <section className="mb-8">
                    <SectionTitle>{t('Open action items')}</SectionTitle>
                    <ActionItemList items={person.openActionItems} onOpen={onOpenMeeting} />
                </section>
            )}

            <section className="mb-8">
                <SectionTitle>{t('Meetings together')}</SectionTitle>
                <div className="-mx-3"><MeetingRefList meetings={person.meetings} onOpen={onOpenMeeting} /></div>
            </section>

            <section className="mb-8">
                <SectionTitle>{t('Your notes')}</SectionTitle>
                <NotesField value={person.notes || ''} placeholder={t('What you want to remember about them')} onSave={(notes) => save({ notes })} />
            </section>
        </OrganisePage>
    );
};

export default PersonPage;
