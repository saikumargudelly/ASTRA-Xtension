import React, { useState, useRef, useEffect } from 'react';
import type {
    CommandResultMessage,
    CommandProgressMessage,
    CommandErrorMessage,
    ConfigResponseMessage,
    Walkthrough as WalkthroughType,
} from '../types/messages';
import { WalkthroughComponent } from './Walkthrough';

interface StepProgress {
    step: number;
    totalSteps: number;
    description: string;
    status: 'pending' | 'running' | 'done' | 'error';
}

type ViewMode = 'input' | 'loading' | 'results' | 'walkthrough';

// ─── Session State Shape (must match background/index.ts) ───
interface AstraSessionState {
    status: 'idle' | 'running' | 'done' | 'error';
    steps: StepProgress[];
    result?: { success: boolean; data: unknown; summary?: string; rankedResults?: unknown[] };
    error?: string;
    startedAt: number;
}

export function Popup() {
    const [prompt, setPrompt] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [steps, setSteps] = useState<StepProgress[]>([]);
    const [result, setResult] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [viewMode, setViewMode] = useState<ViewMode>('input');
    const [currentWalkthrough, setCurrentWalkthrough] = useState<WalkthroughType | null>(null);
    const [alternativeGuides, setAlternativeGuides] = useState<Array<{ title: string; url: string; source: string }>>([]);
    const outputRef = useRef<HTMLDivElement>(null);

    // ─── Restore state from session storage on mount ───
    // This ensures that if the user closes and reopens the popup while
    // the background is still processing, they see the current progress.
    useEffect(() => {
        chrome.storage.session.get('astra_state', (items) => {
            const state: AstraSessionState | undefined = items.astra_state;
            if (!state || state.status === 'idle') return;

            if (state.status === 'running') {
                setIsLoading(true);
                setSteps(state.steps || []);
                setViewMode('loading');
            } else if (state.status === 'done' && state.result) {
                const r = state.result;
                const summary = r.summary ??
                    (typeof r.data === 'string' ? r.data : JSON.stringify(r.data, null, 2));
                setResult(summary);
                setSteps(state.steps || []);
                setViewMode('results');
            } else if (state.status === 'error' && state.error) {
                setError(state.error);
                setSteps(state.steps || []);
                setViewMode('results');
            }
        });
    }, []);

    // ─── Live message listener (for when popup is open during processing) ───
    useEffect(() => {
        const listener = (message: CommandResultMessage | CommandProgressMessage | CommandErrorMessage | ConfigResponseMessage) => {
            switch (message.type) {
                case 'COMMAND_PROGRESS':
                    setIsLoading(true);
                    setSteps((prev) => {
                        const existing = prev.findIndex((s) => s.step === message.payload.step);
                        if (existing >= 0) {
                            const updated = [...prev];
                            updated[existing] = message.payload;
                            return updated;
                        }
                        return [...prev, message.payload];
                    });
                    break;

                case 'COMMAND_RESULT':
                    setIsLoading(false);
                    setResult(
                        message.payload.summary ??
                        (typeof message.payload.data === 'string'
                            ? message.payload.data
                            : JSON.stringify(message.payload.data, null, 2))
                    );
                    setViewMode('results');
                    break;

                case 'COMMAND_ERROR':
                    setIsLoading(false);
                    setError(message.payload.message);
                    setViewMode('results');
                    break;

                case 'CONFIG_RESPONSE':
                    setIsLoading(false);
                    if (message.payload.success && message.payload.walkthrough) {
                        setCurrentWalkthrough(message.payload.walkthrough);
                        setAlternativeGuides(message.payload.alternativeGuides || []);
                        setViewMode('walkthrough');
                    } else {
                        setError(message.payload.error || 'Failed to get configuration walkthrough');
                        setViewMode('results');
                    }
                    break;
            }
        };

        chrome.runtime.onMessage.addListener(listener);

        // Also watch for storage changes from the background (catches missed messages)
        const storageListener = (changes: { [key: string]: chrome.storage.StorageChange }) => {
            const stateChange = changes.astra_state;
            if (!stateChange) return;

            const state: AstraSessionState = stateChange.newValue;
            if (!state) return;

            if (state.status === 'running') {
                setIsLoading(true);
                setSteps(state.steps || []);
            } else if (state.status === 'done' && state.result) {
                const r = state.result;
                const summary = r.summary ??
                    (typeof r.data === 'string' ? r.data : JSON.stringify(r.data, null, 2));
                setIsLoading(false);
                setResult(summary);
                setViewMode('results');
            } else if (state.status === 'error' && state.error) {
                setIsLoading(false);
                setError(state.error);
                setViewMode('results');
            }
        };

        chrome.storage.session.onChanged.addListener(storageListener);

        return () => {
            chrome.runtime.onMessage.removeListener(listener);
            chrome.storage.session.onChanged.removeListener(storageListener);
        };
    }, []);

    useEffect(() => {
        if (outputRef.current) {
            outputRef.current.scrollTop = outputRef.current.scrollHeight;
        }
    }, [steps, result, error]);

    const handleSubmit = () => {
        if (!prompt.trim() || isLoading) return;

        // Clear session state from any prior run
        chrome.storage.session.remove('astra_state');

        setIsLoading(true);
        setSteps([]);
        setResult(null);
        setError(null);
        setViewMode('loading');

        chrome.runtime.sendMessage({
            type: 'SUBMIT_COMMAND',
            payload: { prompt: prompt.trim() },
        });
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
        }
    };

    const getStatusIcon = (status: StepProgress['status']) => {
        switch (status) {
            case 'pending': return '○';
            case 'running': return '◉';
            case 'done': return '✓';
            case 'error': return '✗';
        }
    };

    const getStatusColor = (status: StepProgress['status']) => {
        switch (status) {
            case 'pending': return 'text-astra-text-muted';
            case 'running': return 'text-astra-primary animate-pulse';
            case 'done': return 'text-astra-success';
            case 'error': return 'text-astra-error';
        }
    };

    const handleCloseWalkthrough = () => {
        setCurrentWalkthrough(null);
        setAlternativeGuides([]);
        setViewMode('input');
        setPrompt('');
    };

    const handleReset = () => {
        chrome.storage.session.remove('astra_state');
        setIsLoading(false);
        setSteps([]);
        setResult(null);
        setError(null);
        setPrompt('');
        setViewMode('input');
    };

    // Show walkthrough view if we have a walkthrough
    if (viewMode === 'walkthrough' && currentWalkthrough) {
        return (
            <div className="flex flex-col h-full min-h-[520px] bg-astra-bg">
                <WalkthroughComponent
                    walkthrough={currentWalkthrough}
                    alternativeGuides={alternativeGuides}
                    onClose={handleCloseWalkthrough}
                />
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full min-h-[520px] bg-astra-bg">
            {/* Header */}
            <header className="flex items-center gap-3 px-4 py-3 border-b border-astra-border bg-astra-surface/50 backdrop-blur-sm">
                <div className="relative">
                    <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-astra-primary to-astra-accent flex items-center justify-center text-white font-bold text-sm shadow-lg">
                        A
                    </div>
                    <div className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 bg-astra-success rounded-full border-2 border-astra-surface" />
                </div>
                <div className="flex-1">
                    <h1 className="text-sm font-semibold text-astra-text tracking-wide">ASTRA</h1>
                    <p className="text-[10px] text-astra-text-muted">AI Browser Assistant</p>
                </div>
                {/* Reset button — only shown when there is active state */}
                {(isLoading || result || error) && (
                    <button
                        onClick={handleReset}
                        title="Clear and start over"
                        className="text-[10px] px-2 py-1 rounded-md text-astra-text-muted hover:text-astra-text hover:bg-astra-surface transition-colors"
                    >
                        ✕ Clear
                    </button>
                )}
            </header>

            {/* Input Section */}
            <div className="px-4 py-3">
                <div className="relative group">
                    <textarea
                        value={prompt}
                        onChange={(e) => setPrompt(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="Tell me what to do..."
                        disabled={isLoading}
                        rows={3}
                        className="w-full px-3 py-2.5 bg-astra-surface border border-astra-border rounded-xl text-sm text-astra-text placeholder-astra-text-muted resize-none outline-none transition-all duration-200 focus:border-astra-primary focus:shadow-[0_0_0_3px_rgba(99,102,241,0.15)] disabled:opacity-50 font-sans"
                    />
                    <button
                        onClick={handleSubmit}
                        disabled={!prompt.trim() || isLoading}
                        className="absolute bottom-2.5 right-2.5 px-3 py-1.5 bg-gradient-to-r from-astra-primary to-astra-accent text-white text-xs font-medium rounded-lg transition-all duration-200 hover:shadow-[0_0_12px_rgba(99,102,241,0.4)] hover:scale-[1.02] active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:shadow-none disabled:hover:scale-100"
                    >
                        {isLoading ? (
                            <span className="flex items-center gap-1.5">
                                <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                                </svg>
                                Running
                            </span>
                        ) : (
                            'Run ⏎'
                        )}
                    </button>
                </div>
            </div>

            {/* Output Panel */}
            <div
                ref={outputRef}
                className="flex-1 overflow-y-auto px-4 pb-4 space-y-3"
            >
                {/* Step Progress */}
                {steps.length > 0 && (
                    <div className="space-y-1 animate-fade-in">
                        <p className="text-[10px] font-medium text-astra-text-muted uppercase tracking-wider mb-2">
                            Execution Plan
                        </p>
                        {steps.map((step) => (
                            <div
                                key={step.step}
                                className="flex items-start gap-2 py-1 animate-slide-up"
                            >
                                <span className={`text-xs mt-0.5 ${getStatusColor(step.status)}`}>
                                    {getStatusIcon(step.status)}
                                </span>
                                <span className={`text-xs ${step.status === 'done' ? 'text-astra-text-muted' : 'text-astra-text'}`}>
                                    {step.description}
                                </span>
                            </div>
                        ))}
                    </div>
                )}

                {/* Result */}
                {result && (
                    <div className="animate-slide-up">
                        <p className="text-[10px] font-medium text-astra-text-muted uppercase tracking-wider mb-2">
                            Result
                        </p>
                        <div className="p-3 bg-astra-surface border border-astra-border rounded-xl">
                            <pre className="text-xs text-astra-text whitespace-pre-wrap font-mono leading-relaxed">
                                {result}
                            </pre>
                        </div>
                    </div>
                )}

                {/* Error */}
                {error && (
                    <div className="animate-slide-up">
                        <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-xl">
                            <p className="text-xs text-astra-error font-medium mb-1">Error</p>
                            <p className="text-xs text-red-300">{error}</p>
                        </div>
                    </div>
                )}

                {/* Empty State */}
                {steps.length === 0 && !result && !error && !isLoading && (
                    <div className="flex flex-col items-center justify-center h-full pt-12 text-center animate-fade-in">
                        <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-astra-primary/20 to-astra-accent/20 flex items-center justify-center mb-4 animate-pulse-glow">
                            <svg className="w-7 h-7 text-astra-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z" />
                            </svg>
                        </div>
                        <p className="text-sm text-astra-text font-medium mb-1">Ready to assist</p>
                        <p className="text-xs text-astra-text-muted max-w-[240px]">
                            Type a command like &quot;summarize this page&quot; or &quot;find best python courses on Udemy&quot;
                        </p>
                    </div>
                )}
            </div>

            {/* Footer */}
            <footer className="px-4 py-2 border-t border-astra-border bg-astra-surface/30">
                <p className="text-[9px] text-astra-text-muted text-center">
                    ASTRA v0.1.0 • Powered by Qwen
                </p>
            </footer>
        </div>
    );
}
