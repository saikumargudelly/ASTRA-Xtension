import type { AgentStep, StepResult, BrowserAction } from '../types/index.js';

// ─── Browser Agent ───
// ROLE: Action FORMATTER for the Orchestrator pipeline.
// This module translates AgentStep structs into typed BrowserAction objects
// that the Chrome extension's dispatchPlannerAction() can execute.
//
// ⚠️  THIS MODULE DOES NOT EXECUTE ACTIONS. It formats them.
//     Actual execution happens in the extension's background/browser-actions.ts
//     via dispatchPlannerAction() which is called by the extension's ReAct loop.
//
// The formatted BrowserAction is returned as step.data.action so the
// /orchestrate pipeline can relay it to the extension via WebSocket or HTTP.
// If no relay mechanism is wired, the action is prepared but not delivered —
// use the /plan-actions route + extension ReAct loop for live browser tasks.

export type { BrowserAction };

export async function executeBrowserStep(step: AgentStep): Promise<StepResult> {
    const start = Date.now();

    try {
        const action = formatBrowserAction(step);

        return {
            stepId: step.id,
            success: true,
            data: {
                action,
                // Explicitly mark that this is a formatted command awaiting relay,
                // NOT a confirmation that the action was executed in the browser.
                pendingRelay: true,
                message: `Browser action "${step.action}" formatted — awaiting extension relay`,
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
