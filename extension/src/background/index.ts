import './logger.ts';
import type {
    SubmitCommandMessage,
    ExecuteDOMActionMessage,
    ReadDOMMessage,
    AnalyzePageMessage,
    PageAnalysisData,
    HighlightResultsMessage,
    DiscoverFiltersMessage,
    ClickElementMessage,
} from '../types/messages.js';

// ─── Configuration ───
const BACKEND_URL = 'http://localhost:3001';

// In-memory steps tracking to prevent async race conditions
let MemorySteps: any[] = [];

// ─── Session State (persisted so popup survives close/reopen) ───
interface AstraSessionState {
    status: 'idle' | 'running' | 'done' | 'error';
    steps: Array<{
        step: number;
        totalSteps: number;
        description: string;
        status: 'pending' | 'running' | 'done' | 'error';
    }>;
    result?: { success: boolean; data: unknown; summary?: string; rankedResults?: unknown[] };
    error?: string;
    startedAt: number;
}

async function saveState(state: Partial<AstraSessionState>): Promise<void> {
    try {
        const current = await getState();
        await chrome.storage.session.set({ astra_state: { ...current, ...state } });
    } catch {
        // storage.session may not be available in all environments — silently skip
    }
}

async function getState(): Promise<AstraSessionState> {
    try {
        const result = await chrome.storage.session.get('astra_state');
        return result.astra_state ?? { status: 'idle', steps: [], startedAt: 0 };
    } catch {
        return { status: 'idle', steps: [], startedAt: 0 };
    }
}

async function clearState(): Promise<void> {
    try {
        await chrome.storage.session.remove('astra_state');
    } catch {
        // ignore
    }
}

// ─── Message Listener ───
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'SUBMIT_COMMAND') {
        handleCommand(message as SubmitCommandMessage);
    }

    if (message.type === 'GET_STATE') {
        getState().then(sendResponse);
        return true;
    }

    return true;
});

// ─── Command Handler (Universal Vision-First Pipeline) ───
async function handleCommand(message: SubmitCommandMessage) {
    const { prompt } = message.payload;

    // Clear prior session state and mark as running
    await clearState();
    MemorySteps = [];
    await saveState({ status: 'running', steps: MemorySteps, startedAt: Date.now() });

    try {
        // ─── Step 1: Screenshot first (vision-informed planning) ───
        sendProgress(1, 6, 'Capturing screen...', 'running');
        const activeTab = await getActiveTab();
        const context = activeTab ? {
            url: activeTab.url,
            title: activeTab.title,
        } : undefined;
        const screenshot = await captureScreenshot();
        sendProgress(1, 6, 'Screen captured', 'done');

        // ─── Step 2: Intent planning (60s timeout — LLM can take up to 25s) ───
        sendProgress(2, 6, 'Understanding intent...', 'running');

        const intentController = new AbortController();
        const intentTimeout = setTimeout(() => intentController.abort(), 60000);

        let intentRes: Response;
        try {
            intentRes = await fetch(`${BACKEND_URL}/intent`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt, context, screenshot }),
                signal: intentController.signal,
            });
        } catch (fetchErr: unknown) {
            clearTimeout(intentTimeout);
            const isAbort = fetchErr instanceof DOMException && fetchErr.name === 'AbortError';
            const isNetwork = fetchErr instanceof TypeError && String(fetchErr).includes('fetch');
            if (isAbort) throw new Error('Request timed out — backend is slow. Please try again.');
            if (isNetwork) throw new Error('Cannot reach backend — make sure the server is running on port 3001.');
            throw fetchErr;
        } finally {
            clearTimeout(intentTimeout);
        }

        if (!intentRes.ok) {
            throw new Error(`Backend error ${intentRes.status} — check server logs.`);
        }

        const intentResponse = await intentRes.json();
        const plan = intentResponse.plan;
        sendProgress(2, 6, 'Intent understood', 'done');

        // ─── Classify the plan ───
        const hasAnalyzePage = plan?.steps?.some(
            (s: { action: string }) => s.action === 'analyze_page'
        );
        const hasSearch = plan?.steps?.some(
            (s: { action: string }) => s.action === 'search'
        );
        // CRITICAL: If ANY search step exists, ALWAYS run the full research pipeline
        const isResearchPlan = hasSearch;

        if (isResearchPlan) {
            // ─── Full Research Loop (search → filters → scan → rank → highlight) ───
            sendProgress(3, 6, 'Searching...', 'running');

            // Extract the search query from the plan
            const searchStep = plan.steps.find(
                (s: { action: string }) => s.action === 'search'
            );
            const searchQuery = searchStep?.params?.value || prompt;

            // Execute search DIRECTLY via content script — stay in the existing logged-in tab
            const searchTab = await getActiveTab();
            if (!searchTab?.id) throw new Error('No active tab for search');

            try {
                await sendToContentScript(searchTab.id, {
                    type: 'EXECUTE_DOM_ACTION',
                    payload: { action: 'search', value: searchQuery },
                });
            } catch (searchErr) {
                console.log('[ASTRA] First search attempt failed, retrying in 1.5s:', searchErr);
                sendProgress(3, 6, 'Retrying search...', 'running');
                await new Promise(r => setTimeout(r, 1500));
                // Retry once — same tab, same session, no navigation
                await sendToContentScript(searchTab.id, {
                    type: 'EXECUTE_DOM_ACTION',
                    payload: { action: 'search', value: searchQuery },
                });
            }

            sendProgress(3, 6, 'Search complete', 'done');

            // ─── Step 4: Smart Filter Discovery & Application ───
            sendProgress(4, 6, 'Discovering filters...', 'running');
            await new Promise((r) => setTimeout(r, 2000)); // Wait for results page to load

            let filtersApplied = 0;
            try {
                const filterTab = await getActiveTab();
                if (filterTab?.id) {
                    // Discover available filters on the page
                    const filterResponse = await sendToContentScript(filterTab.id, {
                        type: 'DISCOVER_FILTERS',
                        payload: {} as Record<string, never>,
                    }) as { success: boolean; data?: Array<{ type: string; label: string; selector: string; currentValue?: string; options?: string[] }> };

                    if (filterResponse?.data && filterResponse.data.length > 0) {
                        console.log(`[ASTRA] Found ${filterResponse.data.length} filter elements`);
                        sendProgress(4, 6, `Found ${filterResponse.data.length} filters, matching...`, 'running');

                        // Send filters + user query to LLM for matching
                        const matchRes = await fetch(`${BACKEND_URL}/match-filters`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ query: prompt, filters: filterResponse.data }),
                        });

                        if (matchRes.ok) {
                            const matchResult = await matchRes.json();

                            if (matchResult.filtersToApply?.length > 0) {
                                console.log('[ASTRA] Applying filters:', matchResult.filtersToApply);
                                sendProgress(4, 6, `Applying ${matchResult.filtersToApply.length} filters...`, 'running');

                                // Click each matched filter with cursor animation
                                for (const filter of matchResult.filtersToApply) {
                                    try {
                                        await sendToContentScript(filterTab.id, {
                                            type: 'CLICK_ELEMENT',
                                            payload: {
                                                selector: filter.selector,
                                                label: `Applying: ${filter.label}`,
                                            },
                                        });
                                        filtersApplied++;
                                        await new Promise(r => setTimeout(r, 1200)); // Wait for filter to take effect
                                    } catch (clickErr) {
                                        console.log(`[ASTRA] Failed to click filter ${filter.label}:`, clickErr);
                                    }
                                }

                                // Wait for filtered results to settle
                                if (filtersApplied > 0) {
                                    await new Promise(r => setTimeout(r, 2500));
                                }
                            } else {
                                console.log('[ASTRA] No matching filters for user constraints');
                            }
                        }
                    }
                }
            } catch (filterErr) {
                console.log('[ASTRA] Filter phase failed (non-critical):', filterErr);
            }

            sendProgress(4, 6, filtersApplied > 0 ? `${filtersApplied} filter(s) applied` : 'No filters needed', 'done');

            // ─── Step 5: Scan results page ───
            sendProgress(5, 6, 'Scanning results...', 'running');
            await new Promise((r) => setTimeout(r, 1000));

            const postActionScreenshot = await captureScreenshot();
            const pageData = await analyzeCurrentPage();
            sendProgress(5, 6, 'Results captured', 'done');

            // ─── Step 6: Vision-powered ranking + summarization ───
            sendProgress(6, 6, 'Ranking & summarizing...', 'running');

            const analyzeRes = await fetch(`${BACKEND_URL}/analyze`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    prompt: `[SEARCH RESULTS] Original query: "${prompt}". Rank and summarize the results by relevance and popularity.`,
                    pageData,
                    screenshot: postActionScreenshot || undefined,
                    isSearchResults: true,
                }),
            });

            if (!analyzeRes.ok) throw new Error(`Analysis error: ${analyzeRes.status}`);
            const result = await analyzeRes.json();

            // ─── Send result & persist to session ───
            sendProgress(6, 6, '✅ Done', 'done');

            // Allow queued storage updates from updateStateProgress to flush
            await new Promise(r => setTimeout(r, 100));

            const payload = { success: true, data: result.data, summary: result.summary, rankedResults: result.rankedResults };
            await saveState({ status: 'done', result: payload });

            chrome.runtime.sendMessage({
                type: 'COMMAND_RESULT',
                payload,
            }).catch(() => {
                // Popup may be closed, but state is saved in session. Continue to highlight.
                console.log('[ASTRA] Popup closed before final result could be sent. Continuing to highlight.');
            });

            // ─── Visual on-page result highlighting (after result sent) ───
            if (result.rankedResults && result.rankedResults.length > 0) {
                const currentTab = await getActiveTab();
                if (currentTab?.id) {
                    try {
                        await sendToContentScript(currentTab.id, {
                            type: 'HIGHLIGHT_RESULTS',
                            payload: { results: result.rankedResults, query: prompt },
                        });
                    } catch (highlightErr) {
                        console.log('[ASTRA] Highlight failed (non-critical):', highlightErr);
                    }
                }
            }

        } else if (hasAnalyzePage) {
            // ─── Summarize / analyze current page ───
            sendProgress(3, 4, 'Reading page content...', 'running');
            const pageData = await analyzeCurrentPage();
            sendProgress(3, 4, 'Page read', 'done');

            sendProgress(4, 4, 'Analyzing...', 'running');
            const postScreenshot = await captureScreenshot();
            const analyzeRes = await fetch(`${BACKEND_URL}/analyze`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    prompt,
                    pageData,
                    screenshot: postScreenshot || undefined,
                }),
            });

            if (!analyzeRes.ok) throw new Error(`Analysis error: ${analyzeRes.status}`);
            const result = await analyzeRes.json();
            sendProgress(4, 4, '✅ Done', 'done');

            const payload = { success: true, data: result.data, summary: result.summary };
            await saveState({ status: 'done', result: payload });

            chrome.runtime.sendMessage({
                type: 'COMMAND_RESULT',
                payload,
            });

        } else {
            // ─── Simple browser action (click, open tab, type, etc.) ───
            sendProgress(3, 4, 'Executing...', 'running');
            const execRes = await fetch(`${BACKEND_URL}/execute`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ plan, prompt }),
            });

            if (!execRes.ok) throw new Error(`Execution error: ${execRes.status}`);
            const result = await execRes.json();

            if (result.steps?.length > 0) {
                await executeStepActions(result.steps);
            }
            sendProgress(4, 4, '✅ Done', 'done');

            const payload = { success: true, data: result.data, summary: result.summary };
            await saveState({ status: 'done', result: payload });

            chrome.runtime.sendMessage({
                type: 'COMMAND_RESULT',
                payload,
            });
        }
    } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';
        await saveState({ status: 'error', error: errorMsg });
        chrome.runtime.sendMessage({
            type: 'COMMAND_ERROR',
            payload: { message: errorMsg },
        });
    }
}

// ─── Step Execution (Client-Side) ───
async function executeStepActions(steps: Array<{ success: boolean; data?: { action?: unknown }; error?: string }>) {
    for (const step of steps) {
        if (!step.success || !step.data?.action) continue;

        // BrowserAction uses `type`; ExecuteDOMActionMessage.payload uses `action`.
        // We cast to a loose shape and remap below.
        const raw = step.data.action as {
            type: string;
            selector?: string;
            value?: string;
            duration?: number;
            direction?: 'up' | 'down';
            amount?: number;
            maxDepth?: number;
        };
        console.log('[ASTRA] Executing action:', raw);

        // Build the ExecuteDOMActionMessage payload (action field = the verb)
        const actionType = raw.type as ExecuteDOMActionMessage['payload']['action'];

        try {
            switch (raw.type) {
                case 'scroll':
                case 'click':
                case 'type':
                case 'wait': {
                    const tabI = await getActiveTab();
                    if (tabI?.id) {
                        await sendToContentScript(tabI.id, {
                            type: 'EXECUTE_DOM_ACTION',
                            payload: {
                                action: actionType,
                                selector: raw.selector,
                                value: raw.value,
                                duration: raw.duration,
                                direction: raw.direction,
                                amount: raw.amount,
                            },
                        });
                    }
                    break;
                }

                case 'search': {
                    const tabS = await getActiveTab();
                    if (!tabS?.id) throw new Error('No active tab found for search');

                    try {
                        await sendToContentScript(tabS.id, {
                            type: 'EXECUTE_DOM_ACTION',
                            payload: { action: 'search', value: raw.value ?? '' },
                        });
                    } catch (err) {
                        console.log('[ASTRA] Search attempt 1 failed, retrying:', err);
                        await new Promise(r => setTimeout(r, 1500));
                        await sendToContentScript(tabS.id, {
                            type: 'EXECUTE_DOM_ACTION',
                            payload: { action: 'search', value: raw.value ?? '' },
                        });
                    }
                    break;
                }

                case 'read_page': {
                    const tabR = await getActiveTab();
                    if (tabR?.id) {
                        await sendToContentScript(tabR.id, {
                            type: 'READ_DOM',
                            payload: {
                                selector: raw.selector,
                                maxDepth: raw.maxDepth,
                            },
                        });
                    }
                    break;
                }

                case 'analyze_page':
                    await analyzeCurrentPage();
                    break;
            }
        } catch (err) {
            console.log('[ASTRA] Action execution failed:', err);
        }
    }
}


export async function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
    // Try last focused first (most accurate)
    let [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });

    // Fallback to current window if lastFocused fails (e.g. background processing)
    if (!tab) {
        [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    }
    return tab;
}

// ─── Page Analysis (scroll + extract via content script) ───
async function analyzeCurrentPage(): Promise<PageAnalysisData | null> {
    const tab = await getActiveTab();
    if (!tab?.id) return null;

    // Check for restricted URLs where content scripts cannot run
    if (tab.url && (
        tab.url.startsWith('chrome://') ||
        tab.url.startsWith('edge://') ||
        tab.url.startsWith('about:') ||
        tab.url.startsWith('mozilla://') ||
        tab.url.startsWith('view-source:') ||
        tab.url.startsWith('https://chrome.google.com/webstore') ||
        tab.url.startsWith('https://chromewebstore.google.com')
    )) {
        console.log('[ASTRA] Cannot analyze restricted URL:', tab.url);
        return {
            url: tab.url,
            title: 'Restricted Page',
            meta: { description: 'Browser security prevents access to this page.' },
            fullText: `[SYSTEM MESSAGE]: This is a restricted system page (${tab.url}). Content scripts are blocked, but a screenshot can be analyzed if a Vision Model is configured.`,
            sections: [],
            links: [],
            forms: [],
            tables: [],
            images: [],
            viewportSnapshots: [],
            totalHeight: 0,
            viewportHeight: 0,
            scrollDepth: 0,
            restricted: true,
        };
    }

    try {
        const response = await chrome.tabs.sendMessage(tab.id, {
            type: 'ANALYZE_PAGE',
            payload: {
                maxScrolls: 15,
                scrollDelay: 400,
                includeStructure: true,
            },
        } as AnalyzePageMessage);

        if (response?.success) {
            return response.data as PageAnalysisData;
        }
        console.log('[ASTRA] Page analysis returned error:', response?.error);
        return null;
    } catch (err) {
        console.log('[ASTRA] Could not analyze page:', err);
        return null;
    }
}

// ─── Screenshot Capture ───
async function captureScreenshot(): Promise<string | null> {
    try {
        const dataUrl = await chrome.tabs.captureVisibleTab(undefined as unknown as number, {
            format: 'jpeg',
            quality: 70,
        });
        return dataUrl;
    } catch (err) {
        console.log('[ASTRA] Screenshot capture failed:', err);
        return null;
    }
}


// ─── Content Script Communication ───
export async function sendToContentScript(
    tabId: number,
    message: ExecuteDOMActionMessage | ReadDOMMessage | AnalyzePageMessage | HighlightResultsMessage | DiscoverFiltersMessage | ClickElementMessage,
): Promise<unknown> {
    const trySend = (): Promise<unknown> =>
        new Promise((resolve, reject) => {
            chrome.tabs.sendMessage(tabId, message, (response) => {
                if (chrome.runtime.lastError) {
                    return reject(new Error(chrome.runtime.lastError.message));
                }
                if (response && response.success === false) {
                    return reject(new Error(response.error || 'Unknown error in content script'));
                }
                resolve(response);
            });
        });

    try {
        return await trySend();
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);

        // Content script not loaded in this tab — inject it programmatically then retry
        if (msg.includes('Receiving end does not exist') || msg.includes('Could not establish connection')) {
            console.log('[ASTRA] Content script not found — injecting into tab', tabId);

            try {
                // Read the actual content script filename from the manifest
                // (Vite hashes filenames, so we can't hardcode the path)
                const manifest = chrome.runtime.getManifest();
                const contentScriptFile = manifest.content_scripts?.[0]?.js?.[0];
                if (!contentScriptFile) throw new Error('No content script in manifest');

                await chrome.scripting.executeScript({
                    target: { tabId },
                    files: [contentScriptFile],
                });
            } catch (injectErr) {
                console.log('[ASTRA] Content script injection failed:', injectErr);
                throw new Error('Cannot inject content script into this page');
            }

            // Wait for the content script to initialize and register its listener
            await new Promise(r => setTimeout(r, 600));
            return await trySend();
        }

        throw err;
    }
}


// ─── Helpers ───
function sendProgress(
    step: number,
    totalSteps: number,
    description: string,
    status: 'pending' | 'running' | 'done' | 'error',
) {
    const progressPayload = { step, totalSteps, description, status };

    // Broadcast to popup (works if popup is open)
    chrome.runtime.sendMessage({
        type: 'COMMAND_PROGRESS',
        payload: progressPayload,
    }).catch(() => {
        // Popup may be closed — that's fine, state is persisted in session storage
    });

    // Also persist to session storage so popup can restore on reopen
    const existing = MemorySteps.findIndex(s => s.step === step);
    if (existing >= 0) {
        MemorySteps[existing] = progressPayload;
    } else {
        MemorySteps.push(progressPayload);
    }
    saveState({ steps: MemorySteps });
}

console.log('[ASTRA] Background service worker initialized');
