// ════════════════════════════════════════════════════════════════════════════
// ASTRA Dynamic Action Timeouts
// ─ Action-specific timeout ranges instead of one-size-fits-all
// ─ Reduces false negatives on slow operations (form fill, navigate)
// ─ Prevents hanging on quick operations (click)
// ════════════════════════════════════════════════════════════════════════════

export interface TimeoutRange {
    min: number;    // Absolute minimum timeout
    typical: number; // Expected timeout for normal cases
    max: number;    // Maximum before failing
}

/**
 * Action type → timeout range (in milliseconds)
 * Tuned based on typical operation speeds and network latency
 */
export const ACTION_TIMEOUTS: Record<string, TimeoutRange> = {
    // Pointer interactions - fast
    'click': { min: 500, typical: 2000, max: 5000 },
    'double_click': { min: 500, typical: 2000, max: 5000 },
    'right_click': { min: 500, typical: 2000, max: 5000 },
    'hover': { min: 500, typical: 1500, max: 3000 },
    'drag_and_drop': { min: 1000, typical: 3000, max: 8000 },
    'drag_drop': { min: 1000, typical: 3000, max: 8000 },
    'multi_click': { min: 1000, typical: 5000, max: 15000 },
    'highlight': { min: 500, typical: 1000, max: 2000 },

    // Text & form input - medium
    'type': { min: 1000, typical: 3000, max: 10000 },
    'set_value': { min: 500, typical: 1500, max: 3000 },
    'focus': { min: 500, typical: 1000, max: 2000 },
    'clear': { min: 500, typical: 1500, max: 3000 },
    'select_option': { min: 1000, typical: 2500, max: 6000 },
    'select-option': { min: 1000, typical: 2500, max: 6000 },
    'range_set': { min: 500, typical: 1500, max: 3000 },
    'range-set': { min: 500, typical: 1500, max: 3000 },
    'toggle_checkbox': { min: 500, typical: 1500, max: 3000 },
    'upload_file': { min: 1000, typical: 5000, max: 15000 },
    'fill_form': { min: 2000, typical: 8000, max: 20000 },
    'fill_form_smart': { min: 2000, typical: 10000, max: 25000 },
    'search': { min: 1000, typical: 3000, max: 8000 },
    'submit_form': { min: 1000, typical: 4000, max: 10000 },
    'copy_text': { min: 500, typical: 1000, max: 2000 },
    'extract_data': { min: 500, typical: 1500, max: 3000 },

    // Scrolling - fast
    'scroll': { min: 500, typical: 1000, max: 3000 },
    'scroll_to': { min: 500, typical: 1500, max: 3000 },
    'scroll_to_top': { min: 500, typical: 1500, max: 3000 },
    'scroll_to_bottom': { min: 500, typical: 1500, max: 3000 },
    'scroll_to_percent': { min: 500, typical: 1500, max: 3000 },
    'scroll_with_offset': { min: 500, typical: 1500, max: 3000 },
    'scroll_container': { min: 500, typical: 1500, max: 3000 },

    // Keyboard & dialogs - fast
    'press_enter': { min: 500, typical: 1000, max: 2000 },
    'keyboard': { min: 500, typical: 1500, max: 3000 },
    'dismiss_dialog': { min: 500, typical: 1500, max: 3000 },
    'handle_modal': { min: 1000, typical: 3000, max: 8000 },

    // Async & waiting - variable
    'wait': { min: 100, typical: 5000, max: 15000 },
    'wait_for': { min: 500, typical: 5000, max: 15000 },

    // Page analysis - medium
    'read_page': { min: 1000, typical: 3000, max: 8000 },
    'analyze_page': { min: 2000, typical: 5000, max: 12000 },
    'iframe_action': { min: 1000, typical: 4000, max: 10000 },

    // Assertions - fast
    'assert_visible': { min: 500, typical: 1500, max: 3000 },
    'assert_text': { min: 500, typical: 1500, max: 3000 },

    // Browser-level - slow
    'open_tab': { min: 2000, typical: 5000, max: 15000 },
    'new_tab': { min: 2000, typical: 5000, max: 15000 },
    'close_tab': { min: 500, typical: 1000, max: 3000 },
    'switch_tab': { min: 500, typical: 1000, max: 3000 },
    'reload_tab': { min: 2000, typical: 5000, max: 15000 },
    'duplicate_tab': { min: 1000, typical: 3000, max: 8000 },
    'pin_tab': { min: 300, typical: 800, max: 2000 },
    'mute_tab': { min: 300, typical: 800, max: 2000 },
    'move_tab': { min: 300, typical: 800, max: 2000 },
    'zoom_tab': { min: 300, typical: 800, max: 2000 },
    'navigate': { min: 2000, typical: 8000, max: 30000 },
    'go_back': { min: 2000, typical: 5000, max: 15000 },
    'go_forward': { min: 2000, typical: 5000, max: 15000 },
    'new_window': { min: 1000, typical: 3000, max: 8000 },
    'close_window': { min: 500, typical: 1000, max: 3000 },
    'focus_window': { min: 300, typical: 800, max: 2000 },
    'get_all_tabs': { min: 100, typical: 500, max: 2000 },
    'search_tabs': { min: 100, typical: 500, max: 2000 },
    'screenshot': { min: 500, typical: 2000, max: 5000 },
    'bookmark_page': { min: 300, typical: 1000, max: 3000 },
    'download_file': { min: 1000, typical: 5000, max: 15000 },
};

/**
 * Get timeout for a specific action.
 * Defaults to 'typical' range, but can override pessimistically to 'max'.
 */
export function getActionTimeout(
    actionType: string,
    strategy: 'typical' | 'optimistic' | 'pessimistic' = 'typical'
): number {
    const range = ACTION_TIMEOUTS[actionType] ?? {
        min: 1000,
        typical: 5000,
        max: 10000,
    };

    switch (strategy) {
        case 'optimistic':
            return range.min;
        case 'pessimistic':
            return range.max;
        case 'typical':
        default:
            return range.typical;
    }
}

/**
 * Suggest timeout adjustment based on retry count.
 * Scale up timeout if we've already retried.
 */
export function getAdjustedTimeout(
    actionType: string,
    attemptNumber: number,
    baseStrategy: 'typical' | 'optimistic' | 'pessimistic' = 'typical'
): number {
    const base = getActionTimeout(actionType, baseStrategy);
    
    if (attemptNumber === 0) return base;
    
    // Increase timeout by 50% per retry, up to max
    const range = ACTION_TIMEOUTS[actionType];
    if (!range) return base;
    
    const scaled = base * (1 + (0.5 * attemptNumber));
    return Math.min(scaled, range.max);
}

/**
 * Get expected completion time range for action planning.
 * Used for estimating total time to complete multi-action plans.
 */
export function estimateActionDuration(actionType: string): { min: number; max: number } {
    const range = ACTION_TIMEOUTS[actionType] ?? {
        min: 1000,
        typical: 5000,
        max: 10000,
    };
    return {
        min: range.min,
        max: range.max,
    };
}

/**
 * Estimate total duration for a sequence of actions.
 * Useful for long-running plans to prevent global timeout.
 */
export function estimatePlanDuration(
    actionTypes: string[],
    networkDelay: number = 1000 // Add per-action network latency
): { min: number; max: number } {
    let minTotal = 0;
    let maxTotal = 0;

    for (const type of actionTypes) {
        const { min, max } = estimateActionDuration(type);
        minTotal += min + networkDelay;
        maxTotal += max + networkDelay;
    }

    return { min: minTotal, max: maxTotal };
}

/**
 * Should we increase timeout for this action type?
 * Returns true for operations that are commonly slow or network-dependent.
 */
export function shouldPessimisticTimeout(actionType: string): boolean {
    const slowActions = [
        'navigate',
        'open_tab',
        'new_tab',
        'download_file',
        'upload_file',
        'fill_form',
        'fill_form_smart',
        'analyze_page',
        'reload_tab',
    ];
    return slowActions.includes(actionType);
}
