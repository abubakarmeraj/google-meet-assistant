import React from 'react';
import { motion } from 'framer-motion';
import type { VersionKey } from './notesView';

/**
 * One small tab per version of the notes (2026-10-15): earlier versions kept
 * when the notes were regenerated ("General", "Sales call"), then the current
 * notes. Switching is instant: every version is already on the page.
 *
 * The meeting page's own tab row (Summary / Transcript / Usage), one size down:
 * same well, same sliding pill, its own layoutId so the two never trade pills.
 */
export const NotesVersionTabs: React.FC<{
    tabs: Array<{ key: VersionKey; label: string }>;
    active: VersionKey;
    isLight: boolean;
    onSelect: (key: VersionKey) => void;
}> = ({ tabs, active, isLight, onSelect }) => {
    if (tabs.length === 0) return null;
    return (
        <div
            role="tablist"
            className={`p-0.5 rounded-lg inline-flex items-center gap-0.5 max-w-full overflow-x-auto ${isLight ? 'bg-[#E5E5EA] border border-black/[0.04]' : 'bg-[#0D0D0F] border border-white/[0.08]'}`}
        >
            {tabs.map((tab) => {
                const selected = tab.key === active;
                return (
                    <button
                        key={String(tab.key)}
                        type="button"
                        role="tab"
                        aria-selected={selected}
                        onClick={() => { if (!selected) onSelect(tab.key); }}
                        className={`relative shrink-0 px-2.5 py-0.5 text-[12px] font-medium rounded-md transition-all duration-200 z-10 ${selected
                            ? (isLight ? 'text-black' : 'text-[#E9E9E9]')
                            : `${isLight ? 'text-text-secondary' : 'text-text-tertiary'} hover:text-text-primary`}`}
                    >
                        {selected && (
                            <motion.div
                                layoutId="notesVersionTabBackground"
                                className={`absolute inset-0 rounded-md -z-10 shadow-sm ${isLight ? 'bg-white' : 'bg-[#3A3A3C]'}`}
                                initial={false}
                                transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                            />
                        )}
                        {tab.label}
                    </button>
                );
            })}
        </div>
    );
};
