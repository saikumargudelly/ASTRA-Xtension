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

    const response = await chat(systemPrompt, `Page content:\n${pageContext}`, 'research');

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

        // Extract price constraint from prompt (e.g., "under 20000", "below 5000", "₹3000")
        const priceMatch = prompt.match(/(under|below|within|max|upto|up to|less than)[\s₹rs.]*([\d,]+)/i)
            || prompt.match(/([\d,]+)[\s₹rs]*(max|or less|and below)/i);
        const priceLimit = priceMatch
            ? parseInt((priceMatch[2] || priceMatch[1]).replace(/,/g, ''), 10)
            : null;

        const systemPrompt = `You are NEXUS, an intelligent AI shopping assistant analyzing a SEARCH RESULTS PAGE for the user's query.

The user asked: "${prompt}"
${priceLimit ? `
⚠️  STRICT BUDGET RULE: The user has a budget of ₹${priceLimit.toLocaleString('en-IN')}.
- YOU MUST EXCLUDE any item whose price exceeds ₹${priceLimit.toLocaleString('en-IN')}.
- DO NOT include ₹100, ₹200, ₹500 items just because they are "under budget" — the budget is a MAXIMUM, not a target.
- Focus on items that represent good value CLOSE TO or AT the budget (e.g., for ₹20,000 budget, prioritize ₹5,000–₹20,000 items).
- Entirely exclude items below ₹500 unless the user explicitly asked for cheap/economical gifts.
` : ''}
Your job:
1. Extract ALL visible product items from the page content (titles, prices, URLs, ratings).
2. If a price is visible, verify it is within the budget. SKIP items that exceed the budget.
3. Prioritize items priced between ${priceLimit ? `₹${Math.round(priceLimit * 0.1).toLocaleString('en-IN')} and ₹${priceLimit.toLocaleString('en-IN')}` : 'a reasonable range'}.
4. Rank by: RELEVANCE + RATING + VALUE FOR MONEY.
5. Return TOP 8 results.
6. Assign badges: "🏆 Best Choice", "⭐ Highest Rated", "💎 Best Value", "🎁 Gift Pick".

PAGE CONTENT:
${pageContext}

OUTPUT FORMAT — return exactly this structure:

## 🎯 NEXUS Picks for "${priceLimit ? `budget ₹${priceLimit.toLocaleString('en-IN')}` : 'your query'}"

[Short markdown summary of top 3-5 results with why they fit the criteria]

---
💡 **NEXUS Verdict:** [2-sentence synthesis — best overall pick and why]

[RESULTS_TOON]
rank: 1
title: Exact product title from page
url: Product URL if visible
price: ₹X,XXX (if visible on page)
rating: 4.5 ⭐ (1,234 reviews) or null
reviewCount: 1,234 or null
snippet: 1-2 sentence description
reason: Why NEXUS ranked this #1 for this budget
badge: 🏆 Best Choice
---
rank: 2
...
[/RESULTS_TOON]

CRITICAL RULES:
1. ONLY include items within the budget. Exclude anything over ₹${priceLimit?.toLocaleString('en-IN') ?? 'stated budget'}.
2. Do NOT include gift wrap items, accessories, or non-product entries.
3. Extract EXACT titles as shown — do not paraphrase or combine brand + product.
4. The price field MUST be extracted if visible — this is how we verify budget compliance.
5. Rank by relevance + rating + value.`;

        const response = await chat(systemPrompt, `Analyze these search results, enforce the budget, and return ranked list:\n\n${pageContext}`, 'research');
        console.log('[NEXUS] Raw LLM text:', response.substring(0, 1000) + '...');

        // Parse the [RESULTS_TOON] block
        let rankedResults: Array<{
            rank: number; title: string; url?: string; snippet?: string;
            rating?: string; reviewCount?: string; reason?: string; badge?: string;
        }> = [];

        try {
            const startIndex = response.indexOf('[RESULTS_TOON]');
            if (startIndex !== -1) {
                let toonRaw = response.substring(startIndex + 14);
                const endIndex = toonRaw.indexOf('[/RESULTS_TOON]');
                if (endIndex !== -1) {
                    toonRaw = toonRaw.substring(0, endIndex);
                }

                const lines = toonRaw.trim().split('\n');
                let currentResult: any = null;

                for (const line of lines) {
                    const cleanLine = line.trim();
                    if (!cleanLine || cleanLine === '---') continue;

                    const colonIdx = cleanLine.indexOf(':');
                    if (colonIdx > 0) {
                        const key = cleanLine.substring(0, colonIdx).trim();
                        const val = cleanLine.substring(colonIdx + 1).trim();

                        if (key === 'rank') {
                            if (currentResult && currentResult.title && currentResult.rank) {
                                rankedResults.push(currentResult);
                            }
                            currentResult = { rank: parseInt(val, 10) || rankedResults.length + 1 };
                        } else if (currentResult && val && val !== 'null' && val !== 'None') {
                            currentResult[key] = val;
                        }
                    }
                }
                if (currentResult && currentResult.title && currentResult.rank) {
                    rankedResults.push(currentResult);
                }
            }
        } catch (parseErr) {
            console.warn('[ASTRA] Failed to parse RESULTS_TOON:', parseErr);
        }

        // Strip the TOON block from the summary for clean display
        let summary = response;
        const startIndex = response.indexOf('[RESULTS_TOON]');
        if (startIndex !== -1) {
            summary = response.substring(0, startIndex).trim();
        }

        if (!summary && rankedResults.length > 0) {
            summary = `ASTRA analyzed the page and ranked ${rankedResults.length} relevant results. Check the badges injected directly on the items!`;
        }

        console.log('[ASTRA] parsed rankedResults count:', rankedResults.length);
        if (rankedResults.length > 0) {
            console.log('[ASTRA] first result sample:', rankedResults[0]);
        }

        return { summary, rankedResults };
    }

    // 4. Regular page analysis / summarization
    const regularSystemPrompt = `You are NEXUS, an intelligent browser automation assistant. You have full access to the page content captured by scrolling.

Your task: analyze the page content and respond to the user's request.

PAGE CONTEXT:
${pageContext}

${screenshot ? '(A screenshot was also captured.)' : ''}

INSTRUCTIONS:
- Answer based on page content
- Use headings and bullet points for readability
- If the page doesn't have the answer, say so clearly`;

    const regularResponse = await chat(regularSystemPrompt, prompt, 'research');
    return { summary: regularResponse };
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
                parts.push(section.text.substring(0, 200));
            }
            parts.push('');
        }
    }

    // Viewport snapshots (text at each scroll position)
    const hasViewports = data.viewportSnapshots && data.viewportSnapshots.length > 0;
    if (hasViewports) {
        parts.push(`═══ SCROLL ANALYSIS (${data.viewportSnapshots!.length} viewports captured) ═══`);
        const limitedViewports = data.viewportSnapshots!.slice(0, 6);
        for (let i = 0; i < limitedViewports.length; i++) {
            const snap = limitedViewports[i];
            parts.push(`--- Viewport ${i + 1} (scrollY: ${snap.scrollY}px, ${snap.visibleElements} interactive elements) ---`);
            parts.push(snap.visibleText.substring(0, 150)); // Reduced from 250
            parts.push('');
        }
    }

    // Links (Top 12 to reduce navigational noise)
    if (data.links && data.links.length > 0) {
        parts.push(`═══ LINKS (${data.links.length} found) ═══`);
        const topLinks = data.links.slice(0, 6); // Reduced from 12
        for (const link of topLinks) {
            const ext = link.isExternal ? ' [external]' : '';
            const safeHref = link.href.length > 100 ? link.href.substring(0, 100) + '...' : link.href;
            parts.push(`• ${link.text} → ${safeHref}${ext}`);
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
        for (const img of data.images.slice(0, 10)) {
            parts.push(`  • ${img.alt || '(no alt text)'}`);
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

    // HARD LIMIT: Prevent massive sidebars from destroying token limits
    availableFilters = availableFilters.slice(0, 40);

    const filtersDesc = availableFilters.map((f, i) =>
        `${i + 1}. [${f.type}] "${f.label}" (selector: ${f.selector})${f.currentValue ? ` [current: ${f.currentValue}]` : ''}${f.options ? ` [options: ${f.options.join(', ')}]` : ''}`
    ).join('\n');
    console.log(`[ASTRA] RAW INBOUND FILTERS (${availableFilters.length} items):\n`, filtersDesc);

    const systemPrompt = `You are NEXUS's Filter Intelligence agent. Your job is to pick the correct page filters for the user's shopping query.

USER QUERY: "${userQuery}"

AVAILABLE FILTERS ON THE PAGE:
${filtersDesc}

INSTRUCTIONS:
1. Extract constraints from the user's query: price limit, rating requirement, sort preference.
2. Match those constraints to ACTUAL FILTER WIDGETS — checkboxes, sliders, select dropdowns, radio buttons.

⚠️  CRITICAL — DO NOT click these types of elements:
- Search suggestion links (e.g., "best wedding gifts under 20000 rs" as a link → this would re-search, not filter!)
- Navigation links, category links, autocomplete suggestions
- Any [link] type filter where the label looks like an auto-suggest (contains the full query text)

✅  DO click:
- Price range checkboxes or sliders ("₹0–₹5000", "₹5000–₹10000", etc.)
- Sort options ("Price -- Low to High", "Popularity", "Rating")
- Brand checkboxes
- Rating filters ("4★ & above" etc.)

3. For a budget constraint like "under 20000", select ALL price brackets that fit within that limit.
   Example: if available are "₹0-5000", "₹5000-10000", "₹10000-20000" — select all 3.
4. Always add a relevance/popularity sort if the user says "best" or doesn't specify.
5. Only return filters with type = "checkbox", "select", "radio", "range" — NEVER type = "link".

OUTPUT FORMAT — TOON only:

[CONSTRAINTS]
price under ${userQuery.match(/(\d[\d,]+)/)?.[0] ?? 'stated limit'}
highest rated
[/CONSTRAINTS]
[FILTERS]
selector:#price-range-0-5000 | label:₹0–₹5000 | reason:Within user budget
selector:#sort-popularity | label:Sort by Popularity | reason:User wants best results
[/FILTERS]

RULES:
- Maximum 5 filters.
- EXACT selector from the list above.
- Skip any filter of type [link].
- Return EMPTY sections if no real filter widgets match.`;

    try {
        const response = await chat(systemPrompt, 'Analyze the query and return filter selections in TOON format.', 'research');
        console.log('[ASTRA] Extracted Filters TOON:\n', response);

        const extractedConstraints: string[] = [];
        const filtersToApply: Array<{ selector: string; label: string; reason: string }> = [];

        const constrMatch = response.match(/\[CONSTRAINTS\]([\s\S]*?)\[\/CONSTRAINTS\]/i);
        if (constrMatch) {
            extractedConstraints.push(...constrMatch[1].split('\n').map(l => l.trim()).filter(Boolean));
        }

        const filtersMatch = response.match(/\[FILTERS\]([\s\S]*?)\[\/FILTERS\]/i);
        if (filtersMatch) {
            const lines = filtersMatch[1].split('\n').map(l => l.trim()).filter(Boolean);
            for (const line of lines) {
                const parts = line.split('|').map(p => p.trim());
                let selector = '', label = '', reason = '';
                for (const p of parts) {
                    if (p.toLowerCase().startsWith('selector:')) selector = p.substring(9).trim();
                    else if (p.toLowerCase().startsWith('label:')) label = p.substring(6).trim();
                    else if (p.toLowerCase().startsWith('reason:')) reason = p.substring(7).trim();
                }
                if (selector && label) {
                    filtersToApply.push({ selector, label, reason });
                }
            }
        }

        return {
            filtersToApply: filtersToApply.slice(0, 5),
            extractedConstraints: extractedConstraints,
        };
    } catch (err) {
        console.warn('[ASTRA] Filter matching failed:', err);
    }

    return { filtersToApply: [], extractedConstraints: [] };
}
