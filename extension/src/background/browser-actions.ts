// ════════════════════════════════════════════════════════════════════════════
// ASTRA BrowserActions — Browser-Centric Action Executor
// ─ Handles ALL browser-level (chrome.tabs / chrome.windows) and orchestration
//   actions. Every action passes through SecurityGuard before execution.
// ─ DOM-level actions are delegated to the content script via sendToTab().
// ─ Action routing is driven by the SkillRegistry — see skills/ directory.
//   To add a new action type, add it to browser-skills.ts or dom-skills.ts.
// ════════════════════════════════════════════════════════════════════════════

import {
    validateAction, validateUrl, sanitizeSelector, sanitizeValue,
    isRestrictedUrl, getAuditLog,
} from './security.js';
import type {
    PlannerAction, BrowserAction, TabInfo, ActionLogEntry,
    ExecuteDOMActionMessage, ClickElementMessage, HoverElementMessage,
    FillFormMessage, GetPageSnapshotMessage, HighlightResultsMessage,
    DiscoverFiltersMessage, ReadDOMMessage, AnalyzePageMessage,
    WaitForElementMessage, ExtractDataMessage, KeyboardShortcutMessage,
    ShowFollowUpMessage, HideFollowUpMessage,
} from '../types/messages.js';
import { skillRegistry, registerAllSkills } from './skills/index.js';

// Re-export for callers that used the old background import
export { isRestrictedUrl, getAuditLog };

// ─── Browser Context ──────────────────────────────────────────────────────────
// A single snapshot of the entire browser state, refreshed on demand.
export interface BrowserContext {
    tabs: TabInfo[];
    activeTabId: number | null;
    activeTab: TabInfo | null;
    windowIds: number[];
}

export async function getBrowserContext(): Promise<BrowserContext> {
    const [chromeTabs, windows] = await Promise.all([
        chrome.tabs.query({}),
        chrome.windows.getAll(),
    ]);

    const tabs: TabInfo[] = chromeTabs.map(t => ({
        tabId: t.id!,
        windowId: t.windowId,
        title: t.title || 'Untitled',
        url: t.url || '',
        active: !!t.active,
        pinned: !!t.pinned,
        muted: !!(t.mutedInfo?.muted),
        loading: t.status === 'loading',
        audible: !!t.audible,
    }));

    const activeTab = tabs.find(t => t.active) ?? null;

    return {
        tabs,
        activeTabId: activeTab?.tabId ?? null,
        activeTab,
        windowIds: windows.map(w => w.id!),
    };
}

// ─── Tab Wait Helpers ─────────────────────────────────────────────────────────

export interface NetworkIdleOptions {
    /** Milliseconds of zero network activity before idle is declared. Default: 500ms */
    idleTimeout?: number;
    /** Maximum total wait in ms before resolving regardless. Default: 15000ms */
    maxWait?: number;
}

/**
 * Waits until a tab is fully loaded AND the network is idle (no pending XHR/fetch).
 *
 * Phase 1 — waits for chrome.tabs.onUpdated status='complete'.
 * Phase 2 — observes chrome.webRequest events for the tab.
 *           A 500ms idle timer resets on every new request;
 *           resolves when: (a) idle timer fires cleanly, or (b) maxWait is hit.
 */
export async function waitForNetworkIdle(
    tabId: number,
    options: NetworkIdleOptions = {},
): Promise<void> {
    const idleTimeout = options.idleTimeout ?? 500;
    const maxWait = options.maxWait ?? 15_000;
    const startTime = Date.now();

    // ── Phase 1: Wait for tab status === 'complete' ────────────────────────
    await new Promise<void>((resolve) => {
        const maxTimer = setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(loadListener);
            resolve();
        }, maxWait);

        const loadListener = (id: number, info: chrome.tabs.TabChangeInfo) => {
            if (id === tabId && info.status === 'complete') {
                clearTimeout(maxTimer);
                chrome.tabs.onUpdated.removeListener(loadListener);
                resolve();
            }
        };
        chrome.tabs.onUpdated.addListener(loadListener);

        // Race guard: already complete before listeners attached
        chrome.tabs.get(tabId).then(tab => {
            if (tab.status === 'complete') {
                clearTimeout(maxTimer);
                chrome.tabs.onUpdated.removeListener(loadListener);
                resolve();
            }
        }).catch(() => { /* tab may not exist yet */ });
    });

    // ── Phase 2: Wait for network idle after DOM is ready ─────────────────
    const remainingMs = maxWait - (Date.now() - startTime);
    if (remainingMs <= 0) {
        console.log(`[ASTRA] waitForNetworkIdle: maxWait reached for tab ${tabId}`);
        return;
    }

    let pendingRequests = 0;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    await new Promise<void>((resolve) => {
        const maxTimer = setTimeout(() => {
            cleanup();
            console.log(`[ASTRA] waitForNetworkIdle: maxWait reached tab ${tabId} — ${pendingRequests} requests still pending`);
            resolve();
        }, remainingMs);

        const resolveIdle = () => {
            cleanup();
            console.log(`[ASTRA] Network idle detected for tab ${tabId}`);
            resolve();
        };

        const resetIdleTimer = () => {
            if (idleTimer !== null) clearTimeout(idleTimer);
            if (pendingRequests === 0) {
                idleTimer = setTimeout(resolveIdle, idleTimeout);
            }
        };

        const onBeforeRequest = (details: chrome.webRequest.WebRequestDetails) => {
            if (details.tabId !== tabId) return;
            pendingRequests++;
            if (idleTimer !== null) { clearTimeout(idleTimer); idleTimer = null; }
        };

        const onRequestDone = (details: chrome.webRequest.WebRequestDetails) => {
            if (details.tabId !== tabId) return;
            pendingRequests = Math.max(0, pendingRequests - 1);
            resetIdleTimer();
        };

        const cleanup = () => {
            clearTimeout(maxTimer);
            if (idleTimer !== null) clearTimeout(idleTimer);
            try { chrome.webRequest.onBeforeRequest.removeListener(onBeforeRequest); } catch { /* noop */ }
            try { chrome.webRequest.onCompleted.removeListener(onRequestDone); } catch { /* noop */ }
            try { chrome.webRequest.onErrorOccurred.removeListener(onRequestDone); } catch { /* noop */ }
        };

        const filter: chrome.webRequest.RequestFilter = { urls: ['<all_urls>'], tabId };
        chrome.webRequest.onBeforeRequest.addListener(onBeforeRequest, filter);
        chrome.webRequest.onCompleted.addListener(onRequestDone, filter);
        chrome.webRequest.onErrorOccurred.addListener(onRequestDone, filter);

        // If no requests fire immediately, start idle countdown now
        resetIdleTimer();
    });
}

/**
 * @deprecated Prefer waitForNetworkIdle() which detects true network idle.
 * Kept for backward compatibility with skill modules that reference this directly.
 */
export async function waitForTabLoad(tabId: number, timeoutMs = 15_000): Promise<void> {
    return waitForNetworkIdle(tabId, { idleTimeout: 0, maxWait: timeoutMs });
}

/** Small sleep helper */
export const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));


// ─── Content Script Relay ─────────────────────────────────────────────────────

type ContentScriptMessage =
    | ExecuteDOMActionMessage | ClickElementMessage | HoverElementMessage
    | FillFormMessage | GetPageSnapshotMessage | HighlightResultsMessage
    | DiscoverFiltersMessage | ReadDOMMessage | AnalyzePageMessage
    | WaitForElementMessage | ExtractDataMessage | KeyboardShortcutMessage
    | ShowFollowUpMessage | HideFollowUpMessage
    | { type: 'GET_PAGE_SNAPSHOT'; payload: Record<string, never> };

async function ensureContentScript(tabId: number, tabUrl?: string): Promise<void> {
    if (tabUrl && isRestrictedUrl(tabUrl)) {
        throw new Error(`RESTRICTED: Content scripts cannot run on ${tabUrl}`);
    }
    const manifest = chrome.runtime.getManifest();
    const contentFile = manifest.content_scripts?.[0]?.js?.[0];
    if (!contentFile) throw new Error('No content script entry found in manifest');

    console.log(`[ASTRA] Injecting "${contentFile}" into tab ${tabId}`);
    await chrome.scripting.executeScript({ target: { tabId, allFrames: false }, files: [contentFile] });
    await sleep(700);
}

export async function sendToTab(
    tabId: number,
    message: ContentScriptMessage,
    tabUrl?: string,
): Promise<unknown> {
    const trySend = (): Promise<unknown> =>
        new Promise((resolve, reject) => {
            chrome.tabs.sendMessage(tabId, message, (response) => {
                if (chrome.runtime.lastError) {
                    return reject(new Error(chrome.runtime.lastError.message));
                }
                // Don't reject on success=false — let the caller decide
                resolve(response);
            });
        });

    try {
        return await trySend();
    } catch (err) {
        const msg = (err as Error).message ?? '';
        const isDisconnected =
            msg.includes('Receiving end does not exist') ||
            msg.includes('Could not establish connection');
        if (isDisconnected) {
            await ensureContentScript(tabId, tabUrl);
            return await trySend();
        }
        throw err;
    }
}

// ─── Screenshot ────────────────────────────────────────────────────────────────

export async function captureScreenshot(tabId?: number): Promise<string | null> {
    try {
        if (tabId !== undefined) {
            // Capture a specific tab's window
            const tab = await chrome.tabs.get(tabId);
            return await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 70 });
        }
        return await chrome.tabs.captureVisibleTab(undefined as unknown as number, { format: 'jpeg', quality: 70 });
    } catch (err) {
        console.log('[ASTRA] Screenshot capture failed:', err);
        return null;
    }
}

// ─── Skills Registration ──────────────────────────────────────────────────────
// Wires all skill modules into the singleton registry.
// Called once below after all helper functions are defined.
// To add a new action type: edit skills/browser-skills.ts or dom-skills.ts.
function _initSkills(): void {
    registerAllSkills({
        validateUrl,
        waitForTabLoad,
        waitForNetworkIdle,
        sleep,
        captureScreenshot,
        // Cast sendToTab to the looser signature expected by DOM skills
        sendToTab: sendToTab as (tabId: number, msg: Record<string, unknown>, tabUrl?: string) => Promise<unknown>,
        sanitizeSelector,
        sanitizeValue,
    });
}

// ─── Browser Action Executor ───────────────────────────────────────────────────
// Delegates to the SkillRegistry — no switch statement required.
// Adding a new browser action means adding it to skills/browser-skills.ts only.

export async function executeBrowserAction(
    action: BrowserAction,
    ctx: BrowserContext,
): Promise<{ success: boolean; data?: unknown; error?: string }> {
    const skill = skillRegistry.get(action.type);
    if (!skill || skill.type !== 'browser') {
        return { success: false, error: `Unknown browser action: ${action.type}` };
    }
    try {
        return await skill.execute(action as PlannerAction, ctx);
    } catch (err) {
        return { success: false, error: (err as Error).message };
    }
}

// ─── Planner Action Dispatcher ─────────────────────────────────────────────────
// Registry-based routing — no hardcoded action type lists.
// All actions go through validateAction() first (security gate),
// then the SkillRegistry routes to the correct executor.

export async function dispatchPlannerAction(
    action: PlannerAction,
    ctx: BrowserContext,
    sessionId: string,
): Promise<{ success: boolean; data?: unknown; error?: string; blocked?: boolean }> {

    // ── Security gate ──
    const validation = validateAction(action, sessionId);
    if (!validation.allowed) {
        console.warn(`[ASTRA|SECURITY] Blocked action "${action.type}": ${validation.reason}`);
        return { success: false, error: validation.reason, blocked: true };
    }

    // ── Skill lookup ──
    const skill = skillRegistry.get(action.type);
    if (!skill) {
        return { success: false, error: `Unknown action type: "${action.type}" — not found in skill registry` };
    }

    // ── DOM skills need an active, non-restricted tab ──
    if (skill.type === 'dom') {
        const { activeTabId, activeTab } = ctx;
        if (!activeTabId || !activeTab) {
            return { success: false, error: 'No active tab for DOM action' };
        }
        if (isRestrictedUrl(activeTab.url)) {
            return { success: false, error: `Cannot run DOM actions on restricted page: ${activeTab.url}` };
        }
        try {
            const result = await skill.execute(action, ctx, activeTabId, activeTab.url);

            // ── Selector Fallback ──────────────────────────────────────────────
            // If the action failed with a "not found" type error AND the action
            // has a label, ask the content script to find the element by
            // description instead of by CSS selector.
            // This handles:
            //   • Stale selectors after React/SPA rerenders
            //   • Dynamic IDs (e.g. #btn-1234 → different each load)
            //   • Planner hallucinating a selector that never existed
            if (!result.success && action.label) {
                const errorMsg = (result.error ?? '').toLowerCase();
                const isNotFound =
                    errorMsg.includes('not found') ||
                    errorMsg.includes('no element') ||
                    errorMsg.includes('cannot find') ||
                    errorMsg.includes('null') ||
                    errorMsg.includes('undefined') ||
                    errorMsg.includes('queryselector');

                if (isNotFound) {
                    console.log(`[ASTRA|SelectorFallback] Trying description-based search for: "${action.label}"`);
                    try {
                        const findResult = await sendToTab(activeTabId, {
                            type: 'FIND_ELEMENT',
                            payload: { description: action.label, elementType: action.type },
                        } as unknown as Parameters<typeof sendToTab>[1], activeTab.url) as { success: boolean; selector: string | null } | null;

                        if (findResult?.success && findResult.selector) {
                            console.log(`[ASTRA|SelectorFallback] Found via description: "${findResult.selector}" for "${action.label}"`);
                            // Retry the action with the freshly discovered selector
                            const fallbackAction = { ...action, selector: findResult.selector };
                            return await skill.execute(fallbackAction, ctx, activeTabId, activeTab.url);
                        }
                    } catch (fallbackErr) {
                        console.log('[ASTRA|SelectorFallback] Description search failed:', (fallbackErr as Error).message);
                    }
                }
            }

            return result;
        } catch (err) {
            return { success: false, error: (err as Error).message };
        }
    }

    // ── Browser skills run in the background context ──
    try {
        return await skill.execute(action, ctx);
    } catch (err) {
        return { success: false, error: (err as Error).message };
    }
}

// ─── Audit log export ──────────────────────────────────────────────────────────
export type { ActionLogEntry };

// ─── Initialise skill registry ────────────────────────────────────────────────
// All helper functions are now defined — safe to wire the registry.
_initSkills();

// Re-export registry for callers that want to introspect available skills
// (e.g. to enumerate names for LLM prompt generation or security audits).
export { skillRegistry } from './skills/index.js';
