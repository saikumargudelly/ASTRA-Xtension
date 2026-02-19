import { chat, chatVision } from '../services/llm.js';
import type { PageAnalysisPayload } from '../types/index.js';

// ─── Search Results Ranker Agent ───
// Called automatically after a search action completes.
// Reads the results page and returns ranked, relevant results.

export async function analyzeSearchResults(
    originalQuery: string,
    pageData: PageAnalysisPayload,
): Promise<{ summary: string; results: Array<{ title: string; url?: string; score?: string; snippet?: string }> }> {

    const pageContext = buildPageContext(pageData);

    const systemPrompt = `You are ASTRA, an AI research assistant. You are viewing a SEARCH RESULTS PAGE.

The user searched for: "${originalQuery}"

Your job:
1. Extract the individual search results from the page content (titles, URLs, descriptions/snippets).
2. Rank them by TWO signals:
   a. RELEVANCE to the user's original query
   b. POPULARITY (upvotes, scores, comment counts, engagement — if visible)
3. Return a clean, structured summary of the TOP 5-10 most relevant and popular results.

Output FORMAT (markdown):
## 🔎 Top Results for "${originalQuery}"

1. **[Result Title]** — [score/upvotes if visible]
   [1-2 sentence description/snippet]
   🔗 [URL if available]

2. ...

---
💡 **ASTRA Summary:** [2-3 sentence synthesis of what the top results are about, key themes, most popular discussion points]

RULES:
- Prioritize results that best match the query intent.
- If upvote/score data is visible, boost those results in the ranking.
- Do NOT make up results. Only use what is in the page content.
- If fewer than 3 results are found, say so clearly.`;

    const response = await chat(systemPrompt, `Page content:\n${pageContext}`);

    return {
        summary: response,
        results: [], // Structured parsing can be added later
    };
}

// ─── Page Analyzer Agent ───
// Takes structured page data from the extension's scroll-and-extract pipeline
// and uses the LLM to produce an intelligent summary/analysis.

export async function analyzePageContent(
    prompt: string,
    pageData: PageAnalysisPayload | null,
    screenshot?: string,
): Promise<{
    summary: string; rankedResults?: Array<{
        rank: number; title: string; url?: string; snippet?: string;
        rating?: string; reviewCount?: string; reason?: string; badge?: string;
    }>
}> {

    // 1. Vision Analysis (Restricted Page OR Failed Extraction with Screenshot)
    if (screenshot && (pageData?.restricted || !pageData)) {
        try {
            const systemPrompt = `You are ASTRA, an AI browser assistant.
You are viewing a screenshot of a web page.
${!pageData ? 'Note: Text extraction failed for this page, so you must rely on the visual screenshot.' : 'Note: This is a restricted system page.'}
Your task is to analyze the visual content of this page to answer the user's request.
Be specific about what you see in the image.`;

            const response = await chatVision(systemPrompt, prompt, screenshot);
            return { summary: response };
        } catch (err) {
            console.warn('[ASTRA] Vision analysis failed:', err);
        }
    }

    // 2. Missing data or Restricted without/failed Vision
    if (!pageData || (pageData.restricted && !screenshot)) {
        const response = await chat(
            `You are ASTRA, an AI browser assistant. The user asked a question but no page data is available.
            
            IMPORTANT:
            - If the user asked to "check my screen" or "analyze this page", explain that you cannot see the page content.
            - This usually happens on restricted browser pages (like New Tab, Extensions, Settings) or if the page failed to load.
            - Ask the user to try on a regular website (like Wikipedia or Google).${pageData?.restricted ? '\n- Mention that a Vision Model is required for restricted pages.' : ''}`,
            prompt,
        );
        return { summary: response };
    }

    // 3. Standard Text Analysis — detect if this is a search results request
    const pageContext = buildPageContext(pageData);
    const isSearchResults = prompt.toLowerCase().includes('[search results]') || prompt.toLowerCase().includes('rank and summarize');

    if (isSearchResults) {
        // ─── Search Results Mode: Extract structured ranked list ───
        const systemPrompt = `You are ASTRA, an intelligent AI research assistant analyzing a SEARCH RESULTS PAGE.

The user searched for: "${prompt}"

Your job:
1. Extract ALL visible result items (courses, posts, products, articles, videos, etc.) from the page content.
2. For EACH result extract: title, URL (if present), rating/stars/score, review count, short description.
3. Rank them by: RELEVANCE to the query + POPULARITY (ratings, reviews, enrollments, upvotes).
4. Return the TOP 8 results.
5. Assign a badge to the top items: "🏆 Best Match", "⭐ Highest Rated", "🔥 Most Popular", "💎 ASTRA Pick".

PAGE CONTENT:
${pageContext}

OUTPUT FORMAT — you MUST return your response in this exact structure:

## 🎯 ASTRA's Top Picks for "[query]"

[Markdown summary of top 3-5 results with descriptions]

---
💡 **ASTRA's Take:** [2-sentence synthesis of what the best options are and why]

[RESULTS_JSON]
[
  {
    "rank": 1,
    "title": "Exact title of the result as shown on page",
    "url": "URL if visible",
    "rating": "4.8 stars" or "94% positive" or null,
    "reviewCount": "12,400 reviews" or null,
    "snippet": "1-2 sentence description",
    "reason": "Why ASTRA ranked this #1",
    "badge": "🏆 Best Match"
  }
]
[/RESULTS_JSON]`;

        const response = await chat(systemPrompt, `Analyze these search results and return ranked list:`);

        // Parse the [RESULTS_JSON] block
        let rankedResults: Array<{
            rank: number; title: string; url?: string; snippet?: string;
            rating?: string; reviewCount?: string; reason?: string; badge?: string;
        }> = [];

        try {
            const jsonMatch = response.match(/\[RESULTS_JSON\]([\s\S]*?)\[\/RESULTS_JSON\]/);
            if (jsonMatch?.[1]) {
                rankedResults = JSON.parse(jsonMatch[1].trim());
            }
        } catch (parseErr) {
            console.warn('[ASTRA] Failed to parse RESULTS_JSON:', parseErr);
        }

        // Strip the JSON block from the summary for clean display
        const summary = response.replace(/\[RESULTS_JSON\][\s\S]*?\[\/RESULTS_JSON\]/g, '').trim();
        return { summary, rankedResults };
    }

    // 4. Regular page analysis / summarization
    const systemPrompt = `You are ASTRA, an intelligent browser automation assistant. You have been given the full content of a web page that was captured by scrolling through it and extracting text, structure, and metadata.

Your task is to analyze the page content and respond to the user's request. Be comprehensive, specific, and cite relevant details from the page.

PAGE CONTEXT:
${pageContext}

${screenshot ? '(A screenshot of the page was also captured for reference, though I am analyzing the text content here.)' : ''}

INSTRUCTIONS:
- Answer the user's question or fulfill their request based on the page content above
- If asked to summarize, provide a clear and organized summary
- If asked to find specific information, locate and present it
- If asked to analyze, provide insights based on the content
- Use headings, bullet points, and structure for readability
- If the page content doesn't contain the answer, say so clearly`;

    const response = await chat(systemPrompt, prompt);
    return { summary: response };
}

// ─── Build a text representation of the page data ───
function buildPageContext(data: PageAnalysisPayload): string {
    const parts: string[] = [];

    // Basic info
    parts.push(`PAGE: ${data.title}`);
    parts.push(`URL: ${data.url}`);

    // Metadata
    if (data.meta) {
        if (data.meta.description) parts.push(`DESCRIPTION: ${data.meta.description}`);
        if (data.meta.keywords) parts.push(`KEYWORDS: ${data.meta.keywords}`);
    }

    parts.push('');

    // Sections (structured content by headings)
    if (data.sections && data.sections.length > 0) {
        parts.push('═══ PAGE SECTIONS ═══');
        for (const section of data.sections) {
            const prefix = '#'.repeat(section.level);
            parts.push(`${prefix} ${section.heading}`);
            if (section.text) {
                parts.push(section.text.substring(0, 500));
            }
            parts.push('');
        }
    }

    // Full text (trimmed, as primary content source)
    if (data.fullText) {
        parts.push('═══ FULL PAGE TEXT ═══');
        parts.push(data.fullText.substring(0, 10000));
        parts.push('');
    }

    // Viewport snapshots (text at each scroll position)
    if (data.viewportSnapshots && data.viewportSnapshots.length > 0) {
        parts.push(`═══ SCROLL ANALYSIS (${data.viewportSnapshots.length} viewports captured) ═══`);
        for (let i = 0; i < data.viewportSnapshots.length; i++) {
            const snap = data.viewportSnapshots[i];
            parts.push(`--- Viewport ${i + 1} (scrollY: ${snap.scrollY}px, ${snap.visibleElements} interactive elements) ---`);
            parts.push(snap.visibleText.substring(0, 1500));
            parts.push('');
        }
    }

    // Links
    if (data.links && data.links.length > 0) {
        parts.push(`═══ LINKS (${data.links.length} found) ═══`);
        const topLinks = data.links.slice(0, 30);
        for (const link of topLinks) {
            const ext = link.isExternal ? ' [external]' : '';
            parts.push(`• ${link.text} → ${link.href}${ext}`);
        }
        parts.push('');
    }

    // Tables
    if (data.tables && data.tables.length > 0) {
        parts.push(`═══ TABLES (${data.tables.length} found) ═══`);
        for (const table of data.tables) {
            if (table.headers.length > 0) {
                parts.push(`Headers: ${table.headers.join(' | ')}`);
            }
            for (const row of table.rows.slice(0, 10)) {
                parts.push(`  ${row.join(' | ')}`);
            }
            if (table.rowCount > 10) {
                parts.push(`  ... (${table.rowCount} rows total)`);
            }
            parts.push('');
        }
    }

    // Forms
    if (data.forms && data.forms.length > 0) {
        parts.push(`═══ FORMS (${data.forms.length} found) ═══`);
        for (const form of data.forms) {
            if (form.action) parts.push(`  Action: ${form.action}`);
            for (const input of form.inputs) {
                parts.push(`  • ${input.type || 'input'}: ${input.label || input.name || input.placeholder || '(unnamed)'}`);
            }
            parts.push('');
        }
    }

    // Images
    if (data.images && data.images.length > 0) {
        parts.push(`═══ IMAGES (${data.images.length} found) ═══`);
        for (const img of data.images.slice(0, 20)) {
            parts.push(`  • ${img.alt || '(no alt text)'} — ${img.src}`);
        }
        parts.push('');
    }

    // Scroll coverage
    if (data.scrollDepth !== undefined) {
        parts.push(`SCROLL COVERAGE: ${Math.round(data.scrollDepth)}% of page analyzed`);
        parts.push(`PAGE HEIGHT: ${data.totalHeight}px / VIEWPORT: ${data.viewportHeight}px`);
    }

    if (data.restricted) {
        parts.push('⚠ RESTRICTED PAGE: DOM access blocked by browser security.');
    }

    return parts.join('\n');
}

// ─── Smart Filter Matcher Agent ───
// Given user query + discovered page filters, decides which filters to apply
export async function matchFiltersToConstraints(
    userQuery: string,
    availableFilters: Array<{
        type: string; label: string; selector: string;
        currentValue?: string; options?: string[];
    }>,
): Promise<{
    filtersToApply: Array<{ selector: string; label: string; reason: string }>;
    extractedConstraints: string[];
}> {
    if (!availableFilters.length) {
        return { filtersToApply: [], extractedConstraints: [] };
    }

    const filtersDesc = availableFilters.map((f, i) =>
        `${i + 1}. [${f.type}] "${f.label}" (selector: ${f.selector})${f.currentValue ? ` [current: ${f.currentValue}]` : ''}${f.options ? ` [options: ${f.options.join(', ')}]` : ''}`
    ).join('\n');

    const systemPrompt = `You are ASTRA's Filter Intelligence agent. Your job is to analyze a user's search query and decide which page filters/sorts to apply to get the best results.

USER QUERY: "${userQuery}"

AVAILABLE FILTERS ON THE PAGE:
${filtersDesc}

INSTRUCTIONS:
1. Extract any constraints from the user query (time limits, rating requirements, price, level, date ranges, sort preferences).
2. Match those constraints to the available filters above.
3. If the user mentions "best", "highest rated", "most popular" — look for a sort/rating filter.
4. If the user mentions a duration like "under 10 hours", "short courses" — look for a duration filter.
5. If the user mentions "free", "paid", price — look for a price filter.
6. If the user mentions "beginner", "advanced" — look for a level filter.
7. Only select filters that are CLEARLY relevant. Don't apply filters that don't match the query.

OUTPUT FORMAT — JSON only:
{
  "extractedConstraints": ["highest rated", "under 10 hours"],
  "filtersToApply": [
    { "selector": "#sort-by-rating", "label": "Sort by Rating", "reason": "User wants highest rated" },
    { "selector": "[data-filter=\"duration-short\"]", "label": "0-3 Hours", "reason": "User wants short courses" }
  ]
}

RULES:
- Return EMPTY filtersToApply [] if no constraints match any available filter.
- Use the EXACT selector from the available filters list.
- Maximum 3 filters to avoid over-filtering.
- If no constraints are detected in the query, return empty arrays.`;

    try {
        const response = await chat(systemPrompt, 'Analyze the query and return filter selections as JSON.');

        // Parse response — expect JSON
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            return {
                filtersToApply: Array.isArray(parsed.filtersToApply) ? parsed.filtersToApply.slice(0, 3) : [],
                extractedConstraints: Array.isArray(parsed.extractedConstraints) ? parsed.extractedConstraints : [],
            };
        }
    } catch (err) {
        console.warn('[ASTRA] Filter matching failed:', err);
    }

    return { filtersToApply: [], extractedConstraints: [] };
}
