import type {
    SubmitCommandMessage,
    ExecuteDOMActionMessage,
    ReadDOMMessage,
    AnalyzePageMessage,
    DOMActionResultMessage,
    DOMDataMessage,
    PageAnalysisData,
    HighlightResultsMessage,
    DiscoverFiltersMessage,
    ClickElementMessage,
} from '../types/messages.js';

// ─── Configuration ───
const BACKEND_URL = 'http://localhost:3001';

// ─── Message Listener ───
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'SUBMIT_COMMAND') {
        handleCommand(message as SubmitCommandMessage);
    }

    return true;
});

// ─── Command Handler (Universal Vision-First Pipeline) ───
async function handleCommand(message: SubmitCommandMessage) {
    const { prompt } = message.payload;

    try {
        // ─── Step 1: Screenshot first (vision-informed planning) ───
        sendProgress(1, 5, 'Capturing screen...', 'running');
        const activeTab = await getActiveTab();
        const context = activeTab ? {
            url: activeTab.url,
            title: activeTab.title
        } : undefined;
        const screenshot = await captureScreenshot();
        sendProgress(1, 5, 'Screen captured', 'done');

        // ─── Step 2: Intent planning (45s timeout — LLM can take up to 25s) ───
        sendProgress(2, 5, 'Understanding intent...', 'running');

        const intentController = new AbortController();
        const intentTimeout = setTimeout(() => intentController.abort(), 45000);

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
        sendProgress(2, 5, 'Intent understood', 'done');

        // ─── Classify the plan ───
        const hasAnalyzePage = plan?.steps?.some(
            (s: { action: string }) => s.action === 'analyze_page'
        );
        const hasSearch = plan?.steps?.some(
            (s: { action: string }) => s.action === 'search'
        );
        // CRITICAL: If ANY search step exists, ALWAYS run the full research pipeline
        // The planner often only generates 1 search step without analyze_page
        const isResearchPlan = hasSearch; // was: hasSearch && hasAnalyzePage

        if (isResearchPlan) {
            // ─── Full Research Loop (search → wait → scroll → read → rank → highlight) ───
            sendProgress(3, 5, 'Searching...', 'running');

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
                sendProgress(3, 7, 'Retrying search...', 'running');
                await new Promise(r => setTimeout(r, 1500));
                // Retry once — same tab, same session, no navigation
                await sendToContentScript(searchTab.id, {
                    type: 'EXECUTE_DOM_ACTION',
                    payload: { action: 'search', value: searchQuery },
                });
            }

            sendProgress(3, 5, 'Search complete', 'done');

            // ─── Step 3.5: Smart Filter Discovery & Application ───
            sendProgress(4, 7, 'Discovering filters...', 'running');
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
                        sendProgress(4, 7, `Found ${filterResponse.data.length} filters, matching...`, 'running');

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
                                sendProgress(4, 7, `Applying ${matchResult.filtersToApply.length} filters...`, 'running');

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
                                    sendProgress(5, 7, 'Waiting for filtered results...', 'running');
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

            sendProgress(filtersApplied > 0 ? 5 : 4, 7, filtersApplied > 0 ? `${filtersApplied} filters applied` : 'No filters needed', 'done');

            // ─── Step 5: Scan results page (with cursor animation) ───
            sendProgress(6, 7, 'Scanning results...', 'running');
            await new Promise((r) => setTimeout(r, 1000));

            const postActionScreenshot = await captureScreenshot();
            const pageData = await analyzeCurrentPage();
            sendProgress(6, 7, 'Results captured', 'done');

            // ─── Step 6: Vision-powered ranking + summarization ───
            sendProgress(7, 7, 'Ranking & summarizing...', 'running');

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
            sendProgress(7, 7, '✅ Done', 'done');

            // ─── Visual on-page result highlighting ───
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

            chrome.runtime.sendMessage({
                type: 'COMMAND_RESULT',
                payload: { success: true, data: result.data, summary: result.summary, rankedResults: result.rankedResults },
            });

        } else if (hasAnalyzePage) {
            // ─── Summarize / analyze current page ───
            sendProgress(3, 5, 'Reading page content...', 'running');
            const pageData = await analyzeCurrentPage();
            sendProgress(3, 5, 'Page read', 'done');

            sendProgress(4, 5, 'Analyzing...', 'running');
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
            sendProgress(5, 5, '✅ Done', 'done');

            chrome.runtime.sendMessage({
                type: 'COMMAND_RESULT',
                payload: { success: true, data: result.data, summary: result.summary },
            });

        } else {
            // ─── Simple browser action (click, open tab, type, etc.) ───
            sendProgress(3, 5, 'Executing...', 'running');
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
            sendProgress(5, 5, '✅ Done', 'done');

            chrome.runtime.sendMessage({
                type: 'COMMAND_RESULT',
                payload: { success: true, data: result.data, summary: result.summary },
            });
        }
    } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';
        chrome.runtime.sendMessage({
            type: 'COMMAND_ERROR',
            payload: { message: errorMsg },
        });
    }
}

// ─── Step Execution (Client-Side) ───
async function executeStepActions(steps: Array<{ success: boolean; data?: { action?: any }; error?: string }>) {
    for (const step of steps) {
        if (!step.success || !step.data?.action) continue;

        const action = step.data.action;
        console.log('[ASTRA] Executing action:', action);

        try {
            switch (action.type) {
                case 'scroll':
                case 'click':
                case 'type':
                case 'wait':
                    const tabI = await getActiveTab();
                    if (tabI?.id) {
                        await sendToContentScript(tabI.id, {
                            type: 'EXECUTE_DOM_ACTION',
                            payload: action,
                        });
                    }
                    break;

                case 'search':
                    const tabS = await getActiveTab();
                    if (!tabS?.id) throw new Error('No active tab found for search');

                    try {
                        // Interact with the existing page's search bar — no navigation
                        await sendToContentScript(tabS.id, {
                            type: 'EXECUTE_DOM_ACTION',
                            payload: action,
                        });
                    } catch (err) {
                        console.log('[ASTRA] Search attempt 1 failed, retrying:', err);
                        await new Promise(r => setTimeout(r, 1500));
                        // Retry — same tab, same session, still no navigation
                        await sendToContentScript(tabS.id, {
                            type: 'EXECUTE_DOM_ACTION',
                            payload: action,
                        });
                    }
                    break;

                case 'read_page':
                    // Read content action
                    const tabR = await getActiveTab();
                    if (tabR?.id) {
                        await sendToContentScript(tabR.id, {
                            type: 'READ_DOM',
                            payload: {
                                selector: action.selector,
                                maxDepth: action.maxDepth,
                            },
                        });
                    }
                    break;
                case 'analyze_page':
                    // If we reach here, it's part of a composite execution.
                    // Ideally, we should capture the result, but for now just run it.
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
        // Returns a special object that the analyzer agent can recognize
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
            restricted: true, // Flag to indicate restricted access
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
    chrome.runtime.sendMessage({
        type: 'COMMAND_PROGRESS',
        payload: { step, totalSteps, description, status },
    });
}

console.log('[ASTRA] Background service worker initialized');
