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

Given a screenshot of a web page and a user's query, you must return a JSON object describing:
1. What TYPE of page this is
2. What UI ELEMENTS are visible and interactable
3. What ACTION would best fulfill the user's query

Return ONLY valid JSON matching this exact structure:
{
  "pageType": "search-engine|content-site|ecommerce|social|news|dashboard|form|generic",
  "hasSearchBox": true/false,
  "hasForms": true/false,
  "mainContentDescription": "brief description of what's on screen",
  "suggestedAction": "search|extract|scroll|click|fill-form|read",
  "uiElements": [
    {
      "type": "search-input|button|form|list|article|nav|other",
      "description": "e.g. 'search bar at top with placeholder Search Reddit'",
      "likelySelector": "e.g. input[placeholder*='Search'], #search, [name='q']"
    }
  ],
  "searchInputHint": "visual description of the search box if found"
}`;

    try {
        const response = await chatVision(
            systemPrompt,
            `User wants to: "${userQuery}"\n\nAnalyze this screenshot and return the JSON.`,
            screenshot,
        );

        // Parse JSON from response
        let jsonStr = response.trim();
        const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
        if (fenceMatch) jsonStr = fenceMatch[1].trim();

        return JSON.parse(jsonStr) as ScreenAnalysis;
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

Return ONLY valid JSON:
{
  "summary": "2-3 sentence overview of results",
  "topResults": [
    {
      "title": "result title",
      "description": "snippet or description",
      "url": "url if visible",
      "score": "upvotes/score/rating if visible",
      "rank": 1
    }
  ],
  "totalResultsFound": estimated number of visible results
}`;

        try {
            const response = await chatVision(
                systemPrompt,
                `Analyze search results for: "${originalQuery}"`,
                screenshot,
            );

            let jsonStr = response.trim();
            const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
            if (fenceMatch) jsonStr = fenceMatch[1].trim();

            return JSON.parse(jsonStr) as ResultsAnalysis;
        } catch (err) {
            console.warn('[ASTRA Vision] Results analysis failed, falling back to text:', err);
        }
    }

    // Text-only fallback
    if (pageText) {
        const response = await chat(
            `You are ASTRA's Results Analyst. The user searched for "${originalQuery}". Analyze the page content, identify results, rank by relevance and popularity. Return JSON: {"summary": "...", "topResults": [{"title":"...","description":"...","url":"...","score":"...","rank":1}], "totalResultsFound": N}`,
            `Page content:\n${pageText.substring(0, 8000)}`,
        );

        try {
            let jsonStr = response.trim();
            const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
            if (fenceMatch) jsonStr = fenceMatch[1].trim();
            return JSON.parse(jsonStr) as ResultsAnalysis;
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

// ─── 3. Format Results for Display ───
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
