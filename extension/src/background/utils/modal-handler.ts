// ════════════════════════════════════════════════════════════════════════════
// ASTRA Modal & Overlay Handling
// ─ Detect modals, overlays, and backdrops
// ─ Close modals intelligently (ESC → close button → backdrop click)
// ─ Handle nested modals
// ════════════════════════════════════════════════════════════════════════════

export interface ModalInfo {
    element: Element;
    type: 'modal' | 'dialog' | 'drawer' | 'overlay' | 'unknown';
    isOpen: boolean;
    closeButton?: Element;
    backdrop?: Element;
    hasAnimation: boolean;
}

/**
 * Detect if there's a modal or overlay visible.
 */
export function detectModal(): ModalInfo | null {
    // Check for standard modal patterns
    const modalSelectors = [
        '[role="dialog"]',
        '[role="alertdialog"]',
        'dialog',
        '.modal',
        '.modal-content',
        '[class*="modal"]',
        '[class*="dialog"]',
        '[class*="drawer"]',
        '[data-testid*="modal"]',
    ];

    for (const selector of modalSelectors) {
        try {
            const modal = document.querySelector(selector);
            if (modal && isElementVisible(modal)) {
                return parseModal(modal);
            }
        } catch {
            continue;
        }
    }

    // Check for overlay
    const overlay = document.querySelector('[role="presentation"], [class*="backdrop"], [class*="overlay"]');
    if (overlay && isElementVisible(overlay)) {
        return {
            element: overlay,
            type: 'overlay',
            isOpen: true,
            hasAnimation: hasAnimation(overlay),
        };
    }

    return null;
}

/**
 * Parse modal element and extract info.
 */
function parseModal(element: Element): ModalInfo {
    const role = element.getAttribute('role');
    let type: ModalInfo['type'] = 'modal';

    if (role === 'dialog') type = 'modal';
    if (role === 'alertdialog') type = 'modal';
    if (element.tagName === 'DIALOG') type = 'dialog';
    if (element.className.toString().includes('drawer')) type = 'drawer';

    // Find close button
    const closeButton = findCloseButton(element);

    // Find backdrop
    const backdrop = findBackdrop(element);

    return {
        element,
        type,
        isOpen: !element.hasAttribute('hidden'),
        closeButton,
        backdrop,
        hasAnimation: hasAnimation(element),
    };
}

/**
 * Find close button within modal.
 */
function findCloseButton(modal: Element): Element | undefined {
    const possibleSelectors = [
        '[aria-label="Close"]',
        '[aria-label*="close"]',
        'button[aria-label*="close"]',
        '[class*="close-btn"]',
        '[class*="close"]',
        'button.close',
    ];

    for (const selector of possibleSelectors) {
        try {
            const button = modal.querySelector(selector);
            if (button) return button;
        } catch {
            continue;
        }
    }

    // Look for X button
    const xButton = Array.from(modal.querySelectorAll('button')).find(btn =>
        btn.textContent?.includes('×') || btn.textContent?.includes('✕')
    );

    return xButton;
}

/**
 * Find modal backdrop.
 */
function findBackdrop(modal: Element): Element | undefined {
    // Look for sibling backdrop
    let current: Element | null = modal;
    while ((current = current.nextElementSibling)) {
        if (
            current.className.toString().includes('backdrop') ||
            current.className.toString().includes('overlay') ||
            current.getAttribute('role') === 'presentation'
        ) {
            return current;
        }
    }

    // Look for parent-level backdrop
    const parent = modal.parentElement;
    if (parent) {
        const backdrop = parent.querySelector('[role="presentation"], [class*="backdrop"]');
        if (backdrop && backdrop !== modal) return backdrop;
    }

    return undefined;
}

/**
 * Check if element is visible.
 */
function isElementVisible(element: Element): boolean {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);

    return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        parseFloat(style.opacity) > 0
    );
}

/**
 * Check if element has animation/transition.
 */
function hasAnimation(element: Element): boolean {
    const style = window.getComputedStyle(element);
    const animation = style.animationName;
    const transition = style.transition;

    return !!((
        (animation && animation !== 'none') ||
        (transition && transition !== 'none')
    ));
}

/**
 * Close modal using best available strategy.
 */
export async function closeModal(
    options: {
        tryESC?: boolean;
        tryButton?: boolean;
        tryBackdrop?: boolean;
        tryHidden?: boolean;
        waitForAnimation?: boolean;
    } = {}
): Promise<boolean> {
    const {
        tryESC = true,
        tryButton = true,
        tryBackdrop = true,
        tryHidden = true,
        waitForAnimation = true,
    } = options;

    const modal = detectModal();
    if (!modal) return false;

    let closed = false;

    // Strategy 1: Press ESC
    if (tryESC) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape' }));
        await sleep(300);
        closed = !detectModal();
    }

    // Strategy 2: Click close button
    if (!closed && tryButton && modal.closeButton) {
        (modal.closeButton as HTMLElement).click();
        await sleep(300);
        closed = !detectModal();
    }

    // Strategy 3: Set hidden attribute or display: none
    if (!closed && tryHidden) {
        modal.element.setAttribute('hidden', '');
        const style = modal.element.getAttribute('style') || '';
        if (!style.includes('display')) {
            modal.element.setAttribute('style', style + '; display: none !important;');
        }
        await sleep(300);
        closed = !detectModal();
    }

    // Strategy 4: Click backdrop
    if (!closed && tryBackdrop && modal.backdrop) {
        (modal.backdrop as HTMLElement).click();
        await sleep(300);
        closed = !detectModal();
    }

    // Wait for close animation if applicable
    if (closed && waitForAnimation && modal.hasAnimation) {
        await sleep(500);
    }

    return closed;
}

/**
 * Wait for modal to appear.
 */
export async function waitForModal(
    timeoutMs: number = 5000,
    pollIntervalMs: number = 100
): Promise<ModalInfo | null> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
        const modal = detectModal();
        if (modal) return modal;

        await sleep(pollIntervalMs);
    }

    return null;
}

/**
 * Check if element is behind overlay/modal.
 */
export function isElementBehindOverlay(element: Element): boolean {
    const modal = detectModal();
    if (!modal) return false;

    // Check z-index
    const elementStack = getStackingContext(element);
    const modalStack = getStackingContext(modal.element);

    return modalStack > elementStack;
}

/**
 * Get z-index stacking context.
 */
function getStackingContext(element: Element): number {
    const zIndex = window.getComputedStyle(element).zIndex;
    const parsed = parseInt(zIndex, 10);
    return isNaN(parsed) ? 0 : parsed;
}

/**
 * Handle nested modals (close top-most first).
 */
export async function closeAllModals(
    maxRetries: number = 5
): Promise<number> {
    let closedCount = 0;

    for (let i = 0; i < maxRetries; i++) {
        const success = await closeModal();
        if (!success) break;
        closedCount++;
        await sleep(300);
    }

    return closedCount;
}

/**
 * Interact with element inside modal.
 * Ensures modal is open and element is clickable first.
 */
export async function interactWithModalElement(
    selector: string,
    action: 'click' | 'type' | 'value' = 'click',
    value?: string
): Promise<boolean> {
    const modal = detectModal();
    if (!modal?.isOpen) {
        // Wait for modal to appear
        const result = await waitForModal(3000);
        if (!result) return false;
    }

    const element = modal!.element.querySelector(selector);
    if (!element) return false;

    // Ensure element is visible
    if (!isElementVisible(element)) {
        (element as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'center' });
        await sleep(300);
    }

    switch (action) {
        case 'click':
            (element as HTMLElement).click();
            return true;

        case 'type':
            if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement)) {
                return false;
            }
            element.value = value ?? '';
            element.dispatchEvent(new Event('input', { bubbles: true }));
            return true;

        case 'value':
            if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement)) {
                return false;
            }
            element.value = value ?? '';
            element.dispatchEvent(new Event('change', { bubbles: true }));
            return true;

        default:
            return false;
    }
}

/**
 * Sleep utility for async operations.
 */
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
