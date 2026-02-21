// ─── Walkthrough Component ───
// Interactive step-by-step guide display for configuration assistance
// Walks users through each step with clear navigation and progress tracking

import React, { useState, useEffect, useCallback } from 'react';

// Types matching backend types
interface UIElement {
    type: 'button' | 'menu' | 'input' | 'link' | 'tab' | 'dropdown' | 'checkbox' | 'toggle';
    label: string;
    location?: string;
    action?: string;
}

interface NavigationHint {
    path: string[];
    url?: string;
    shortcut?: string;
}

interface WalkthroughStep {
    stepNumber: number;
    title: string;
    instruction: string;
    tips?: string[];
    warnings?: string[];
    estimatedSeconds?: number;
    screenshot?: string;
    uiElements?: UIElement[];
    navigation?: NavigationHint;
}

interface Walkthrough {
    id: string;
    title: string;
    description: string;
    application: string;
    totalSteps: number;
    estimatedTime?: string;
    steps: WalkthroughStep[];
    source: {
        url: string;
        name: string;
    };
    lastUpdated: string;
}

interface AlternativeGuide {
    title: string;
    url: string;
    source: string;
}

interface WalkthroughProps {
    walkthrough: Walkthrough;
    alternativeGuides?: AlternativeGuide[];
    onClose: () => void;
}

export function WalkthroughComponent({ walkthrough, alternativeGuides, onClose }: WalkthroughProps) {
    const [currentStep, setCurrentStep] = useState(0);
    const [completedSteps, setCompletedSteps] = useState<Set<number>>(new Set());
    const [showStepList, setShowStepList] = useState(false);
    const [animating, setAnimating] = useState(false);

    const step = walkthrough.steps[currentStep];
    const isFirstStep = currentStep === 0;
    const isLastStep = currentStep === walkthrough.steps.length - 1;
    const progress = ((currentStep + 1) / walkthrough.steps.length) * 100;
    const allCompleted = completedSteps.size === walkthrough.steps.length;

    // Animate step transitions
    const goToStep = useCallback((index: number) => {
        if (index >= 0 && index < walkthrough.steps.length && !animating) {
            setAnimating(true);
            setTimeout(() => {
                setCurrentStep(index);
                setAnimating(false);
            }, 150);
        }
    }, [walkthrough.steps.length, animating]);

    const handleNext = () => {
        if (!isLastStep) {
            setCompletedSteps(prev => new Set([...prev, currentStep]));
            goToStep(currentStep + 1);
        }
    };

    const handlePrevious = () => {
        if (!isFirstStep) {
            goToStep(currentStep - 1);
        }
    };

    const handleStepClick = (index: number) => {
        goToStep(index);
        setShowStepList(false);
    };

    const handleComplete = () => {
        setCompletedSteps(prev => new Set([...prev, currentStep]));
    };

    const handleKeyDown = useCallback((e: KeyboardEvent) => {
        switch (e.key) {
            case 'ArrowRight':
            case 'n':
            case 'N':
                if (!isLastStep) handleNext();
                break;
            case 'ArrowLeft':
            case 'p':
            case 'P':
                if (!isFirstStep) handlePrevious();
                break;
            case 'Escape':
                onClose();
                break;
        }
    }, [isLastStep, isFirstStep, onClose]);

    useEffect(() => {
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [handleKeyDown]);

    return (
        <div className="flex flex-col h-full bg-astra-bg">
            {/* Header */}
            <div className="flex items-center justify-between p-3 border-b border-astra-border bg-astra-surface/50">
                <div className="flex items-center gap-2 flex-1 min-w-0">
                    <span className="text-lg flex-shrink-0">📋</span>
                    <div className="flex-1 min-w-0">
                        <h2 className="text-sm font-semibold text-astra-text truncate">
                            {walkthrough.title}
                        </h2>
                        <p className="text-xs text-astra-text-muted truncate">
                            {walkthrough.application} • {walkthrough.totalSteps} steps
                            {walkthrough.estimatedTime && ` • ⏱️ ${walkthrough.estimatedTime}`}
                        </p>
                    </div>
                </div>
                <button
                    onClick={onClose}
                    className="p-1.5 text-astra-text-muted hover:text-astra-text hover:bg-astra-surface rounded-lg transition-colors flex-shrink-0"
                    title="Close (Esc)"
                >
                    ✕
                </button>
            </div>

            {/* Progress Bar */}
            <div className="px-3 py-2 border-b border-astra-border">
                <div className="flex items-center justify-between text-xs text-astra-text-muted mb-1.5">
                    <span className="font-medium">
                        Step {currentStep + 1} of {walkthrough.totalSteps}
                    </span>
                    <span className="text-astra-primary font-medium">
                        {Math.round(progress)}% complete
                    </span>
                </div>
                <div className="h-2 bg-astra-surface rounded-full overflow-hidden">
                    <div
                        className="h-full bg-gradient-to-r from-astra-primary to-astra-accent transition-all duration-300 ease-out"
                        style={{ width: `${progress}%` }}
                    />
                </div>
            </div>

            {/* Step Navigation Pills */}
            <div className="px-3 py-2 border-b border-astra-border bg-astra-surface/30">
                <div className="flex items-center gap-1 overflow-x-auto pb-1">
                    {walkthrough.steps.map((s, index) => (
                        <button
                            key={index}
                            onClick={() => handleStepClick(index)}
                            className={`flex-shrink-0 w-8 h-8 text-xs font-medium rounded-lg transition-all duration-200 ${
                                index === currentStep
                                    ? 'bg-astra-primary text-white shadow-md scale-110'
                                    : completedSteps.has(index)
                                    ? 'bg-astra-success/20 text-astra-success border border-astra-success/30'
                                    : 'bg-astra-surface text-astra-text-muted hover:bg-astra-surface-hover border border-astra-border'
                            }`}
                            title={`Step ${index + 1}: ${s.title}`}
                        >
                            {completedSteps.has(index) ? '✓' : index + 1}
                        </button>
                    ))}
                </div>
            </div>

            {/* Main Content Area */}
            <div className={`flex-1 overflow-y-auto p-4 transition-opacity duration-150 ${animating ? 'opacity-0' : 'opacity-100'}`}>
                <div className="space-y-4">
                    {/* Step Header */}
                    <div className="flex items-start gap-3">
                        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-astra-primary to-astra-accent flex items-center justify-center text-white font-bold text-sm shadow-lg flex-shrink-0">
                            {currentStep + 1}
                        </div>
                        <div className="flex-1 min-w-0">
                            <h3 className="text-base font-semibold text-astra-text leading-tight">
                                {step.title}
                            </h3>
                            {step.estimatedSeconds && (
                                <p className="text-xs text-astra-text-muted mt-0.5">
                                    ⏱️ ~{step.estimatedSeconds < 60 
                                        ? `${step.estimatedSeconds} seconds` 
                                        : `${Math.ceil(step.estimatedSeconds / 60)} minutes`}
                                </p>
                            )}
                        </div>
                    </div>

                    {/* Navigation Path */}
                    {step.navigation && step.navigation.path.length > 0 && (
                        <div className="flex items-center gap-1.5 text-xs bg-blue-500/10 text-blue-400 px-3 py-2 rounded-lg border border-blue-500/20">
                            <span className="font-medium">📍 Path:</span>
                            <div className="flex items-center gap-1 flex-wrap">
                                {step.navigation.path.map((p, i) => (
                                    <React.Fragment key={i}>
                                        <span className="font-medium">{p}</span>
                                        {i < step.navigation!.path.length - 1 && (
                                            <span className="text-blue-500/50">→</span>
                                        )}
                                    </React.Fragment>
                                ))}
                            </div>
                            {step.navigation.shortcut && (
                                <span className="ml-auto text-astra-text-muted">
                                    Shortcut: <kbd className="px-1.5 py-0.5 bg-astra-surface rounded text-[10px]">{step.navigation.shortcut}</kbd>
                                </span>
                            )}
                        </div>
                    )}

                    {/* Main Instruction */}
                    <div className="bg-astra-surface border border-astra-border rounded-xl p-4">
                        <p className="text-sm text-astra-text leading-relaxed">
                            {step.instruction}
                        </p>
                    </div>

                    {/* UI Elements */}
                    {step.uiElements && step.uiElements.length > 0 && (
                        <div className="space-y-2">
                            <p className="text-xs font-medium text-astra-text-muted uppercase tracking-wider">
                                UI Elements to Look For
                            </p>
                            {step.uiElements.map((el, i) => (
                                <div key={i} className="flex items-center gap-3 text-sm bg-astra-surface border border-astra-border px-3 py-2.5 rounded-lg">
                                    <span className="text-lg">
                                        {getElementIcon(el.type)}
                                    </span>
                                    <div className="flex-1 min-w-0">
                                        <span className="font-medium text-astra-text">{el.label}</span>
                                        {el.location && (
                                            <span className="text-astra-text-muted text-xs block mt-0.5">
                                                📍 {el.location}
                                            </span>
                                        )}
                                    </div>
                                    {el.action && (
                                        <span className="text-xs bg-astra-primary/10 text-astra-primary px-2 py-1 rounded-full">
                                            {el.action}
                                        </span>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Tips */}
                    {step.tips && step.tips.length > 0 && (
                        <div className="space-y-2">
                            <p className="text-xs font-medium text-blue-400 uppercase tracking-wider">
                                💡 Tips
                            </p>
                            {step.tips.map((tip, i) => (
                                <div key={i} className="flex items-start gap-2 text-sm bg-blue-500/10 text-blue-300 px-3 py-2.5 rounded-lg border border-blue-500/20">
                                    <span className="text-blue-400 mt-0.5">•</span>
                                    <span>{tip}</span>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Warnings */}
                    {step.warnings && step.warnings.length > 0 && (
                        <div className="space-y-2">
                            <p className="text-xs font-medium text-yellow-500 uppercase tracking-wider">
                                ⚠️ Warnings
                            </p>
                            {step.warnings.map((warning, i) => (
                                <div key={i} className="flex items-start gap-2 text-sm bg-yellow-500/10 text-yellow-500 px-3 py-2.5 rounded-lg border border-yellow-500/20">
                                    <span className="text-yellow-500 mt-0.5">!</span>
                                    <span>{warning}</span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            {/* Navigation Buttons */}
            <div className="p-3 border-t border-astra-border bg-astra-surface/50">
                <div className="flex gap-2">
                    <button
                        onClick={handlePrevious}
                        disabled={isFirstStep}
                        className={`flex-1 py-2.5 px-4 text-sm font-medium rounded-lg transition-all duration-200 ${
                            isFirstStep
                                ? 'bg-astra-surface/50 text-astra-text-muted cursor-not-allowed'
                                : 'bg-astra-surface text-astra-text hover:bg-astra-surface-hover border border-astra-border active:scale-[0.98]'
                        }`}
                    >
                        ← Previous
                    </button>
                    
                    {isLastStep ? (
                        <button
                            onClick={handleComplete}
                            className={`flex-1 py-2.5 px-4 text-sm font-medium rounded-lg transition-all duration-200 active:scale-[0.98] ${
                                allCompleted
                                    ? 'bg-astra-success text-white'
                                    : 'bg-gradient-to-r from-astra-primary to-astra-accent text-white hover:shadow-lg'
                            }`}
                        >
                            ✓ Complete Walkthrough
                        </button>
                    ) : (
                        <button
                            onClick={handleNext}
                            className="flex-1 py-2.5 px-4 text-sm font-medium bg-gradient-to-r from-astra-primary to-astra-accent text-white rounded-lg hover:shadow-lg transition-all duration-200 active:scale-[0.98]"
                        >
                            Next Step →
                        </button>
                    )}
                </div>
                
                {/* Keyboard shortcuts hint */}
                <p className="text-[10px] text-astra-text-muted text-center mt-2">
                    Use ← → arrow keys or N/P to navigate • Esc to close
                </p>
            </div>

            {/* Source Attribution */}
            <div className="px-3 py-2 border-t border-astra-border bg-astra-surface/30">
                <a
                    href={walkthrough.source.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-astra-text-muted hover:text-astra-primary transition-colors flex items-center gap-1"
                >
                    📖 Source: <span className="underline">{walkthrough.source.name}</span>
                    <span className="text-[10px]">↗</span>
                </a>
            </div>

            {/* Alternative Guides */}
            {alternativeGuides && alternativeGuides.length > 0 && (
                <details className="px-3 py-2 border-t border-astra-border">
                    <summary className="text-xs text-astra-text-muted cursor-pointer hover:text-astra-text">
                        Alternative guides ({alternativeGuides.length})
                    </summary>
                    <div className="mt-2 space-y-1">
                        {alternativeGuides.map((guide, i) => (
                            <a
                                key={i}
                                href={guide.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="block text-xs text-astra-accent hover:underline truncate py-1"
                            >
                                • {guide.title}
                            </a>
                        ))}
                    </div>
                </details>
            )}
        </div>
    );
}

// Helper function to get icon for UI element type
function getElementIcon(type: UIElement['type']): string {
    switch (type) {
        case 'button': return '🔘';
        case 'menu': return '📋';
        case 'input': return '✏️';
        case 'link': return '🔗';
        case 'tab': return '📑';
        case 'dropdown': return '▼';
        case 'checkbox': return '☑️';
        case 'toggle': return '🎚️';
        default: return '•';
    }
}

export default WalkthroughComponent;
