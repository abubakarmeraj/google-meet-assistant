// Settings › Intelligence: "About you". A few lines in the user's own words
// (role, team, what they care about) that the meeting notes prompt reads as
// their bio, the way Granola adds the user's bio to every summary. Stored in
// SettingsManager.userBio (at most 600 characters); empty means not used.
// Saved on blur, never sent anywhere on its own.
import React, { useEffect, useRef, useState } from 'react';
import { UserRound } from 'lucide-react';
import { useT } from '../../i18n';
import { SETTINGS_INPUT, SettingsRow } from './SettingsRow';

const MAX = 600;

export const AboutYouSettings: React.FC = () => {
    const t = useT();
    const [bio, setBio] = useState('');
    const [saved, setSaved] = useState('');
    const live = useRef(true);

    useEffect(() => {
        live.current = true;
        void window.electronAPI?.userBioGet?.().then((r) => { if (live.current && r) { setBio(r.bio); setSaved(r.bio); } }).catch(() => {});
        return () => { live.current = false; };
    }, []);

    const save = async () => {
        const next = bio.trim().slice(0, MAX);
        if (next === saved) return;
        const res = await window.electronAPI?.userBioSet?.(next).catch(() => undefined);
        if (res?.success) { setSaved(res.bio ?? next); setBio(res.bio ?? next); }
        else setBio(saved);
    };

    return (
        <SettingsRow
            icon={<UserRound size={20} />}
            title={t('About you')}
            description={saved ? t('Read by every meeting summary, in your words.') : t('A few lines on who you are and what you care about. Meeting notes read it so they know whose notes they are.')}
            descriptionKey={saved ? 'set' : 'empty'}
        >
            <div className="pb-3">
                <textarea
                    className={`${SETTINGS_INPUT} min-h-[84px] resize-y`}
                    value={bio}
                    maxLength={MAX}
                    spellCheck
                    placeholder={t('Head of Product at Acme. I run the weekly roadmap review and care most about customer commitments and dates.')}
                    onChange={(e) => setBio(e.target.value.slice(0, MAX))}
                    onBlur={() => void save()}
                />
                <p className="mt-1 text-xs text-text-tertiary">{bio.length} / {MAX}</p>
            </div>
        </SettingsRow>
    );
};
