// Above the meetings list: Meetings / People / Companies (the meeting notes'
// tab well), and on Meetings the folder and tag filters with "New folder".
// A folder that is selected shows its settings button; while it is selected,
// search and Ask from the top bar look only at its meetings.

import React from 'react';
import { motion } from 'framer-motion';
import { Folder, FolderPlus, Settings2 } from 'lucide-react';
import { useT } from '../../i18n';
import type { OrganiseFolder, OrganiseTag } from '../../types/electron';

export type LauncherView = 'meetings' | 'people' | 'companies';
export type MeetingFilter = { kind: 'folder'; id: string } | { kind: 'tag'; name: string } | null;

const VIEWS: Array<{ id: LauncherView; label: string }> = [
    { id: 'meetings', label: 'Meetings' },
    { id: 'people', label: 'People' },
    { id: 'companies', label: 'Companies' },
];

export const OrganiseBar: React.FC<{
    isLight: boolean;
    view: LauncherView;
    onView: (view: LauncherView) => void;
    folders: OrganiseFolder[];
    tags: OrganiseTag[];
    filter: MeetingFilter;
    onFilter: (filter: MeetingFilter) => void;
    onEditFolder: (folder: OrganiseFolder | null) => void;
}> = ({ isLight, view, onView, folders, tags, filter, onFilter, onEditFolder }) => {
    const t = useT();
    const chip = (active: boolean) => `shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12px] font-medium transition-colors ${active
        ? (isLight ? 'bg-white text-black shadow-sm' : 'bg-[#3A3A3C] text-[#E9E9E9] shadow-sm')
        : 'text-text-secondary hover:text-text-primary hover:bg-bg-elevated'}`;
    const selectedFolder = filter?.kind === 'folder' ? folders.find((f) => f.id === filter.id) : undefined;

    return (
        <div className="space-y-3">
            <div className={`p-1 rounded-xl inline-flex items-center gap-0.5 ${isLight ? 'bg-[#E5E5EA] border border-black/[0.04]' : 'bg-[#0D0D0F] border border-white/[0.08]'}`}>
                {VIEWS.map((v) => (
                    <button
                        key={v.id}
                        type="button"
                        onClick={() => onView(v.id)}
                        className={`relative px-3 py-1 text-[13px] font-medium rounded-lg transition-all duration-200 z-10 ${view === v.id ? (isLight ? 'text-black' : 'text-[#E9E9E9]') : `${isLight ? 'text-text-secondary' : 'text-text-tertiary'} hover:text-text-primary`}`}
                    >
                        {view === v.id && (
                            <motion.div
                                layoutId="launcherViewBackground"
                                className={`absolute inset-0 rounded-lg -z-10 shadow-sm ${isLight ? 'bg-white' : 'bg-[#3A3A3C]'}`}
                                initial={false}
                                transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                            />
                        )}
                        {t(v.label)}
                    </button>
                ))}
            </div>

            {view === 'meetings' && (
                <div className="flex items-center gap-1 flex-wrap">
                    <button type="button" className={chip(filter === null)} onClick={() => onFilter(null)}>{t('All')}</button>
                    {folders.map((f) => (
                        <button key={f.id} type="button" className={chip(filter?.kind === 'folder' && filter.id === f.id)} onClick={() => onFilter({ kind: 'folder', id: f.id })}>
                            <Folder size={12} strokeWidth={2} />
                            {f.name}
                            <span className="text-text-tertiary tabular-nums">{f.meetingCount}</span>
                        </button>
                    ))}
                    {tags.map((tag) => (
                        <button key={tag.id} type="button" className={chip(filter?.kind === 'tag' && filter.name.toLowerCase() === tag.name.toLowerCase())} onClick={() => onFilter({ kind: 'tag', name: tag.name })}>
                            #{tag.name}
                        </button>
                    ))}
                    <button type="button" className={`${chip(false)} text-text-tertiary`} onClick={() => onEditFolder(null)}>
                        <FolderPlus size={12} strokeWidth={2} />
                        {t('New folder')}
                    </button>
                    {selectedFolder && (
                        <button type="button" className={`${chip(false)} ml-auto`} onClick={() => onEditFolder(selectedFolder)}>
                            <Settings2 size={12} strokeWidth={2} />
                            {t('Folder settings')}
                        </button>
                    )}
                </div>
            )}
        </div>
    );
};

export default OrganiseBar;
