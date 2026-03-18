import { chat } from '../services/llm.js';
import { analyzeScreen, identifyElements } from './vision.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface InteractiveElement {
    idx: number;
    type: string;
    label: string;
    selector: string;
    value?: string;
    section?: string;
    context?: string;
    role?: string;
    min?: string;
    max?: string;
    options?: string[];
}

export interface BrowserTab {
    tabId: number;
    title: string;
    url: string;
    active: boolean;
}

export interface BrowserSnapshot {
    activeTab: {
        url: string;
        title: string;
        visibleText: string;
        interactiveElements: InteractiveElement[];
    };
    tabs: BrowserTab[];
}

export interface ParsedIntent {
    taskType: 'shopping' | 'research' | 'page_analysis' | 'navigation' | 'form_fill' | 'general';
    budget?: { max: number; currency: string };
    sortBy?: 'rating' | 'price_asc' | 'price_desc' | 'relevance' | 'popularity' | 'newest';
    filters: Array<{ dimension: string; value: string }>;
    searchQuery?: string;
    targetSite?: string;   // The platform/website name (e.g., "netflix", "youtube")
    rawConstraints: string[];
    needsWebResearch?: boolean;  // true when LLM may need external docs to navigate
}

export interface PlannedAction {
    action: 'click' | 'type' | 'select-option' | 'range-set' | 'wait' | 'scroll' | 'navigate' | 'new_tab' | 'switch_tab' | 'close_tab' | 'ask_user' | 'press_enter' | 'task_complete';
    selector: string;     // For DOM: css selector. For Browser: URL or "tabId"
    value?: string;       // For type/navigate. For ask_user: the question to ask
    label: string;
    reason: string;
    elementIdx?: number;  // Optional, because a 'new_tab' doesn't target an element
    options?: string[];   // For ask_user: quick-select options from the page
    category?: 'profile_select' | 'login_required' | 'cookie_consent' | 'captcha' | 'age_verify' | 'disambiguation' | 'general';
}

// ─── Phase 1: Parse Intent ────────────────────────────────────────────────────

export async function parseUserIntent(query: string, plannerHint?: string): Promise<ParsedIntent> {
    const systemPrompt = `You are an intent parser for a universal browser automation agent.
Parse the user's natural language query into structured constraints.

OUTPUT FORMAT — TOON only:
[INTENT]
taskType: navigation
searchQuery: plugin screen
targetSite: oracle
needsWebResearch: true
[/INTENT]

RULES:
- taskType: shopping | research | page_analysis | navigation | form_fill | general
- budget_max: number only
- budget_currency: INR | USD | EUR | GBP
- sortBy: rating | price_asc | price_desc | relevance | popularity | newest | null
- needsWebResearch: true if the query references a specific product, platform, or tool (e.g. "OFSC", "Oracle", "AWS", "GitHub") that requires external documentation to navigate correctly. false otherwise.
- searchQuery: the CONTENT the user wants to find/play/buy — NOT the platform/website name.
  Examples: "open netflix and play naruto" → searchQuery: "naruto" (NOT "netflix")
  "search amazon for bluetooth headphones" → searchQuery: "bluetooth headphones" (NOT "amazon")
  "find python courses on udemy" → searchQuery: "python courses" (NOT "udemy")
- targetSite: the platform/website name if mentioned (e.g. "netflix", "amazon", "youtube"). Omit if none.
- Omit fields that do not apply`;

    // If the Planner already extracted a high-level intent description, include it as context
    // so this parsing aligns with what the Planner already understood about the task.
    const userPrompt = plannerHint
        ? `Parse this query: "${query}"\n\nPlanner context (use as a hint, don't override your own parse): ${plannerHint}`
        : `Parse this query: "${query}"`;

    const response = await chat(systemPrompt, userPrompt, 'planning');
    const intent: ParsedIntent = { taskType: 'general', filters: [], rawConstraints: [], needsWebResearch: false };

    try {
        const block = response.match(/\[INTENT\]([\s\S]*?)\[\/INTENT\]/i)?.[1] ?? response;
        for (const line of block.split('\n').map(l => l.trim()).filter(Boolean)) {
            const colon = line.indexOf(':');
            if (colon < 0) continue;
            const key = line.slice(0, colon).trim().toLowerCase();
            const val = line.slice(colon + 1).trim();
            if (!val || val === 'null') continue;

            if (key === 'tasktype') intent.taskType = val as ParsedIntent['taskType'];
            else if (key === 'searchquery') intent.searchQuery = val;
            else if (key === 'targetsite') intent.targetSite = val;
            else if (key === 'needswebresearch') intent.needsWebResearch = val.toLowerCase() === 'true';
            else if (key === 'budget_max') {
                const num = parseInt(val.replace(/,/g, ''), 10);
                if (!isNaN(num)) intent.budget = { max: num, currency: 'INR' };
            }
            else if (key === 'budget_currency' && intent.budget) intent.budget.currency = val;
            else if (key === 'sortby') intent.sortBy = val as ParsedIntent['sortBy'];
            else if (key === 'filter_dimension') intent.rawConstraints.push(val);
            else if (key === 'filter_value' && intent.rawConstraints.length > 0) {
                const dim = intent.rawConstraints[intent.rawConstraints.length - 1];
                intent.filters.push({ dimension: dim, value: val });
                intent.rawConstraints.pop();
            }
        }
    } catch (e) {
        console.warn('[PageIntelligence] Intent parse error:', e);
    }

    console.log('[PageIntelligence] Parsed intent:', JSON.stringify(intent));
    return intent;
}

// ─── TOON Action Parser ───────────────────────────────────────────────────────
// Handles both:
//   Pipe format:   action: click | elementIdx: 5 | selector: ... | label: ... | reason: ...
//   Multi-line:    action: click\n elementIdx: 5\n selector: ...\n

function parseToonActions(response: string): Array<Partial<PlannedAction>> {
    // Find the [ACTIONS] block — tolerate missing [/ACTIONS] closing tag
    // (some models stop generating before closing it)
    let actionsBlock: string;
    const closedMatch = response.match(/\[ACTIONS\]([\s\S]*?)\[\/ACTIONS\]/i);
    if (closedMatch) {
        actionsBlock = closedMatch[1];
    } else {
        // Fallback: take everything from [ACTIONS] to end of string (or [NOTES] / [REASONING])
        const openIdx = response.search(/\[ACTIONS\]/i);
        if (openIdx >= 0) {
            const after = response.slice(openIdx + '[ACTIONS]'.length);
            // Stop at [NOTES], [/ACTIONS], [REASONING] if present
            const stopMatch = after.search(/\[\/?(NOTES|REASONING|ACTIONS)\]/i);
            actionsBlock = stopMatch >= 0 ? after.slice(0, stopMatch) : after;
        } else {
            actionsBlock = '';
        }
    }
    const parsed: Array<Partial<PlannedAction>> = [];
    const lines = actionsBlock.split('\n').map(l => l.trim()).filter(Boolean);

    for (const line of lines) {
        // Detect pipe-format: starts with "action:" and has " | " as field separator
        // We must split carefully — avoid splitting on \| which appears inside CSS selectors
        if (line.toLowerCase().startsWith('action:') && line.includes(' | ')) {
            // Replace escaped \| in CSS selectors BEFORE splitting on ' | '
            // Strategy: split on ' | ' that are NOT preceded by a backslash
            const safeLine = line; // keep original
            const parts = splitPipeSafe(safeLine);
            const entry: Partial<PlannedAction> = {};
            for (const part of parts) {
                const colon = part.indexOf(':');
                if (colon < 0) continue;
                const k = part.slice(0, colon).trim().toLowerCase();
                const v = part.slice(colon + 1).trim();
                applyField(entry, k, v);
            }
            if (entry.action !== undefined) parsed.push(entry);
        } else {
            // Multi-line format
            const colon = line.indexOf(':');
            if (colon < 0) continue;
            const k = line.slice(0, colon).trim().toLowerCase();
            const v = line.slice(colon + 1).trim();
            if (!v) continue;

            if (k === 'action') {
                parsed.push({ action: v as PlannedAction['action'], label: '', reason: '' });
            } else if (parsed.length > 0) {
                applyField(parsed[parsed.length - 1], k, v);
            }
        }
    }

    return parsed;
}

// Split on ' | ' but NOT on CSS-selector escaped '\ |' sequences
function splitPipeSafe(line: string): string[] {
    const parts: string[] = [];
    let current = '';
    let i = 0;
    while (i < line.length) {
        // Check for ' | ' separator (3 chars: space, pipe, space)
        if (line[i] === ' ' && line[i + 1] === '|' && line[i + 2] === ' ' && (i === 0 || line[i - 1] !== '\\')) {
            parts.push(current);
            current = '';
            i += 3; // skip ' | '
        } else {
            current += line[i];
            i++;
        }
    }
    if (current) parts.push(current);
    return parts;
}

function applyField(entry: Partial<PlannedAction>, key: string, value: string) {
    if (key === 'action') entry.action = value as PlannedAction['action'];
    else if (key === 'elementidx') entry.elementIdx = parseInt(value, 10);
    else if (key === 'selector') entry.selector = value;
    else if (key === 'value') entry.value = value;
    else if (key === 'label') entry.label = value;
    else if (key === 'reason') entry.reason = value;
    else if (key === 'options') entry.options = value.split(',').map(o => o.trim()).filter(Boolean);
    else if (key === 'category') entry.category = value as PlannedAction['category'];
}

function isTextEntryElementType(type?: string): boolean {
    const t = (type || '').toLowerCase();
    return t === 'text-input' || t === 'search-input' || t === 'number-input';
}

function findBestTextInputElement(elements: InteractiveElement[], query?: string): InteractiveElement | undefined {
    const candidates = elements.filter((el) => isTextEntryElementType(el.type));
    if (candidates.length === 0) return undefined;

    const words = (query || '')
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 2)
        .slice(0, 5);

    const scored = candidates.map((el) => {
        const hay = `${el.label || ''} ${el.selector || ''} ${el.context || ''}`.toLowerCase();
        let score = 0;

        const hasLayoutFlag = /(resizer|splitter|divider|layout)/i.test(hay) && !/(search|query|find)/i.test(hay);
        if (hasLayoutFlag) score -= 220;

        if (el.type === 'search-input') score += 80;
        if (el.type === 'text-input') score += 20;
        if (/(search|query|find|what do you want to play|play)/i.test(hay)) score += 45;

        for (const w of words) {
            if (hay.includes(w)) score += 8;
        }

        return { el, score };
    }).sort((a, b) => b.score - a.score);

    const best = scored[0];
    if (!best || best.score < 0) return undefined;
    return best.el;
}

// ─── Phase 2: Plan Actions from Intent + Snapshot ────────────────────────────

export async function planPageActions(
    intent: ParsedIntent,
    snapshot: BrowserSnapshot,
    originalQuery: string,
    executedActions?: Array<{ label: string; action: string; elementIdx?: number }>,
    webContext?: string,    // optional: pre-fetched documentation/web search result
    stateFeedback?: string, // optional: feedback if the last action failed to change state
    screenshot?: string,    // optional: JPEG screenshot for visual page context
): Promise<PlannedAction[]> {

    const activePage = snapshot.activeTab;

    if (!activePage.interactiveElements.length && snapshot.tabs.length <= 1) {
        console.log('[PageIntelligence] No interactive elements and no other tabs');
        return [];
    }

    // Build element list for LLM — smart filtering based on task type
    // For navigation: prioritize nav/button/link elements
    // For all tasks: include all elements but mark categories to help LLM focus
    const isNavTask = intent.taskType === 'navigation';
    const isFormTask = intent.taskType === 'form_fill';
    
    let relevantElements = activePage.interactiveElements;
    
    if (isNavTask && activePage.interactiveElements.length > 80) {
        // Only filter aggressively if we have too many elements
        relevantElements = activePage.interactiveElements.filter(el =>
            ['button', 'link', 'select', 'dialog-control', 'image-button', 'text-input', 'custom-option'].includes(el.type) ||
            (el.role && ['navigation', 'sort', 'search'].includes(el.role)) ||
            el.label.toLowerCase().includes('menu') ||
            el.label.toLowerCase().includes('nav') ||
            el.label.toLowerCase().includes('setting') ||
            el.label.toLowerCase().includes('config') ||
            el.label.toLowerCase().includes('plugin') ||
            el.label.toLowerCase().includes('action') ||
            el.label.toLowerCase().includes('manage') ||
            el.label.toLowerCase().includes('profile') ||
            el.label.toLowerCase().includes('search') ||
            el.label.toLowerCase().includes('sign') ||
            el.label.toLowerCase().includes('log') ||
            el.label.toLowerCase().includes('accept') ||
            el.label.toLowerCase().includes('close') ||
            el.label.toLowerCase().includes('dismiss') ||
            el.label.toLowerCase().includes('play') ||
            el.label.toLowerCase().includes('watch') ||
            el.label.toLowerCase().includes('continue')
        );
    }

    // Fall back to all elements if filtering is too aggressive
    let elementsToUse = relevantElements.length >= 2 ? relevantElements : activePage.interactiveElements;

    // ── Hard token cap
    // Since we fixed the 413 screenshot payload issue, we can safely allow up to 120 elements.
    // 120 elements * ~70 chars = ~8.4k chars ≈ 2k tokens, well within any modern LLM's 8k+ window.
    const ELEMENT_CAP = 120;
    if (elementsToUse.length > ELEMENT_CAP) {
        // priority 0: elements matching the search query (highest priority!)
        const queryTerms = intent.searchQuery ? intent.searchQuery.toLowerCase().trim().split(/\s+/) : [];
        const p0 = elementsToUse.filter(el => 
            queryTerms.length > 0 && queryTerms.every(term => 
                el.label.toLowerCase().includes(term) || (el.context && el.context.toLowerCase().includes(term))
            )
        );
        
        // priority 1: search / text inputs
        const p1 = elementsToUse.filter(el => !p0.includes(el) && (['text-input', 'search-input'].includes(el.type) || /search|query/i.test(el.label)));
        
        // priority 2: buttons and links
        const p2 = elementsToUse.filter(el => !p0.includes(el) && !p1.includes(el) && ['button', 'link', 'image-button', 'custom-option'].includes(el.type));
        
        // priority 3: everything else (in original DOM order)
        const p3 = elementsToUse.filter(el => !p0.includes(el) && !p1.includes(el) && !p2.includes(el));
        
        elementsToUse = [...p0, ...p1, ...p2, ...p3].slice(0, ELEMENT_CAP);
    }

    const elementList = elementsToUse.map(el =>
        `[${el.idx}] ${el.type} | "${el.label}"${el.context ? ` | context:"${el.context}"` : ''}${el.section ? ` (in: ${el.section})` : ''}${el.role ? ` | role:${el.role}` : ''}${el.value ? ` | current:"${el.value}"` : ''}${el.options ? ` | options:[${el.options.slice(0, 5).join(', ')}]` : ''}${el.min !== undefined ? ` | range:${el.min}-${el.max}` : ''} | selector:${el.selector}`
    ).join('\n');

    const intentParts = [
        `Task type: ${intent.taskType}`,
        intent.budget ? `Budget: max ${intent.budget.currency} ${intent.budget.max.toLocaleString()}` : null,
        intent.sortBy ? `Sort by: ${intent.sortBy}` : null,
        ...intent.filters.map(f => `Filter "${f.dimension}" = "${f.value}"`),
        intent.searchQuery ? `🎯 SEARCH TARGET: "${intent.searchQuery}" — this is what we need to find/play/buy on this site` : null,
        intent.targetSite ? `Site: ${intent.targetSite}` : null,
    ].filter(Boolean).join('\n');

    // ── Vision: Analyze screenshot for visual page state ──────────────────────
    // Called on the FIRST round (no executedActions) and on PAGE TRANSITIONS
    // (URL changed / SPA navigation) so the planner can see what the page looks
    // like visually — not just what the DOM text says.
    let visualContextSection = '';
    if (screenshot) {
        const isPageTransition = !!stateFeedback && (
            stateFeedback.includes('URL changed') ||
            stateFeedback.includes('new screen') ||
            stateFeedback.includes('content changed') ||
            stateFeedback.includes('SPA navigation')
        );
        const isFirstRound = !executedActions?.length;
        if (isFirstRound || isPageTransition) {
            const visionStart = Date.now();
            
            // OPTIMIZATION: Run both vision calls in PARALLEL instead of sequentially
            // analyzeScreen and identifyElements are independent - no need to wait for one before starting the other
            try {
                const [visual, visionMap] = await Promise.all([
                    analyzeScreen(screenshot, originalQuery).catch(err => {
                        console.warn('[PageIntelligence] analyzeScreen failed:', err.message);
                        return null;
                    }),
                    identifyElements(
                        screenshot,
                        elementsToUse.slice(0, 30).map(e => ({ idx: e.idx, type: e.type, label: e.label })),
                        originalQuery,
                    ).catch(err => {
                        console.warn('[PageIntelligence] identifyElements failed:', err.message);
                        return [];
                    }),
                ]);
                
                const visionDuration = Date.now() - visionStart;
                const logEntry = JSON.stringify({location:'pageIntelligence.ts:vision', timestamp: new Date().toISOString(), event: 'vision_parallel', duration_ms: visionDuration, analyzeScreen: !!visual, identifyElements: visionMap?.length ?? 0});
                console.log(`[PERF] ${logEntry}`);
                
                if (visual) {
                    visualContextSection = [
                        '\nVISUAL PAGE ANALYSIS (from screenshot — what the page LOOKS like):',
                        `- Page type: ${visual.pageType}`,
                        `- Visual description: ${visual.mainContentDescription}`,
                        `- Suggested action: ${visual.suggestedAction}`,
                        `- Has search box: ${visual.hasSearchBox}`,
                        visual.searchInputHint ? `- Search input hint: ${visual.searchInputHint}` : '',
                        visual.uiElements.length
                            ? `- Key UI elements seen:\n${visual.uiElements.slice(0, 5).map(e => `    [${e.type}] ${e.description}`).join('\n')}`
                            : '',
                    ].filter(Boolean).join('\n') + '\n';
                }
                
                // Process element mapping results
                if (visionMap && visionMap.length > 0) {
                    const hints = visionMap
                        .filter(v => v.confidence >= 60)
                        .map(v => `  idx:${v.domIdx} → ${v.visualRole}`)
                        .join('\n');
                    if (hints) {
                        visualContextSection += `\nVISION ELEMENT MAP (what Vision actually sees on screen):\n${hints}\n` +
                            `→ Use these visual descriptions to pick the CORRECT elementIdx for each step.\n`;
                    }
                }
            } catch (err) {
                // Vision failure is non-fatal — DOM snapshot is still the primary source
                console.warn('[PageIntelligence] Vision analysis skipped:', (err as Error).message);
            }
        }
    }

    const recentExecutedActions = executedActions?.slice(-18);
    const historySection = recentExecutedActions?.length
        ? `\nACTIONS ALREADY EXECUTED (DO NOT REPEAT):\n${recentExecutedActions.map((a, i) => {
            const status = (a as any).failed ? '❌ FAILED' : '✅ OK';
            const reason = (a as any).failReason ? ` — reason: ${(a as any).failReason}` : '';
            return `  ${i + 1}. [${status}] ${a.action}: ${a.label}${reason}`;
        }).join('\n')}\n→ Plan only the NEXT steps toward the goal. Learn from failures — try different elements or approaches.`
        : '';

    const webContextSection = webContext
        ? `\nWEB DOCUMENTATION / RESEARCH (use this as navigation guide):\n${webContext.slice(0, 1200)}`
        : '';

    const stateFeedbackSection = stateFeedback
        ? `\n🚨 SYSTEM FEEDBACK (CRITICAL) 🚨\n${stateFeedback}\n`
        : '';

    // ── Stuck-click detection ─────────────────────────────────────────────────
    // If the last 2+ executed actions were identical clicks on the same elementIdx
    // and the page didn't change, inject a specific override hint so the LLM
    // stops repeating the click and moves to type instead.
    let stuckClickHint = '';
    if (executedActions && executedActions.length >= 2) {
        const lastTwo = executedActions.slice(-2);
        const allSameClick = lastTwo.every(a =>
            a.action === 'click' &&
            a.elementIdx !== undefined &&
            a.elementIdx === lastTwo[0].elementIdx
        );
        if (allSameClick) {
            const stuckIdx = lastTwo[0].elementIdx!;
            const stuckEl = activePage.interactiveElements.find(e => e.idx === stuckIdx);
            const isInput = stuckEl && ['text-input', 'search-input', 'input'].includes(stuckEl.type);
            stuckClickHint = isInput
                ? `\n⛔ STUCK LOOP DETECTED: You clicked elementIdx ${stuckIdx} ("${stuckEl?.label}") ${lastTwo.length}+ times with no page change.` +
                  `\n→ This is a text input. STOP clicking it. Use 'type' directly: action: type | elementIdx: ${stuckIdx} | value: ${intent.searchQuery ?? 'your search query'}` +
                  `\n→ Then in the SAME round add the search submit button click.\n`
                : `\n⛔ STUCK LOOP DETECTED: You clicked elementIdx ${stuckIdx} ${lastTwo.length}+ times with no change. Try a completely different element or approach.\n`;
        }
    }

    const browserContextSection = `
BROWSER STATE:
- Active Tab URL: ${activePage.url}
- Active Tab Title: ${activePage.title}

OPEN TABS:
${snapshot.tabs.map((t, i) => `[TabID:${t.tabId}] ${t.title} (${t.url})${t.active ? ' (ACTIVE)' : ''}`).join('\n')}
`;

    // Inject stuckClickHint directly into stateFeedbackSection so it appears
    // prominently near the top of the system prompt where models pay most attention
    const fullStateFeedback = stuckClickHint
        ? `\n🚨 SYSTEM FEEDBACK (CRITICAL) 🚨\n${stuckClickHint}${stateFeedback ? stateFeedback + '\n' : ''}`
        : stateFeedbackSection;

    const systemPrompt = `You are NEXUS, a live browser automation agent that operates CONVERSATIONALLY.
Plan EXACT browser actions to fulfill the user's request.

USER QUERY: "${originalQuery}"

INTENT:
${intentParts}
${historySection}
${webContextSection}
${visualContextSection}
${fullStateFeedback}
${browserContextSection}

VISIBLE TEXT (excerpt — use this to understand the current screen state):
${activePage.visibleText.slice(0, 800)}

INTERACTIVE ELEMENTS (Active Tab) — use ONLY these [idx] values for DOM clicks/typing:
${elementList}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

INTERMEDIATE UI STATE DETECTION — CRITICAL:
Before planning actions, first classify the current screen:

🔹 COOKIE/CONSENT BANNER: If you see "Accept cookies", "Accept all", "I agree", "Got it", or GDPR-related banners:
   → AUTO-DISMISS: Click the accept/agree/dismiss button. Do NOT ask the user.

🔹 PROFILE SELECTION: If the page shows profile avatars/names (e.g., Netflix "Who's watching?", Disney+ profiles):
   → You MUST emit exactly one ask_user action. Use the profile labels from INTERACTIVE ELEMENTS as options.
   → Example: action: ask_user | value: Which profile do you want to use? | label: Profile selection | options: Saikumar, Itachi, Children, Manage Profiles | category: profile_select
   → Do NOT click a profile yourself — always ask_user first so the pipeline can auto-click the user's choice.

🔹 LOGIN REQUIRED: If the page shows a login form, "Sign in", "Log in" screen that blocks progress:
   → ASK USER: Tell the user they need to log in. ASTRA will resume after they do.
   → category: login_required

🔹 CAPTCHA: If the page shows a CAPTCHA, reCAPTCHA, "I'm not a robot":
   → ASK USER: Inform the user. ASTRA cannot bypass CAPTCHAs.
   → category: captcha

🔹 AGE VERIFICATION: If the page asks for age or date of birth verification:
   → ASK USER: Ask the user to confirm or provide their info.
   → category: age_verify

🔹 "ARE YOU STILL THERE?" / SESSION TIMEOUT: Idle prompts or "Continue watching?":
   → AUTO-DISMISS: Click the continue/resume button.

🔹 DISAMBIGUATION (STRICT — CRITICAL FOR MUSIC/VIDEO TASKS): 
   If the page shows MULTIPLE search results (songs, videos, products) with similar names:
   → DO NOT auto-click the first result!
   → You MUST emit ask_user so the user can choose which one they want.
   → Look at the INTERACTIVE ELEMENTS list for items matching the search query.
   → action: ask_user | value: I found multiple results for "${intent.searchQuery || originalQuery}". Which one should I play? | label: Choose result | options: [first 3-5 matching item labels from the page] | category: disambiguation
   → EXAMPLE for "play blinding lights": If you see multiple items with "Blinding Lights" or similar, ask:
      action: ask_user | value: I found multiple songs matching "blinding lights". Which one should I play? | label: Song selection | options: Blinding Lights - The Weeknd, Blinding Lights (Original), Blinding Lights - Live Version, ... | category: disambiguation

🔹 POPUP/MODAL/OVERLAY: App install prompts, notification permission dialogs, survey popups:
   → AUTO-DISMISS: Click close/dismiss/skip/no thanks. Do NOT ask the user.

🔹 NORMAL PAGE: The page is directly relevant to the goal:
   → Proceed with normal action planning.

🔹 TASK COMPLETE: If the user's goal is fully achieved (e.g., song is actively playing, purchase confirmed) AND you have no further actions to take:
   → You MUST emit a special action: action: task_complete | reason: Goal achieved. Song is playing.
   → This tells the system to terminate instantly instead of waiting to retry.

🔹 LOADING/SPINNER: If the page shows a loading indicator, spinner, or "Please wait":
   → Use action: wait | value: 2000 | reason: Page is still loading
   → The pipeline will re-snapshot after waiting.

🔹 ERROR/404 PAGE: If the page shows "Page not found", "Something went wrong", or similar errors:
   → Try navigating back or to the correct URL. If you can't determine the URL, ask the user.

🔹 SEARCH RESULTS PAGE (CRITICAL — ALWAYS CHECK FOR DISAMBIGUATION FIRST):
   If the page shows search results and you need to find a specific item:
   → FIRST: Check if there are MULTIPLE items that could match the user's request.
   → If YES → Use ask_user with disambiguation category and options from the page.
   → If there's only ONE clear match → Click that result.

CONFIDENCE GATE — CRITICAL RULES:
1. ⛔ ONLY plan an action if you are CONFIDENT it moves toward the user's goal.
2. ⛔ If you see checkboxes, column headers, or form fields unrelated to the goal — SKIP THEM.
3. ⛔ For navigation: only click menus, navigation buttons, or links that plausibly lead to the target screen.
4. ✅ If you are BLOCKED and cannot proceed without user input, emit an ask_user action (NEVER return empty actions silently).
5. ✅ Multi-step is fine: click a menu → next round will show the opened dropdown.
6. ⛔ NEVER guess random clicks just to "do something" — wrong actions make things worse.
7. ⛔ Do NOT repeat actions that are already in the "EXECUTED" list above.
8. 🌐 BROWSER ACTIONS: You can use browser-level actions to navigate the web:
   - action: new_tab | value: https://example.com | reason: Searching for guide
   - action: switch_tab | elementIdx: <TabID> | reason: Going back to original tab
   - action: close_tab | elementIdx: <TabID> | reason: Done reading
   - action: navigate | value: https://example.com | reason: Going directly to URL
9. 🗣️ ASK USER: When you need user input to continue (profile selection, disambiguation, login):
   - action: ask_user | value: <question to ask> | label: <short description> | reason: <why you need input> | options: <comma-separated list of choices> | category: <profile_select|login_required|cookie_consent|captcha|age_verify|disambiguation|general>
   - The pipeline will PAUSE and show the question to the user, then RESUME with their answer.

OUTPUT FORMAT — You MUST output a [REASONING] block first, then an [ACTIONS] block.

ACTION LINE RULES (strict):
- For click, type, select-option: you MUST include elementIdx: N where N is one of the [idx] values from INTERACTIVE ELEMENTS above. One action per line in pipe format.
- For ask_user: include value (question), label, options (comma-separated from the page), category.
- If the EXECUTED list shows a click on elementIdx X that failed or did not change the page: do NOT repeat the same elementIdx for the same action. Either use ask_user (e.g. for profile choice) or pick a different elementIdx.

MULTI-STEP PATTERNS (you can output multiple actions per round):
- SEARCH ON A SITE — CRITICAL RULES:
  1. NEVER click a text-input/search-input element just to "focus" it — it wastes a round.
     The first action on a search input must ALWAYS be 'type', not 'click'.
  2. If the user intent includes an explicit 'searchQuery' (e.g. they want to find/play a specific item):
     → If ANY text-input or search-input is VISIBLE (even if its label is "What do you want to play?"): Go straight to: action: type | elementIdx: N | value: <query>
  3. AUTOCOMPLETE / COMBOBOX DROPDOWNS (like Spotify or YouTube search):
     → DO NOT append \\n to your type value.
     → Type the text and WAIT for the next round. 
     → In the next round, the autocomplete dropdown will appear. You MUST then click the correct suggestion from the dropdown instead of pressing Enter.
  4. If NO autocomplete is expected (simple forms):
     → Append \\n to the value (e.g. value: <query>\\n) to automatically press Enter.
  5. CRITICAL: NEVER click a "Search" button/icon if a text-input element is already on the page! ONLY click a search icon if there are ZERO text-inputs visible.
     If a text-input exists (e.g. labeled "What do you want to play?"), that IS the search box. Type into it directly.
- Fill form + submit: type into fields → then click submit button. These CAN be in the same round, or you can just use \\n on the last field.
- Navigate menus: click menu → next round shows dropdown → click item. One step per round.

IMPORTANT: Each round you only see the CURRENT page elements. If an element you need (like a search input)
is not in the list, you may need to click a button to reveal it first. Plan only what's possible NOW.

[REASONING]
1. Goal: Describe the ultimate user request and final desired state.
2. Screen State: What kind of screen is this? (normal / cookie banner / profile select / login wall / etc.)
3. Context: What has been done so far? Did previous actions succeed or FAIL? What failed and why?
4. Strategy: Based on goal + screen state + history — what's the optimal next action? Consider alternatives.
5. Risk Assessment: What could go wrong? Is there a safer alternative? What if this action doesn't change the page?
[/REASONING]

[ACTIONS]
action: click | elementIdx: 3 | label: Open Navigator Menu | reason: It opens the navigation panel
[/ACTIONS]
(Use exactly one line per action. For click/type always include elementIdx from the element list.)

[NOTES]
Explain anything unclear. If you asked the user something, explain the context.
[/NOTES]

If no confident action exists AND no user question is needed → return [REASONING]...[/REASONING][ACTIONS][/ACTIONS] with explanation in [NOTES].
PREFER asking the user over returning empty actions — an engaged agent is better than a silent failure.`;

    const round = executedActions?.length
        ? `Continuation (${executedActions.length} actions done)`
        : 'Initial plan';
    const response = await chat(
        systemPrompt,
        `${round} for: "${originalQuery}"\nActive Tab: ${activePage.title} (${elementsToUse.length} relevant elements shown)`,
        'planning'
    );

    console.log('[PageIntelligence] LLM action plan:\n', response.substring(0, 1000));

    // Strip <think> blocks (some models emit them); keep [REASONING]/[ACTIONS]/[NOTES]
    let cleaned = response.replace(/<think>[\s\S]*?<\/think>\s*/gi, '');
    const unclosedThink = cleaned.search(/<think>/i);
    if (unclosedThink >= 0) {
        const after = cleaned.slice(unclosedThink);
        const nextBlock = after.search(/\n\s*\[(REASONING|ACTIONS|NOTES)\]/i);
        cleaned = (nextBlock >= 0 ? cleaned.slice(0, unclosedThink) + after.slice(nextBlock) : cleaned.slice(0, unclosedThink)).trim();
    }
    const parsed = parseToonActions(cleaned);

    // Validate by elementIdx — always use ground-truth selector from snapshot
    const elementByIdx = new Map(activePage.interactiveElements.map(e => [e.idx, e]));
    const validated: PlannedAction[] = [];

    for (const a of parsed) {
        if (a.action === undefined) continue;

        // Only reject duplicates for CLICK actions — repeating the same click on the same element
        // on the same page is a loop. type/select are excluded: the same element can be typed
        // into again (e.g. correcting text, or after a failed no-value type).
        // elementIdx === undefined on an exec means it was on a PREVIOUS page (extension strips
        // old indices on navigation), so those don't block current-page actions.
        if (a.action === 'click' && a.elementIdx !== undefined && executedActions?.some(exec =>
            exec.elementIdx !== undefined && exec.elementIdx === a.elementIdx && exec.action === 'click'
        )) {
            console.warn(`[PageIntelligence] ⚠ Rejecting duplicate click on elementIdx ${a.elementIdx} which was already executed.`);
            continue;
        }

        // Reject 'type' actions with no value — a type with no text executes as a no-op
        // and then blocks future type retries via the dedup guard.
        if (a.action === 'type' && (!a.value || !a.value.trim())) {
            console.warn(`[PageIntelligence] ⚠ Rejecting type action on elementIdx ${a.elementIdx} — missing value (no text to type)`);
            continue;
        }

        // press_enter — submits the focused element (no separate element lookup needed)
        if (a.action === 'press_enter') {
            const sourceEl = a.elementIdx !== undefined ? elementByIdx.get(a.elementIdx) : undefined;
            validated.push({
                action: 'press_enter',
                selector: sourceEl?.selector ?? a.selector ?? '',
                value: undefined,
                label: a.label || 'Press Enter to submit',
                reason: a.reason || 'Submit current input',
                elementIdx: a.elementIdx,
            });
            continue;
        }

        // Handle ask_user actions — conversational follow-up, no DOM element needed
        if (a.action === 'ask_user') {
            if (!a.value) {
                console.warn(`[PageIntelligence] ⚠ ask_user action missing 'value' (question text)`);
                continue;
            }
            validated.push({
                action: 'ask_user',
                selector: '',
                value: a.value,
                label: a.label || 'Waiting for your input',
                reason: a.reason || '',
                options: a.options,
                category: a.category || 'general',
            });
            continue;
        }

        // Handle explicit task completion signal.
        // This allows the extension loop to terminate immediately when the goal is achieved.
        if (a.action === 'task_complete') {
            validated.push({
                action: 'task_complete',
                selector: '',
                label: a.label || 'Task complete',
                reason: a.reason || a.value || 'Goal achieved.',
            });
            continue;
        }

        // Handle wait/scroll — no DOM element needed, value carries duration/direction
        if (a.action === 'wait' || a.action === 'scroll') {
            validated.push({
                action: a.action,
                selector: a.selector || '',
                value: a.value,
                label: a.label || (a.action === 'wait' ? 'Wait for page to settle' : 'Scroll page'),
                reason: a.reason || '',
                elementIdx: a.elementIdx,
            });
            continue;
        }

        // Handle Browser-level actions first (they don't need DOM elements)
        if (['new_tab', 'navigate'].includes(a.action)) {
            if (!a.value || !a.value.trim().toLowerCase().startsWith('http')) {
                console.warn(`[PageIntelligence] ⚠ Action ${a.action} has invalid/missing URL: "${a.value}" — skipping`);
                continue;
            }
            // Reject same-URL navigates — they loop the agent back to the current page with no progress
            const currentUrl = snapshot.activeTab.url?.trim().replace(/\/$/, '');
            const targetUrl = a.value.trim().replace(/\/$/, '');
            if (currentUrl && targetUrl === currentUrl) {
                console.warn(`[PageIntelligence] ⚠ Skipping navigate to current URL (${targetUrl}) — no-op`);
                continue;
            }
            validated.push({
                action: a.action,
                selector: '',
                value: a.value,
                label: a.label || `Navigate to ${a.value}`,
                reason: a.reason || '',
                elementIdx: undefined
            });
            continue;
        }

        if (['switch_tab', 'close_tab'].includes(a.action)) {
            if (a.elementIdx === undefined || !snapshot.tabs.find(t => t.tabId === a.elementIdx)) {
                console.warn(`[PageIntelligence] ⚠ Action ${a.action} provided invalid tabId: ${a.elementIdx}`);
                continue;
            }
            validated.push({
                action: a.action,
                selector: '',
                label: a.label || `${a.action} ${a.elementIdx}`,
                reason: a.reason || '',
                elementIdx: a.elementIdx,
            });
            continue;
        }

        // Handle DOM-level actions
        if (a.elementIdx === undefined) {
            console.warn(`[PageIntelligence] ⚠ Action ${a.action} missing elementIdx`);
            continue;
        }

        const el = elementByIdx.get(a.elementIdx);
        if (!el) {
            console.warn(`[PageIntelligence] ⚠ elementIdx ${a.elementIdx} not in snapshot — rejected`);
            continue;
        }

        // Guard rail: never type into non-text elements (e.g., search icon button).
        // Auto-correct to the best text input when possible.
        if (a.action === 'type') {
            const elText = `${el.label || ''} ${el.selector || ''} ${el.context || ''}`.toLowerCase();
            const looksLikeLayoutControl = /(resizer|splitter|divider|layout)/i.test(elText) && !/(search|query|find)/i.test(elText);
            const isTypeTarget = isTextEntryElementType(el.type);

            if (!isTypeTarget || looksLikeLayoutControl) {
                const fallbackTarget = findBestTextInputElement(
                    activePage.interactiveElements,
                    a.value || intent.searchQuery || originalQuery,
                );

                if (fallbackTarget && fallbackTarget.idx !== el.idx) {
                    console.warn(
                        `[PageIntelligence] Auto-corrected type target: idx ${el.idx} (${el.type}:${el.label}) -> idx ${fallbackTarget.idx} (${fallbackTarget.type}:${fallbackTarget.label})`,
                    );
                    validated.push({
                        action: 'type',
                        selector: fallbackTarget.selector,
                        elementIdx: fallbackTarget.idx,
                        value: a.value,
                        label: fallbackTarget.label,
                        reason: `${a.reason || ''}${a.reason ? ' | ' : ''}Auto-corrected to visible text input`,
                    });
                    continue;
                }

                console.warn(`[PageIntelligence] ⚠ Rejecting type action on non-text elementIdx ${el.idx} (${el.type}:${el.label})`);
                continue;
            }
        }

        validated.push({
            action: a.action as PlannedAction['action'],
            selector: el.selector,  // always ground-truth, never LLM's selector string
            elementIdx: a.elementIdx,
            value: a.value,
            label: a.label || el.label,
            reason: a.reason || '',
        });
    }

    // Extract and log the NOTES so we can surface them to the user
    const notes = response.match(/\[NOTES\]([\s\S]*?)\[\/NOTES\]/i)?.[1]?.trim();
    if (notes) console.log('[PageIntelligence] Notes:', notes);

    // Fallback: when LLM produced 0 valid actions, suggest ask_user (profile) or click (cookie)
    if (validated.length === 0) {
        const fallbackAsk = suggestFallbackAskUser(activePage);
        if (fallbackAsk) {
            console.log('[PageIntelligence] 0 actions validated — using fallback ask_user for profile screen');
            return [fallbackAsk];
        }
        const fallbackClick = suggestFallbackCookieClick(activePage);
        if (fallbackClick) {
            console.log('[PageIntelligence] 0 actions validated — using fallback click for cookie/consent');
            return [fallbackClick];
        }
    }

    // ─── Disambiguation Fallback ───────────────────────────────────────────────
    // If the LLM clicked on a search result directly without asking the user,
    // and there are MULTIPLE results matching the query, force ask_user instead.
    // This handles music/video sites where "play X" returns multiple versions.
    const searchQueryLower = (intent.searchQuery || originalQuery).toLowerCase();
    const queryWords = searchQueryLower.split(/\s+/).filter(w => w.length > 2);
    const isContinuationRound = executedActions && executedActions.length > 0;
    
    // Find all elements that could be search results matching the query
    const matchingResults: Array<{ el: typeof activePage.interactiveElements[0]; score: number }> = [];
    for (const el of activePage.interactiveElements) {
        if (!['link', 'button', 'custom-option', 'image-button'].includes(el.type)) continue;
        const label = (el.label || '').toLowerCase();
        
        // Score based on how many query words match
        const matchCount = queryWords.filter(w => label.includes(w)).length;
        if (matchCount >= Math.min(2, queryWords.length)) {
            matchingResults.push({ el, score: matchCount });
        }
    }
    
    // Sort by score descending
    matchingResults.sort((a, b) => b.score - a.score);
    
    // If there are 2+ high-scoring matches AND the LLM is about to click one of them,
    // intercept with ask_user for disambiguation
    const topMatches = matchingResults.slice(0, 5);
    const hasDisambiguationAction = validated.some(a => a.action === 'ask_user' && a.category === 'disambiguation');
    const aboutToClickResult = validated.some(a => 
        a.action === 'click' && 
        topMatches.some(m => m.el.idx === a.elementIdx)
    );
    
    // Only trigger on FIRST round (before any actions executed) to avoid blocking
    // when user has already made their choice
    if (topMatches.length >= 2 && !hasDisambiguationAction && aboutToClickResult && !isContinuationRound) {
        const options = topMatches
            .map(m => m.el.label?.trim())
            .filter(Boolean)
            .slice(0, 5) as string[];
        
        if (options.length >= 2) {
            console.log(`[PageIntelligence] 🎯 Disambiguation fallback triggered: ${topMatches.length} matches for "${searchQueryLower}"`);
            console.log(`[DEBUG|PageIntelligence] Options: ${options.join(', ')}`);
            // Remove any click actions on matching results — we'll ask instead
            const filtered = validated.filter(a => 
                !(a.action === 'click' && topMatches.some(m => m.el.idx === a.elementIdx))
            );
            filtered.unshift({
                action: 'ask_user',
                selector: '',
                value: `I found ${options.length} results matching "${intent.searchQuery || originalQuery}". Which one do you want?`,
                label: 'Choose result',
                reason: 'Multiple search results match your query',
                options,
                category: 'disambiguation',
            });
            return filtered;
        }
    }

    console.log(`[PageIntelligence] ${validated.length}/${parsed.length} actions validated`);
    return validated;
}

/**
 * When the LLM returns no valid actions, detect profile selection or similar screens
 * and return a synthetic ask_user so the pipeline can still advance (user picks option → auto-click).
 */
function suggestFallbackAskUser(activePage: BrowserSnapshot['activeTab']): PlannedAction | null {
    const text = (activePage.visibleText || '').toLowerCase();
    const title = (activePage.title || '').toLowerCase();
    const elements = activePage.interactiveElements || [];

    // Profile selection: "Who's watching?", "Select profile", Netflix/Disney+ style
    const looksLikeProfile =
        /\bwho'?s\s+watching\b|\bselect\s+profile\b|\bchoose\s+profile\b|\bmanage\s+profile/i.test(text) ||
        /\bwho'?s\s+watching\b|\bprofile\b/.test(title) ||
        (elements.length >= 2 && elements.length <= 12 && elements.some(el =>
            ['link', 'button', 'image-button'].includes(el.type) && el.label && el.label.length < 40 && !/accept|agree|cookie|sign\s*in|log\s*in/i.test(el.label)
        ));

    if (looksLikeProfile && elements.length >= 1) {
        const options = elements
            .filter(el => el.label && el.label.trim().length > 0 && el.label.length < 50)
            .slice(0, 10)
            .map(el => el.label!.trim());
        if (options.length >= 1) {
            return {
                action: 'ask_user',
                selector: '',
                value: "Which profile do you want to use?",
                label: 'Profile selection',
                reason: 'Page appears to be profile selection; no valid action was produced.',
                options: options.length > 1 ? options : undefined,
                category: 'profile_select',
            };
        }
    }

    return null;
}

/**
 * When the LLM returns no valid actions and the page looks like a cookie/consent banner,
 * return a single click action on the first Accept/Agree/Allow button so the pipeline can dismiss it.
 */
function suggestFallbackCookieClick(activePage: BrowserSnapshot['activeTab']): PlannedAction | null {
    const text = (activePage.visibleText || '').toLowerCase();
    const hasConsentBanner = /\bcookie\b|accept\s*all|accept\s*cookies|i\s*agree|got\s*it|allow\s*all|consent|gdpr|privacy\s*notice/i.test(text);
    if (!hasConsentBanner) return null;

    const acceptLike = /^(accept|agree|allow\s*all|got\s*it|ok|continue|dismiss|allow|i\s*agree)$/i;
    for (const el of activePage.interactiveElements || []) {
        const label = (el.label || '').trim();
        if (label && acceptLike.test(label) && ['button', 'link', 'image-button'].includes(el.type)) {
            return {
                action: 'click',
                selector: el.selector,
                elementIdx: el.idx,
                label: `Dismiss: ${el.label}`,
                reason: 'Cookie/consent banner detected; clicking accept to continue.',
            };
        }
    }
    return null;
}

// ─── Budget post-filter ───────────────────────────────────────────────────────

export function enforcebudgetOnResults<T extends { price?: string; title?: string }>(
    results: T[],
    budget: ParsedIntent['budget'],
): T[] {
    if (!budget) return results;
    return results.filter(r => {
        if (!r.price) return true;
        const price = parseFloat(r.price.replace(/[^\d.]/g, ''));
        if (isNaN(price)) return true;
        const passes = price <= budget.max;
        if (!passes) console.log(`[PageIntelligence] Excluded "${r.title?.slice(0, 30)}" — ${price} > ${budget.max}`);
        return passes;
    });
}
