import React, { useState, useRef, useEffect } from 'react';
import type {
    CommandResultMessage,
    CommandProgressMessage,
    CommandErrorMessage,
} from '../types/messages';

interface StepProgress {
    step: number;
    totalSteps: number;
    description: string;
    status: 'pending' | 'running' | 'done' | 'error';
}

export function Popup() {
    const [prompt, setPrompt] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [steps, setSteps] = useState<StepProgress[]>([]);
    const [result, setResult] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const outputRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const listener = (message: CommandResultMessage | CommandProgressMessage | CommandErrorMessage) => {
            switch (message.type) {
                case 'COMMAND_PROGRESS':
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
                    break;

                case 'COMMAND_ERROR':
                    setIsLoading(false);
                    setError(message.payload.message);
                    break;
            }
        };

        chrome.runtime.onMessage.addListener(listener);
        return () => chrome.runtime.onMessage.removeListener(listener);
    }, []);

    useEffect(() => {
        if (outputRef.current) {
            outputRef.current.scrollTop = outputRef.current.scrollHeight;
        }
    }, [steps, result, error]);

    const handleSubmit = () => {
        if (!prompt.trim() || isLoading) return;

        setIsLoading(true);
        setSteps([]);
        setResult(null);
        setError(null);

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
                <div>
                    <h1 className="text-sm font-semibold text-astra-text tracking-wide">ASTRA</h1>
                    <p className="text-[10px] text-astra-text-muted">AI Browser Assistant</p>
                </div>
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
                            Type a command like "summarize this page" or "collect Reddit posts from r/technology"
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
