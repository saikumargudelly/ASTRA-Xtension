import type { AgentStep, StepResult, BrowserAction } from '../types/index.js';

// ─── Browser Agent ───
// Translates high-level step plans into browser extension commands.

export async function executeBrowserStep(step: AgentStep): Promise<StepResult> {
    const start = Date.now();

    try {
        const action = formatBrowserAction(step);

        return {
            stepId: step.id,
            success: true,
            data: {
                action,
                message: `Browser action "${step.action}" prepared for execution`,
            },
            durationMs: Date.now() - start,
        };
    } catch (err) {
        return {
            stepId: step.id,
            success: false,
            error: err instanceof Error ? err.message : String(err),
            durationMs: Date.now() - start,
        };
    }
}

function formatBrowserAction(step: AgentStep): BrowserAction {
    const p = step.params;

    switch (step.action) {
        case 'scroll':
            return {
                type: 'scroll',
                direction: (p.direction as 'up' | 'down') ?? 'down',
                amount: Number(p.amount ?? 500),
                selector: p.selector as string | undefined,
            };

        case 'click':
            return { type: 'click', selector: String(p.selector ?? '') };

        case 'type':
            return { type: 'type', selector: String(p.selector ?? ''), value: String(p.value ?? '') };

        case 'wait':
            return { type: 'wait', duration: Number(p.duration ?? 1000) };

        case 'read_page':
            return {
                type: 'read_page',
                selector: p.selector as string | undefined,
                maxDepth: Number(p.maxDepth ?? 5),
            };

        case 'analyze_page':
            return {
                type: 'analyze_page',
                maxScrolls: Number(p.maxScrolls ?? 15),
                scrollDelay: Number(p.scrollDelay ?? 400),
            };

        case 'search':
            return { type: 'search', value: String(p.value ?? '') };

        default:
            throw new Error(`Unknown browser action: ${step.action}`);
    }
}
