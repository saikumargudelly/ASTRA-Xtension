import React, { useState, useRef, useEffect, useCallback } from 'react';
import type {
    CommandResultMessage,
    CommandProgressMessage,
    CommandErrorMessage,
    ConfigResponseMessage,
    CommandFollowUpMessage,
    Walkthrough as WalkthroughType,
} from '../types/messages';
import { WalkthroughComponent } from './Walkthrough';

// ─── Types ────────────────────────────────────────────────────────────────────
type ViewMode = 'input' | 'running' | 'results' | 'walkthrough';

interface StepProgress {
    step: number;
    totalSteps: number;
    description: string;
    status: 'pending' | 'running' | 'done' | 'error';
}

interface FollowUpState {
    question: string;
    options?: string[];
    context?: string;
    category?: string;
}

// ─── Agent icon map ────────────────────────────────────────────────────────────
const agentIcon: Record<string, string> = {
    coordinator: '🧠', planner: '📋', browser: '🌐',
    memory: '💾', vision: '👁️', critic: '🛡️', default: '⚡',
};

// ─── Ranked result type ────────────────────────────────────────────────────────
interface RankedResult {
    rank: number;
    title: string;
    url?: string;
    rating?: string;
    reviewCount?: string;
    snippet?: string;
    reason?: string;
    badge?: string;
    price?: string;
}

export function Popup() {
    const [prompt, setPrompt] = useState('');
    const [viewMode, setViewMode] = useState<ViewMode>('input');
    const [steps, setSteps] = useState<StepProgress[]>([]);
    const [streamedText, setStreamedText] = useState('');
    const [rankedResults, setRankedResults] = useState<RankedResult[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [currentWalkthrough, setCurrentWalkthrough] = useState<WalkthroughType | null>(null);
    const [alternativeGuides, setAlternativeGuides] = useState<Array<{ title: string; url: string; source: string }>>([]);
    const [isConnected, setIsConnected] = useState(true);
    const [followUp, setFollowUp] = useState<FollowUpState | null>(null);
    const [followUpInput, setFollowUpInput] = useState('');
    const [actionProgress, setActionProgress] = useState<Array<{ actionIndex: number; label: string; status: string; emoji?: string; result?: string }>>([]);
    const outputRef = useRef<HTMLDivElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    // ─── Health check on mount ───────────────────────────────────────────────
    useEffect(() => {
        fetch('http://localhost:3001/health')
            .then(() => setIsConnected(true))
            .catch(() => setIsConnected(false));
    }, []);

    // ─── Restore from session storage on popup open ──────────────────────────
    useEffect(() => {
        chrome.storage.session.get('astra_state', (items) => {
            const state = items.astra_state;
            if (!state || state.status === 'idle') return;

            if (state.status === 'running') {
                setSteps(state.steps || []);
                setViewMode('running');
                // Restore pending follow-up question if the popup was reopened
                if (state.followUp) {
                    setFollowUp(state.followUp);
                }
            } else if (state.status === 'done' && state.result) {
                const r = state.result;
                setStreamedText(r.summary ?? (typeof r.data === 'string' ? r.data : JSON.stringify(r.data, null, 2)));
                setSteps(state.steps || []);
                setRankedResults(r.rankedResults || []);
                setViewMode('results');
            } else if (state.status === 'error' && state.error) {
                setError(state.error);
                setSteps(state.steps || []);
                setViewMode('results');
            }
        });
    }, []);

    // ─── Auto-scroll output ──────────────────────────────────────────────────
    useEffect(() => {
        if (outputRef.current) {
            outputRef.current.scrollTop = outputRef.current.scrollHeight;
        }
    }, [steps, streamedText]);

    // ─── Message listener (from background SW) ───────────────────────────────
    useEffect(() => {
        const listener = (
            message: CommandResultMessage | CommandProgressMessage | CommandErrorMessage | ConfigResponseMessage | CommandFollowUpMessage
        ) => {
            switch (message.type) {
                case 'COMMAND_PROGRESS':
                    setSteps((prev) => {
                        const idx = prev.findIndex((s) => s.step === message.payload.step);
                        if (idx >= 0) {
                            const updated = [...prev];
                            updated[idx] = message.payload;
                            return updated;
                        }
                        return [...prev, message.payload];
                    });
                    break;

                // NEXUS AI streaming tokens (relayed from background SW)
                case 'NEXUS_TOKEN' as CommandResultMessage['type']:
                    setStreamedText((prev) => prev + (message as any).payload.text);
                    break;

                case 'ACTION_PROGRESS':
                    const actionMsg = message as any;
                    const actionProg = actionMsg.payload as { actionIndex: number; label: string; status: string; emoji?: string; result?: string; error?: string };
                    setActionProgress((prev) => {
                        const idx = prev.findIndex(a => a.actionIndex === actionProg.actionIndex);
                        const updated = idx >= 0 ? [...prev] : [...prev];
                        updated[idx >= 0 ? idx : prev.length] = actionProg;
                        return updated;
                    });
                    break;

                case 'COMMAND_FOLLOW_UP':
                    setFollowUp({
                        question: message.payload.question,
                        options: message.payload.options,
                        context: message.payload.context,
                        category: message.payload.category,
                    });
                    setFollowUpInput('');
                    break;

                case 'COMMAND_RESULT':
                    setFollowUp(null); // Clear any pending follow-up
                    setStreamedText(
                        message.payload.summary ??
                        (typeof message.payload.data === 'string'
                            ? message.payload.data
                            : JSON.stringify(message.payload.data, null, 2))
                    );
                    setRankedResults((message.payload as any).rankedResults || []);
                    setViewMode('results');
                    break;

                case 'COMMAND_ERROR':
                    setError(message.payload.message);
                    setViewMode('results');
                    break;

                case 'CONFIG_RESPONSE':
                    if (message.payload.success && message.payload.walkthrough) {
                        setCurrentWalkthrough(message.payload.walkthrough);
                        setAlternativeGuides(message.payload.alternativeGuides || []);
                        setViewMode('walkthrough');
                    } else {
                        setError(message.payload.error || 'Failed to get walkthrough');
                        setViewMode('results');
                    }
                    break;
            }
        };

        chrome.runtime.onMessage.addListener(listener);

        // Also watch session storage for when popup is reopened mid-task
        const storageListener = (changes: { [key: string]: chrome.storage.StorageChange }) => {
            const change = changes.astra_state;
            if (!change?.newValue) return;
            const state = change.newValue;

            if (state.status === 'running') {
                setSteps(state.steps || []);
                setViewMode('running');
            } else if (state.status === 'done' && state.result) {
                const r = state.result;
                setStreamedText(r.summary ?? (typeof r.data === 'string' ? r.data : JSON.stringify(r.data, null, 2)));
                setRankedResults(r.rankedResults || []);
                setViewMode('results');
            } else if (state.status === 'error' && state.error) {
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

    // ─── Submit: ALL tasks go through background SW ──────────────────────────
    const handleSubmit = useCallback(() => {
        const trimmed = prompt.trim();
        if (!trimmed || viewMode === 'running') return;

        chrome.storage.session.remove('astra_state');
        setSteps([]);
        setStreamedText('');
        setRankedResults([]);
        setError(null);
        setViewMode('running');

        // Every task goes to the background service worker
        // The SW decides: browser tasks → full pipeline; AI tasks → /chat SSE relay
        chrome.runtime.sendMessage({
            type: 'SUBMIT_COMMAND',
            payload: { prompt: trimmed, locale: navigator.language },
        });
    }, [prompt, viewMode]);

    // ─── Submit follow-up response ──────────────────────────────────────────
    const sendFollowUpResponse = useCallback((answer: string) => {
        if (!answer.trim()) return;
        chrome.runtime.sendMessage({
            type: 'FOLLOW_UP_RESPONSE',
            payload: { answer: answer.trim() },
        });
        setFollowUp(null);
        setFollowUpInput('');
    }, []);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
        }
    };

    const handleReset = () => {
        chrome.storage.session.remove('astra_state');
        setSteps([]);
        setStreamedText('');
        setRankedResults([]);
        setError(null);
        setPrompt('');
        setFollowUp(null);
        setFollowUpInput('');
        setActionProgress([]);
        setViewMode('input');
        setTimeout(() => textareaRef.current?.focus(), 50);
    };

    const isRunning = viewMode === 'running';

    if (viewMode === 'walkthrough' && currentWalkthrough) {
        return (
            <div className="flex flex-col h-full min-h-[580px] bg-astra-bg">
                <WalkthroughComponent
                    walkthrough={currentWalkthrough}
                    alternativeGuides={alternativeGuides}
                    onClose={() => { setCurrentWalkthrough(null); setViewMode('input'); setPrompt(''); }}
                />
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full min-h-[580px] bg-astra-bg">

            {/* ── Header ──────────────────────────────────────────────────────── */}
            <header className="flex items-center gap-3 px-4 py-3 border-b border-astra-border bg-astra-surface/50 backdrop-blur-sm">
                <div className="relative">
                    <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-600 to-indigo-500 flex items-center justify-center shadow-lg">
                        <span className="text-white font-black text-sm tracking-tight">N</span>
                    </div>
                    <div className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-astra-surface ${isConnected ? 'bg-green-400' : 'bg-red-400'}`} />
                </div>
                <div className="flex-1">
                    <h1 className="text-sm font-bold text-astra-text tracking-wide">NEXUS</h1>
                    <p className="text-[10px] text-astra-text-muted">
                        {isRunning ? (
                            <span className="text-violet-400 animate-pulse">● Working...</span>
                        ) : isConnected ? 'AI Shopping & Research Assistant' : '⚠ Backend offline — start with npm run dev'}
                    </p>
                </div>
                {(isRunning || streamedText || error) && (
                    <button
                        onClick={handleReset}
                        className="text-[10px] px-2 py-1 rounded-md text-astra-text-muted hover:text-astra-text hover:bg-astra-surface transition-colors"
                    >
                        ✕ Clear
                    </button>
                )}
            </header>

            {/* ── Input ───────────────────────────────────────────────────────── */}
            <div className="px-4 py-3">
                <div className="relative group">
                    <textarea
                        ref={textareaRef}
                        value={prompt}
                        onChange={(e) => setPrompt(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="e.g. Find best wireless earphones under ₹3000 on Flipkart..."
                        disabled={isRunning}
                        rows={3}
                        className="w-full px-3 py-2.5 bg-astra-surface border border-astra-border rounded-xl text-sm text-astra-text placeholder-astra-text-muted resize-none outline-none transition-all duration-200 focus:border-violet-500 focus:shadow-[0_0_0_3px_rgba(139,92,246,0.15)] disabled:opacity-50 font-sans"
                    />
                    <button
                        onClick={handleSubmit}
                        disabled={!prompt.trim() || isRunning}
                        className="absolute bottom-2.5 right-2.5 px-3 py-1.5 bg-gradient-to-r from-violet-600 to-indigo-500 text-white text-xs font-medium rounded-lg transition-all duration-200 hover:shadow-[0_0_12px_rgba(139,92,246,0.5)] hover:scale-[1.02] active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:shadow-none disabled:hover:scale-100"
                    >
                        {isRunning ? (
                            <span className="flex items-center gap-1.5">
                                <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                                </svg>
                                Running
                            </span>
                        ) : 'Run ⏎'}
                    </button>
                </div>
            </div>

            {/* ── Output Panel ─────────────────────────────────────────────────── */}
            <div ref={outputRef} className="flex-1 overflow-y-auto px-4 pb-4 space-y-3">

                {/* Step Progress */}
                {steps.length > 0 && (
                    <div className="space-y-1.5">
                        <p className="text-[10px] font-semibold text-astra-text-muted uppercase tracking-wider">
                            {isRunning ? 'Working...' : 'Completed Steps'}
                        </p>
                        {steps.map((step) => (
                            <div key={step.step} className="flex items-start gap-2 animate-slide-up">
                                <span className="text-sm mt-0.5 flex-shrink-0">
                                    {step.status === 'done' ? '✅' :
                                        step.status === 'error' ? '❌' :
                                            step.status === 'running' ? '🌀' : '○'}
                                </span>
                                <div className="flex-1 min-w-0">
                                    <span className={`text-xs ${step.status === 'done' ? 'text-astra-text-muted' : 'text-astra-text'}`}>
                                        {step.description}
                                    </span>
                                    {step.status === 'running' && (
                                        <span className="ml-2 text-[9px] text-violet-400 animate-pulse">●</span>
                                    )}
                                </div>
                                <span className="text-[9px] text-astra-text-muted flex-shrink-0">
                                    {step.step}/{step.totalSteps}
                                </span>
                            </div>
                        ))}
                    </div>
                )}

                {/* Action-Level Progress: Show what ASTRA is doing step-by-step */}
                {actionProgress.length > 0 && (
                    <div className="space-y-1">
                        <p className="text-[10px] font-semibold text-astra-text-muted uppercase tracking-wider">
                            📍 Actions Executed
                        </p>
                        {actionProgress.map((action, i) => (
                            <div key={i} className="flex items-start gap-2 text-xs animate-slide-up">
                                <span className="flex-shrink-0 mt-0.5">
                                    {action.status === 'success' ? '✅' :
                                        action.status === 'failed' ? '❌' :
                                            action.status === 'executing' ? '▶️' : '○'}
                                </span>
                                <div className="flex-1 min-w-0">
                                    <span className="text-astra-text">{action.emoji ?? ''} {action.label}</span>
                                    {action.result && (
                                        <div className="text-[9px] text-green-400/80 mt-0.5">→ {action.result}</div>
                                    )}
                                    {action.error && (
                                        <div className="text-[9px] text-red-400/80 mt-0.5">✗ {action.error}</div>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                )}

                {/* Follow-Up Question from Agent */}
                {followUp && (
                    <div className="animate-slide-up">
                        <div className="p-3 bg-violet-500/10 border border-violet-500/30 rounded-xl">
                            <div className="flex items-center gap-1.5 mb-2">
                                <span className="text-sm">🗣️</span>
                                <p className="text-[10px] font-semibold text-violet-400 uppercase tracking-wider">
                                    NEXUS needs your input
                                </p>
                            </div>
                            <p className="text-xs text-astra-text font-medium mb-2">{followUp.question}</p>
                            {followUp.context && (
                                <p className="text-[10px] text-astra-text-muted mb-2 italic">💡 {followUp.context}</p>
                            )}
                            {/* Quick-select option buttons */}
                            {followUp.options && followUp.options.length > 0 && (
                                <div className="flex flex-wrap gap-1.5 mb-2">
                                    {followUp.options.map((opt, i) => (
                                        <button
                                            key={i}
                                            onClick={() => sendFollowUpResponse(opt)}
                                            className="px-3 py-1.5 bg-violet-600/20 hover:bg-violet-600/40 border border-violet-500/30 hover:border-violet-500/60 text-xs text-violet-300 hover:text-white rounded-lg transition-all duration-150 active:scale-95"
                                        >
                                            {opt}
                                        </button>
                                    ))}
                                </div>
                            )}
                            {/* Free-text input for custom answers */}
                            <div className="flex gap-1.5">
                                <input
                                    type="text"
                                    value={followUpInput}
                                    onChange={(e) => setFollowUpInput(e.target.value)}
                                    onKeyDown={(e) => { if (e.key === 'Enter') sendFollowUpResponse(followUpInput); }}
                                    placeholder="Type your answer..."
                                    className="flex-1 px-2.5 py-1.5 bg-astra-surface border border-astra-border rounded-lg text-xs text-astra-text placeholder-astra-text-muted outline-none focus:border-violet-500 transition-colors"
                                    autoFocus
                                />
                                <button
                                    onClick={() => sendFollowUpResponse(followUpInput)}
                                    disabled={!followUpInput.trim()}
                                    className="px-3 py-1.5 bg-violet-600 text-white text-xs font-medium rounded-lg hover:bg-violet-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed active:scale-95"
                                >
                                    Send
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {/* Streaming AI text (for Q&A / non-browser tasks) */}
                {streamedText && rankedResults.length === 0 && (
                    <div className="animate-fade-in">
                        <p className="text-[10px] font-semibold text-astra-text-muted uppercase tracking-wider mb-2">
                            Response
                        </p>
                        <div className="p-3 bg-astra-surface border border-astra-border rounded-xl">
                            <pre className="text-xs text-astra-text whitespace-pre-wrap font-sans leading-relaxed">
                                {streamedText}
                                {isRunning && <span className="inline-block w-1 h-3 bg-violet-400 animate-pulse ml-0.5 rounded-sm" />}
                            </pre>
                        </div>
                    </div>
                )}

                {/* Ranked results (from browser research pipeline) */}
                {rankedResults.length > 0 && (
                    <div className="animate-fade-in space-y-2">
                        <p className="text-[10px] font-semibold text-astra-text-muted uppercase tracking-wider">
                            🏆 NEXUS Rankings
                        </p>
                        {rankedResults.map((r, i) => (
                            <div
                                key={i}
                                className="p-3 bg-astra-surface border border-astra-border rounded-xl hover:border-violet-500/50 transition-colors"
                            >
                                <div className="flex items-start justify-between gap-2 mb-1">
                                    <div className="flex items-center gap-1.5">
                                        <span className="text-[10px] font-bold text-violet-400">#{r.rank}</span>
                                        {r.badge && (
                                            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-violet-500/20 text-violet-300 font-medium">
                                                {r.badge}
                                            </span>
                                        )}
                                    </div>
                                    {r.rating && (
                                        <span className="text-[9px] text-yellow-400 flex-shrink-0">
                                            ⭐ {r.rating} {r.reviewCount ? `(${r.reviewCount})` : ''}
                                        </span>
                                    )}
                                </div>
                                <p className="text-xs font-medium text-astra-text leading-snug mb-1">
                                    {r.url ? (
                                        <a href={r.url} target="_blank" rel="noreferrer" className="hover:text-violet-400 transition-colors">
                                            {r.title}
                                        </a>
                                    ) : r.title}
                                </p>
                                {r.price && (
                                    <p className="text-[10px] text-green-400 font-semibold mb-1">{r.price}</p>
                                )}
                                {r.snippet && (
                                    <p className="text-[10px] text-astra-text-muted leading-relaxed">{r.snippet}</p>
                                )}
                                {r.reason && (
                                    <p className="text-[9px] text-violet-300/70 mt-1 italic">💡 {r.reason}</p>
                                )}
                            </div>
                        ))}
                    </div>
                )}

                {/* Short summary when ranked results are shown */}
                {rankedResults.length > 0 && streamedText && (
                    <div className="p-3 bg-astra-surface/50 border border-astra-border/50 rounded-xl">
                        <p className="text-[10px] text-astra-text-muted font-semibold uppercase tracking-wider mb-1">Summary</p>
                        <pre className="text-xs text-astra-text whitespace-pre-wrap font-sans leading-relaxed">{streamedText}</pre>
                    </div>
                )}

                {/* Error */}
                {error && (
                    <div className="animate-slide-up">
                        <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-xl">
                            <p className="text-xs text-red-400 font-medium mb-1">Error</p>
                            <p className="text-xs text-red-300">{error}</p>
                            {(error.includes('fetch') || error.includes('connect') || error.includes('backend')) && (
                                <p className="text-[10px] text-red-400/70 mt-1">Run: <code className="font-mono">cd backend && npm run dev</code></p>
                            )}
                        </div>
                    </div>
                )}

                {/* Empty State */}
                {steps.length === 0 && !streamedText && !error && !isRunning && (
                    <div className="flex flex-col items-center justify-center h-full pt-8 text-center animate-fade-in">
                        <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-violet-600/20 to-indigo-500/20 flex items-center justify-center mb-4">
                            <svg className="w-7 h-7 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z" />
                            </svg>
                        </div>
                        <p className="text-sm font-semibold text-astra-text mb-1">NEXUS Ready</p>
                        <p className="text-xs text-astra-text-muted max-w-[220px] leading-relaxed mb-4">
                            Your AI shopping assistant. Tell me what to find or research.
                        </p>
                        <div className="flex flex-col gap-1.5 w-full max-w-[260px]">
                            {[
                                '🛍️ Best wireless earphones under ₹3000',
                                '💍 Wedding gifts under ₹20000 on Flipkart',
                                '💻 Summarize this page',
                                '📊 Compare laptops on this page',
                            ].map((s) => (
                                <button
                                    key={s}
                                    onClick={() => setPrompt(s.replace(/^[^\s]+ /, ''))}
                                    className="text-left text-[11px] text-astra-text-muted hover:text-astra-text px-3 py-1.5 rounded-lg hover:bg-astra-surface border border-transparent hover:border-astra-border transition-all"
                                >
                                    {s}
                                </button>
                            ))}
                        </div>
                    </div>
                )}
            </div>

            {/* ── Footer ──────────────────────────────────────────────────────── */}
            <footer className="px-4 py-2 border-t border-astra-border bg-astra-surface/30 flex items-center justify-between">
                <p className="text-[9px] text-astra-text-muted">
                    NEXUS v1.0 · Groq + Fireworks · Real Browser Agent
                </p>
                <button
                    onClick={() => {
                        const trimmed = prompt.trim();
                        if (!trimmed || isRunning) return;
                        setViewMode('running');
                        setSteps([{ step: 1, totalSteps: 1, description: 'Generating walkthrough...', status: 'running' }]);
                        chrome.runtime.sendMessage({ type: 'SUBMIT_COMMAND', payload: { prompt: trimmed, locale: navigator.language } });
                    }}
                    disabled={!prompt.trim() || isRunning}
                    className="text-[9px] text-astra-text-muted hover:text-violet-400 transition-colors disabled:opacity-30"
                    title="Generate step-by-step walkthrough"
                >
                    📖 Guide
                </button>
            </footer>
        </div>
    );
}
