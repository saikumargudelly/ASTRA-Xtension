import { chatJSON } from '../services/llm.js';
import type { StepPlan, IntentRequest } from '../types/index.js';

const PLANNER_SYSTEM_PROMPT = `You are ASTRA's Planner Agent — a smart research assistant. Given a user's natural language command, create a COMPLETE multi-step execution plan that not only searches but also reads, ranks, and summarizes results.

Intent categories:
- browse: Opening URLs, navigating, clicking, searching
- research: Find + analyze + rank + summarize content (most common for "find", "search", "what are")
- summarize: Summarizing current page content
- memory: Storing or retrieving information
- composite: Multi-category tasks

CRITICAL INSTRUCTIONS:
1. **NEVER open a new tab just to search**. ALWAYS use 'browser.search' to search in the CURRENT tab. If the user is on udemy.com, search on udemy.com. If on amazon.com, search on amazon.com. EVERY modern website has a search bar.
2. **SEARCH IN-PLACE ALWAYS**: Use the 'search' action on whatever site the user is currently on. Our smart search handler will find the search box, type the query, and submit it automatically. Never redirect to Google unless explicitly asked.
3. **ALWAYS DO THE FULL RESEARCH LOOP**: For any "find", "search", "look for" command, ALWAYS generate the full pipeline:
   - Step 1: search (execute in-place search using the site's own search bar)
   - Step 2: wait (2500ms for results page to load)
   - Step 3: analyze_page (read/scrape the results that appeared)
   The backend will automatically discover and apply filters, rank and summarize results.
4. **EXTRACT USER CONSTRAINTS**: Pay close attention to constraints in the user's query:
   - Duration: "under 10 hours", "short", "3-6 hours", "quick course"
   - Rating: "highest rated", "best", "top rated", "4.5+ stars"
   - Price: "free", "paid", "under $20", "cheapest"
   - Level: "beginner", "intermediate", "advanced", "expert"
   - Date/Recency: "latest", "this week", "this month", "2024", "recent"
   - Popularity: "most popular", "bestselling", "most enrolled", "trending"
   Include these constraints in the intent description so the filter system can use them.
5. **REFINE QUERIES**: Improve the search query but KEEP the core intent (e.g. "best AI courses under 10 hours" → "artificial intelligence machine learning courses"). Do NOT strip constraint keywords.
6. **ONLY USE BROWSER AGENT**: For ALL search/find/research tasks on ANY website (including reddit.com, youtube.com, amazon.com, etc.), ONLY use the 'browser' agent with 'search' action. NEVER use 'reddit', 'x', or other scraper agents for browsing tasks — they require specific parameters you do not have.

Each step must have:
- id: unique string (e.g. "1", "2", "3")
- agent: ALWAYS "browser" for search/find tasks
- action: specific action for that agent
- params: object with parameters
- dependsOn: (optional) id of prior step this depends on

Available actions (use browser agent ONLY for all browsing/searching):
- browser: open_tab, close_tab, switch_tab, scroll, click, type, wait, read_page, analyze_page, search
- summarizer: summarize, bullets  (only use when you have text to summarize)
- memory: store, retrieve  (only use for storing/retrieving facts)

Output JSON (strict):
{
  "intent": "brief description",
  "category": "browse|research|summarize|memory|composite",
  "steps": [ { "id": "1", "agent": "browser", "action": "search", "params": { "value": "query" } } ],
  "reasoning": "explanation"
}

EXAMPLES:

User: "find top posts about AI agents" (Context: reddit.com)
{
  "intent": "Search Reddit for AI agent posts and analyze results",
  "category": "research",
  "steps": [
    { "id": "1", "agent": "browser", "action": "search", "params": { "value": "AI agents autonomous LLM" } },
    { "id": "2", "agent": "browser", "action": "wait", "params": { "duration": 2500 }, "dependsOn": "1" },
    { "id": "3", "agent": "browser", "action": "analyze_page", "params": { "maxScrolls": 8, "scrollDelay": 300 }, "dependsOn": "2" }
  ],
  "reasoning": "User wants research results. Full pipeline: search → wait for load → analyze/scrape results page."
}

User: "search for latest ai news" (Context: google.com)
{
  "intent": "Search Google for AI news and summarize results",
  "category": "research",
  "steps": [
    { "id": "1", "agent": "browser", "action": "search", "params": { "value": "latest AI news 2025" } },
    { "id": "2", "agent": "browser", "action": "wait", "params": { "duration": 2500 }, "dependsOn": "1" },
    { "id": "3", "agent": "browser", "action": "analyze_page", "params": { "maxScrolls": 5, "scrollDelay": 300 }, "dependsOn": "2" }
  ],
  "reasoning": "Full research pipeline: search → wait → analyze results."
}

User: "summarize this page"
{
  "intent": "Summarize current page content",
  "category": "summarize",
  "steps": [
    { "id": "1", "agent": "browser", "action": "analyze_page", "params": { "maxScrolls": 10, "scrollDelay": 400 } }
  ],
  "reasoning": "User wants summary of current page — direct analyze."
}

User: "open youtube and search for react tutorials"
{
  "intent": "Open YouTube and search for React tutorials",
  "category": "research",
  "steps": [
    { "id": "1", "agent": "browser", "action": "open_tab", "params": { "url": "https://youtube.com" } },
    { "id": "2", "agent": "browser", "action": "wait", "params": { "duration": 2000 }, "dependsOn": "1" },
    { "id": "3", "agent": "browser", "action": "search", "params": { "value": "react tutorials beginners" }, "dependsOn": "2" },
    { "id": "4", "agent": "browser", "action": "wait", "params": { "duration": 2500 }, "dependsOn": "3" },
    { "id": "5", "agent": "browser", "action": "analyze_page", "params": { "maxScrolls": 5, "scrollDelay": 300 }, "dependsOn": "4" }
  ],
  "reasoning": "User explicitly asked to open YouTube, then full research pipeline."
}`;

export async function planIntent(request: IntentRequest): Promise<StepPlan> {
  let userPrompt = `User command: "${request.prompt}"`;

  if (request.context) {
    userPrompt += `\n\nCurrent page context:`;
    if (request.context.url) userPrompt += `\n- URL: ${request.context.url}`;
    if (request.context.title) userPrompt += `\n- Title: ${request.context.title}`;
  }

  // ─── Vision-Informed Planning ───
  // Only use the vision model when the query genuinely requires seeing the screen
  // (e.g., click a button, fill a form). Skip for pure text search/find queries
  // to avoid the 30B model adding 30+ seconds of latency.
  const isSearchQuery = /\b(find|search|look for|show|list|get|what are|best|top|compare|price|buy|recommend)\b/i.test(request.prompt);
  const needsVision = !isSearchQuery && request.screenshot;

  if (needsVision) {
    try {
      // 8-second timeout on vision call so it can never hang forever
      const vision = await import('./vision.js');
      const screenState = await Promise.race([
        vision.analyzeScreen(request.screenshot!, request.prompt),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Vision timeout after 8s')), 8000)
        ),
      ]);

      userPrompt += `\n\n[VISION ANALYSIS OF CURRENT SCREEN]:`;
      userPrompt += `\n- Page type: ${screenState.pageType}`;
      userPrompt += `\n- Search box visible: ${screenState.hasSearchBox}`;
      userPrompt += `\n- Forms visible: ${screenState.hasForms}`;
      userPrompt += `\n- What's on screen: ${screenState.mainContentDescription}`;
      userPrompt += `\n- Suggested action: ${screenState.suggestedAction}`;

      if (screenState.searchInputHint) {
        userPrompt += `\n- Search input found: ${screenState.searchInputHint}`;
      }
      if (screenState.uiElements.length > 0) {
        userPrompt += `\n- Visible UI elements:`;
        screenState.uiElements.forEach(el => {
          userPrompt += `\n  • ${el.type}: "${el.description}"${el.likelySelector ? ` [selector hint: ${el.likelySelector}]` : ''}`;
        });
      }
      userPrompt += `\n\nUse this visual context to generate the most accurate and targeted plan.`;

      console.log('[ASTRA] Vision analysis completed for planning:', screenState.pageType, screenState.suggestedAction);
    } catch (err) {
      console.warn('[ASTRA] Vision analysis skipped:', (err as Error).message);
    }
  } else if (isSearchQuery) {
    console.log('[ASTRA] Skipping vision for search query — using text-only planning (fast path)');
  }

  const plan = await chatJSON<StepPlan>(PLANNER_SYSTEM_PROMPT, userPrompt);
  console.log('[ASTRA] Planner generated:', JSON.stringify(plan, null, 2));

  // Validate plan structure
  if (!plan.intent || !plan.category || !Array.isArray(plan.steps)) {
    throw new Error('Invalid plan structure from LLM');
  }

  return plan;
}

