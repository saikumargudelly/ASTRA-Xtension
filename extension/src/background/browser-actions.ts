// ════════════════════════════════════════════════════════════════════════════
// ASTRA BrowserActions — Enhanced
// ─ Handles browser-level actions plus DOM orchestration via SkillRegistry.
// ─ Adds structured ActionResult, safer relay/injection, and stronger fallback.
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
import { executeWithRetry, calculateBackoffDelay, CircuitBreaker, classifyError, DEFAULT_RETRY_STRATEGY } from './utils/error-recovery.js';
import { getActionTimeout, getAdjustedTimeout, shouldPessimisticTimeout } from './utils/action-timeouts.js';
import { recordActionTelemetry, initTelemetry } from './utils/action-telemetry.js';

export { isRestrictedUrl, getAuditLog };
export type { ActionLogEntry };

export interface ActionResult<T = unknown> {
    success: boolean;
    data?: T;
    error?: string;
    code?: ActionErrorCode | string;
    blocked?: boolean;
    durationMs?: number;
}

export type ActionErrorCode =
    | 'RESTRICTED_URL'
    | 'NO_ACTIVE_TAB'
    | 'SECURITY_BLOCKED'
    | 'UNKNOWN_SKILL'
    | 'INJECT_FAILED'
    | 'RELAY_TIMEOUT'
    | 'RELAY_FAILED'
    | 'FALLBACK_EXHAUSTED'
    | 'SCREENSHOT_FAILED'
    | 'CONTEXT_FETCH_FAILED'
    | 'SKILL_THREW';

const log = {
    info: (scope: string, msg: string, extra?: unknown) =>
        console.log(`[ASTRA|${scope}]`, msg, ...(extra !== undefined ? [extra] : [])),
    warn: (scope: string, msg: string, extra?: unknown) =>
        console.warn(`[ASTRA|${scope}]`, msg, ...(extra !== undefined ? [extra] : [])),
    error: (scope: string, msg: string, extra?: unknown) =>
        console.error(`[ASTRA|${scope}]`, msg, ...(extra !== undefined ? [extra] : [])),
};

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

// ─── Browser Context ──────────────────────────────────────────────────────────

export interface BrowserContext {
    tabs: TabInfo[];
    activeTabId: number | null;
    activeTab: TabInfo | null;
    windowIds: number[];
    focusedWindowId: number | null;
}

export async function getBrowserContext(): Promise<BrowserContext> {
    const [tabsResult, windowsResult] = await Promise.allSettled([
        chrome.tabs.query({}),
        chrome.windows.getAll({ populate: false }),
    ]);

    if (tabsResult.status === 'rejected') {
        log.error('Context', 'chrome.tabs.query failed', tabsResult.reason);
        return {
            tabs: [],
            activeTabId: null,
            activeTab: null,
            windowIds: [],
            focusedWindowId: null,
        };
    }

    const chromeTabs = tabsResult.value;
    const chromeWins = windowsResult.status === 'fulfilled' ? windowsResult.value : [];
    if (windowsResult.status === 'rejected') {
        log.warn('Context', 'chrome.windows.getAll failed', windowsResult.reason);
    }

    const tabs: TabInfo[] = chromeTabs.map((t) => ({
        tabId: t.id!,
        windowId: t.windowId,
        title: t.title ?? 'Untitled',
        url: t.url ?? '',
        active: !!t.active,
        pinned: !!t.pinned,
        muted: !!(t.mutedInfo?.muted),
        loading: t.status === 'loading',
        audible: !!t.audible,
    }));

    const focusedWindow = chromeWins.find((w) => w.focused);
    const focusedWindowId = focusedWindow?.id ?? null;
    const activeTab =
        tabs.find((t) => t.active && t.windowId === focusedWindowId)
        ?? tabs.find((t) => t.active)
        ?? null;

    return {
        tabs,
        activeTabId: activeTab?.tabId ?? null,
        activeTab,
        windowIds: chromeWins.map((w) => w.id!).filter((id): id is number => typeof id === 'number'),
        focusedWindowId,
    };
}

// ─── Tab Wait Helpers ─────────────────────────────────────────────────────────

export interface NetworkIdleOptions {
    idleTimeout?: number;
    maxWait?: number;
    signal?: AbortSignal;
}

export async function waitForNetworkIdle(
    tabId: number,
    options: NetworkIdleOptions = {},
): Promise<void> {
    const idleTimeout = options.idleTimeout ?? 500;
    const maxWait = options.maxWait ?? 15_000;
    const signal = options.signal;
    const startTime = Date.now();

    if (signal?.aborted) return;

    // Phase 1: wait for tab complete. Listener is attached before tab.get to avoid races.
    await new Promise<void>((resolve) => {
        let settled = false;
        const done = () => {
            if (settled) return;
            settled = true;
            resolve();
        };

        const onUpdated = (id: number, info: chrome.tabs.TabChangeInfo) => {
            if (id === tabId && info.status === 'complete') {
                clearTimeout(maxTimer);
                chrome.tabs.onUpdated.removeListener(onUpdated);
                done();
            }
        };

        const maxTimer = setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(onUpdated);
            done();
        }, maxWait);

        chrome.tabs.onUpdated.addListener(onUpdated);

        signal?.addEventListener('abort', () => {
            clearTimeout(maxTimer);
            chrome.tabs.onUpdated.removeListener(onUpdated);
            done();
        }, { once: true });

        chrome.tabs.get(tabId)
            .then((tab) => {
                if (tab.status === 'complete') {
                    clearTimeout(maxTimer);
                    chrome.tabs.onUpdated.removeListener(onUpdated);
                    done();
                }
            })
            .catch(() => {
                // Tab may not exist yet. We continue waiting for onUpdated/max timer.
            });
    });

    if (signal?.aborted) return;

    // Phase 2: wait for network idle.
    const remainingMs = maxWait - (Date.now() - startTime);
    if (remainingMs <= 0) {
        log.info('NetworkIdle', `maxWait consumed during load phase for tab ${tabId}`);
        return;
    }

    let pendingRequests = 0;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    await new Promise<void>((resolve) => {
        let settled = false;

        const done = (reason: string) => {
            if (settled) return;
            settled = true;
            cleanup();
            log.info('NetworkIdle', reason, { tabId, pendingRequests });
            resolve();
        };

        const resetIdleTimer = () => {
            if (idleTimer !== null) {
                clearTimeout(idleTimer);
                idleTimer = null;
            }
            if (pendingRequests === 0) {
                idleTimer = setTimeout(() => done('Network idle detected'), idleTimeout);
            }
        };

        const onBeforeRequest = (details: chrome.webRequest.WebRequestDetails) => {
            if (details.tabId !== tabId) return;
            pendingRequests++;
            if (idleTimer !== null) {
                clearTimeout(idleTimer);
                idleTimer = null;
            }
        };

        const onRequestDone = (details: chrome.webRequest.WebRequestDetails) => {
            if (details.tabId !== tabId) return;
            pendingRequests = Math.max(0, pendingRequests - 1);
            resetIdleTimer();
        };

        const maxTimer = setTimeout(() => {
            done(`maxWait reached with ${pendingRequests} pending request(s)`);
        }, remainingMs);

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

        signal?.addEventListener('abort', () => done('Aborted by signal'), { once: true });

        resetIdleTimer();
    });
}

/** @deprecated Prefer waitForNetworkIdle() for event-driven load+network settle. */
export async function waitForTabLoad(tabId: number, timeoutMs = 15_000): Promise<void> {
    log.warn('waitForTabLoad', 'Deprecated. Use waitForNetworkIdle instead.');
    return waitForNetworkIdle(tabId, { idleTimeout: 0, maxWait: timeoutMs });
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ─── Content Script Relay ─────────────────────────────────────────────────────

type ContentScriptMessage =
    | ExecuteDOMActionMessage | ClickElementMessage | HoverElementMessage
    | FillFormMessage | GetPageSnapshotMessage | HighlightResultsMessage
    | DiscoverFiltersMessage | ReadDOMMessage | AnalyzePageMessage
    | WaitForElementMessage | ExtractDataMessage | KeyboardShortcutMessage
    | ShowFollowUpMessage | HideFollowUpMessage
    | { type: 'GET_PAGE_SNAPSHOT'; payload: Record<string, never> }
    | { type: 'FIND_ELEMENT'; payload: { description: string; elementType?: string; strategy?: string } };

export interface InjectOptions {
    maxRetries?: number;
    settleMs?: number;
}

export interface SendToTabOptions {
    timeoutMs?: number;
    maxRetries?: number;
    injectOptions?: InjectOptions;
    actionType?: string;
    attemptNumber?: number;
}

const injectedTabs = new Set<number>();

// ─── Circuit Breaker per Tab ──────────────────────────────────────────────────
const tabCircuitBreakers = new Map<number, CircuitBreaker>();

function getCircuitBreaker(tabId: number): CircuitBreaker {
    if (!tabCircuitBreakers.has(tabId)) {
        tabCircuitBreakers.set(tabId, new CircuitBreaker());
    }
    return tabCircuitBreakers.get(tabId)!;
}

chrome.tabs.onRemoved.addListener((tabId) => {
    injectedTabs.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status === 'loading') injectedTabs.delete(tabId);
});

async function ensureContentScript(
    tabId: number,
    tabUrl?: string,
    opts: InjectOptions = {},
): Promise<void> {
    if (tabUrl && isRestrictedUrl(tabUrl)) {
        const err = new Error(`RESTRICTED: Content scripts cannot run on ${tabUrl}`) as Error & { code?: ActionErrorCode };
        err.code = 'RESTRICTED_URL';
        throw err;
    }

    if (injectedTabs.has(tabId)) return;

    const manifest = chrome.runtime.getManifest();
    const contentFile = manifest.content_scripts?.[0]?.js?.[0];
    if (!contentFile) throw new Error('No content script entry found in manifest');

    const maxRetries = opts.maxRetries ?? 1;
    const settleMs = opts.settleMs ?? 400;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            log.info('Inject', `Injecting "${contentFile}" into tab ${tabId} (attempt ${attempt + 1})`);
            await chrome.scripting.executeScript({
                target: { tabId, allFrames: false },
                files: [contentFile],
            });
            if (settleMs > 0) await sleep(settleMs);
            injectedTabs.add(tabId);
            return;
        } catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));
            log.warn('Inject', `Injection attempt ${attempt + 1} failed`, lastError.message);
            if (attempt < maxRetries) await sleep(300 * (attempt + 1));
        }
    }

    const injectErr = (lastError ?? new Error('Injection failed')) as Error & { code?: ActionErrorCode };
    injectErr.code = 'INJECT_FAILED';
    throw injectErr;
}

export async function sendToTab(
    tabId: number,
    message: ContentScriptMessage,
    tabUrl?: string,
    options: SendToTabOptions = {},
): Promise<unknown> {
    // Determine timeout based on action type
    let timeoutMs = options.timeoutMs;
    if (!timeoutMs && options.actionType) {
        const strategy = shouldPessimisticTimeout(options.actionType) ? 'pessimistic' : 'typical';
        timeoutMs = getAdjustedTimeout(options.actionType, options.attemptNumber ?? 0, strategy);
    }
    timeoutMs ??= 10_000;

    const maxRetries = options.maxRetries ?? 2;
    const circuitBreaker = getCircuitBreaker(tabId);

    // Check circuit breaker
    if (!circuitBreaker.canExecute()) {
        const state = circuitBreaker.getState();
        log.warn('CircuitBreaker', `Circuit open for tab ${tabId}: ${state.failureCount} failures`, state);
        const cbErr = new Error('Circuit breaker is open - too many failures') as Error & { code?: ActionErrorCode };
        cbErr.code = 'RELAY_FAILED';
        throw cbErr;
    }

    const trySend = (attempt: number): Promise<unknown> =>
        new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const timeoutErr = new Error('sendToTab timed out') as Error & { code?: ActionErrorCode };
                timeoutErr.code = 'RELAY_TIMEOUT';
                reject(timeoutErr);
            }, timeoutMs!);

            chrome.tabs.sendMessage(tabId, message, (response) => {
                clearTimeout(timer);
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                    return;
                }
                resolve(response);
            });
        });

    try {
        return await executeWithRetry(
            async (attempt) => {
                if (attempt > 0) {
                    // Pre-retry hook for content script injection (if needed)
                    const disconnected = true; // Would be checked from previous error
                    if (disconnected) {
                        await ensureContentScript(tabId, tabUrl, options.injectOptions);
                    }
                }
                return await trySend(attempt);
            },
            {
                maxRetries,
                baseDelayMs: DEFAULT_RETRY_STRATEGY.baseDelayMs,
                exponentialBase: DEFAULT_RETRY_STRATEGY.exponentialBase,
                jitterPercent: DEFAULT_RETRY_STRATEGY.jitterPercent,
                onRetry: (attempt, error, delayMs) => {
                    const category = classifyError(error);
                    log.warn('Retry', `Attempt ${attempt + 1} failed (${category}), retrying in ${delayMs}ms`, 
                        (error instanceof Error ? error.message : String(error)).slice(0, 60));
                },
            }
        );
    } catch (err) {
        circuitBreaker.recordFailure();
        const relayErr = err as Error & { code?: ActionErrorCode };
        relayErr.code = relayErr.code ?? 'RELAY_FAILED';
        throw relayErr;
    }
}

// ─── Screenshot ───────────────────────────────────────────────────────────────

export interface ScreenshotOptions {
    format?: 'jpeg' | 'png';
    quality?: number;
}

export interface ScreenshotResult {
    dataUrl: string;
    format: 'jpeg' | 'png';
    tabId?: number;
    windowId: number;
}

export async function captureScreenshotResult(
    tabId?: number,
    options: ScreenshotOptions = {},
): Promise<ScreenshotResult | null> {
    const format = options.format ?? 'jpeg';
    const quality = options.quality ?? 70;

    try {
        if (tabId !== undefined) {
            const tab = await chrome.tabs.get(tabId);
            const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format, quality });
            return { dataUrl, format, tabId, windowId: tab.windowId };
        }

        const windows = await chrome.windows.getAll({ populate: false });
        const focused = windows.find((w) => w.focused);
        if (!focused?.id) {
            log.warn('Screenshot', 'No focused window found');
            return null;
        }

        const dataUrl = await chrome.tabs.captureVisibleTab(focused.id, { format, quality });
        return { dataUrl, format, windowId: focused.id };
    } catch (err) {
        log.warn('Screenshot', 'Capture failed', errorMessage(err));
        return null;
    }
}

// Backward-compatible helper used by existing callers.
export async function captureScreenshot(tabId?: number): Promise<string | null> {
    const result = await captureScreenshotResult(tabId, { format: 'jpeg', quality: 70 });
    return result?.dataUrl ?? null;
}

// ─── Skills Registration ──────────────────────────────────────────────────────

let skillsInitialised = false;

function _initSkills(): void {
    if (skillsInitialised) {
        log.warn('Skills', '_initSkills called more than once. Ignoring duplicate call.');
        return;
    }
    skillsInitialised = true;

    registerAllSkills({
        validateUrl,
        waitForTabLoad,
        waitForNetworkIdle,
        sleep,
        captureScreenshot,
        sendToTab: sendToTab as (tabId: number, msg: Record<string, unknown>, tabUrl?: string) => Promise<unknown>,
        sanitizeSelector,
        sanitizeValue,
    });

    log.info('Skills', `Registered ${skillRegistry.listNames().length} skills`);
}

// ─── Browser Action Executor ──────────────────────────────────────────────────

export async function executeBrowserAction(
    action: BrowserAction,
    ctx: BrowserContext,
): Promise<ActionResult> {
    const skill = skillRegistry.get(action.type);
    if (!skill || skill.type !== 'browser') {
        return { success: false, error: `Unknown browser action: ${action.type}`, code: 'UNKNOWN_SKILL' };
    }
    try {
        return await skill.execute(action as PlannerAction, ctx);
    } catch (err) {
        return { success: false, error: errorMessage(err), code: 'SKILL_THREW' };
    }
}

// ─── Selector Fallback Chain ──────────────────────────────────────────────────

type FallbackLevel = 'description' | 'visible-text';

const NOT_FOUND_PATTERNS = [
    'not found', 'no element', 'cannot find',
    'null', 'undefined', 'queryselector', 'no matching',
] as const;

function isNotFoundError(error: string): boolean {
    const lower = error.toLowerCase();
    return NOT_FOUND_PATTERNS.some((pattern) => lower.includes(pattern));
}

interface FallbackResult {
    level: FallbackLevel | 'none';
    selector: string | null;
}

async function runSelectorFallback(
    action: PlannerAction,
    tabId: number,
    tabUrl: string,
): Promise<FallbackResult> {
    if (action.label) {
        try {
            const res = await sendToTab(tabId, {
                type: 'FIND_ELEMENT',
                payload: { description: action.label, elementType: action.type },
            }, tabUrl) as { success: boolean; selector: string | null } | null;

            if (res?.success && res.selector) {
                log.info('Fallback', `Level description recovered selector: ${res.selector}`);
                return { level: 'description', selector: res.selector };
            }
        } catch (err) {
            log.warn('Fallback', 'Level description failed', errorMessage(err));
        }
    }

    if (action.label) {
        try {
            const res = await sendToTab(tabId, {
                type: 'FIND_ELEMENT',
                payload: { description: action.label, strategy: 'text-content' },
            }, tabUrl) as { success: boolean; selector: string | null } | null;

            if (res?.success && res.selector) {
                log.info('Fallback', `Level visible-text recovered selector: ${res.selector}`);
                return { level: 'visible-text', selector: res.selector };
            }
        } catch (err) {
            log.warn('Fallback', 'Level visible-text failed', errorMessage(err));
        }
    }

    return { level: 'none', selector: null };
}

// ─── Planner Action Dispatcher ────────────────────────────────────────────────

export async function dispatchPlannerAction(
    action: PlannerAction,
    ctx: BrowserContext,
    sessionId: string,
): Promise<ActionResult> {
    const startedAt = Date.now();
    const withTiming = (result: ActionResult): ActionResult => ({
        ...result,
        durationMs: Date.now() - startedAt,
    });

    const validation = validateAction(action, sessionId);
    if (!validation.allowed) {
        log.warn('Security', `Blocked action "${action.type}"`, validation.reason);
        recordActionTelemetry(action.type, false, Date.now() - startedAt, 'SECURITY_BLOCKED');
        return withTiming({
            success: false,
            error: validation.reason,
            blocked: true,
            code: 'SECURITY_BLOCKED',
        });
    }

    const skill = skillRegistry.get(action.type);
    if (!skill) {
        recordActionTelemetry(action.type, false, Date.now() - startedAt, 'UNKNOWN_SKILL');
        return withTiming({
            success: false,
            error: `Unknown action type: "${action.type}" — not found in skill registry`,
            code: 'UNKNOWN_SKILL',
        });
    }

    if (skill.type === 'dom') {
        const { activeTabId, activeTab } = ctx;

        if (!activeTabId || !activeTab) {
            recordActionTelemetry(action.type, false, Date.now() - startedAt, 'NO_ACTIVE_TAB');
            return withTiming({ success: false, error: 'No active tab for DOM action', code: 'NO_ACTIVE_TAB' });
        }

        if (isRestrictedUrl(activeTab.url)) {
            recordActionTelemetry(action.type, false, Date.now() - startedAt, 'RESTRICTED_URL');
            return withTiming({
                success: false,
                error: `Cannot run DOM actions on restricted page: ${activeTab.url}`,
                code: 'RESTRICTED_URL',
            });
        }

        try {
            let result = await skill.execute(action, ctx, activeTabId, activeTab.url);

            if (!result.success && isNotFoundError(result.error ?? '')) {
                log.info('Dispatcher', `Action "${action.type}" failed with not-found class error, running fallback.`);

                const fallback = await runSelectorFallback(action, activeTabId, activeTab.url);
                if (fallback.selector) {
                    try {
                        const fallbackAction: PlannerAction = { ...action, selector: fallback.selector };
                        result = await skill.execute(fallbackAction, ctx, activeTabId, activeTab.url);
                        if (!result.success && !result.code) {
                            result = { ...result, code: 'FALLBACK_EXHAUSTED' };
                        }
                    } catch (err) {
                        result = {
                            success: false,
                            error: errorMessage(err),
                            code: 'FALLBACK_EXHAUSTED',
                        };
                    }
                } else {
                    result = { ...result, code: result.code ?? 'FALLBACK_EXHAUSTED' };
                }
            }

            // Record telemetry
            const timingMs = Date.now() - startedAt;
            recordActionTelemetry(action.type, result.success, timingMs, result.error);

            return withTiming(result);
        } catch (err) {
            const timingMs = Date.now() - startedAt;
            recordActionTelemetry(action.type, false, timingMs, errorMessage(err));
            return withTiming({ success: false, error: errorMessage(err), code: 'SKILL_THREW' });
        }
    }

    try {
        const result = await skill.execute(action, ctx);
        recordActionTelemetry(action.type, result.success, Date.now() - startedAt, result.error);
        return withTiming(result);
    } catch (err) {
        recordActionTelemetry(action.type, false, Date.now() - startedAt, errorMessage(err));
        return withTiming({ success: false, error: errorMessage(err), code: 'SKILL_THREW' });
    }
}

// ─── Initialise skill registry ────────────────────────────────────────────────

_initSkills();

export { skillRegistry } from './skills/index.js';
