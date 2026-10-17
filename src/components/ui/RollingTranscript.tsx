import React, { useEffect, useRef } from 'react';

interface ChannelStatus {
    status: 'connected' | 'reconnecting' | 'failed' | 'awaiting-audio' | 'preparing';
    error?: string;
    provider?: string;
}

interface RollingTranscriptProps {
    text: string;
    isActive?: boolean;
    surfaceStyle?: React.CSSProperties;
    interviewerChannel?: ChannelStatus;
    microphoneChannel?: ChannelStatus;
}

const RollingTranscript: React.FC<RollingTranscriptProps> = ({
    text, isActive = true, surfaceStyle,
    interviewerChannel, microphoneChannel,
}) => {
    const containerRef = useRef<HTMLDivElement>(null);

    const intStatus = interviewerChannel?.status ?? 'connected';
    const micStatus = microphoneChannel?.status ?? 'connected';
    // Active/normal whenever at least one channel is connected and neither is failed or reconnecting.
    // A silent mic awaiting audio (e.g. listening through headphones/Bluetooth) must not block
    // system/interviewer transcript readiness.
    const isNormal = (intStatus === 'connected' || micStatus === 'connected')
        && intStatus !== 'failed'
        && micStatus !== 'failed'
        && intStatus !== 'reconnecting'
        && micStatus !== 'reconnecting';
    const showTranscriptText = intStatus !== 'failed' && micStatus !== 'failed';
    const preparingMessage = intStatus === 'preparing'
        ? interviewerChannel?.error
        : micStatus === 'preparing'
        ? microphoneChannel?.error
        : undefined;

    useEffect(() => {
        if (containerRef.current && showTranscriptText && text) {
            containerRef.current.scrollTop = containerRef.current.scrollHeight;
        }
    }, [text, showTranscriptText]);

    return (
        <div className="relative w-full px-4 pt-3 pb-2">
            <div className="overlay-transcript-surface px-3 py-2.5" style={surfaceStyle}>
                <div
                    ref={containerRef}
                    className="rolling-transcript-content no-drag"
                    role="region"
                    aria-label="Live transcript"
                    tabIndex={0}
                    dir="auto"
                >
                    {showTranscriptText && (
                        <span>
                            {text || preparingMessage || 'Listening…'}
                            {isActive && isNormal && (
                                <span aria-hidden="true" className="inline-block align-middle ml-2 w-1.5 h-1.5 bg-emerald-500 rounded-full" />
                            )}
                        </span>
                    )}
                </div>
            </div>
        </div>
    );
};

export default RollingTranscript;
