// ════════════════════════════════════════════════════════════════════════════
// ASTRA Action Semantic Validator
// ─ Validates that actions make sense for the elements they target
// ─ Prevents typing into wrong inputs, clicking wrong buttons, etc.
// ════════════════════════════════════════════════════════════════════════════

export interface SemanticValidation {
    valid: boolean;
    score: number;  // 0-100, confidence in action-element pairing
    issues: string[];
    suggestions?: string[];
}

/**
 * Validate that an action makes sense for a given label/selector pairing.
 * Catches semantic mismatches like typing into resize inputs.
 */
export function validateActionSemantics(
    actionType: string,
    label: string,
    selector: string,
    element?: Element
): SemanticValidation {
    const issues: string[] = [];
    const suggestions: string[] = [];
    let score = 100;

    const labelLower = label.toLowerCase();
    const selectorLower = selector.toLowerCase();

    // ─── Type Action Validation ───
    if (actionType === 'type') {
        // Check label/selector mismatch
        if (!labelLower.includes('input') && !labelLower.includes('search') && !labelLower.includes('field') && !labelLower.includes('text')) {
            if (labelLower.includes('resize') || labelLower.includes('navigation') || labelLower.includes('layout')) {
                issues.push('Label suggests layout control, not text input');
                score -= 40;
                suggestions.push('Look for actual search input with role=search or placeholder="search"');
            }
        }

        // Check if selector suggests wrong element
        const wrongTypeKeywords = ['resize', 'layout', 'splitter', 'nav', 'toggle', 'button', 'nav-bar', 'sidebar'];
        for (const keyword of wrongTypeKeywords) {
            if (selectorLower.includes(keyword)) {
                issues.push(`Selector suggests "${keyword}" control, not searchable input`);
                score -= 30;
            }
        }

        // Element-level checks
        if (element) {
            const tag = element.tagName.toLowerCase();
            const type = element instanceof HTMLInputElement ? element.type : '';

            // Not an input
            if (tag !== 'input' && tag !== 'textarea' && !element.hasAttribute('contenteditable')) {
                issues.push(`Element is <${tag}>, not a text input`);
                score -= 50;
                suggestions.push('Use click action on this element, not type');
            }

            // Input but wrong type
            if (tag === 'input' && type && type !== 'text' && type !== 'search' && type !== 'email' && type !== 'password') {
                issues.push(`Input type="${type}" cannot accept typed text`);
                score -= 40;
            }

            // Check if element is hidden
            const style = window.getComputedStyle(element);
            if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) {
                issues.push('Element is hidden (display:none, visibility:hidden, or opacity:0)');
                score -= 50;
            }
        }
    }

    // ─── Click Action Validation ───
    if (actionType === 'click') {
        // Verify label suggests clickable
        const nonClickableKeywords = ['input', 'field', 'text', 'form'];
        for (const keyword of nonClickableKeywords) {
            if (labelLower.includes(keyword) && !labelLower.includes('button')) {
                issues.push(`Label suggests "${keyword}", not a clickable element`);
                score -= 20;
            }
        }

        if (element) {
            const tag = element.tagName.toLowerCase();
            const role = element.getAttribute('role')?.toLowerCase();

            // Not clickable
            if (!['button', 'a', 'input'].includes(tag) && role !== 'button' && role !== 'link' && role !== 'option') {
                issues.push(`<${tag}> may not be clickable`);
                score -= 15;
            }
        }
    }

    // ─── Select Action Validation ───
    if (actionType === 'select_option' || actionType === 'select-option') {
        if (!labelLower.includes('select') && !labelLower.includes('dropdown') && !labelLower.includes('option')) {
            issues.push('Label does not suggest dropdown/select element');
            score -= 20;
        }

        if (element && element.tagName.toLowerCase() !== 'select') {
            issues.push('Element is not a <select> element');
            score -= 40;
        }
    }

    // ─── General Checks ───
    // Check for generic mismatches
    if (label.length < 3) {
        issues.push('Label is too short to validate');
        score -= 10;
    }

    // Check for obvious contradictions
    const majorContradictions = [
        { label: 'resize', action: 'type', conflict: true },
        { label: 'navigation', action: 'type', conflict: true },
        { label: 'slider', action: 'type', conflict: true },
        { label: 'toggle', action: 'type', conflict: true },
    ];

    for (const contradiction of majorContradictions) {
        if (labelLower.includes(contradiction.label) && actionType === contradiction.action) {
            issues.push(`Action "${actionType}" contradicts label "${contradiction.label}"`);
            score -= 50;
        }
    }

    return {
        valid: score >= 60 && issues.length === 0,
        score: Math.max(0, score),
        issues,
        suggestions: suggestions.length > 0 ? suggestions : undefined,
    };
}

/**
 * Detailed scoring for element matching based on context.
 */
export function scoreElementForAction(
    element: Element,
    actionType: string,
    description: string
): number {
    let score = 50; // Base score

    const desc = description.toLowerCase();
    const elText = [
        element.getAttribute('placeholder'),
        element.getAttribute('aria-label'),
        element.getAttribute('name'),
        element.getAttribute('id'),
        element.getAttribute('class'),
        element.getAttribute('title'),
        element.getAttribute('data-testid'),
        element.textContent,
    ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

    // Exact keyword matches
    const keywords = desc.split(/\s+/).filter(w => w.length > 2);
    let exactMatches = 0;
    for (const keyword of keywords) {
        if (elText.includes(keyword)) {
            exactMatches++;
            score += 15;
        }
    }

    // Penalize if all keywords don't match
    if (exactMatches === 0) {
        score -= 30;
    } else if (exactMatches < keywords.length / 2) {
        score -= 10;
    }

    // Action-specific scoring
    if (actionType === 'type' || actionType === 'search') {
        // Prefer search-specific attributes
        if (element.hasAttribute('role') && element.getAttribute('role')!.includes('search')) score += 20;
        if (element.hasAttribute('aria-label') && element.getAttribute('aria-label')!.includes('search')) score += 20;
        if (element instanceof HTMLInputElement && (element.type === 'search' || element.type === 'text')) score += 15;

        // Penalize non-text elements
        if (element.tagName === 'INPUT' && element instanceof HTMLInputElement && element.type !== 'text' && element.type !== 'search') {
            score -= 40;
        }

        // Heavily penalize layout/control keywords
        const badKeywords = ['resize', 'layout', 'nav', 'toggle', 'splitter'];
        for (const bad of badKeywords) {
            if (elText.includes(bad)) {
                score -= 35;
            }
        }
    }

    if (actionType === 'click') {
        // Prefer button-like elements
        if (element.tagName === 'BUTTON') score += 15;
        if (element.hasAttribute('role') && element.getAttribute('role')!.includes('button')) score += 15;
        if (element.tagName === 'A') score += 10;

        // Penalize if it's clearly input-only
        if (element instanceof HTMLInputElement && element.type === 'text') score -= 20;
    }

    // Visibility bonus
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0 && rect.top >= 0) {
        score += 10;
    }

    return Math.max(0, Math.min(100, score));
}

/**
 * Check if action-label-selector pairing has red flags.
 */
export function hasSemanticRedFlags(
    actionType: string,
    label: string,
    selector: string
): { hasRedFlags: boolean; severity: 'critical' | 'warning' | 'info'; message: string } {
    const labelLower = label.toLowerCase();
    const selectorLower = selector.toLowerCase();

    // Critical red flags
    if (actionType === 'type') {
        if (labelLower.includes('resize')) {
            return {
                hasRedFlags: true,
                severity: 'critical',
                message: 'Trying to type into a resize control - element is wrong',
            };
        }
        if (selectorLower.includes('layoutresizer')) {
            return {
                hasRedFlags: true,
                severity: 'critical',
                message: 'Selector "LayoutResizer" is a layout control, not a text input',
            };
        }
    }

    // Warning red flags
    if (actionType === 'type' && labelLower.includes('navigation')) {
        return {
            hasRedFlags: true,
            severity: 'warning',
            message: 'Label suggests navigation element, not a searchable input',
        };
    }

    return {
        hasRedFlags: false,
        severity: 'info',
        message: 'No semantic issues detected',
    };
}
