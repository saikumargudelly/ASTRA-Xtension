// Planner using TOON output
import type { StepPlan, IntentRequest } from '../types/index.js';

// Configuration patterns for early detection
const CONFIG_PATTERNS = [
  /how (do i|to|can i) (configure|setup|set up|change|update|modify|enable|disable)/i,
  /where (is|are|can i find) (the |my )?(settings?|configuration|options?|preferences)/i,
  /help me (configure|setup|find|change|update)/i,
  /(enable|disable|turn on|turn off|activate|deactivate) .*(setting|option|feature|mode)/i,
  /(privacy|security|account|profile|notification) settings?/i,
  /configure .*(oic|ofsc|oci|oracle|facebook|google|microsoft|aws|azure)/i,
  /i (want to|need to|would like to) (change|update|configure|modify)/i,
  /(step[- ]by[- ]step|walkthrough|guide|tutorial) (for|on|to)/i,
  /(settings?|configuration) (for|in|on) (facebook|oracle|google|microsoft)/i,
];

const PLANNER_SYSTEM_PROMPT = `You are ASTRA's Planner. Output a TOON (Token-Oriented Object Notation) execution plan.

Intent categories: browse | research | summarize | memory | configuration | composite

RULES:
1. NEVER open a new tab to search. ALWAYS use "browser.search" in the CURRENT tab.
2. For "find/search/what are/best/top" queries → ALWAYS use the full research pipeline:
   { search } → { wait 2500ms } → { analyze_page }
3. For summarize/analyze current page → single { analyze_page } step.
4. For settings/how-to/configure questions → single { config.get_walkthrough } step.
5. Extract constraints from the query (rating, price, duration, level, date) and include in intent description.
6. Use ONLY agents: browser, config, summarizer, memory.

Step format: id:1 | agent:browser | action:search | params.value:query | dependsOn:0
Actions: browser→(open_tab|close_tab|scroll|click|type|wait|read_page|analyze_page|search) | config→get_walkthrough | summarizer→(summarize|bullets) | memory→(store|retrieve)

Output ONLY this TOON block (no extra text, no markdown):
intent: ...
category: ...
reasoning: ...
[STEPS]
id:1 | agent:... | action:... | params.key:val
[/STEPS]

EXAMPLES:
User: "find best python courses" (on udemy.com)
intent: Search Udemy for best Python courses and rank results
category: research
reasoning: Full research pipeline on current site.
[STEPS]
id:1 | agent:browser | action:search | params.value:best python courses
id:2 | agent:browser | action:wait | params.duration:2500 | dependsOn:1
id:3 | agent:browser | action:analyze_page | params.maxScrolls:8 | params.scrollDelay:300 | dependsOn:2
[/STEPS]

User: "summarize this page"
intent: Summarize current page
category: summarize
reasoning: Direct page analysis.
[STEPS]
id:1 | agent:browser | action:analyze_page | params.maxScrolls:10 | params.scrollDelay:400
[/STEPS]

User: "how do I enable 2FA on Facebook?"
intent: Enable 2FA on Facebook
category: configuration
reasoning: Config walkthrough request.
[STEPS]
id:1 | agent:config | action:get_walkthrough | params.query:enable two-factor authentication on Facebook
[/STEPS]`;


export async function planIntent(request: IntentRequest): Promise<StepPlan> {
  let userPrompt = `User command: "${request.prompt}"`;

  if (request.context) {
    userPrompt += `\n\nCurrent page context:`;
    if (request.context.url) userPrompt += `\n- URL: ${request.context.url}`;
    if (request.context.title) userPrompt += `\n- Title: ${request.context.title}`;
  }

  // ─── Vision-Informed Planning ───
  // ASTRA utilizes a high-speed Vision model to look at the screen 
  // and intelligently dictate the execution plan based on the visual UI state.
  const needsVision = !!request.screenshot;

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
        screenState.uiElements.slice(0, 10).forEach(el => {
          userPrompt += `\n  • ${el.type}: "${el.description}"${el.likelySelector ? ` [selector hint: ${el.likelySelector}]` : ''}`;
        });
      }
      userPrompt += `\n\nUse this visual context to generate the most accurate and targeted plan.`;

      console.log('[ASTRA] Vision analysis completed for planning:', screenState.pageType, screenState.suggestedAction);
    } catch (err) {
      console.warn('[ASTRA] Vision analysis skipped:', (err as Error).message);
    }
  }
  // Use standard chat instead of chatJSON to get TOON output
  const { chat } = await import('../services/llm.js');

  const rawResponse = await chat(PLANNER_SYSTEM_PROMPT, userPrompt);
  console.log('[ASTRA] Planner generated TOON:\n', rawResponse);

  // Parse TOON back into the StepPlan JSON structure for the API
  const plan: Partial<StepPlan> = { steps: [] };

  const lines = rawResponse.split('\n');
  let parsingSteps = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('[STEPS]')) {
      parsingSteps = true;
      continue;
    }
    if (trimmed.startsWith('[/STEPS]')) {
      parsingSteps = false;
      continue;
    }

    if (!parsingSteps) {
      if (trimmed.startsWith('intent:')) plan.intent = trimmed.substring(7).trim();
      else if (trimmed.startsWith('category:')) plan.category = trimmed.substring(9).trim() as any;
      else if (trimmed.startsWith('reasoning:')) plan.reasoning = trimmed.substring(10).trim();
    } else {
      // Parse a pipe|separated step
      const stepObj: any = { params: {} };
      const chunks = trimmed.split('|');
      for (const chunk of chunks) {
        const colonIdx = chunk.indexOf(':');
        if (colonIdx > 0) {
          const key = chunk.substring(0, colonIdx).trim();
          let val: any = chunk.substring(colonIdx + 1).trim();

          if (!isNaN(Number(val))) val = Number(val);

          if (key.startsWith('params.')) {
            const paramKey = key.substring(7);
            stepObj.params[paramKey] = val;
          } else {
            stepObj[key] = String(val); // id, agent, action are strings
          }
        }
      }
      if (stepObj.id && stepObj.action) {
        plan.steps!.push(stepObj as any);
      }
    }
  }

  // Validate plan structure
  if (!plan.intent || !plan.category || !plan.steps || plan.steps.length === 0) {
    throw new Error('Invalid TOON plan structure from LLM');
  }

  return plan as StepPlan;
}

