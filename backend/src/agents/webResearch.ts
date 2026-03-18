import { chat } from '../services/llm.js';
import { searchWeb, fetchPageContent } from '../services/webSearch.js';

export interface WebResearchResult {
    found: boolean;
    summary: string;       // concise navigation steps from docs
    sources: string[];     // URLs that were consulted
}

// Keywords that identify platform-specific applications by URL pattern
const PLATFORM_GUIDES: Record<string, string> = {
    'ofsc.app': 'Oracle Field Service Cloud',
    'ocs.oraclecloud.com': 'Oracle Field Service Cloud',
    'oracle.com': 'Oracle',
    'console.aws.amazon': 'AWS Console',
    'console.cloud.google': 'Google Cloud Console',
    'portal.azure.com': 'Azure Portal',
    'github.com': 'GitHub',
    'jira': 'Jira',
    'salesforce': 'Salesforce',
    'servicenow': 'ServiceNow',
};

function detectPlatform(url: string): string | null {
    for (const [pattern, name] of Object.entries(PLATFORM_GUIDES)) {
        if (url.includes(pattern)) return name;
    }
    return null;
}

export async function performWebResearch(
    query: string,
    currentUrl: string,
    searchQuery: string,
): Promise<WebResearchResult> {
    const platform = detectPlatform(currentUrl);
    const platformHint = platform ? `${platform} ` : '';

    console.log(`[WebResearch] Researching: "${searchQuery}" on ${platform ?? currentUrl}`);

    // Build a focused documentation search query
    const searchTerms = `${platformHint}${searchQuery} navigation guide steps`;

    try {
        // Use the robust webSearch service, getting 7 results to survive blocked fetches
        const results = await searchWeb(searchTerms, { maxResults: 7 });

        if (results.length === 0) {
            console.log('[WebResearch] No search results found');
            return { found: false, summary: '', sources: [] };
        }

        const sources: string[] = [];
        let combinedText = '';

        // Fetch up to 2 readable URLs that aren't PDFs/videos
        let fetched = 0;
        for (const res of results) {
            if (fetched >= 2) break;
            if (res.url.endsWith('.pdf') || res.url.includes('youtube.com')) continue;

            try {
                const text = await fetchPageContent(res.url, { timeout: 4000, maxContentLength: 15000 });
                if (text && text.length > 200) {
                    combinedText += `\n--- Source: ${res.url} ---\n${text.slice(0, 3000)}\n`;
                    sources.push(res.url);
                    fetched++;
                }
            } catch (fetchErr) {
                console.log(`[WebResearch] Failed fetching ${res.url}`);
            }
        }

        // ── Snippet fallback: if all page fetches failed, use DuckDuckGo snippets ──
        // This ensures we always return the best available real data, never nothing.
        if (!combinedText) {
            for (const res of results.slice(0, 7)) {
                const snippet = res.snippet ?? '';
                if (snippet && snippet.length > 30) {
                    combinedText += `\n--- ${res.title ?? res.url} (${res.url}) ---\n${snippet}\n`;
                    sources.push(res.url);
                }
            }
            if (combinedText) {
                console.log(`[WebResearch] Full fetch failed — using ${sources.length} snippets as fallback`);
            }
        }

        if (!combinedText) {
            console.log('[WebResearch] No fetchable content or usable snippets in search results');
            return { found: false, summary: '', sources: [] };
        }

        // Ask LLM to synthesize an answer grounded in the real retrieved web content
        const systemPrompt = `You are a web research analyst. Using ONLY the provided web content, answer the user's task clearly and accurately.

USER TASK: "${searchQuery}"
PLATFORM CONTEXT: ${platform ?? 'general web'}

RULES:
- Base your entire response on the retrieved content only — do not add outside knowledge
- Do not add information not present in the sources
- If the content includes navigation/configuration steps, format them as a numbered list
- If the content has useful facts, prices, reviews, or summaries, present them clearly
- If the content truly does not contain relevant information, output: NOT_FOUND`;

        const summary = await chat(systemPrompt, `Extract navigation steps from:\n${combinedText.slice(0, 5000)}`, 'research');

        const found = !summary.includes('NOT_FOUND') && summary.trim().length > 10;
        console.log(`[WebResearch] ${found ? 'Found' : 'No'} navigation guide (${sources.length} sources)`);

        return { found, summary: found ? summary : '', sources };
    } catch (e) {
        console.error('[WebResearch] Failed:', e);
        return { found: false, summary: '', sources: [] };
    }
}
