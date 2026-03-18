// ════════════════════════════════════════════════════════════════════════════
// ASTRA Enhanced Element Finding
// ─ Multi-strategy fallback: CSS → aria-label → data-testid → XPath → text fuzzy
// ─ Smart element discovery for complex SPAs and web components
// ─ Visibility and clickability validation
// ════════════════════════════════════════════════════════════════════════════

export interface ElementSearchResult {
    element: Element | null;
    selector: string | null;
    strategy: 'css' | 'aria-label' | 'data-testid' | 'xpath' | 'text-fuzzy' | 'xpath-raw' | 'none';
    confidence: number; // 0-1
}

export interface SearchOptions {
    requireVisible?: boolean;
    requireClickable?: boolean;
    throwIfNotFound?: boolean;
    strategies?: ('css' | 'aria-label' | 'data-testid' | 'xpath' | 'text-fuzzy')[];
}

/**
 * Check if element is visible in viewport.
 */
export function isElementVisible(element: Element): boolean {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);

    return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        style.pointerEvents !== 'none' &&
        parseFloat(style.opacity) > 0
    );
}

/**
 * Check if element is clickable (visible + in interaction mode).
 */
export function isElementClickable(element: Element): boolean {
    if (!isElementVisible(element)) return false;

    const style = window.getComputedStyle(element);
    const isInteractive = style.cursor !== 'not-allowed' && style.pointerEvents !== 'none';

    return isInteractive;
}

/**
 * Generate stable CSS selector from element.
 * Used to store found elements for future reference.
 */
export function generateCSSSelector(element: Element): string {
    // Prefer data-testid if available
    if (element.hasAttribute('data-testid')) {
        return `[data-testid="${element.getAttribute('data-testid')}"]`;
    }

    // Prefer aria-label if unique
    if (element.hasAttribute('aria-label')) {
        const label = element.getAttribute('aria-label');
        const similar = document.querySelectorAll(`[aria-label="${label}"]`);
        if (similar.length === 1) {
            return `[aria-label="${label}"]`;
        }
    }

    // Build path-based selector
    let path: string[] = [];
    let current = element;

    while (current && current !== document.body) {
        let selector = current.tagName.toLowerCase();

        if (current.id) {
            selector = `#${current.id}`;
        } else {
            // Add class, data attributes, or position if needed
            if (current.className) {
                const classes = (current.className as string).split(/\s+/).filter(c => c && !c.startsWith('__'));
                if (classes.length) {
                    selector += '.' + classes.join('.');
                }
            }

            // Add data-* attributes for identification
            const dataAttrs = Array.from(current.attributes)
                .filter(a => a.name.startsWith('data-') && a.value.length < 50)
                .map(a => `[${a.name}="${a.value}"]`)
                .join('');
            if (dataAttrs) selector += dataAttrs;
        }

        path.unshift(selector);
        const parent = current.parentElement;
        if (!parent) break;
        current = parent;
    }

    return path.join(' > ');
}

/**
 * Find element by exact CSS selector.
 */
function findByCSS(selector: string): Element | null {
    try {
        return document.querySelector(selector);
    } catch {
        return null;
    }
}

/**
 * Find element by aria-label (accessibility).
 */
function findByAriaLabel(description: string): Element | null {
    const escaped = description.replace(/"/g, '\\"');
    const selector = `[aria-label~="${escaped}"], [aria-label*="${escaped}"]`;

    try {
        const elements = document.querySelectorAll(selector);
        // Prefer exact match
        for (const el of elements) {
            if (el.getAttribute('aria-label') === description) {
                return el;
            }
        }
        // Fall back to partial match
        return elements[0] ?? null;
    } catch {
        return null;
    }
}

/**
 * Find element by data-testid attribute.
 */
function findByDataTestId(description: string): Element | null {
    const escaped = description.replace(/"/g, '\\"');
    const selectors = [
        `[data-testid="${escaped}"]`,
        `[data-testid*="${escaped}"]`,
    ];

    for (const selector of selectors) {
        try {
            const result = document.querySelector(selector);
            if (result) return result;
        } catch {
            continue;
        }
    }

    return null;
}

/**
 * Find element by visible text content (fuzzy match).
 */
function findByTextFuzzy(description: string, minSimilarity: number = 0.7): Element | null {
    const lower = description.toLowerCase().trim();

    // Get all interactive elements
    const interactive = document.querySelectorAll(
        'button, a, input, select, textarea, [role="button"], [role="link"], [role="option"]'
    );

    let bestMatch: { element: Element; score: number } | null = null;

    for (const element of interactive) {
        const text = element.textContent?.toLowerCase().trim() ?? '';

        // Calculate similarity (simple substring + Levenshtein-ish)
        if (text.includes(lower) || lower.includes(text)) {
            // Strong match
            if (!bestMatch || text.length < bestMatch.element.textContent!.length) {
                bestMatch = { element, score: 0.95 };
            }
        } else if (levenshteinSimilarity(lower, text) > minSimilarity) {
            // Fuzzy match
            const score = levenshteinSimilarity(lower, text);
            if (!bestMatch || score > bestMatch.score) {
                bestMatch = { element, score };
            }
        }
    }

    return bestMatch?.element ?? null;
}

/**
 * Find element by XPath expression.
 */
function findByXPath(xpathExpression: string): Element | null {
    try {
        const result = document.evaluate(
            xpathExpression,
            document,
            null,
            XPathResult.FIRST_ORDERED_NODE_TYPE,
            null
        );
        return result.singleNodeValue as Element | null;
    } catch {
        return null;
    }
}

/**
 * Generate XPath for common button patterns.
 */
function generateXPathForButton(description: string): string[] {
    const escaped = description.replace(/'/g, "\\'");
    return [
        `//button[contains(text(), '${escaped}')]`,
        `//button[contains(., '${escaped}')]`,
        `//a[contains(text(), '${escaped}')]`,
        `//input[@value='${escaped}']`,
        `//*[@role='button' and contains(text(), '${escaped}')]`,
    ];
}

/**
 * Simple Levenshtein distance calculator for fuzzy matching.
 */
function levenshteinDistance(a: string, b: string): number {
    const matrix: number[][] = [];

    for (let i = 0; i <= b.length; i++) {
        matrix[i] = [i];
    }

    for (let j = 0; j <= a.length; j++) {
        matrix[0][j] = j;
    }

    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) === a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1, // substitution
                    matrix[i][j - 1] + 1,     // insertion
                    matrix[i - 1][j] + 1      // deletion
                );
            }
        }
    }

    return matrix[b.length][a.length];
}

/**
 * Calculate similarity between two strings (0-1).
 */
function levenshteinSimilarity(a: string, b: string): number {
    const maxLen = Math.max(a.length, b.length);
    if (maxLen === 0) return 1;
    const distance = levenshteinDistance(a, b);
    return 1 - (distance / maxLen);
}

/**
 * Search for element using multiple strategies.
 * Returns first successful match or null.
 */
export function findElementSmart(
    description: string,
    elementType?: string,
    options: SearchOptions = {}
): ElementSearchResult {
    const {
        strategies = ['css', 'aria-label', 'data-testid', 'xpath', 'text-fuzzy'],
        requireVisible = true,
    } = options;

    // Try each strategy in order
    for (const strategy of strategies) {
        let element: Element | null = null;

        try {
            switch (strategy) {
                case 'css':
                    element = findByCSS(description);
                    break;
                case 'aria-label':
                    element = findByAriaLabel(description);
                    break;
                case 'data-testid':
                    element = findByDataTestId(description);
                    break;
                case 'xpath': {
                    const xpaths = generateXPathForButton(description);
                    for (const xpath of xpaths) {
                        element = findByXPath(xpath);
                        if (element) break;
                    }
                    break;
                }
                case 'text-fuzzy':
                    element = findByTextFuzzy(description, 0.7);
                    break;
            }

            if (element) {
                // Check visibility if required
                if (requireVisible && !isElementVisible(element)) {
                    element = null;
                    continue;
                }

                return {
                    element,
                    selector: generateCSSSelector(element),
                    strategy: strategy as any,
                    confidence: strategy === 'css' ? 1.0 : 0.85,
                };
            }
        } catch (err) {
            console.warn(`[ASTRA|ElementFinder] Strategy '${strategy}' failed:`, err);
            continue;
        }
    }

    return {
        element: null,
        selector: null,
        strategy: 'none',
        confidence: 0,
    };
}

/**
 * Handle Shadow DOM piercing (experimental).
 * Search within web components.
 */
export function findElementInShadow(description: string): Element | null {
    // Start with normal search
    let result = findElementSmart(description);
    if (result.element) return result.element;

    // Search in shadow trees
    const walkerOptions = {
        acceptNode: function (node: Node) {
            if (node instanceof Element) {
                if (node.shadowRoot) return NodeFilter.FILTER_ACCEPT;
                const text = node.textContent?.toLowerCase() ?? '';
                if (text.includes(description.toLowerCase())) {
                    return NodeFilter.FILTER_ACCEPT;
                }
            }
            return NodeFilter.FILTER_SKIP;
        },
    };

    const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_ELEMENT,
        walkerOptions as NodeFilter
    );

    let current: Node | null;
    while ((current = walker.nextNode())) {
        if (current instanceof Element && current.shadowRoot) {
            const inShadow = current.shadowRoot.querySelector(
                `*:has-text("${description}")`
            );
            if (inShadow) return inShadow;
        }
    }

    return null;
}

/**
 * Validate that element can be interacted with.
 */
export function validateElementInteractivity(element: Element): {
    valid: boolean;
    issues: string[];
} {
    const issues: string[] = [];

    if (!isElementVisible(element)) {
        issues.push('Element is not visible');
    }

    if (!isElementClickable(element)) {
        issues.push('Element may not be clickable');
    }

    const style = window.getComputedStyle(element);
    if (style.visibility === 'hidden') {
        issues.push('Element has visibility:hidden');
    }

    if (style.display === 'none') {
        issues.push('Element has display:none');
    }

    // Check if covered by other elements
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const topElement = document.elementFromPoint(centerX, centerY);
        if (topElement !== element && !element.contains(topElement!)) {
            issues.push('Element is covered by another element');
        }
    }

    return {
        valid: issues.length === 0,
        issues,
    };
}
