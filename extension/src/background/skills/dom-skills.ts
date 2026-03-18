// ============================================================================
// ASTRA DOM Skills - Enhanced
// - Content-script actions: click, type, scroll, keyboard, assertions, etc.
// - Per-skill validation with descriptive SkillResult errors
// - Retry wrapper for transient selector failures
// - Consistent relay guards for tabId/tabUrl
// ============================================================================

import type { Skill, SkillResult, BrowserContext } from './registry.js';
import type { PlannerAction } from '../../types/messages.js';

export type DOMSkillAction = PlannerAction & {
    selector?: string;
    value?: string | number;
    label?: string;
    attribute?: string;
    direction?: 'up' | 'down' | 'left' | 'right';
    amount?: number;
    duration?: number;
    timeout?: number;
    keys?: string[];
    fields?: Array<{ selector: string; value: string; label?: string }>;
    targetSelector?: string;
    innerAction?: DOMSkillAction;
    iframeSelector?: string;
    selectors?: string[];
    expectedText?: string;
    checked?: boolean;
    files?: string[];
    percent?: number;
    retries?: number;
};

export interface DOMSkillDeps {
    sendToTab: (tabId: number, msg: Record<string, unknown>, tabUrl?: string) => Promise<unknown>;
    sanitizeSelector: (raw: string) => string;
    sanitizeValue: (raw: string) => string;
    sleep: (ms: number) => Promise<void>;
}

function toDOMAction(action: PlannerAction): DOMSkillAction {
    return action as DOMSkillAction;
}

function skillError(message: string, code?: string): SkillResult {
    return { success: false, error: message, ...(code ? { code } : {}) };
}

function guardTab(tabId?: number, tabUrl?: string): SkillResult | null {
    if (!tabId) return skillError('No active tab - cannot relay DOM action.', 'NO_TAB');
    if (!tabUrl) return skillError('Tab URL missing - cannot relay DOM action.', 'NO_TAB_URL');
    return null;
}

function requireFields(action: DOMSkillAction, ...fields: Array<keyof DOMSkillAction>): SkillResult | null {
    for (const field of fields) {
        const val = action[field];
        if (val === undefined || val === null || String(val).trim() === '') {
            return skillError(
                `Action "${action.type}" is missing required field: ${String(field)}.`,
                'MISSING_FIELD',
            );
        }
    }
    return null;
}

function isTransientSelectorError(result: SkillResult): boolean {
    if (result.success) return false;
    const msg = (result.error ?? '').toLowerCase();
    return (
        msg.includes('not found')
        || msg.includes('queryselector')
        || msg.includes('stale')
        || msg.includes('detached')
        || msg.includes('timeout')
        || msg.includes('no target')
    );
}

export function buildDOMSkills(deps: DOMSkillDeps): Skill[] {
    const { sendToTab, sanitizeSelector, sanitizeValue, sleep } = deps;

    async function relay(
        tabId: number,
        tabUrl: string,
        payload: Record<string, unknown>,
    ): Promise<SkillResult> {
        return (await sendToTab(tabId, payload, tabUrl)) as SkillResult;
    }

    async function relayWithRetry(
        tabId: number,
        tabUrl: string,
        payload: Record<string, unknown>,
        maxRetries = 2,
        delayMs = 500,
    ): Promise<SkillResult> {
        let last: SkillResult = skillError('Not started');
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            last = await relay(tabId, tabUrl, payload);
            if (last.success) return last;
            if (!isTransientSelectorError(last)) return last;
            if (attempt < maxRetries) await sleep(delayMs * (attempt + 1));
        }
        return { ...last, error: `Failed after ${maxRetries + 1} attempts: ${last.error ?? 'unknown'}` };
    }

    function domAction(
        tabId: number,
        tabUrl: string,
        action: string,
        selector: string,
        value = '',
        extra: Record<string, unknown> = {},
    ): Promise<SkillResult> {
        return relay(tabId, tabUrl, {
            type: 'EXECUTE_DOM_ACTION',
            payload: { action, selector, value, ...extra },
        });
    }

    return [
        // Pointer interactions
        {
            name: 'click',
            type: 'dom',
            description: 'Click an element by CSS selector. Required: selector.',
            async execute(action: PlannerAction, _ctx: BrowserContext, tabId?: number, tabUrl?: string): Promise<SkillResult> {
                const a = toDOMAction(action);
                const tabErr = guardTab(tabId, tabUrl); if (tabErr) return tabErr;
                const reqErr = requireFields(a, 'selector'); if (reqErr) return reqErr;
                const selector = sanitizeSelector(a.selector!);
                return relayWithRetry(tabId!, tabUrl!, { type: 'CLICK_ELEMENT', payload: { selector, label: a.label } }, a.retries ?? 2);
            },
        },
        {
            name: 'double_click',
            type: 'dom',
            description: 'Double-click an element. Required: selector.',
            async execute(action: PlannerAction, _ctx: BrowserContext, tabId?: number, tabUrl?: string): Promise<SkillResult> {
                const a = toDOMAction(action);
                const tabErr = guardTab(tabId, tabUrl); if (tabErr) return tabErr;
                const reqErr = requireFields(a, 'selector'); if (reqErr) return reqErr;
                return relayWithRetry(tabId!, tabUrl!, {
                    type: 'EXECUTE_DOM_ACTION',
                    payload: { action: 'double_click', selector: sanitizeSelector(a.selector!) },
                }, a.retries ?? 1);
            },
        },
        {
            name: 'right_click',
            type: 'dom',
            description: 'Right-click an element. Required: selector.',
            async execute(action: PlannerAction, _ctx: BrowserContext, tabId?: number, tabUrl?: string): Promise<SkillResult> {
                const a = toDOMAction(action);
                const tabErr = guardTab(tabId, tabUrl); if (tabErr) return tabErr;
                const reqErr = requireFields(a, 'selector'); if (reqErr) return reqErr;
                return relay(tabId!, tabUrl!, {
                    type: 'EXECUTE_DOM_ACTION',
                    payload: { action: 'right_click', selector: sanitizeSelector(a.selector!) },
                });
            },
        },
        {
            name: 'hover',
            type: 'dom',
            description: 'Hover over an element. Required: selector.',
            async execute(action: PlannerAction, _ctx: BrowserContext, tabId?: number, tabUrl?: string): Promise<SkillResult> {
                const a = toDOMAction(action);
                const tabErr = guardTab(tabId, tabUrl); if (tabErr) return tabErr;
                const reqErr = requireFields(a, 'selector'); if (reqErr) return reqErr;
                return relay(tabId!, tabUrl!, {
                    type: 'HOVER_ELEMENT',
                    payload: { selector: sanitizeSelector(a.selector!), label: a.label },
                });
            },
        },
        {
            name: 'drag_and_drop',
            type: 'dom',
            description: 'Drag source element onto target element. Required: selector, targetSelector.',
            async execute(action: PlannerAction, _ctx: BrowserContext, tabId?: number, tabUrl?: string): Promise<SkillResult> {
                const a = toDOMAction(action);
                const tabErr = guardTab(tabId, tabUrl); if (tabErr) return tabErr;
                const reqErr = requireFields(a, 'selector', 'targetSelector'); if (reqErr) return reqErr;
                return relay(tabId!, tabUrl!, {
                    type: 'EXECUTE_DOM_ACTION',
                    payload: {
                        action: 'drag_and_drop',
                        selector: sanitizeSelector(a.selector!),
                        targetSelector: sanitizeSelector(a.targetSelector!),
                    },
                });
            },
        },
        {
            name: 'drag_drop',
            type: 'dom',
            description: 'Alias for drag_and_drop.',
            async execute(action: PlannerAction, _ctx: BrowserContext, tabId?: number, tabUrl?: string): Promise<SkillResult> {
                const a = toDOMAction(action);
                // Legacy shape may send fromSelector/toSelector.
                if (!a.selector && (a as unknown as { fromSelector?: string }).fromSelector) {
                    a.selector = (a as unknown as { fromSelector?: string }).fromSelector;
                }
                if (!a.targetSelector && (a as unknown as { toSelector?: string }).toSelector) {
                    a.targetSelector = (a as unknown as { toSelector?: string }).toSelector;
                }
                const tabErr = guardTab(tabId, tabUrl); if (tabErr) return tabErr;
                const reqErr = requireFields(a, 'selector', 'targetSelector'); if (reqErr) return reqErr;
                return relay(tabId!, tabUrl!, {
                    type: 'EXECUTE_DOM_ACTION',
                    payload: {
                        action: 'drag_and_drop',
                        selector: sanitizeSelector(a.selector!),
                        targetSelector: sanitizeSelector(a.targetSelector!),
                    },
                });
            },
        },
        {
            name: 'multi_click',
            type: 'dom',
            description: 'Click multiple selectors in sequence. Required: selectors[]. Optional: amount as delay ms.',
            async execute(action: PlannerAction, _ctx: BrowserContext, tabId?: number, tabUrl?: string): Promise<SkillResult> {
                const a = toDOMAction(action);
                const tabErr = guardTab(tabId, tabUrl); if (tabErr) return tabErr;
                if (!a.selectors?.length) return skillError('multi_click requires a non-empty selectors array.', 'MISSING_FIELD');

                const results: SkillResult[] = [];
                for (const raw of a.selectors) {
                    const selector = sanitizeSelector(raw);
                    const r = await relayWithRetry(tabId!, tabUrl!, { type: 'CLICK_ELEMENT', payload: { selector } }, a.retries ?? 1);
                    results.push(r);
                    if (!r.success) {
                        return skillError(`multi_click failed on selector "${selector}": ${r.error ?? 'unknown'}`, 'CLICK_FAILED');
                    }
                    if (a.amount) await sleep(a.amount);
                }
                return { success: true, data: results };
            },
        },
        {
            name: 'highlight',
            type: 'dom',
            description: 'Temporarily highlight an element. Required: selector.',
            async execute(action: PlannerAction, _ctx: BrowserContext, tabId?: number, tabUrl?: string): Promise<SkillResult> {
                const a = toDOMAction(action);
                const tabErr = guardTab(tabId, tabUrl); if (tabErr) return tabErr;
                const reqErr = requireFields(a, 'selector'); if (reqErr) return reqErr;
                return relay(tabId!, tabUrl!, {
                    type: 'EXECUTE_DOM_ACTION',
                    payload: {
                        action: 'highlight',
                        selector: sanitizeSelector(a.selector!),
                        duration: a.duration ?? 1500,
                    },
                });
            },
        },

        // Text and form input
        {
            name: 'type',
            type: 'dom',
            description: 'Type text into an input/textarea. Required: selector, value.',
            async execute(action: PlannerAction, _ctx: BrowserContext, tabId?: number, tabUrl?: string): Promise<SkillResult> {
                const a = toDOMAction(action);
                const tabErr = guardTab(tabId, tabUrl); if (tabErr) return tabErr;
                const reqErr = requireFields(a, 'selector', 'value'); if (reqErr) return reqErr;

                const selector = sanitizeSelector(a.selector!);
                const value = sanitizeValue(String(a.value!));

                // Semantic validation: Check if selector makes sense for type action
                const label = (a.label || '').toLowerCase();

                // Red flag detection: prevent typing into layout controls, resizers, etc.
                if ((label.includes('resize') || label.includes('layout') || (label.includes('nav') && label.includes('main'))) 
                    && !label.includes('search')) {
                    return {
                        success: false,
                        error: `Semantic validation failed: Trying to type into "${label}" suggests wrong element.`,
                        code: 'SEMANTIC_MISMATCH',
                    };
                }

                return relayWithRetry(tabId!, tabUrl!, { type: 'EXECUTE_DOM_ACTION', payload: { action: 'type', selector, value } }, a.retries ?? 2);
            },
        },
        {
            name: 'set_value',
            type: 'dom',
            description: 'Set input value directly (without per-key events). Required: selector, value.',
            async execute(action: PlannerAction, _ctx: BrowserContext, tabId?: number, tabUrl?: string): Promise<SkillResult> {
                const a = toDOMAction(action);
                const tabErr = guardTab(tabId, tabUrl); if (tabErr) return tabErr;
                const reqErr = requireFields(a, 'selector', 'value'); if (reqErr) return reqErr;
                return domAction(tabId!, tabUrl!, 'set_value', sanitizeSelector(a.selector!), sanitizeValue(String(a.value!)));
            },
        },
        {
            name: 'focus',
            type: 'dom',
            description: 'Focus an element. Required: selector.',
            async execute(action: PlannerAction, _ctx: BrowserContext, tabId?: number, tabUrl?: string): Promise<SkillResult> {
                const a = toDOMAction(action);
                const tabErr = guardTab(tabId, tabUrl); if (tabErr) return tabErr;
                const reqErr = requireFields(a, 'selector'); if (reqErr) return reqErr;
                return domAction(tabId!, tabUrl!, 'focus', sanitizeSelector(a.selector!));
            },
        },
        {
            name: 'clear',
            type: 'dom',
            description: 'Clear an input value. Required: selector.',
            async execute(action: PlannerAction, _ctx: BrowserContext, tabId?: number, tabUrl?: string): Promise<SkillResult> {
                const a = toDOMAction(action);
                const tabErr = guardTab(tabId, tabUrl); if (tabErr) return tabErr;
                const reqErr = requireFields(a, 'selector'); if (reqErr) return reqErr;
                return domAction(tabId!, tabUrl!, 'clear', sanitizeSelector(a.selector!));
            },
        },
        {
            name: 'select_option',
            type: 'dom',
            description: 'Select a value in a dropdown. Required: selector, value.',
            async execute(action: PlannerAction, _ctx: BrowserContext, tabId?: number, tabUrl?: string): Promise<SkillResult> {
                const a = toDOMAction(action);
                const tabErr = guardTab(tabId, tabUrl); if (tabErr) return tabErr;
                const reqErr = requireFields(a, 'selector', 'value'); if (reqErr) return reqErr;
                return domAction(tabId!, tabUrl!, 'select_option', sanitizeSelector(a.selector!), sanitizeValue(String(a.value!)));
            },
        },
        {
            name: 'select-option',
            type: 'dom',
            description: 'Alias for select_option.',
            async execute(action: PlannerAction, _ctx: BrowserContext, tabId?: number, tabUrl?: string): Promise<SkillResult> {
                const a = toDOMAction(action);
                const tabErr = guardTab(tabId, tabUrl); if (tabErr) return tabErr;
                const reqErr = requireFields(a, 'selector', 'value'); if (reqErr) return reqErr;
                return domAction(tabId!, tabUrl!, 'select_option', sanitizeSelector(a.selector!), sanitizeValue(String(a.value!)));
            },
        },
        {
            name: 'range_set',
            type: 'dom',
            description: 'Set a range slider value. Required: selector, value.',
            async execute(action: PlannerAction, _ctx: BrowserContext, tabId?: number, tabUrl?: string): Promise<SkillResult> {
                const a = toDOMAction(action);
                const tabErr = guardTab(tabId, tabUrl); if (tabErr) return tabErr;
                const reqErr = requireFields(a, 'selector', 'value'); if (reqErr) return reqErr;
                return domAction(tabId!, tabUrl!, 'range-set', sanitizeSelector(a.selector!), sanitizeValue(String(a.value!)));
            },
        },
        {
            name: 'range-set',
            type: 'dom',
            description: 'Alias for range_set.',
            async execute(action: PlannerAction, _ctx: BrowserContext, tabId?: number, tabUrl?: string): Promise<SkillResult> {
                const a = toDOMAction(action);
                const tabErr = guardTab(tabId, tabUrl); if (tabErr) return tabErr;
                const reqErr = requireFields(a, 'selector', 'value'); if (reqErr) return reqErr;
                return domAction(tabId!, tabUrl!, 'range-set', sanitizeSelector(a.selector!), sanitizeValue(String(a.value!)));
            },
        },
        {
            name: 'toggle_checkbox',
            type: 'dom',
            description: 'Toggle/check/uncheck a checkbox or radio. Required: selector.',
            async execute(action: PlannerAction, _ctx: BrowserContext, tabId?: number, tabUrl?: string): Promise<SkillResult> {
                const a = toDOMAction(action);
                const tabErr = guardTab(tabId, tabUrl); if (tabErr) return tabErr;
                const reqErr = requireFields(a, 'selector'); if (reqErr) return reqErr;
                return relay(tabId!, tabUrl!, {
                    type: 'EXECUTE_DOM_ACTION',
                    payload: {
                        action: 'toggle_checkbox',
                        selector: sanitizeSelector(a.selector!),
                        checked: a.checked,
                    },
                });
            },
        },
        {
            name: 'upload_file',
            type: 'dom',
            description: 'Upload one or more files to a file input. Required: selector, files[].',
            async execute(action: PlannerAction, _ctx: BrowserContext, tabId?: number, tabUrl?: string): Promise<SkillResult> {
                const a = toDOMAction(action);
                const tabErr = guardTab(tabId, tabUrl); if (tabErr) return tabErr;
                const reqErr = requireFields(a, 'selector'); if (reqErr) return reqErr;
                if (!a.files?.length) return skillError('upload_file requires a non-empty files array.', 'MISSING_FIELD');
                return relay(tabId!, tabUrl!, {
                    type: 'EXECUTE_DOM_ACTION',
                    payload: {
                        action: 'upload_file',
                        selector: sanitizeSelector(a.selector!),
                        files: a.files,
                    },
                });
            },
        },
        {
            name: 'fill_form',
            type: 'dom',
            description: 'Fill multiple form fields. Required: fields[].',
            async execute(action: PlannerAction, _ctx: BrowserContext, tabId?: number, tabUrl?: string): Promise<SkillResult> {
                const a = toDOMAction(action);
                const tabErr = guardTab(tabId, tabUrl); if (tabErr) return tabErr;
                if (!a.fields?.length) return skillError('fill_form requires a non-empty fields array.', 'MISSING_FIELD');
                const fields = a.fields.map((f) => ({
                    selector: sanitizeSelector(f.selector),
                    value: sanitizeValue(f.value),
                    label: f.label,
                }));
                return relay(tabId!, tabUrl!, { type: 'FILL_FORM', payload: { fields } });
            },
        },
        {
            name: 'search',
            type: 'dom',
            description: 'Search in the current page context. Required: value.',
            async execute(action: PlannerAction, _ctx: BrowserContext, tabId?: number, tabUrl?: string): Promise<SkillResult> {
                const a = toDOMAction(action);
                const tabErr = guardTab(tabId, tabUrl); if (tabErr) return tabErr;
                const reqErr = requireFields(a, 'value'); if (reqErr) return reqErr;
                return domAction(
                    tabId!,
                    tabUrl!,
                    'search',
                    a.selector ? sanitizeSelector(a.selector) : '',
                    sanitizeValue(String(a.value!)),
                );
            },
        },
        {
            name: 'submit_form',
            type: 'dom',
            description: 'Submit a form by selector or default submit button.',
            async execute(action: PlannerAction, _ctx: BrowserContext, tabId?: number, tabUrl?: string): Promise<SkillResult> {
                const a = toDOMAction(action);
                const tabErr = guardTab(tabId, tabUrl); if (tabErr) return tabErr;
                const selector = a.selector ? sanitizeSelector(a.selector) : 'button[type="submit"]';
                return domAction(tabId!, tabUrl!, 'click', selector);
            },
        },
        {
            name: 'copy_text',
            type: 'dom',
            description: 'Copy the text content of an element. Required: selector.',
            async execute(action: PlannerAction, _ctx: BrowserContext, tabId?: number, tabUrl?: string): Promise<SkillResult> {
                const a = toDOMAction(action);
                const tabErr = guardTab(tabId, tabUrl); if (tabErr) return tabErr;
                const reqErr = requireFields(a, 'selector'); if (reqErr) return reqErr;
                return relay(tabId!, tabUrl!, {
                    type: 'EXECUTE_DOM_ACTION',
                    payload: { action: 'copy_text', selector: sanitizeSelector(a.selector!) },
                });
            },
        },

        // Scroll
        {
            name: 'scroll',
            type: 'dom',
            description: 'Scroll page or element. Optional: selector, direction, amount.',
            async execute(action: PlannerAction, _ctx: BrowserContext, tabId?: number, tabUrl?: string): Promise<SkillResult> {
                const a = toDOMAction(action);
                const tabErr = guardTab(tabId, tabUrl); if (tabErr) return tabErr;
                return relay(tabId!, tabUrl!, {
                    type: 'EXECUTE_DOM_ACTION',
                    payload: {
                        action: 'scroll',
                        selector: a.selector ? sanitizeSelector(a.selector) : undefined,
                        direction: a.direction ?? 'down',
                        amount: a.amount ?? 300,
                    },
                });
            },
        },
        {
            name: 'scroll_to',
            type: 'dom',
            description: 'Scroll element into view. Required: selector.',
            async execute(action: PlannerAction, _ctx: BrowserContext, tabId?: number, tabUrl?: string): Promise<SkillResult> {
                const a = toDOMAction(action);
                const tabErr = guardTab(tabId, tabUrl); if (tabErr) return tabErr;
                const reqErr = requireFields(a, 'selector'); if (reqErr) return reqErr;
                return relay(tabId!, tabUrl!, {
                    type: 'EXECUTE_DOM_ACTION',
                    payload: { action: 'scroll_to', selector: sanitizeSelector(a.selector!) },
                });
            },
        },
        {
            name: 'scroll_to_top',
            type: 'dom',
            description: 'Scroll to top of page or container.',
            async execute(action: PlannerAction, _ctx: BrowserContext, tabId?: number, tabUrl?: string): Promise<SkillResult> {
                const a = toDOMAction(action);
                const tabErr = guardTab(tabId, tabUrl); if (tabErr) return tabErr;
                return relay(tabId!, tabUrl!, {
                    type: 'EXECUTE_DOM_ACTION',
                    payload: {
                        action: 'scroll',
                        selector: a.selector ? sanitizeSelector(a.selector) : undefined,
                        direction: 'up',
                        amount: 9_999_999,
                    },
                });
            },
        },
        {
            name: 'scroll_to_bottom',
            type: 'dom',
            description: 'Scroll to bottom of page or container.',
            async execute(action: PlannerAction, _ctx: BrowserContext, tabId?: number, tabUrl?: string): Promise<SkillResult> {
                const a = toDOMAction(action);
                const tabErr = guardTab(tabId, tabUrl); if (tabErr) return tabErr;
                return relay(tabId!, tabUrl!, {
                    type: 'EXECUTE_DOM_ACTION',
                    payload: {
                        action: 'scroll',
                        selector: a.selector ? sanitizeSelector(a.selector) : undefined,
                        direction: 'down',
                        amount: 9_999_999,
                    },
                });
            },
        },
        {
            name: 'scroll_to_percent',
            type: 'dom',
            description: 'Scroll to percentage of total page height. Required: percent (0-100).',
            async execute(action: PlannerAction, _ctx: BrowserContext, tabId?: number, tabUrl?: string): Promise<SkillResult> {
                const a = toDOMAction(action);
                const tabErr = guardTab(tabId, tabUrl); if (tabErr) return tabErr;
                const pct = a.percent;
                if (pct === undefined || pct === null || Number.isNaN(Number(pct))) {
                    return skillError('scroll_to_percent requires a numeric percent field (0-100).', 'MISSING_FIELD');
                }
                const clamped = Math.max(0, Math.min(100, Number(pct)));
                return relay(tabId!, tabUrl!, {
                    type: 'EXECUTE_DOM_ACTION',
                    payload: {
                        action: 'scroll_to_percent',
                        selector: a.selector ? sanitizeSelector(a.selector) : undefined,
                        percent: clamped,
                    },
                });
            },
        },

        // Keyboard and dialogs
        {
            name: 'press_enter',
            type: 'dom',
            description: 'Press Enter on selector or focused element.',
            async execute(action: PlannerAction, _ctx: BrowserContext, tabId?: number, tabUrl?: string): Promise<SkillResult> {
                const a = toDOMAction(action);
                const tabErr = guardTab(tabId, tabUrl); if (tabErr) return tabErr;
                return relay(tabId!, tabUrl!, {
                    type: 'EXECUTE_DOM_ACTION',
                    payload: { action: 'press_enter', selector: a.selector ? sanitizeSelector(a.selector) : '' },
                });
            },
        },
        {
            name: 'keyboard',
            type: 'dom',
            description: 'Send keyboard shortcuts. Required: keys[].',
            async execute(action: PlannerAction, _ctx: BrowserContext, tabId?: number, tabUrl?: string): Promise<SkillResult> {
                const a = toDOMAction(action);
                const tabErr = guardTab(tabId, tabUrl); if (tabErr) return tabErr;
                if (!a.keys?.length) return skillError('keyboard action requires a non-empty keys array.', 'MISSING_FIELD');
                return relay(tabId!, tabUrl!, { type: 'KEYBOARD_SHORTCUT', payload: { keys: a.keys } });
            },
        },
        {
            name: 'dismiss_dialog',
            type: 'dom',
            description: 'Handle a dialog with accept or dismiss behavior.',
            async execute(action: PlannerAction, _ctx: BrowserContext, tabId?: number, tabUrl?: string): Promise<SkillResult> {
                const a = toDOMAction(action);
                const tabErr = guardTab(tabId, tabUrl); if (tabErr) return tabErr;
                const response = String(a.value ?? 'dismiss');
                return relay(tabId!, tabUrl!, {
                    type: 'EXECUTE_DOM_ACTION',
                    payload: { action: 'dismiss_dialog', response },
                });
            },
        },

        // Wait and timing
        {
            name: 'wait',
            type: 'browser',
            description: 'Pause execution for duration milliseconds.',
            async execute(action: PlannerAction, _ctx: BrowserContext): Promise<SkillResult> {
                const a = toDOMAction(action);
                const raw =
                    typeof a.duration === 'number'
                        ? a.duration
                        : typeof a.value === 'number'
                            ? a.value
                            : typeof a.value === 'string'
                                ? Number.parseInt(a.value, 10)
                                : 1000;
                const ms = Math.max(100, Math.min(15_000, Number.isFinite(raw) ? raw : 1000));
                await sleep(ms);
                return { success: true };
            },
        },
        {
            name: 'wait_for',
            type: 'dom',
            description: 'Wait for selector presence. Required: selector. Optional timeout.',
            async execute(action: PlannerAction, _ctx: BrowserContext, tabId?: number, tabUrl?: string): Promise<SkillResult> {
                const a = toDOMAction(action);
                const tabErr = guardTab(tabId, tabUrl); if (tabErr) return tabErr;
                const reqErr = requireFields(a, 'selector'); if (reqErr) return reqErr;
                return relay(tabId!, tabUrl!, {
                    type: 'WAIT_FOR_ELEMENT',
                    payload: { selector: sanitizeSelector(a.selector!), timeout: a.timeout ?? 5000 },
                });
            },
        },

        // Data extraction
        {
            name: 'extract_data',
            type: 'dom',
            description: 'Extract text or attribute from selector. Required: selector.',
            async execute(action: PlannerAction, _ctx: BrowserContext, tabId?: number, tabUrl?: string): Promise<SkillResult> {
                const a = toDOMAction(action);
                const tabErr = guardTab(tabId, tabUrl); if (tabErr) return tabErr;
                const reqErr = requireFields(a, 'selector'); if (reqErr) return reqErr;
                return relay(tabId!, tabUrl!, {
                    type: 'EXTRACT_DATA',
                    payload: { selector: sanitizeSelector(a.selector!), attribute: a.attribute },
                });
            },
        },
        {
            name: 'get_attribute',
            type: 'dom',
            description: 'Get specific HTML attribute from selector. Required: selector, attribute.',
            async execute(action: PlannerAction, _ctx: BrowserContext, tabId?: number, tabUrl?: string): Promise<SkillResult> {
                const a = toDOMAction(action);
                const tabErr = guardTab(tabId, tabUrl); if (tabErr) return tabErr;
                const reqErr = requireFields(a, 'selector', 'attribute'); if (reqErr) return reqErr;
                return relay(tabId!, tabUrl!, {
                    type: 'EXTRACT_DATA',
                    payload: { selector: sanitizeSelector(a.selector!), attribute: a.attribute! },
                });
            },
        },

        // Assertions
        {
            name: 'assert_visible',
            type: 'dom',
            description: 'Assert selector is visible. Required: selector.',
            async execute(action: PlannerAction, _ctx: BrowserContext, tabId?: number, tabUrl?: string): Promise<SkillResult> {
                const a = toDOMAction(action);
                const tabErr = guardTab(tabId, tabUrl); if (tabErr) return tabErr;
                const reqErr = requireFields(a, 'selector'); if (reqErr) return reqErr;
                return relay(tabId!, tabUrl!, {
                    type: 'EXECUTE_DOM_ACTION',
                    payload: { action: 'assert_visible', selector: sanitizeSelector(a.selector!) },
                });
            },
        },
        {
            name: 'assert_text',
            type: 'dom',
            description: 'Assert selector text contains expectedText. Required: selector, expectedText.',
            async execute(action: PlannerAction, _ctx: BrowserContext, tabId?: number, tabUrl?: string): Promise<SkillResult> {
                const a = toDOMAction(action);
                const tabErr = guardTab(tabId, tabUrl); if (tabErr) return tabErr;
                const reqErr = requireFields(a, 'selector'); if (reqErr) return reqErr;
                if (a.expectedText === undefined) return skillError('assert_text requires expectedText field.', 'MISSING_FIELD');
                return relay(tabId!, tabUrl!, {
                    type: 'EXECUTE_DOM_ACTION',
                    payload: {
                        action: 'assert_text',
                        selector: sanitizeSelector(a.selector!),
                        expectedText: a.expectedText,
                    },
                });
            },
        },

        // Page analysis
        {
            name: 'read_page',
            type: 'dom',
            description: 'Run structured page analysis of current page.',
            async execute(_action: PlannerAction, _ctx: BrowserContext, tabId?: number, tabUrl?: string): Promise<SkillResult> {
                const tabErr = guardTab(tabId, tabUrl); if (tabErr) return tabErr;
                return relay(tabId!, tabUrl!, {
                    type: 'ANALYZE_PAGE',
                    payload: { maxScrolls: 10, scrollDelay: 300, includeStructure: true },
                });
            },
        },
        {
            name: 'analyze_page',
            type: 'dom',
            description: 'Alias for read_page.',
            async execute(_action: PlannerAction, _ctx: BrowserContext, tabId?: number, tabUrl?: string): Promise<SkillResult> {
                const tabErr = guardTab(tabId, tabUrl); if (tabErr) return tabErr;
                return relay(tabId!, tabUrl!, {
                    type: 'ANALYZE_PAGE',
                    payload: { maxScrolls: 10, scrollDelay: 300, includeStructure: true },
                });
            },
        },

        // Frame actions
        {
            name: 'iframe_action',
            type: 'dom',
            description: 'Execute a nested DOM action inside an iframe.',
            async execute(action: PlannerAction, _ctx: BrowserContext, tabId?: number, tabUrl?: string): Promise<SkillResult> {
                const a = toDOMAction(action);
                const tabErr = guardTab(tabId, tabUrl); if (tabErr) return tabErr;
                if (!a.iframeSelector) {
                    return skillError('iframe_action requires iframeSelector.', 'MISSING_FIELD');
                }
                if (!a.innerAction) {
                    return skillError('iframe_action requires innerAction.', 'MISSING_FIELD');
                }
                return relay(tabId!, tabUrl!, {
                    type: 'EXECUTE_DOM_ACTION',
                    payload: {
                        action: 'iframe_action',
                        iframeSelector: sanitizeSelector(a.iframeSelector),
                        innerAction: a.innerAction,
                    },
                });
            },
        },
    ] satisfies Skill[];
}
