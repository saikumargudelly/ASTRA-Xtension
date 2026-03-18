// ════════════════════════════════════════════════════════════════════════════
// ASTRA Advanced Scroll Control
// ─ Scroll with viewport offset positioning
// ─ Container-specific scrolling (not just window)
// ─ Infinite scroll detection
// ═════════════════════════════════════════════════════════════════════════════

export interface ScrollTarget {
    type: 'element' | 'window' | 'container';
    selector?: string; // For element or container
    offset?: number;   // Pixels from top
    percent?: number;  // 0-100, percent of scrollable height
}

/**
 * Find the scrollable parent of an element.
 * Walks up DOM tree to find element with overflow: auto/scroll.
 */
export function findScrollableParent(element: Element): Element {
    let current = element.parentElement;

    while (current) {
        const style = window.getComputedStyle(current);
        const isScrollable =
            style.overflowY === 'auto' ||
            style.overflowY === 'scroll' ||
            (style.overflowY === 'hidden' && current.scrollHeight > current.clientHeight);

        if (isScrollable) {
            return current;
        }

        current = current.parentElement;
    }

    return window.document.documentElement;
}

/**
 * Scroll element into view with precise offset.
 * Useful for complex layouts where centered view isn't ideal.
 */
export async function scrollElementIntoView(
    element: Element,
    offset: { top?: number; percent?: number } = {},
    smooth: boolean = true
): Promise<void> {
    const rect = element.getBoundingClientRect();
    const container = findScrollableParent(element);
    const isWindow = container === document.documentElement;

    const targetY = isWindow
        ? window.scrollY + rect.top
        : container.scrollTop + rect.top;

    let finalY = targetY;

    // Apply offset if specified
    if (offset.percent !== undefined) {
        const containerHeight = isWindow ? window.innerHeight : container.clientHeight;
        const percentPixels = (containerHeight * offset.percent) / 100;
        finalY = targetY - percentPixels;
    } else if (offset.top !== undefined) {
        finalY = targetY - offset.top;
    }

    const scrollTarget = isWindow ? window : container;
    if ('scrollTo' in scrollTarget) {
        scrollTarget.scrollTo({
            top: Math.max(0, finalY),
            behavior: smooth ? 'smooth' : 'auto',
        });
    } else {
        container.scrollTop = Math.max(0, finalY);
    }

    // Wait for smooth scroll to complete
    if (smooth) {
        await new Promise(resolve => setTimeout(resolve, 500));
    }
}

/**
 * Scroll within a container (not window).
 */
export async function scrollContainer(
    containerSelector: string,
    direction: 'up' | 'down' | 'left' | 'right',
    amount: number = 100,
    smooth: boolean = true
): Promise<void> {
    const container = document.querySelector(containerSelector);
    if (!container) throw new Error(`Container not found: ${containerSelector}`);

    let scrollAmount = amount;
    if (direction === 'up') scrollAmount = -amount;
    if (direction === 'left') scrollAmount = -amount;

    if (direction === 'up' || direction === 'down') {
        container.scrollBy?.({
            top: scrollAmount,
            behavior: smooth ? 'smooth' : 'auto',
        });
    } else {
        container.scrollBy?.({
            left: scrollAmount,
            behavior: smooth ? 'smooth' : 'auto',
        });
    }

    if (smooth) {
        await new Promise(resolve => setTimeout(resolve, 300));
    }
}

/**
 * Detects if page has infinite scroll or pagination.
 * Returns: 'infinite', 'paginated', or 'unknown'
 */
export function detectScrollType(): 'infinite' | 'paginated' | 'unknown' {
    // Look for pagination UI
    const paginationSelectors = [
        '.pagination',
        '[role="navigation"] + *', // Next button after nav
        'button:contains("Next")',
        'a[rel="next"]',
        '[aria-label*="next"]',
    ];

    for (const selector of paginationSelectors) {
        if (document.querySelector(selector)) {
            return 'paginated';
        }
    }

    // Look for infinite scroll indicators
    const infiniteSelectors = [
        '[class*="infinite"]',
        '[class*="load-more"]',
        '.waypoint',
        '[data-testid*="infinite"]',
    ];

    for (const selector of infiniteSelectors) {
        if (document.querySelector(selector)) {
            return 'infinite';
        }
    }

    return 'unknown';
}

/**
 * Detect if we've reached bottom of scrollable content.
 */
export function isAtScrollBottom(threshold: number = 100): boolean {
    const scrollHeight = document.documentElement.scrollHeight;
    const scrollTop = window.scrollY;
    const clientHeight = window.innerHeight;

    return scrollHeight - (scrollTop + clientHeight) <= threshold;
}

/**
 * Check if element is in viewport.
 */
export function isElementInViewport(element: Element, partialOk: boolean = false): boolean {
    const rect = element.getBoundingClientRect();

    if (partialOk) {
        // Element partially visible
        return (
            rect.bottom > 0 &&
            rect.right > 0 &&
            rect.top < window.innerHeight &&
            rect.left < window.innerWidth
        );
    }

    // Element fully visible
    return (
        rect.top >= 0 &&
        rect.left >= 0 &&
        rect.bottom <= window.innerHeight &&
        rect.right <= window.innerWidth
    );
}

/**
 * Smooth scroll to a percent of page height.
 */
export async function scrollToPercent(percent: number, smooth: boolean = true): Promise<void> {
    const scrollHeight = document.documentElement.scrollHeight - window.innerHeight;
    const targetY = (scrollHeight * percent) / 100;

    window.scrollTo({
        top: targetY,
        behavior: smooth ? 'smooth' : 'auto',
    });

    if (smooth) {
        await new Promise(resolve => setTimeout(resolve, 500));
    }
}

/**
 * Handle "Load More" button clicking for paginated content.
 */
export async function clickLoadMoreIfAvailable(
    selector: string = 'button[class*="load"], button[class*="more"]',
    maxRetries: number = 3,
    delayMs: number = 1000
): Promise<boolean> {
    let clicked = false;

    for (let i = 0; i < maxRetries; i++) {
        const button = document.querySelector(selector) as HTMLButtonElement;
        if (!button || button.disabled) {
            break;
        }

        button.click();
        clicked = true;

        // Wait for content to load
        await new Promise(resolve => setTimeout(resolve, delayMs));

        // Scroll down to trigger more loads
        window.scrollBy({ top: window.innerHeight });
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    return clicked;
}
