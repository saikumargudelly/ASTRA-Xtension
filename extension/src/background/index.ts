// ════════════════════════════════════════════════════════════════════════════
// ASTRA Background Service Worker — Browser-Centric Intelligence Core
// ─ Upgraded from tab-centric to fully browser-aware:
//   • Knows all open windows, tabs, and their state
//   • Routes EVERY action through the SecurityGuard before execution
//   • Audit logs every action taken in this session
//   • Supports the full BrowserAction + DOMAction surface
// ════════════════════════════════════════════════════════════════════════════

import './logger.ts';
import type {
    SubmitCommandMessage,
    PageAnalysisData,
    HighlightResultsMessage,
    AnalyzePageMessage,
    PlannerAction,
    BrowserStateUpdateMessage,
    TabInfo,
    CommandFollowUpMessage,
    ShowFollowUpMessage,
    HideFollowUpMessage,
} from '../types/messages.js';
import {
    getBrowserContext,
    sendToTab,
    captureScreenshot,
    dispatchPlannerAction,
    waitForTabLoad,
    sleep,
    isRestrictedUrl,
    getAuditLog,
    type BrowserContext,
} from './browser-actions';
import { validateUrl } from './security.js';

// ─── Configuration ───────────────────────────────────────────────────────────
const BACKEND_URL = 'http://localhost:3001';

// Enable side panel to open on extension icon click
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

/** Infer user region from tab URL for location-aware navigation (e.g. amazon.in → IN). */
function inferRegionFromUrl(url: string | undefined): string | undefined {
    if (!url) return undefined;
    try {
        const host = new URL(url).hostname.toLowerCase();
        if (host.endsWith('.in')) return 'IN';
        if (host.endsWith('.co.uk')) return 'UK';
        if (host.endsWith('.de')) return 'DE';
        if (host.endsWith('.fr')) return 'FR';
        if (host.endsWith('.co.jp') || host.endsWith('.jp')) return 'JP';
        if (host.endsWith('.com.au')) return 'AU';
        if (host.endsWith('.ca')) return 'CA';
        if (host.endsWith('.com.br')) return 'BR';
        if (host.endsWith('.com.mx')) return 'MX';
    } catch {
        /* ignore */
    }
    return undefined;
}

/** Normalize locale string to two-letter region (e.g. en-IN → IN, en-US → US). */
function localeToRegion(locale: string | undefined): string | undefined {
    if (!locale || typeof locale !== 'string') return undefined;
    const v = locale.trim();
    if (v.includes('-')) {
        const part = v.split('-').pop();
        if (part && part.length === 2) return part.toUpperCase();
    }
    if (v.length === 2) return v.toUpperCase();
    return undefined;
}

let MemorySteps: Array<{
    step: number; totalSteps: number; description: string;
    status: 'pending' | 'running' | 'done' | 'error';
    agentName?: string;
}> = [];

// ─── Follow-Up Response Queue ─────────────────────────────────────────────────
// When the pipeline emits an ask_user action, it creates a pending Promise here.
// The message listener resolves it when the user responds via FOLLOW_UP_RESPONSE.
let pendingFollowUp: {
    resolve: (answer: string) => void;
    reject: (reason: Error) => void;
} | null = null;

function waitForUserResponse(question: string, options?: string[], category?: string, context?: string): Promise<string> {
    // Send the question to the popup (may fail if popup is closed — that's OK)
    const followUpMsg: CommandFollowUpMessage = {
        type: 'COMMAND_FOLLOW_UP',
        payload: { question, options, context, category: (category as CommandFollowUpMessage['payload']['category']) || 'general' },
    };
    chrome.runtime.sendMessage(followUpMsg).catch(() => {
        console.log('[ASTRA] Popup closed — follow-up delivered via in-page overlay instead');
    });

    // ALSO send to the active tab's content script — this injects a floating overlay
    // that stays visible even when the popup is closed (which Chrome does on tab switch)
    getBrowserContext().then(ctx => {
        if (ctx.activeTabId && ctx.activeTab && !isRestrictedUrl(ctx.activeTab.url)) {
            sendToTab(ctx.activeTabId, {
                type: 'SHOW_FOLLOW_UP',
                payload: { question, options, context, category: category || 'general' },
            } as ShowFollowUpMessage, ctx.activeTab.url).catch(() => {
                console.log('[ASTRA] Could not show in-page overlay — content script not ready');
            });
        }
    });

    // Save follow-up state so reopened popup can show the question
    saveState({
        status: 'running' as const,
        followUp: { question, options, category, context },
    } as any);

    return new Promise<string>((resolve, reject) => {
        pendingFollowUp = { resolve, reject };
        // Timeout after 5 minutes — user abandoned
        setTimeout(() => {
            if (pendingFollowUp) {
                pendingFollowUp = null;
                reject(new Error('Follow-up question timed out — no response from user.'));
            }
        }, 5 * 60_000);
    });
}

// ─── Session State ────────────────────────────────────────────────────────────
interface AstraSessionState {
    status: 'idle' | 'running' | 'done' | 'error';
    steps: typeof MemorySteps;
    result?: { success: boolean; data: unknown; summary?: string; rankedResults?: unknown[]; actionLog?: unknown[] };
    error?: string;
    startedAt: number;
    browserContext?: { tabs: TabInfo[]; activeTabId: number | null };
}

async function saveState(state: Partial<AstraSessionState>): Promise<void> {
    try {
        const current = await getState();
        await chrome.storage.session.set({ astra_state: { ...current, ...state } });
    } catch { /* storage.session may not be available — silently skip */ }
}

async function getState(): Promise<AstraSessionState> {
    try {
        const result = await chrome.storage.session.get('astra_state');
        return result.astra_state ?? { status: 'idle', steps: [], startedAt: 0 };
    } catch { return { status: 'idle', steps: [], startedAt: 0 }; }
}

async function clearState(): Promise<void> {
    try { await chrome.storage.session.remove('astra_state'); } catch { /* ignore */ }
}

function coercePositiveInt(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        return Math.floor(value);
    }
    if (typeof value === 'string') {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    }
    return undefined;
}

function normalizePlannerAction(raw: Record<string, any>): PlannerAction {
    const type = String(raw.action ?? raw.type ?? '').trim();
    const label = (typeof raw.label === 'string' && raw.label.trim())
        ? raw.label.trim()
        : ((typeof raw.reason === 'string' && raw.reason.trim()) ? raw.reason.trim() : type);

    const normalized: Record<string, unknown> = { ...raw, type, label };

    if (typeof raw.selector === 'string') normalized.selector = raw.selector;
    if (typeof raw.value === 'string') normalized.value = raw.value;
    if (typeof raw.reason === 'string') normalized.reason = raw.reason;
    if (Array.isArray(raw.options)) normalized.options = raw.options;
    if (typeof raw.category === 'string') normalized.category = raw.category;

    const elementIdx = coercePositiveInt(raw.elementIdx);
    if (elementIdx !== undefined) normalized.elementIdx = elementIdx;

    // Backward/forward compatibility across planner payload variants.
    if (type === 'open_tab' || type === 'new_tab' || type === 'navigate') {
        const urlCandidate = typeof raw.url === 'string'
            ? raw.url
            : (typeof raw.value === 'string'
                ? raw.value
                : (typeof raw.selector === 'string' ? raw.selector : undefined));
        if (urlCandidate) normalized.url = urlCandidate;
    }

    if (type === 'switch_tab' || type === 'close_tab') {
        const tabId = coercePositiveInt(raw.tabId) ?? elementIdx;
        if (tabId !== undefined) normalized.tabId = tabId;
    }

    if (type === 'wait') {
        const duration = coercePositiveInt(raw.duration) ?? coercePositiveInt(raw.value);
        if (duration !== undefined) normalized.duration = duration;
    }

    if (type === 'scroll') {
        const amount = coercePositiveInt(raw.amount) ?? coercePositiveInt(raw.value);
        if (amount !== undefined) normalized.amount = amount;
        if (typeof raw.direction === 'string') normalized.direction = raw.direction;
    }

    return normalized as PlannerAction;
}

function actionSignature(actions: PlannerAction[]): string {
    return actions
        .map((a) => {
            const extras = a as Record<string, unknown>;
            return [
                a.type,
                String(a.elementIdx ?? ''),
                String(a.selector ?? ''),
                String(a.value ?? ''),
                String(extras.url ?? ''),
                String(extras.tabId ?? ''),
            ].join('|');
        })
        .join('||');
}

// ─── Message Listener ─────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'SUBMIT_COMMAND') {
        handleCommand(message as SubmitCommandMessage);
        return true;
    }
    if (message.type === 'FOLLOW_UP_RESPONSE') {
        const answer = message.payload?.answer;
        if (pendingFollowUp && answer) {
            console.log('[ASTRA] User responded to follow-up:', answer);
            pendingFollowUp.resolve(answer);
            pendingFollowUp = null;
            // Hide the in-page overlay
            getBrowserContext().then(ctx => {
                if (ctx.activeTabId && ctx.activeTab && !isRestrictedUrl(ctx.activeTab.url)) {
                    sendToTab(ctx.activeTabId, { type: 'HIDE_FOLLOW_UP' } as HideFollowUpMessage, ctx.activeTab.url).catch(() => {});
                }
            });
        }
        sendResponse({ received: true });
        return true;
    }
    if (message.type === 'GET_STATE') {
        getState().then(sendResponse);
        return true;
    }
    if (message.type === 'GET_BROWSER_STATE') {
        getBrowserContext().then(ctx => {
            const update: BrowserStateUpdateMessage = {
                type: 'BROWSER_STATE_UPDATE',
                payload: { tabs: ctx.tabs, activeTabId: ctx.activeTabId },
            };
            sendResponse(update);
        });
        return true;
    }
    if (message.type === 'GET_AUDIT_LOG') {
        const sessionId = message.sessionId ?? 'default';
        sendResponse({ log: getAuditLog(sessionId) });
        return true;
    }
    return true;
});

// ─── Tab change → push browser state to popup ─────────────────────────────────
function broadcastBrowserState(): void {
    getBrowserContext().then(ctx => {
        const update: BrowserStateUpdateMessage = {
            type: 'BROWSER_STATE_UPDATE',
            payload: { tabs: ctx.tabs, activeTabId: ctx.activeTabId },
        };
        chrome.runtime.sendMessage(update).catch(() => { /* popup may be closed */ });
    });
}

chrome.tabs.onCreated.addListener(broadcastBrowserState);
chrome.tabs.onRemoved.addListener(broadcastBrowserState);
chrome.tabs.onUpdated.addListener((_id, info) => { if (info.status === 'complete') broadcastBrowserState(); });
chrome.tabs.onActivated.addListener(broadcastBrowserState);

// ─── Universal Browser-Centric Pipeline ──────────────────────────────────────
// 5 steps that work for ANY browser task:
// 1. Full browser context capture (all windows, all tabs + screenshot)
// 2. Classify intent
// 3. Multi-round action loop (browser + DOM) via dispatchPlannerAction
// 4. Read resulting page state
// 5. Analyze, rank, summarize, highlight
async function handleCommand(message: SubmitCommandMessage) {
    const { prompt, sessionId = 'default', locale } = message.payload;
    await clearState();
    MemorySteps = [];
    await saveState({ status: 'running', steps: MemorySteps, startedAt: Date.now() });

    try {
        // ── Step 1: Capture full browser context ─────────────────────────
        sendProgress(1, 5, 'Capturing browser context...', 'running', 'coordinator');
        const ctx: BrowserContext = await getBrowserContext();
        // Capture once and reuse for initial planning to avoid duplicate screenshot cost.
        const screenshot = await captureScreenshot();
        const region = inferRegionFromUrl(ctx.activeTab?.url) ?? localeToRegion(locale);
        const context = ctx.activeTab
            ? { url: ctx.activeTab.url, title: ctx.activeTab.title, tabCount: ctx.tabs.length, ...(region && { region }) }
            : region ? { region } : undefined;
        await saveState({ browserContext: { tabs: ctx.tabs, activeTabId: ctx.activeTabId } });
        sendProgress(1, 5, `Context: ${ctx.tabs.length} tab(s) captured`, 'done', 'coordinator');

        // ── Step 2: Classify intent ──────────────────────────────────────
        sendProgress(2, 5, 'Understanding intent...', 'running', 'planner');
        const intentController = new AbortController();
        const intentTimeout = setTimeout(() => intentController.abort(), 60_000);
        let intentData: {
            plan?: { intent?: string; steps?: Array<{ action: string; params?: Record<string, string> }> };
            taskType?: string;
        } = {};

        try {
            const intentRes = await fetch(`${BACKEND_URL}/intent`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    prompt,
                    context,
                    screenshot,
                    browserState: { tabCount: ctx.tabs.length, tabs: ctx.tabs.map(t => ({ url: t.url, title: t.title, active: t.active })) },
                }),
                signal: intentController.signal,
            });
            if (intentRes.ok) intentData = await intentRes.json();
        } catch (intentErr: unknown) {
            const isAbort = intentErr instanceof DOMException && intentErr.name === 'AbortError';
            if (isAbort) throw new Error('Request timed out — backend is slow. Please try again.');
            const isNetwork = intentErr instanceof TypeError && String(intentErr).includes('fetch');
            if (isNetwork) throw new Error('Cannot reach backend — make sure server is running on port 3001.');
            throw intentErr;
        } finally {
            clearTimeout(intentTimeout);
        }

        const plan = intentData.plan;
        const hasSearch = plan?.steps?.some(s => s.action === 'search');
        const isLLMOnly = plan?.steps?.length &&
            plan.steps.every(s => ['answer', 'respond', 'explain'].includes(s.action));
        sendProgress(2, 5, 'Intent classified', 'done', 'planner');

        // Pure LLM Q&A — no browser interaction needed
        if (isLLMOnly) {
            sendProgress(3, 5, 'Generating answer...', 'running', 'planner');
            const chatRes = await fetch(`${BACKEND_URL}/chat`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt, context }),
            });
            const chatText = await chatRes.text();
            sendProgress(3, 5, '✅ Done', 'done', 'planner');
            const payload = { success: true, data: {}, summary: chatText, actionLog: getAuditLog(sessionId) };
            await saveState({ status: 'done', result: payload });
            chrome.runtime.sendMessage({ type: 'COMMAND_RESULT', payload }).catch(() => { });
            return;
        }

        // ── Step 3: Navigate + snapshot + plan + execute (multi-round) ───
        sendProgress(3, 5, 'Executing browser actions...', 'running', 'browser');

        // Pre-navigation: if the plan wants us to open a new URL, do it first
        const navStep = plan?.steps?.find(s =>
            s.action === 'open_tab' || s.action === 'navigate' || s.action === 'goto' || s.action === 'new_tab'
        );
        console.log('[ASTRA] Nav step check:', navStep ? `action=${navStep.action} url=${navStep?.params?.url}` : 'none');
        const navUrl = typeof navStep?.params?.url === 'string' ? navStep.params.url : undefined;
        if (navUrl) {
            const urlCheck = validateUrl(navUrl);
            if (!urlCheck.allowed) throw new Error(`Blocked navigation: ${urlCheck.reason}`);

            let hostname: string;
            try { hostname = new URL(navUrl).hostname; } catch { hostname = navUrl; }
            sendProgress(3, 5, `Opening ${hostname}...`, 'running', 'browser');
            console.log('[ASTRA] Pre-nav: opening', navUrl);

            // Check if a tab for that host already exists
            const freshCtx = await getBrowserContext();
            const existingTab = freshCtx.tabs.find(t => {
                try { return new URL(t.url).hostname === hostname; } catch { return false; }
            });

            let navTabId: number;
            if (existingTab) {
                // Reuse existing tab — just switch to it and ensure correct URL
                console.log('[ASTRA] Pre-nav: reusing existing tab', existingTab.tabId, existingTab.url);
                await chrome.tabs.update(existingTab.tabId, { active: true, url: navUrl });
                await chrome.windows.update(existingTab.windowId, { focused: true });
                navTabId = existingTab.tabId;
            } else {
                // Always open a NEW tab — don't replace the user's current page
                console.log('[ASTRA] Pre-nav: creating new tab');
                const newTab = await chrome.tabs.create({ url: navUrl, active: true });
                navTabId = newTab.id!;
            }

            // Wait for page to fully load
            await waitForTabLoad(navTabId, 15_000);
            await sleep(800); // Brief settle time for SPAs (React/Netflix/etc)
            console.log('[ASTRA] Pre-nav: tab loaded, navTabId =', navTabId);
        }

        // If there's an explicit search step AND we didn't just navigate to a new site,
        // execute the search before the plan loop. Skip if we navigated — the plan loop
        // will handle search after first assessing the page (e.g. profile selection, login)
        if (hasSearch && !navUrl) {
            const searchStep = plan?.steps?.find(s => s.action === 'search');
            const searchQuery = searchStep?.params?.value || prompt;
            const freshCtx = await getBrowserContext();
            if (freshCtx.activeTabId) {
                await dispatchPlannerAction(
                    { type: 'search', value: searchQuery, label: `Search: ${searchQuery}` } as PlannerAction,
                    freshCtx, sessionId,
                ).catch(() => { /* non-fatal */ });
                await sleep(1400);
            }
        }

        // Multi-round snapshot → plan → execute loop
        let actionsApplied = 0;
        const MAX_ROUNDS = 8;  // Prevent long replan loops while keeping enough room for multi-step tasks
        const sessionHistory: Array<{ action: string; label: string; elementIdx?: number; success?: boolean; error?: string }> = [];
        let lastSnapshotSig = '';
        let userFollowUpContext = '';  // Injected when user answers a follow-up question
        let consecutiveEmptyRounds = 0; // Track when planner keeps returning nothing
        let consecutiveFailedRounds = 0;
        let repeatedPlanRounds = 0;
        let lastPlanSig = '';
        let lastPageUrl = '';  // Detect URL changes mid-loop
        let stopReason: 'rate_limit' | 'repeated_plan' | 'repeated_failures' | null = null;
        let lastRoundHadZeroActions = false; // Hint for next round when plan produced no valid actions
        const taskStartTime = Date.now();

        for (let round = 0; round < MAX_ROUNDS; round++) {
            const roundStartTime = Date.now();
            const roundCtx = await getBrowserContext();
            const activeT = roundCtx.activeTab;
            if (!activeT || isRestrictedUrl(activeT.url)) break;

            try {
                // Snapshot the active page
                const snapResp = await sendToTab(activeT.tabId, {
                    type: 'GET_PAGE_SNAPSHOT',
                    payload: {},
                }, activeT.url) as {
                    success: boolean;
                    data?: {
                        url: string; title: string; visibleText: string;
                        interactiveElements: Array<{ idx: number; type: string; label: string; selector: string; context?: string }>;
                    };
                };

                if (!snapResp?.success || !snapResp.data?.interactiveElements?.length) {
                    // Page might still be loading — retry with increasing delay
                    const retryDelay = round === 0 ? 1500 : 1200;
                    console.log(`[ASTRA] Round ${round}: snapshot empty/failed, retrying after ${retryDelay}ms...`);
                    await sleep(retryDelay);
                    const retrySnap = await sendToTab(activeT.tabId, {
                        type: 'GET_PAGE_SNAPSHOT', payload: {},
                    }, activeT.url) as typeof snapResp;
                    if (!retrySnap?.success || !retrySnap.data?.interactiveElements?.length) {
                        console.log(`[ASTRA] Round ${round}: retry also failed — breaking`);
                        break;
                    }
                    // Use retry data
                    Object.assign(snapResp, retrySnap);
                }

                // Detect URL change (page navigated due to a click/link)
                const currentUrl = snapResp.data!.url;
                const urlChanged = !!(lastPageUrl && currentUrl !== lastPageUrl);
                lastPageUrl = currentUrl;

                const sig = JSON.stringify(snapResp.data!.interactiveElements.map(e => ({ idx: e.idx, type: e.type, label: e.label })));
                // Detect SPA page change: URL same but DOM elements completely different
                const pageContentChanged = !!(lastSnapshotSig && sig !== lastSnapshotSig);

                // When the URL OR the page content changes significantly, elementIdx values
                // from the old page are meaningless (different DOM = different indices).
                // Strip them to prevent false "duplicate action" rejections.
                // This covers SPAs like Netflix where URL stays netflix.com/browse but
                // the page transitions from profile select → home → search.
                if (urlChanged || (pageContentChanged && round > 0)) {
                    for (const entry of sessionHistory) {
                        delete entry.elementIdx;
                    }
                    const reason = urlChanged ? 'URL changed' : 'page content changed (SPA)';
                    console.log(`[ASTRA] ${reason} → cleared elementIdx from ${sessionHistory.length} history entries`);
                }

                let stateFeedback: string | undefined;
                if (round > 0 && lastRoundHadZeroActions) {
                    stateFeedback = 'The previous round produced no valid actions. If this is a profile or cookie screen, use ask_user with options from the page (e.g. profile names). For click/type always include elementIdx from the INTERACTIVE ELEMENTS list. Do NOT repeat an action that was already in EXECUTED.';
                }
                if (round > 0 && sig === lastSnapshotSig && !urlChanged && !stateFeedback) {
                    stateFeedback = 'The last action did NOT change the page state. Try a different element or approach. Do NOT repeat the same action.';
                } else if (urlChanged || (pageContentChanged && round > 0)) {
                    stateFeedback = urlChanged
                        ? `The page URL changed from the previous page to: ${currentUrl}. This is a new screen — re-assess what's visible and plan next steps toward the goal.`
                        : `The page content changed significantly (SPA navigation). This is a new screen — re-assess what's visible and plan next steps toward the goal.`;
                }

                // Include failed action context in feedback to help planner adapt
                const failedActions = sessionHistory.filter(h => h.success === false);
                if (failedActions.length > 0) {
                    const failInfo = failedActions.map(f => `"${f.label}" failed: ${f.error || 'unknown'}`).join('; ');
                    stateFeedback = (stateFeedback ? stateFeedback + '\n' : '') +
                        `FAILED ACTIONS (avoid these approaches): ${failInfo}`;
                }

                // Inject user's follow-up answer as context for the planner
                // This is the FALLBACK path — only used when auto-click couldn't find a matching element
                if (userFollowUpContext) {
                    stateFeedback = (stateFeedback ? stateFeedback + '\n' : '') +
                        `🚨 USER ANSWERED A FOLLOW-UP QUESTION: "${userFollowUpContext}"\n` +
                        `→ You MUST now CLICK the element on this page that best matches "${userFollowUpContext}".\n` +
                        `→ The user's choice has NOT been applied yet — YOU must find and click the matching element.\n` +
                        `→ Do NOT assume the action was already taken. Look at the page elements and click the right one.`;
                    userFollowUpContext = ''; // Consume the context — only inject once
                }
                lastSnapshotSig = sig;

                const elCount = snapResp.data?.interactiveElements?.length ?? 0;
                sendProgress(3, 5,
                    round === 0
                        ? `Planning on ${elCount} page elements...`
                        : `Continue round ${round + 1} / ${MAX_ROUNDS}...`,
                    'running', 'browser',
                );

                // Build full browser snapshot for the planner
                const browserSnapshot = {
                    activeTab: snapResp.data,
                    tabs: roundCtx.tabs.map(t => ({
                        tabId: t.tabId, title: t.title, url: t.url, active: t.active,
                    })),
                };

                // FIX 2: Only capture a screenshot when: (a) it's round 0, or (b) the URL changed,
                // or (c) the page content changed significantly (SPA navigation).
                // Sending a 200-500KB base64 screenshot every round is the structural cause
                // of 413 errors, excessive token usage, and rate-limit burnout.
                // Unchanged pages need no vision re-analysis — the DOM snapshot is sufficient.
                const shouldCaptureScreenshot = round === 0 || urlChanged || (pageContentChanged && round > 0);
                // Reuse the initial screenshot for round 0 (already captured for /intent).
                // For later rounds, only capture when needed.
                const roundScreenshot = shouldCaptureScreenshot
                    ? (round === 0 ? screenshot : await captureScreenshot().catch(() => null))
                    : null;
                if (!shouldCaptureScreenshot) {
                    console.log(`[ASTRA] Round ${round + 1}: skipping screenshot (URL and content unchanged)`);
                }
                const planRegion = inferRegionFromUrl(roundCtx.activeTab?.url);
                const planRes = await fetch(`${BACKEND_URL}/plan-actions`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        query: prompt,
                        browserSnapshot,
                        executedActions: sessionHistory.length > 0
                            ? sessionHistory.map(h => ({
                                ...h,
                                ...(h.success === false ? { failed: true, failReason: h.error } : {}),
                            }))
                            : undefined,
                        stateFeedback,
                        ...(planRegion && { region: planRegion }),
                        sessionId,                                      // Gap 2: memory scoping
                        ...(roundScreenshot && { screenshot: roundScreenshot }), // Gap 6: vision every round
                        ...(intentData.plan?.intent && { plannerHint: intentData.plan.intent }), // Gap 3: planner hint
                    }),
                });
                if (!planRes.ok) break;

                const rawPlanResult = await planRes.json() as {
                    actions: Array<Record<string, any>>;
                    askUser?: { question: string; options?: string[]; category?: string; context?: string };
                    /** GoalEvaluator result — present when planner returns 0 actions or task_complete page state */
                    goalEval?: { status: 'complete' | 'in_progress' | 'stuck' | 'failed'; confidence: number; reason: string; suggestion?: string };
                    /** PageState classification from PageStateAgent */
                    pageState?: { state: string; confidence: number; actionHint: string };
                };

                // ── Map server field names: PlannedAction uses `action` field, PlannerAction uses `type` ─
                const actions: PlannerAction[] = (rawPlanResult.actions ?? []).map(normalizePlannerAction);

                // ─── Handle ask_user: the planner wants to ask the user something ───
                // Check both the top-level askUser flag and any ask_user actions in the list
                const askUserAction = actions.find(a => a.type === 'ask_user');
                const askPayload = rawPlanResult.askUser || (askUserAction ? {
                    question: askUserAction.value || askUserAction.label,
                    options: (askUserAction as any).options,
                    category: (askUserAction as any).category || 'general',
                    context: (askUserAction as any).reason,
                } : null);

                if (askPayload) {
                    console.log(`[ASTRA] 🗣️ Asking user: "${askPayload.question}" (${askPayload.category})`);
                    console.log(`[DEBUG|Background] ask_user triggered: ${JSON.stringify({ question: askPayload.question, options: askPayload.options, category: askPayload.category })}`);
                    sendProgress(3, 5, `🗣️ ${askPayload.question}`, 'running', 'browser');

                    try {
                        const userAnswer = await waitForUserResponse(
                            askPayload.question,
                            askPayload.options,
                            askPayload.category,
                            askPayload.context,
                        );
                        console.log(`[ASTRA] ✅ User answered: "${userAnswer}"`);
                        sessionHistory.push({ action: 'ask_user', label: `Asked: ${askPayload.question} → User: ${userAnswer}` });

                        // ── AUTO-CLICK: Find and click the element matching the user's answer ──
                        // Instead of relying on the LLM to map the answer to an element,
                        // we directly find the matching element and click it. This prevents
                        // the planner from hallucinating that the action was already taken.
                        const answerLower = userAnswer.toLowerCase().trim();
                        const snapshotElements = snapResp.data?.interactiveElements ?? [];
                        const matchingElement = snapshotElements.find(el =>
                            el.label.toLowerCase().includes(answerLower) ||
                            answerLower.includes(el.label.toLowerCase())
                        );

                        if (matchingElement) {
                            console.log(`[ASTRA] 🎯 Auto-clicking element matching "${userAnswer}": [${matchingElement.idx}] ${matchingElement.label}`);
                            sendProgress(3, 5, `▶ Selecting: ${matchingElement.label}`, 'running', 'browser');
                            const clickAction = {
                                type: 'click',
                                selector: matchingElement.selector,
                                elementIdx: matchingElement.idx,
                                label: `Click: ${matchingElement.label}`,
                                value: undefined,
                            } as PlannerAction;
                            const clickResult = await dispatchPlannerAction(clickAction, roundCtx, sessionId);
                            if (clickResult.success) {
                                sessionHistory.push({ action: 'click', label: matchingElement.label, elementIdx: matchingElement.idx, success: true });
                                actionsApplied++;
                                await sleep(1300); // Wait for page transition
                                // Wait for potential page load after click
                                const postClickCtx = await getBrowserContext();
                                if (postClickCtx.activeTab?.loading) {
                                    await sleep(1200);
                                }
                                console.log(`[ASTRA] ✅ Auto-click succeeded — page should have changed`);
                            } else {
                                console.log(`[ASTRA] ⚠ Auto-click failed: ${clickResult.error}`);
                                sessionHistory.push({ action: 'click', label: matchingElement.label, elementIdx: matchingElement.idx, success: false, error: clickResult.error });
                                // Fall through — planner will handle in next round with failure context
                            }
                            // Continue normally — no need to inject followUpContext since we already clicked
                            userFollowUpContext = '';
                        } else {
                            console.log(`[ASTRA] No exact element match for "${userAnswer}" — planner will handle`);
                            userFollowUpContext = userAnswer;
                        }

                        sendProgress(3, 5, `User chose: ${userAnswer}`, 'running', 'browser');
                        await sleep(250);
                        continue; // Re-snapshot and re-plan
                    } catch (followUpErr) {
                        console.warn('[ASTRA] Follow-up timed out or errored:', followUpErr);
                        sendProgress(3, 5, '⏰ No response — continuing...', 'running', 'browser');
                        break;
                    }
                }

                // Filter out ask_user from executable actions (already handled above)
                const executableActions = actions.filter(a => a.type !== 'ask_user');

                const currentPlanSig = actionSignature(executableActions);
                if (currentPlanSig && currentPlanSig === lastPlanSig) {
                    repeatedPlanRounds++;
                } else {
                    repeatedPlanRounds = 0;
                }
                lastPlanSig = currentPlanSig;

                // Track when server returned no valid executable actions so next round gets a hint
                lastRoundHadZeroActions = executableActions.length === 0;

                // ── Explicit Task Complete Signal ──
                const taskCompleteAction = executableActions.find(a => a.type === 'task_complete');
                if (taskCompleteAction) {
                    console.log(`[ASTRA] ✅ LLM signaled task complete: ${taskCompleteAction.reason}`);
                    sendProgress(3, 5, `✅ Task Complete: ${taskCompleteAction.reason || 'Goal achieved'}`, 'done', 'browser');
                    break;
                }

                if (repeatedPlanRounds >= 2 && executableActions.length > 0) {
                    stopReason = 'repeated_plan';
                    console.warn('[ASTRA] Planner repeated effectively the same action set for 3 rounds — stopping loop.');
                    sendProgress(3, 5, '⚠ Planner repeated the same steps. Stopping to avoid loop.', 'running', 'browser');
                    break;
                }

                if (executableActions.length === 0) {
                    lastPlanSig = '';
                    repeatedPlanRounds = 0;
                    // ── GoalEval: did the backend confirm task is complete? ──
                    const ge = rawPlanResult.goalEval;
                    if (ge && ge.status === 'complete' && ge.confidence >= 0.75) {
                        console.log(`[ASTRA] ✅ GoalEvaluator: task complete — ${ge.reason}`);
                        sendProgress(3, 5, `✅ Goal achieved: ${ge.reason}`, 'done', 'browser');
                        break;
                    }
                    // GoalEval says stuck or failed — surface a hint and stop
                    if (ge && (ge.status === 'stuck' || ge.status === 'failed') && ge.confidence >= 0.8) {
                        console.log(`[ASTRA] ⚠ GoalEvaluator: ${ge.status} — ${ge.reason}`);
                        sendProgress(3, 5, `⚠ ${ge.reason}${ge.suggestion ? ` — ${ge.suggestion}` : ''}`, 'running', 'browser');
                        // Still fall through to the empty-round counter so we don't break too early
                    }
                    consecutiveEmptyRounds++;
                    console.log(`[ASTRA] Round ${round + 1}: no executable actions (consecutiveEmptyRounds=${consecutiveEmptyRounds})`);
                    if (consecutiveEmptyRounds >= 2) {
                        console.log(`[ASTRA] ${consecutiveEmptyRounds} empty rounds — stopping`);
                        break;
                    }
                    console.log(`[ASTRA] Round ${round + 1}: no new actions — will retry once more`);
                    await sleep(800);
                    continue;
                }
                consecutiveEmptyRounds = 0; // Reset on valid actions
                
                console.log(`[ASTRA] Round ${round + 1}: Executing ${executableActions.length} action(s): ${executableActions.map(a => a.type).join(', ')}`);

                let roundCount = 0;
                let roundHitRateLimit = false;
                for (const [idx, action] of executableActions.entries()) {
                    // Refresh context before each action (tab may have changed)
                    const actionCtx = await getBrowserContext();
                    const actionStart = Date.now();
                    console.log(`[ASTRA] ▶ ${action.type}: "${action.label}" (${action.selector ?? action.value ?? action.elementIdx ?? ''})`);
                    sendProgress(3, 5, `▶ ${action.label}`, 'running', 'browser');

                    // Send action start progress
                    sendActionProgress({
                        actionIndex: actionsApplied + idx,
                        totalActions: sessionHistory.length + executableActions.length,
                        type: action.type,
                        label: action.label,
                        status: 'executing',
                        emoji: getActionEmoji(action.type),
                    });

                    const result = await dispatchPlannerAction(action, actionCtx, sessionId);
                    const actionDuration = Date.now() - actionStart;
                    console.log(`[ASTRA] ◀ ${action.type} result: ${result.success ? 'SUCCESS' : 'FAILED'} (${actionDuration}ms)${result.error ? ` - ${result.error}` : ''}`);

                    if (result.blocked) {
                        console.warn(`[ASTRA|SECURITY] Blocked: ${result.error}`);
                        sendProgress(3, 5, `⚠️ Blocked: ${result.error}`, 'running', 'critic');
                        
                        // Send failed action progress
                        sendActionProgress({
                            actionIndex: actionsApplied + idx,
                            totalActions: sessionHistory.length + executableActions.length,
                            type: action.type,
                            label: action.label,
                            status: 'failed',
                            emoji: '🛡️',
                            error: `Security blocked`,
                        });
                        
                        sessionHistory.push({ action: action.type, label: action.label, elementIdx: action.elementIdx, success: false, error: `Security blocked: ${result.error}` });
                        if ((result.error ?? '').includes('Rate limit exceeded')) {
                            roundHitRateLimit = true;
                            stopReason = 'rate_limit';
                            break;
                        }
                        // Don't abort on non-rate-limit blocked actions — skip and continue
                        continue;
                    }

                    if (result.success) {
                        sessionHistory.push({ action: action.type, label: action.label, elementIdx: action.elementIdx, success: true });
                        roundCount++;
                        actionsApplied++;

                        // Send success action progress
                        const successMsg = getActionSuccessMessage(action.type, action.label);
                        sendActionProgress({
                            actionIndex: actionsApplied - 1 + idx,
                            totalActions: sessionHistory.length + executableActions.length,
                            type: action.type,
                            label: action.label,
                            status: 'success',
                            emoji: getActionEmoji(action.type),
                            result: successMsg,
                        });

                        // Adaptive post-action delay based on action type
                        const isNav = ['open_tab', 'navigate', 'new_tab', 'go_back', 'go_forward', 'new_window'].includes(action.type);
                        const isPressEnter = action.type === 'press_enter';
                        const isClick = action.type === 'click';
                        
                        await sleep(isNav ? 1200 : (isClick ? 900 : 500));
                        if (isPressEnter) {
                            await sleep(1100); // Wait for search results or forms to initiate load
                        }
                        
                        // After navigation actions AND press_enter (which triggers form/search submit
                        // causing a full page load), wait for the tab to finish loading.
                        if (isNav || isPressEnter) {
                            const postNavCtx = await getBrowserContext();
                            if (postNavCtx.activeTab?.loading) {
                                await sleep(1800); // Extra wait for slow pages
                            }
                            // Additional settle for search result pages that lazy-render
                            if (isPressEnter) await sleep(600);
                        }
                    } else {
                        console.log(`[ASTRA] Action "${action.label}" failed: ${result.error}`);
                        
                        // Send failed action progress
                        sendActionProgress({
                            actionIndex: actionsApplied + idx,
                            totalActions: sessionHistory.length + executableActions.length,
                            type: action.type,
                            label: action.label,
                            status: 'failed',
                            emoji: '❌',
                            error: result.error ?? 'Unknown error',
                        });
                        
                        sessionHistory.push({ action: action.type, label: action.label, elementIdx: action.elementIdx, success: false, error: result.error });
                        sendProgress(3, 5, `⚠️ ${action.label} failed — adapting...`, 'running', 'browser');
                    }
                }

                if (roundHitRateLimit) {
                    sendProgress(3, 5, '⚠ Action rate limit reached. Ending this run.', 'running', 'critic');
                    break;
                }

                if (roundCount > 0) {
                    consecutiveFailedRounds = 0;
                    await sleep(900); // Let page settle before re-snapshotting
                } else {
                    // All actions in this round failed — don't break immediately
                    // Give the planner a chance to adapt with failure feedback
                    const allFailed = executableActions.length > 0;
                    if (allFailed) {
                        consecutiveFailedRounds++;
                        console.log(`[ASTRA] Round ${round + 1}: all actions failed — replanning with failure context`);
                        if (consecutiveFailedRounds >= 3) {
                            stopReason = 'repeated_failures';
                            console.warn('[ASTRA] Multiple consecutive failed rounds — stopping loop.');
                            sendProgress(3, 5, '⚠ Multiple rounds failed. Stopping to avoid loop.', 'running', 'browser');
                            break;
                        }
                        await sleep(700);
                        // Don't break — the planner will get the failure info via sessionHistory
                    } else {
                        break;
                    }
                }

            } catch (roundErr) {
                console.log(`[ASTRA] Round ${round + 1} non-fatal:`, roundErr);
                break;
            }
            const roundDuration = Date.now() - roundStartTime;
            const totalDuration = Date.now() - taskStartTime;
            console.log(`[PERF] ${JSON.stringify({location:'background/index.ts', event: 'round_complete', round: round + 1, roundDuration_ms: roundDuration, totalDuration_ms: totalDuration, actionsApplied})}`);
        }

        sendProgress(3, 5,
            actionsApplied > 0
                ? `✓ ${actionsApplied} action(s) executed`
                : (stopReason === 'rate_limit'
                    ? 'Stopped: action rate limit reached'
                    : (stopReason === 'repeated_plan'
                        ? 'Stopped: repeated action plan detected'
                        : (stopReason === 'repeated_failures' ? 'Stopped: repeated failures' : 'Ready'))),
            'done', 'browser',
        );

        // ── Step 4: Read resulting page state ────────────────────────────
        sendProgress(4, 5, 'Reading page results...', 'running', 'vision');
        await sleep(500);
        const postScreenshot = await captureScreenshot();
        const pageData = await analyzeCurrentPage();
        sendProgress(4, 5, 'Page read', 'done', 'vision');

        // ── Step 5: Analyze, rank, summarize ─────────────────────────────
        sendProgress(5, 5, 'Summarizing results...', 'running', 'summarizer');
        const analyzeRes = await fetch(`${BACKEND_URL}/analyze`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                prompt: hasSearch
                    ? `[SEARCH RESULTS] Original query: "${prompt}". Rank and summarize by relevance.`
                    : prompt,
                pageData,
                screenshot: postScreenshot ?? undefined,
                isSearchResults: hasSearch,
            }),
        });
        if (!analyzeRes.ok) {
            const errBody = await analyzeRes.text().catch(() => '');
            const fallbackSummary = actionsApplied > 0
                ? 'Actions were executed, but the final summarizer could not complete. The page likely changed as requested.'
                : 'ASTRA could not complete final page analysis in this run.';
            const payload = {
                success: true,
                data: {},
                summary: `${fallbackSummary}${errBody ? ` (analyze: ${errBody.slice(0, 160)})` : ''}`,
                rankedResults: [],
                actionLog: getAuditLog(sessionId),
            };
            await saveState({ status: 'done', result: payload });
            chrome.runtime.sendMessage({ type: 'COMMAND_RESULT', payload }).catch(() => {
                console.log('[ASTRA] Popup closed — state preserved in session.');
            });
            return;
        }
        const result = await analyzeRes.json();
        sendProgress(5, 5, '✅ Done', 'done', 'summarizer');
        await sleep(100);

        const payload = {
            success: true,
            data: result.data,
            summary: result.summary,
            rankedResults: result.rankedResults,
            actionLog: getAuditLog(sessionId),
        };
        await saveState({ status: 'done', result: payload });
        chrome.runtime.sendMessage({ type: 'COMMAND_RESULT', payload }).catch(() => {
            console.log('[ASTRA] Popup closed — state preserved in session.');
        });

        // Highlight results on-page
        if (result.rankedResults?.length > 0) {
            const finalCtx = await getBrowserContext();
            if (finalCtx.activeTabId && finalCtx.activeTab && !isRestrictedUrl(finalCtx.activeTab.url)) {
                sendToTab(finalCtx.activeTabId, {
                    type: 'HIGHLIGHT_RESULTS',
                    payload: { results: result.rankedResults, query: prompt },
                } as HighlightResultsMessage, finalCtx.activeTab.url).catch(() => { });
            }
        }

    } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';
        const isSecurityErr = errorMsg.startsWith('Blocked') || errorMsg.includes('security');
        await saveState({ status: 'error', error: errorMsg });
        chrome.runtime.sendMessage({
            type: 'COMMAND_ERROR',
            payload: { message: errorMsg, securityViolation: isSecurityErr },
        }).catch(() => { });
    }
}

// ─── Active Tab Helper (legacy — callers can use getBrowserContext instead) ────
export async function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
    let [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
}

// ─── Restricted Page Stub ─────────────────────────────────────────────────────
function restrictedStub(url: string, title: string, msg: string): PageAnalysisData {
    return {
        url, title: title || 'Protected Page', meta: {}, fullText: msg,
        sections: [], links: [], forms: [], tables: [], images: [],
        viewportSnapshots: [], totalHeight: 0, viewportHeight: 0, scrollDepth: 0,
        restricted: true,
    };
}

// ─── Page Analysis ────────────────────────────────────────────────────────────
async function analyzeCurrentPage(): Promise<PageAnalysisData | null> {
    const ctx = await getBrowserContext();
    if (!ctx.activeTab) return null;
    const { tabId, url, title } = ctx.activeTab;

    if (isRestrictedUrl(url)) {
        console.log('[ASTRA] Restricted URL — vision-only:', url);
        return restrictedStub(url, title, `[RESTRICTED PAGE] ${url} blocks content scripts.`);
    }

    try {
        const response = await sendToTab(tabId, {
            type: 'ANALYZE_PAGE',
            payload: { maxScrolls: 9, scrollDelay: 280, includeStructure: true },
        } as AnalyzePageMessage, url) as { success: boolean; data?: PageAnalysisData; error?: string };

        if (response?.success) return response.data as PageAnalysisData;
        console.log('[ASTRA] Page analysis content error:', response?.error);
        return null;
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.startsWith('RESTRICTED:') || msg.includes('Cannot access') || msg.includes('Missing host permission')) {
            return restrictedStub(url, title, `[PROTECTED PAGE] ${msg}. Vision screenshot is the only data source.`);
        }
        console.log('[ASTRA] Page analysis failed:', msg);
        return null;
    }
}

// ─── Legacy Step Execution (used by /execute route) ──────────────────────────
export async function executeStepActions(steps: Array<{ success: boolean; data?: { action?: unknown }; error?: string }>) {
    const ctx = await getBrowserContext();
    const sessionId = 'legacy';
    for (const step of steps) {
        if (!step.success || !step.data?.action) continue;
        const raw = step.data.action as { type: string; selector?: string; value?: string; direction?: 'up' | 'down'; amount?: number };
        try {
            await dispatchPlannerAction(
                { type: raw.type as PlannerAction['type'], selector: raw.selector, value: raw.value, label: raw.type } as PlannerAction,
                ctx, sessionId,
            );
        } catch (err) {
            console.log('[ASTRA] Legacy step action failed:', err);
        }
    }
}

// ─── Progress Reporter ────────────────────────────────────────────────────────
function sendProgress(
    step: number, totalSteps: number, description: string,
    status: 'pending' | 'running' | 'done' | 'error',
    agentName?: string,
) {
    const progressPayload = { step, totalSteps, description, status, agentName };
    chrome.runtime.sendMessage({ type: 'COMMAND_PROGRESS', payload: progressPayload }).catch(() => { });
    const existing = MemorySteps.findIndex(s => s.step === step);
    if (existing >= 0) MemorySteps[existing] = progressPayload;
    else MemorySteps.push(progressPayload);
    saveState({ steps: MemorySteps });
}

// ─── Action-Level Progress: Broadcast detailed action-by-action execution status ──
interface ActionProgress {
    actionIndex: number;
    totalActions: number;
    type: string;
    label: string;
    status: 'pending' | 'executing' | 'success' | 'failed';
    result?: string;
    error?: string;
    emoji?: string;
}

function sendActionProgress(progress: ActionProgress) {
    chrome.runtime.sendMessage({ type: 'ACTION_PROGRESS', payload: progress }).catch(() => { });
}

// ─── Action UI Helpers ───────────────────────────────────────────────────────────
function getActionEmoji(actionType: string): string {
    const emojiMap: Record<string, string> = {
        click: '🖱️', type: '⌨️', scroll: '↕️', navigate: '🌐', open_tab: '📑',
        close_tab: '❌', wait: '⏳', hover: '👆', drag_and_drop: '🎯',
        select_option: '✓', press_enter: '↩️', search: '🔍', ask_user: '🗣️',
        screenshot: '📸', submit_form: '📤', fill_form: '📋', focus: '✨',
        clear: '🗑️', copy_text: '📋', highlight: '🌟', keyboard: '⌨️',
        dismiss_dialog: '✕', extract_data: '🔑', assert_visible: '👁️', assert_text: '📖',
        read_page: '📖', analyze_page: '🔍', iframe_action: '📦', upload_file: '📁',
        set_value: '✎', toggle_checkbox: '☑️', range_set: '🎚️', double_click: '🖱️🖱️',
        right_click: '🖱️➜', multi_click: '🖱️x', go_back: '← ', go_forward: '→',
        reload_tab: '🔄', pin_tab: '📌', mute_tab: '🔇', zoom_tab: '🔍',
        get_all_tabs: '📑', search_tabs: '🔍', bookmark_page: '🔖', download_file: '⬇️',
    };
    return emojiMap[actionType] ?? '⚙️';
}

function getActionSuccessMessage(actionType: string, label: string): string {
    switch (actionType) {
        case 'click': return `Clicked element`;
        case 'type': return `Text entered`;
        case 'scroll': return `Page scrolled`;
        case 'navigate': return `Navigation complete`;
        case 'open_tab': return `New tab opened`;
        case 'close_tab': return `Tab closed`;
        case 'wait': return `Wait finished`;
        case 'hover': return `Element hovered`;
        case 'drag_and_drop': return `Drag completed`;
        case 'select_option': return `Option selected`;
        case 'submit_form': return `Form submitted`;
        case 'search': return `Search executed`;
        case 'ask_user': return `User asked`;
        default: return `Action completed`;
    }
}

console.log('[ASTRA] Background service worker initialized (browser-centric v2)');
