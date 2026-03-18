import { chatVision, chat } from '../services/llm.js';

// ─── Vision Agent ───
// Provides two capabilities:
// 1. screenAnalysis — "What is on this screen? What can I interact with?"
// 2. resultsAnalysis — "What results appeared after an action?"

export interface ScreenAnalysis {
    pageType: 'search-engine' | 'content-site' | 'ecommerce' | 'social' | 'news' | 'dashboard' | 'form' | 'generic';
    hasSearchBox: boolean;
    hasForms: boolean;
    mainContentDescription: string;
    suggestedAction: 'search' | 'extract' | 'scroll' | 'click' | 'fill-form' | 'read';
    uiElements: Array<{
        type: 'search-input' | 'button' | 'form' | 'list' | 'article' | 'nav' | 'other';
        description: string;
        likelySelector?: string;
    }>;
    searchInputHint?: string; // e.g. "search bar at top center with placeholder 'Search Reddit'"
}

export interface ResultsAnalysis {
    summary: string;
    topResults: Array<{
        title: string;
        description?: string;
        url?: string;
        score?: string;
        rank: number;
    }>;
    totalResultsFound: number;
}

// ─── 1. Screen Analysis ───
// Takes a screenshot and returns structured info about the page state.
// Used BEFORE executing any action to understand what's on screen.
export async function analyzeScreen(
    screenshot: string,
    userQuery: string,
): Promise<ScreenAnalysis> {
    const systemPrompt = `You are ASTRA's Vision Agent. You analyze browser screenshots to understand page state and identify interactive elements.

Given a screenshot of a web page and a user's query, you must return a TOON object describing:
1. What TYPE of page this is
2. What UI ELEMENTS are visible and interactable
3. Limit the extracted UI elements to a MAXIMUM of 10 items to save tokens.
3. What ACTION would best fulfill the user's query

OUTPUT FORMAT — TOON only (Token-Oriented Object Notation):
Do not use JSON formatting. Use this exact line-by-line format:
pageType: search-engine|content-site|ecommerce|social|news|dashboard|form|generic
hasSearchBox: true/false
hasForms: true/false
mainContentDescription: brief description of what's on screen
suggestedAction: search|extract|scroll|click|fill-form|read
searchInputHint: visual description of the search box if found

[UI_ELEMENTS]
type:search-input | description:search bar at top | likelySelector:#search
type:button | description:login button | likelySelector:.login-btn
[/UI_ELEMENTS]`;

    try {
        const response = await chatVision(
            systemPrompt,
            `User wants to: "${userQuery}"\n\nAnalyze this screenshot and return the TOON output.`,
            screenshot,
        );

        const result: ScreenAnalysis = {
            pageType: 'generic',
            hasSearchBox: false,
            hasForms: false,
            mainContentDescription: '',
            suggestedAction: 'search',
            uiElements: [],
        };

        const lines = response.split('\n').map(l => l.trim()).filter(Boolean);
        let inElements = false;

        for (const line of lines) {
            if (line.toUpperCase() === '[UI_ELEMENTS]') { inElements = true; continue; }
            if (line.toUpperCase() === '[/UI_ELEMENTS]') { inElements = false; continue; }

            if (inElements) {
                const parts = line.split('|').map(p => p.trim());
                let type: any = 'other', desc = '', sel = '';
                for (const p of parts) {
                    if (p.toLowerCase().startsWith('type:')) type = p.substring(5).trim();
                    else if (p.toLowerCase().startsWith('description:')) desc = p.substring(12).trim();
                    else if (p.toLowerCase().startsWith('likelyselector:')) sel = p.substring(15).trim();
                }
                if (desc) {
                    result.uiElements.push({ type, description: desc, likelySelector: sel || undefined });
                }
            } else {
                if (line.toLowerCase().startsWith('pagetype:')) result.pageType = line.substring(9).trim() as any;
                else if (line.toLowerCase().startsWith('hassearchbox:')) result.hasSearchBox = line.substring(13).trim().toLowerCase() === 'true';
                else if (line.toLowerCase().startsWith('hasforms:')) result.hasForms = line.substring(9).trim().toLowerCase() === 'true';
                else if (line.toLowerCase().startsWith('maincontentdescription:')) result.mainContentDescription = line.substring(23).trim();
                else if (line.toLowerCase().startsWith('suggestedaction:')) result.suggestedAction = line.substring(16).trim() as any;
                else if (line.toLowerCase().startsWith('searchinputhint:')) result.searchInputHint = line.substring(16).trim();
            }
        }

        return result;
    } catch {
        // Return honest fallback — don't pretend we know the page state
        return {
            pageType: 'generic',
            hasSearchBox: false,
            hasForms: false,
            mainContentDescription: 'Vision analysis unavailable',
            suggestedAction: 'search',
            uiElements: [],
        };
    }
}

// ─── 2. Results Analysis ───
// Takes a screenshot AFTER an action and reads the results.
// Used to understand what appeared after a search or navigation.
export async function analyzeResults(
    screenshot: string,
    originalQuery: string,
    pageText?: string,
): Promise<ResultsAnalysis> {
    const hasVision = !!screenshot;

    if (hasVision) {
        const systemPrompt = `You are ASTRA's Results Analyst. You are viewing a web page after a search was performed.

The user searched for: "${originalQuery}"

Your task:
1. Identify all visible result items (posts, articles, products, links, etc.)
2. Rank them by: RELEVANCE to the query AND POPULARITY (scores, upvotes, reviews, engagement)
3. Return the top 8 results in structured format

OUTPUT FORMAT — TOON only (Token-Oriented Object Notation):
Do not use JSON formatting. Use this exact line-by-line format:
summary: 2-3 sentence overview of results
totalResultsFound: estimated number of visible results

[TOP_RESULTS]
rank:1 | title:result title | description:snippet or description | url:url if visible | score:upvotes/score/rating if visible
[/TOP_RESULTS]`;

        try {
            const response = await chatVision(
                systemPrompt,
                `Analyze search results for: "${originalQuery}". Return TOON output.`,
                screenshot,
            );

            const result: ResultsAnalysis = { summary: '', topResults: [], totalResultsFound: 0 };
            const lines = response.split('\n').map(l => l.trim()).filter(Boolean);
            let inResults = false;

            for (const line of lines) {
                if (line.toUpperCase() === '[TOP_RESULTS]') { inResults = true; continue; }
                if (line.toUpperCase() === '[/TOP_RESULTS]') { inResults = false; continue; }

                if (inResults) {
                    const parts = line.split('|').map(p => p.trim());
                    let rank = 0, title = '', desc = '', url = '', score = '';
                    for (const p of parts) {
                        if (p.toLowerCase().startsWith('rank:')) rank = parseInt(p.substring(5).trim()) || 0;
                        else if (p.toLowerCase().startsWith('title:')) title = p.substring(6).trim();
                        else if (p.toLowerCase().startsWith('description:')) desc = p.substring(12).trim();
                        else if (p.toLowerCase().startsWith('url:')) url = p.substring(4).trim();
                        else if (p.toLowerCase().startsWith('score:')) score = p.substring(6).trim();
                    }
                    if (title) {
                        result.topResults.push({ rank, title, description: desc || undefined, url: url || undefined, score: score || undefined });
                    }
                } else {
                    if (line.toLowerCase().startsWith('summary:')) result.summary = line.substring(8).trim();
                    else if (line.toLowerCase().startsWith('totalresultsfound:')) result.totalResultsFound = parseInt(line.substring(18).trim()) || 0;
                }
            }
            return result;
        } catch (err) {
            console.warn('[ASTRA Vision] Results analysis failed, falling back to text:', err);
        }
    }

    // Text-only fallback
    if (pageText) {
        const response = await chat(
            `You are ASTRA's Results Analyst. The user searched for "${originalQuery}". Analyze the page content, identify results, rank by relevance and popularity.
OUTPUT FORMAT — TOON only:
summary: ...
totalResultsFound: N
[TOP_RESULTS]
rank:1 | title:... | description:... | url:... | score:...
[/TOP_RESULTS]`,
            `Page content:\n${pageText.substring(0, 2500)}\n\nReturn TOON output.`,
            'research',
        );

        try {
            const result: ResultsAnalysis = { summary: '', topResults: [], totalResultsFound: 0 };
            const lines = response.split('\n').map(l => l.trim()).filter(Boolean);
            let inResults = false;

            for (const line of lines) {
                if (line.toUpperCase() === '[TOP_RESULTS]') { inResults = true; continue; }
                if (line.toUpperCase() === '[/TOP_RESULTS]') { inResults = false; continue; }

                if (inResults) {
                    const parts = line.split('|').map(p => p.trim());
                    let rank = 0, title = '', desc = '', url = '', score = '';
                    for (const p of parts) {
                        if (p.toLowerCase().startsWith('rank:')) rank = parseInt(p.substring(5).trim()) || 0;
                        else if (p.toLowerCase().startsWith('title:')) title = p.substring(6).trim();
                        else if (p.toLowerCase().startsWith('description:')) desc = p.substring(12).trim();
                        else if (p.toLowerCase().startsWith('url:')) url = p.substring(4).trim();
                        else if (p.toLowerCase().startsWith('score:')) score = p.substring(6).trim();
                    }
                    if (title) {
                        result.topResults.push({ rank, title, description: desc || undefined, url: url || undefined, score: score || undefined });
                    }
                } else {
                    if (line.toLowerCase().startsWith('summary:')) result.summary = line.substring(8).trim();
                    else if (line.toLowerCase().startsWith('totalresultsfound:')) result.totalResultsFound = parseInt(line.substring(18).trim()) || 0;
                }
            }
            return result;
        } catch {
            // ignored
        }
    }

    return {
        summary: 'Could not analyze results.',
        topResults: [],
        totalResultsFound: 0,
    };
}

// ─── 3. Vision Element Mapper ──────────────────────────────────────────────────────────────
// Receives screenshot + list of DOM elements detected by the browser.
// The Vision model maps each DOM element to what it visually looks like on screen.
// Gives the planner ACCURATE visual descriptions (e.g. "idx 1 is the magnifying-glass
// search-submit button at top right") instead of raw DOM label text.

export interface VisionElement {
    domIdx: number;    // Matches InteractiveElement.idx
    confidence: number;  // 0-100
    visualRole: string;  // e.g. "large search input bar at top center"
}

export async function identifyElements(
    screenshot: string,
    elements: Array<{ idx: number; type: string; label: string }>,
    query: string,
): Promise<VisionElement[]> {
    if (!screenshot || !elements.length) return [];

    const elementLines = elements
        .slice(0, 30)
        .map(e => `idx:${e.idx} | type:${e.type} | label:${e.label}`)
        .join('\n');

    const systemPrompt = `You are ASTRA's Vision Element Mapper.
You see a browser screenshot AND a list of DOM elements found by the browser crawler.
Your task: look at the screenshot and identify WHICH DOM elements you can actually SEE and what they visually look like.

DOM ELEMENTS:
${elementLines}

For each element you can visually locate in the screenshot, output one line:
  idx:N | confidence:0-100 | role:visual description (e.g. "main search text field at top of page")

RULES:
- Only output elements you are CONFIDENT are visible in the screenshot
- Be specific: "white search bar spanning top header" not just "input"
- Pay special attention to: submit/search BUTTONS that sit next to text inputs (often a magnifying glass icon)
- confidence below 60 = skip that element

Output ONLY the [VISION_ELEMENTS] block:
[VISION_ELEMENTS]
idx:0 | confidence:98 | role:white search text field at top center, empty placeholder text visible
idx:1 | confidence:95 | role:blue search submit button (magnifying glass icon) immediately to the right of the search bar
[/VISION_ELEMENTS]`;

    try {
        const response = await chatVision(
            systemPrompt,
            `User wants to: "${query}". Identify visible DOM elements in this screenshot.`,
            screenshot,
        );

        const result: VisionElement[] = [];
        const blockMatch = response.match(/\[VISION_ELEMENTS\]([\s\S]*?)\[\/VISION_ELEMENTS\]/i);
        if (!blockMatch) return [];

        for (const line of blockMatch[1].split('\n').map(l => l.trim()).filter(Boolean)) {
            const parts = line.split('|').map(p => p.trim());
            let idx = -1, confidence = 0, role = '';
            for (const p of parts) {
                if (p.toLowerCase().startsWith('idx:')) idx = parseInt(p.slice(4).trim(), 10);
                else if (p.toLowerCase().startsWith('confidence:')) confidence = parseInt(p.slice(11).trim(), 10) || 0;
                else if (p.toLowerCase().startsWith('role:')) role = p.slice(5).trim();
            }
            if (idx >= 0 && role && confidence >= 60) result.push({ domIdx: idx, confidence, visualRole: role });
        }
        return result;
    } catch {
        return [];
    }
}

// ─── 4. Format Results for Display ───
// Converts structured results into a clean markdown summary for the user.
export function formatResultsMarkdown(results: ResultsAnalysis, query: string): string {
    const lines: string[] = [];

    lines.push(`## 🔎 Results for "${query}"\n`);

    if (results.topResults.length === 0) {
        lines.push('No results found.');
        return lines.join('\n');
    }

    results.topResults.forEach((r, i) => {
        lines.push(`**${i + 1}. ${r.title}**${r.score ? ` — ${r.score}` : ''}`);
        if (r.description) lines.push(`   ${r.description}`);
        if (r.url) lines.push(`   🔗 ${r.url}`);
        lines.push('');
    });

    if (results.summary) {
        lines.push('---');
        lines.push(`💡 **ASTRA Summary:** ${results.summary}`);
    }

    return lines.join('\n');
}
