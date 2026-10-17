// The People and Companies lists under "My Natively", in the meetings list's
// row style. Both re-read when a meeting is saved (meetings-updated).

import React, { useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import { useT } from '../../i18n';
import { Face, ListRow } from './organiseUi';
import { meetingsCount, personSubtitle, shortDay } from './organiseView';
import type { OrganiseCompany, OrganisePerson } from '../../types/electron';

const SearchField: React.FC<{ value: string; onChange: (v: string) => void; placeholder: string }> = ({ value, onChange, placeholder }) => (
    <div className="relative w-full max-w-[280px] mb-4">
        <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none" />
        <input
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            spellCheck={false}
            className="w-full pl-8 pr-3 py-1.5 bg-bg-elevated border border-border-muted rounded-full text-[13px] text-text-primary placeholder-text-tertiary/70 focus:outline-none transition-colors"
        />
    </div>
);

/**
 * Re-run `load` whenever a meeting is saved or changed, and as older meetings
 * are indexed in the background (a batch at a time, after an upgrade).
 */
function useMeetingsUpdated(load: () => void): void {
    useEffect(() => {
        const off = window.electronAPI?.onMeetingsUpdated?.(() => load());
        const offIndexed = window.electronAPI?.organise?.onPeopleIndexed?.(() => load());
        return () => {
            try { off?.(); } catch { /* already gone */ }
            try { offIndexed?.(); } catch { /* already gone */ }
        };
    }, [load]);
}

export const PeopleList: React.FC<{ onOpen: (personId: string) => void }> = ({ onOpen }) => {
    const t = useT();
    const [query, setQuery] = useState('');
    const [people, setPeople] = useState<OrganisePerson[] | null>(null);
    const load = React.useCallback(() => {
        window.electronAPI?.organise?.listPeople().then(setPeople).catch(() => setPeople([]));
    }, []);
    useEffect(() => { load(); }, [load]);
    useMeetingsUpdated(load);
    const q = query.trim().toLowerCase();
    const shown = (people || []).filter((p) => !q || [p.name, p.email, p.title, p.company].some((v) => (v || '').toLowerCase().includes(q)));
    return (
        <div>
            <SearchField value={query} onChange={setQuery} placeholder={t('Search people')} />
            {people !== null && people.length === 0 && (
                <p className="p-1 text-sm text-text-tertiary">{t("People you meet show up here: everyone on your calendar invites, in the meeting app's participant list, or named as a speaker.")}</p>
            )}
            <div className="space-y-1">
                {shown.map((p) => (
                    <ListRow
                        key={p.id}
                        onClick={() => onOpen(p.id)}
                        aside={(
                            <>
                                <span className="bg-bg-elevated text-text-secondary text-[9px] px-1.5 py-0.5 rounded-full font-medium tracking-wide">{meetingsCount(p.meetingCount)}</span>
                                <span className="text-[13px] text-text-secondary font-medium min-w-[60px] text-right">{shortDay(p.lastMetAt)}</span>
                            </>
                        )}
                    >
                        <Face name={p.name} email={p.email} />
                        <span className="min-w-0">
                            <span className="block font-medium text-[14px] text-text-primary truncate">{p.name}</span>
                            {personSubtitle(p) && <span className="block text-[12px] text-text-tertiary truncate">{personSubtitle(p)}</span>}
                        </span>
                    </ListRow>
                ))}
            </div>
        </div>
    );
};

export const CompaniesList: React.FC<{ onOpen: (domain: string) => void }> = ({ onOpen }) => {
    const t = useT();
    const [query, setQuery] = useState('');
    const [companies, setCompanies] = useState<OrganiseCompany[] | null>(null);
    const load = React.useCallback(() => {
        window.electronAPI?.organise?.listCompanies().then(setCompanies).catch(() => setCompanies([]));
    }, []);
    useEffect(() => { load(); }, [load]);
    useMeetingsUpdated(load);
    const q = query.trim().toLowerCase();
    const shown = (companies || []).filter((c) => !q || c.name.toLowerCase().includes(q) || c.domain.includes(q));
    return (
        <div>
            <SearchField value={query} onChange={setQuery} placeholder={t('Search companies')} />
            {companies !== null && companies.length === 0 && (
                <p className="p-1 text-sm text-text-tertiary">{t('Companies show up here once you meet people who use a work email address. Personal addresses like Gmail or iCloud are left out.')}</p>
            )}
            <div className="space-y-1">
                {shown.map((c) => (
                    <ListRow
                        key={c.domain}
                        onClick={() => onOpen(c.domain)}
                        aside={(
                            <>
                                <span className="bg-bg-elevated text-text-secondary text-[9px] px-1.5 py-0.5 rounded-full font-medium tracking-wide">{meetingsCount(c.meetingCount)}</span>
                                <span className="text-[13px] text-text-secondary font-medium min-w-[60px] text-right">{shortDay(c.lastMetAt)}</span>
                            </>
                        )}
                    >
                        <Face name={c.name} />
                        <span className="min-w-0">
                            <span className="block font-medium text-[14px] text-text-primary truncate">{c.name}</span>
                            <span className="block text-[12px] text-text-tertiary truncate">{c.domain} · {c.peopleCount} {c.peopleCount === 1 ? t('person') : t('people')}</span>
                        </span>
                    </ListRow>
                ))}
            </div>
        </div>
    );
};
