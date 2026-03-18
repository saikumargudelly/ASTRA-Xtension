// ════════════════════════════════════════════════════════════════════════════
// ASTRA DOM Skills
// ─ All content-script actions (click, type, scroll, keyboard, etc.).
// ─ Each skill describes itself and knows how to relay to the content script.
// ─ To add a new DOM action: append a new entry to buildDOMSkills() array.
//   The executor, security guard, and router all pick it up automatically.
// ════════════════════════════════════════════════════════════════════════════

import type { Skill, SkillResult, BrowserContext } from './registry.js';
import type { PlannerAction } from '../../types/messages.js';

export interface DOMSkillDeps {
    /** Relay a message to the content script running in a tab. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sendToTab: (tabId: number, msg: Record<string, any>, tabUrl?: string) => Promise<unknown>;
    sanitizeSelector: (raw: string) => string;
    sanitizeValue: (raw: string) => string;
    sleep: (ms: number) => Promise<void>;
}

type BAction = PlannerAction;

export function buildDOMSkills(deps: DOMSkillDeps): Skill[] {
    const { sendToTab, sanitizeSelector, sanitizeValue, sleep } = deps;

    // Small helper — the DOM skills all need the same relay call pattern
    async function relay(tabId: number, tabUrl: string, payload: Record<string, unknown>): Promise<SkillResult> {
        return await sendToTab(tabId, payload, tabUrl) as SkillResult;
    }

    return [
        // ── Pointer interactions ──────────────────────────────────────────
        {
            name: 'click',
            type: 'dom',
            description: 'Click an element by CSS selector. Required: selector.',
            async execute(action: BAction, _ctx: BrowserContext, tabId?: number, tabUrl?: string): Promise<SkillResult> {
                const selector = sanitizeSelector(action.selector ?? '');
                return relay(tabId!, tabUrl!, { type: 'CLICK_ELEMENT', payload: { selector, label: action.label } });
            },
        },
        {
            name: 'hover',
            type: 'dom',
            description: 'Hover the mouse over an element (triggers tooltips, dropdowns).',
            async execute(action: BAction, _ctx: BrowserContext, tabId?: number, tabUrl?: string): Promise<SkillResult> {
                const selector = sanitizeSelector(action.selector ?? '');
                return relay(tabId!, tabUrl!, { type: 'HOVER_ELEMENT', payload: { selector, label: action.label } });
            },
        },

        // ── Text & form input ─────────────────────────────────────────────
        {
            name: 'type',
            type: 'dom',
            description: 'Type text into an input/textarea. Required: selector, value.',
            async execute(action: BAction, _ctx: BrowserContext, tabId?: number, tabUrl?: string): Promise<SkillResult> {
                return relay(tabId!, tabUrl!, {
                    type: 'EXECUTE_DOM_ACTION',
                    payload: { action: 'type', selector: sanitizeSelector(action.selector ?? ''), value: sanitizeValue(action.value ?? '') },
                });
            },
        },
        {
            name: 'focus',
            type: 'dom',
            description: 'Focus an element without typing.',
            async execute(action: BAction, _ctx: BrowserContext, tabId?: number, tabUrl?: string): Promise<SkillResult> {
                return relay(tabId!, tabUrl!, {
                    type: 'EXECUTE_DOM_ACTION',
                    payload: { action: 'focus', selector: sanitizeSelector(action.selector ?? ''), value: '' },
                });
            },
        },
        {
            name: 'clear',
            type: 'dom',
            description: 'Clear the current value of an input element.',
            async execute(action: BAction, _ctx: BrowserContext, tabId?: number, tabUrl?: string): Promise<SkillResult> {
                return relay(tabId!, tabUrl!, {
                    type: 'EXECUTE_DOM_ACTION',
                    payload: { action: 'clear', selector: sanitizeSelector(action.selector ?? ''), value: '' },
                });
            },
        },
        {
            name: 'select_option',
            type: 'dom',
            description: 'Select an option in a <select> dropdown. Required: selector, value (option text or value).',
            async execute(action: BAction, _ctx: BrowserContext, tabId?: number, tabUrl?: string): Promise<SkillResult> {
                return relay(tabId!, tabUrl!, {
                    type: 'EXECUTE_DOM_ACTION',
                    payload: { action: 'select_option', selector: sanitizeSelector(action.selector ?? ''), value: sanitizeValue(action.value ?? '') },
                });
            },
        },
        {
            // Legacy alias from older planner versions
            name: 'select-option',
            type: 'dom',
            description: 'Alias for select_option.',
            async execute(action: BAction, _ctx: BrowserContext, tabId?: number, tabUrl?: string): Promise<SkillResult> {
                return relay(tabId!, tabUrl!, {
                    type: 'EXECUTE_DOM_ACTION',
                    payload: { action: 'select_option', selector: sanitizeSelector(action.selector ?? ''), value: sanitizeValue(action.value ?? '') },
                });
            },
        },
        {
            name: 'range-set',
            type: 'dom',
            description: 'Set an <input type="range"> slider to a numeric value.',
            async execute(action: BAction, _ctx: BrowserContext, tabId?: number, tabUrl?: string): Promise<SkillResult> {
                return relay(tabId!, tabUrl!, {
                    type: 'EXECUTE_DOM_ACTION',
                    payload: { action: 'range-set', selector: sanitizeSelector(action.selector ?? ''), value: sanitizeValue(action.value ?? '') },
                });
            },
        },
        {
            name: 'fill_form',
            type: 'dom',
            description: 'Fill multiple form fields at once. Required: fields array [{selector, value, label?}].',
            async execute(action: BAction, _ctx: BrowserContext, tabId?: number, tabUrl?: string): Promise<SkillResult> {
                const fields = ((action as { fields?: Array<{ selector: string; value: string; label?: string }> }).fields ?? [])
                    .map(f => ({ selector: sanitizeSelector(f.selector), value: sanitizeValue(f.value), label: f.label }));
                return relay(tabId!, tabUrl!, { type: 'FILL_FORM', payload: { fields } });
            },
        },
        {
            name: 'search',
            type: 'dom',
            description: 'Type into the page\'s active search box and submit. Required: value.',
            async execute(action: BAction, _ctx: BrowserContext, tabId?: number, tabUrl?: string): Promise<SkillResult> {
                return relay(tabId!, tabUrl!, {
                    type: 'EXECUTE_DOM_ACTION',
                    payload: { action: 'search', value: sanitizeValue(action.value ?? '') },
                });
            },
        },
        {
            name: 'submit_form',
            type: 'dom',
            description: 'Submit a form. Uses the provided selector or falls back to button[type="submit"].',
            async execute(action: BAction, _ctx: BrowserContext, tabId?: number, tabUrl?: string): Promise<SkillResult> {
                const selector = action.selector ? sanitizeSelector(action.selector) : 'button[type="submit"]';
                return relay(tabId!, tabUrl!, {
                    type: 'EXECUTE_DOM_ACTION',
                    payload: { action: 'click', selector },
                });
            },
        },

        // ── Scroll ────────────────────────────────────────────────────────
        {
            name: 'scroll',
            type: 'dom',
            description: 'Scroll the page. direction: "up"|"down"|"left"|"right". amount: pixels (default 300).',
            async execute(action: BAction, _ctx: BrowserContext, tabId?: number, tabUrl?: string): Promise<SkillResult> {
                return relay(tabId!, tabUrl!, {
                    type: 'EXECUTE_DOM_ACTION',
                    payload: {
                        action: 'scroll',
                        direction: (action as { direction?: string }).direction ?? 'down',
                        amount: (action as { amount?: number }).amount ?? 300,
                    },
                });
            },
        },
        {
            name: 'scroll_to',
            type: 'dom',
            description: 'Scroll a specific element into view by selector.',
            async execute(action: BAction, _ctx: BrowserContext, tabId?: number, tabUrl?: string): Promise<SkillResult> {
                return relay(tabId!, tabUrl!, {
                    type: 'EXECUTE_DOM_ACTION',
                    payload: { action: 'scroll', selector: sanitizeSelector(action.selector ?? 'body') },
                });
            },
        },

        // ── Keyboard ──────────────────────────────────────────────────────
        {            name: 'press_enter',
            type: 'dom',
            description: 'Press Enter on a specific element (by selector/elementIdx) or the currently focused element. Use this immediately after a type action on a search bar to submit the search — avoids needing to find a separate submit button.',
            async execute(action: BAction, _ctx: BrowserContext, tabId?: number, tabUrl?: string): Promise<SkillResult> {
                return relay(tabId!, tabUrl!, {
                    type: 'EXECUTE_DOM_ACTION',
                    payload: { action: 'press_enter', selector: action.selector ?? '' },
                });
            },
        },
        {            name: 'keyboard',
            type: 'dom',
            description: 'Send keyboard shortcut(s) to the page. keys: array of key names e.g. ["Ctrl+F"].',
            async execute(action: BAction, _ctx: BrowserContext, tabId?: number, tabUrl?: string): Promise<SkillResult> {
                const keys = (action as { keys?: string[] }).keys ?? [];
                return relay(tabId!, tabUrl!, { type: 'KEYBOARD_SHORTCUT', payload: { keys } });
            },
        },

        // ── Wait / timing ─────────────────────────────────────────────────
        {
            name: 'wait',
            type: 'dom',
            description: 'Pause execution for a specified duration (ms). Default 1000ms.',
            async execute(action: BAction, _ctx: BrowserContext): Promise<SkillResult> {
                await sleep((action as { duration?: number }).duration ?? 1000);
                return { success: true };
            },
        },
        {
            name: 'wait_for',
            type: 'dom',
            description: 'Wait for a CSS selector to appear in the DOM. Optional timeout (ms).',
            async execute(action: BAction, _ctx: BrowserContext, tabId?: number, tabUrl?: string): Promise<SkillResult> {
                return relay(tabId!, tabUrl!, {
                    type: 'WAIT_FOR_ELEMENT',
                    payload: { selector: sanitizeSelector(action.selector ?? ''), timeout: (action as { timeout?: number }).timeout ?? 5000 },
                });
            },
        },

        // ── Data extraction ───────────────────────────────────────────────
        {
            name: 'extract_data',
            type: 'dom',
            description: 'Extract text or an attribute from an element. Optional: attribute name.',
            async execute(action: BAction, _ctx: BrowserContext, tabId?: number, tabUrl?: string): Promise<SkillResult> {
                return relay(tabId!, tabUrl!, {
                    type: 'EXTRACT_DATA',
                    payload: { selector: sanitizeSelector(action.selector ?? 'body'), attribute: (action as { attribute?: string }).attribute },
                });
            },
        },

        // ── Page analysis ─────────────────────────────────────────────────
        {
            name: 'read_page',
            type: 'dom',
            description: 'Read and return structured DOM content of the current page (text, links, forms).',
            async execute(_action: BAction, _ctx: BrowserContext, tabId?: number, tabUrl?: string): Promise<SkillResult> {
                return relay(tabId!, tabUrl!, {
                    type: 'ANALYZE_PAGE',
                    payload: { maxScrolls: 10, scrollDelay: 300, includeStructure: true },
                });
            },
        },
        {
            name: 'analyze_page',
            type: 'dom',
            description: 'Alias for read_page — returns structured DOM analysis of the current page.',
            async execute(_action: BAction, _ctx: BrowserContext, tabId?: number, tabUrl?: string): Promise<SkillResult> {
                return relay(tabId!, tabUrl!, {
                    type: 'ANALYZE_PAGE',
                    payload: { maxScrolls: 10, scrollDelay: 300, includeStructure: true },
                });
            },
        },
    ] satisfies Skill[];
}
