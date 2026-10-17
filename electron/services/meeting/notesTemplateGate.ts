/**
 * The Pro gate on "Regenerate as" (2026-10-15), lifted out of the
 * regenerate-meeting-summary handler unchanged so the template picker on the
 * meeting page can be tested against it.
 *
 * Regenerating AS another template is the same gate as switching to that mode
 * (modes:set-active): a non-general template needs Pro or a live trial, and the
 * notes must not be a side door to it. A plain regenerate (no override) keeps
 * the meeting's own mode and is never gated. An unknown mode id is gated like
 * any non-general one.
 *
 * Platform-independent.
 */

export interface RegenerateTarget {
    modeId?: string;
    templateType?: string;
}

/**
 * 'pro_required' when this regenerate is refused, else null.
 * `templateOfMode` resolves a mode id to its template type (ModesManager);
 * it may throw or return undefined.
 */
export function regenerateGate(
    target: RegenerateTarget,
    deps: { templateOfMode: (modeId: string) => string | undefined; isProOrTrialActive: () => boolean },
): 'pro_required' | null {
    const { modeId, templateType } = target ?? {};
    if (!modeId && !templateType) return null;
    let resolved = templateType;
    try {
        if (modeId) resolved = deps.templateOfMode(modeId) ?? resolved;
    } catch { /* resolve best-effort; an unknown mode is gated like any non-general one */ }
    if (resolved !== 'general' && !deps.isProOrTrialActive()) return 'pro_required';
    return null;
}
