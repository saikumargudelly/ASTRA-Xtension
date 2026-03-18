// ─── NEXUS ReAct Coordinator ──────────────────────────────────────────────────
// The top-level brain. Accepts a natural-language message, runs the ReAct
// (Reason → Act → Observe → Reflect) loop, and streams all progress.
//
// Wraps the existing agent Orchestrator for backward compatibility while
// adding: intent routing, multi-agent selection, ReAct loops, Critic gate.

import { StreamEmitter } from '../llm/streaming.js';
import { chatMessages } from '../services/llm.js';
import { evaluate as criticEvaluate } from '../agents/critic.js';
import { recall, workingSet, storeMemoryDirect } from '../agents/memory.js';
import { getOrchestrator } from '../agents/orchestrator/index.js';
import { performWebResearch } from '../agents/webResearch.js';
import type { LLMMessage } from '../types/index.js';

// ─── Types ─────────────────────────────────────────────────────────────────────
export interface CoordinatorConfig {
    maxReActIterations: number;   // default: 8
    reflectionThreshold: number;  // trigger critic if confidence below this
    taskTimeoutMs: number;        // default: 60000
    enableCritic: boolean;        // default: true
    enableMemory: boolean;        // default: true
}

export interface NexusTask {
    message: string;
    sessionId: string;
    context?: {
        url?: string;
        title?: string;
        screenshot?: string;
    };
}

export type NexusTaskCategory =
    | 'browse'
    | 'research'
    | 'code'
    | 'files'
    | 'productivity'
    | 'system'
    | 'composite'
    | 'voice'
    | 'schedule'
    | 'simple-qa';

interface ReActState {
    iteration: number;
    thoughts: string[];
    actions: string[];
    observations: string[];
}

// ─── Default Config ────────────────────────────────────────────────────────────
const DEFAULT_CONFIG: CoordinatorConfig = {
    maxReActIterations: 8,
    reflectionThreshold: 0.7,
    taskTimeoutMs: 60000,
    enableCritic: true,
    enableMemory: true,
};

// ─── Intent Classification Prompt ─────────────────────────────────────────────
const INTENT_SYSTEM_PROMPT = `You are NEXUS's Intent Classifier. Classify the user's message.

Categories:
- browse: Navigate/interact with websites, click, fill forms
- research: Search, gather info from multiple sources, analyze
- code: Write, debug, run, or explain code
- files: Read, write, move, organize files
- productivity: Email, calendar, tasks, documents
- system: Terminal commands, OS operations, app control
- composite: Multiple categories needed
- voice: Speech/audio related
- schedule: Plan future tasks, reminders
- simple-qa: General Q&A, no tool use needed

Return ONLY this JSON:
{"category": "research", "confidence": 0.9, "requiresTools": true, "estimatedSteps": 3, "reasoning": "brief reason"}`;

// ─── ReAct System Prompt ────────────────────────────────────────────────────────
function buildReActPrompt(
    category: NexusTaskCategory,
    memory: string,
    iteration: number,
    history: string,
): string {
    return `You are NEXUS, a super-intelligent AI assistant with advanced critical thinking, adaptive problem-solving, and live web research capabilities.

Task category: ${category}
Current iteration: ${iteration}

${memory ? `Relevant memory:\n${memory}\n` : ''}

You operate in ReAct loops: Reason → Act → Observe → Reflect → Adapt.

${history ? `Previous steps:\n${history}\n` : ''}

CRITICAL THINKING PROTOCOL — follow this EVERY iteration:

Step 1 — SITUATIONAL AWARENESS:
  • What do I already know? What observations have I gathered?
  • What do I still NOT know? What gaps remain?
  • Has any previous action failed or returned unexpected results?

Step 2 — HYPOTHESIS FORMATION:
  • What is the most likely answer given current evidence?
  • What alternative explanations or paths should I consider?
  • Could prior observations be misleading or incomplete?

Step 3 — STRATEGIC ACTION SELECTION:
  Choose ONE action from: [search_web, analyze_page, recall_memory, answer_directly]
  • search_web   → { "query": "search terms", "url": "optional current page url" }
  • analyze_page → { "selector": "optional CSS selector" }
  • recall_memory→ { "query": "memory query" }
  • answer_directly → { "answer": "your response" }  — only after real observations exist

Step 4 — CONFIDENCE CALIBRATION:
  • Rate your confidence 0.0–1.0 honestly.
  • If confidence < 0.7 after observations, search again with a DIFFERENT query angle.
  • If two searches returned no results, reformulate with broader/narrower terms before giving up.

ADAPTIVE RULES:
- You MUST call search_web before answer_directly for any factual/research/browser query
- answer_directly is ONLY valid after at least one search_web or analyze_page observation
- NEVER set isComplete=true on iteration 1 or when you have zero prior observations
- NEVER generate a finalAnswer from training knowledge — all answers must cite real observations
- If unsure what to search, use the full user task as the search query
- If a search returned poor results, try a DIFFERENT query formulation (more specific, different keywords, different angle)
- If you have 2+ observations that partially answer the question, SYNTHESIZE them before deciding you need more
- When answering, cite specific data from observations — don't just summarize vaguely

SELF-CORRECTION:
- If you realize a previous action was wrong or unproductive, acknowledge it and change strategy
- If observations contradict each other, investigate further before concluding
- Track which queries worked and which didn't — don't repeat failed patterns

Return ONLY this JSON:
{
  "thought": "your detailed reasoning following the 4-step protocol above",
  "action": "action_name",
  "actionParams": {"key": "value"},
  "isComplete": false,
  "confidence": 0.8,
  "finalAnswer": null,
  "reflection": "what I learned from previous steps and how it shapes my next move"
}

If isComplete=true, finalAnswer MUST be grounded in your search_web/analyze_page observations above.`;
}

// ─── Coordinator Class ─────────────────────────────────────────────────────────
export class NexusCoordinator {
    private config: CoordinatorConfig;

    constructor(config: Partial<CoordinatorConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    // ─── Main Task Stream ──────────────────────────────────────────────────────
    async *streamTask(task: NexusTask): AsyncGenerator<import('../llm/streaming.js').StreamEvent> {
        const startTime = Date.now();
        const { message, sessionId, context } = task;

        yield { type: 'thinking', text: 'Classifying intent...' };

        // Step 1: Classify intent
        const category = await this.classifyIntent(message);
        yield { type: 'action', agent: 'coordinator', action: 'intent_classified', params: { category } };

        // Step 2: Load relevant memory
        let memoryContext = '';
        if (this.config.enableMemory) {
            try {
                const memories = await recall(message, 6, sessionId);
                const episodicItems = memories.episodic.map((m) => m.text).join('\n');
                const semanticItems = memories.semantic.map((m) => m.text).join('\n');
                memoryContext = [episodicItems, semanticItems].filter(Boolean).join('\n');
                if (memoryContext) {
                    yield { type: 'thinking', text: `Found ${memories.episodic.length + memories.semantic.length} relevant memories` };
                }
            } catch {
                // Memory errors are non-fatal
            }
        }

        // Step 3: For simple-qa, skip ReAct loop and answer directly
        if (category === 'simple-qa') {
            yield { type: 'agent_start', agent: 'coordinator' };
            yield* this.handleSimpleQA(message, memoryContext, sessionId);
            return;
        }

        // Step 4: For browser/research tasks route through existing orchestrator (backward compat)
        if (category === 'browse' || category === 'research') {
            yield { type: 'agent_start', agent: 'planner' };
            yield { type: 'thinking', text: 'Generating execution plan...' };
            yield* this.handleBrowserResearch(message, context, sessionId);
            return;
        }

        // Step 5: ReAct loop for composite/complex tasks
        yield { type: 'thinking', text: `Starting ReAct loop for '${category}' task...` };
        const result = yield* this.runReActLoop(message, category, memoryContext, sessionId);

        // Step 6: Critic gate
        if (this.config.enableCritic && result) {
            const score = await criticEvaluate(result, message);
            if (score.overall < this.config.reflectionThreshold) {
                yield { type: 'thinking', text: `Quality score ${score.overall.toFixed(2)} — improving response...` };
            }
        }

        // Step 7: Store this interaction in memory
        if (this.config.enableMemory && result) {
            const duration = Date.now() - startTime;
            await storeMemoryDirect(
                `Task: "${message}" → Result: ${result.substring(0, 500)}`,
                { sessionId, category, duration: duration.toString() },
            ).catch(() => { /* non-fatal */ });
        }
    }

    // ─── Intent Classification ─────────────────────────────────────────────────
    private async classifyIntent(message: string): Promise<NexusTaskCategory> {
        try {
            const response = await chatMessages(
                [
                    { role: 'system', content: INTENT_SYSTEM_PROMPT },
                    { role: 'user', content: message },
                ],
                'planning',
            );

            const jsonMatch = response.content.match(/(\{[\s\S]*\})/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[1]) as { category: NexusTaskCategory };
                return parsed.category;
            }
        } catch (err) {
            console.warn('[Coordinator] Intent classification failed:', (err as Error).message);
        }
        return 'simple-qa';
    }

    // ─── Simple Q&A Handler ────────────────────────────────────────────────────
    private async *handleSimpleQA(
        message: string,
        memoryContext: string,
        _sessionId: string,
    ): AsyncGenerator<import('../llm/streaming.js').StreamEvent> {
        const systemPrompt = `You are NEXUS, a helpful AI assistant.${memoryContext ? `\n\nRelevant context from memory:\n${memoryContext}` : ''}`;

        const messages: LLMMessage[] = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: message },
        ];

        const { chatStream } = await import('../services/llm.js');
        yield* chatStream(messages, 'simple-qa');
    }

    // ─── Browser/Research Handler ─────────────────────────────────────────────
    // When called from /chat (no Chrome content script connection), the orchestrator's
    // browser steps will fail/timeout. We try quickly — if it fails, fall back to
    // a pure LLM answer using the model's web knowledge.
    private async *handleBrowserResearch(
        message: string,
        context: NexusTask['context'],
        sessionId: string,
    ): AsyncGenerator<import('../llm/streaming.js').StreamEvent> {
        try {
            const { planIntent } = await import('../agents/planner.js');
            const plan = await planIntent({
                prompt: message,
                context: { url: context?.url, title: context?.title },
                screenshot: context?.screenshot,
            });

            yield { type: 'action', agent: 'planner', action: 'plan_ready', params: { intent: plan.intent, steps: plan.steps.length } };
            yield { type: 'thinking', text: `Plan: ${plan.intent} (${plan.steps.length} steps)` };

            // Wrap orchestrator in a short timeout — if no content script is connected
            // (i.e. called from popup via /chat instead of background script), it will
            // time out and we fall through to the LLM fallback below.
            const orchestratorResult = await Promise.race([
                (async () => {
                    const orchestrator = getOrchestrator();
                    return await orchestrator.orchestrate({
                        plan,
                        prompt: message,
                        context: { sessionId, url: context?.url, title: context?.title },
                    });
                })(),
                new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000)),
            ]);

            if (
                orchestratorResult &&
                orchestratorResult.summary &&
                orchestratorResult.summary.length > 100 &&
                !orchestratorResult.summary.includes('completed successfully') &&
                !orchestratorResult.summary.includes('Page analysis completed')
            ) {
                // ── Critic gate for browse/research results ──────────────────
                if (this.config.enableCritic) {
                    const score = await criticEvaluate(orchestratorResult.summary, message);
                    if (score.overall < this.config.reflectionThreshold) {
                        yield { type: 'thinking', text: `Quality score ${score.overall.toFixed(2)} — response may be incomplete.` };
                    }
                }
                yield { type: 'token', text: orchestratorResult.summary };
                yield { type: 'agent_done', agent: 'browser', durationMs: orchestratorResult.duration ?? 0 };
                yield { type: 'done' };
                return;
            }

            // Orchestrator timed out or returned empty/generic result (no content script)
            yield { type: 'thinking', text: 'Browser agent not available — running live web research...' };
        } catch (err) {
            yield { type: 'thinking', text: 'Browser agent unavailable — running live web research...' };
            console.warn('[Coordinator] Browser orchestrator failed:', (err as Error).message);
        }

        // ── Live Web Research — grounded responses only, never synthetic ─────────
        // We NEVER answer from LLM training knowledge alone. Always fetch real data first.
        yield { type: 'agent_start', agent: 'webResearch' };
        yield { type: 'thinking', text: 'Fetching live web data...' };

        let webGrounding = '';
        let webSources: string[] = [];
        try {
            const research = await performWebResearch(message, context?.url ?? '', message);
            if (research.found && research.summary) {
                webGrounding = research.summary;
                webSources = research.sources;
                yield { type: 'thinking', text: `Web research complete — ${research.sources.length} source(s) consulted` };
            }
        } catch (researchErr) {
            console.warn('[Coordinator] Web research failed:', (researchErr as Error).message);
        }

        if (!webGrounding) {
            // Both browser automation AND live web research produced no data — be honest
            yield {
                type: 'error',
                message: 'ASTRA could not retrieve live data for this query. Please open a relevant page in a browser tab, or check your internet connection and try again.',
            };
            yield { type: 'done' };
            return;
        }

        // Synthesize final answer grounded ONLY in real fetched data
        const { chatStream } = await import('../services/llm.js');
        const sourceLine = webSources.length
            ? `\n\nSources consulted:\n${webSources.slice(0, 3).map(s => `- ${s}`).join('\n')}`
            : '';
        const groundedSystem = `You are ASTRA, a browser intelligence assistant.
Answer the user's question using ONLY the retrieved web content below. Do not add any information not present in the sources. Be specific and factual.

RETRIEVED WEB CONTENT:
${webGrounding}${sourceLine}`;

        yield* chatStream(
            [
                { role: 'system', content: groundedSystem },
                { role: 'user', content: message },
            ],
            'research',
        );
        yield { type: 'done' };
    }

    // ─── ReAct Loop ───────────────────────────────────────────────────────────
    private async *runReActLoop(
        task: string,
        category: NexusTaskCategory,
        memoryContext: string,
        sessionId: string,
    ): AsyncGenerator<import('../llm/streaming.js').StreamEvent, string | null> {
        const state: ReActState = { iteration: 0, thoughts: [], actions: [], observations: [] };
        let finalAnswer: string | null = null;
        let consecutiveFailures = 0;
        const failedQueries = new Set<string>();  // Track failed search queries to avoid repeats

        while (state.iteration < this.config.maxReActIterations) {
            state.iteration++;
            consecutiveFailures = 0;

            const history = state.thoughts.map((t, i) =>
                `Iteration ${i + 1}:\nThought: ${t}\nAction: ${state.actions[i]}\nObservation: ${state.observations[i] ?? 'pending'}${failedQueries.size > 0 ? `\n(Failed queries so far: ${[...failedQueries].join(', ')})` : ''}`,
            ).join('\n\n');

            yield { type: 'thinking', text: `ReAct iteration ${state.iteration}/${this.config.maxReActIterations}` };

            try {
                const response = await chatMessages(
                    [
                        { role: 'system', content: buildReActPrompt(category, memoryContext, state.iteration, history) },
                        { role: 'user', content: `Task: ${task}` },
                    ],
                    'planning',
                );

                const jsonMatch = response.content.match(/(\{[\s\S]*\})/);
                if (!jsonMatch) {
                    yield { type: 'thinking', text: 'ReAct: parsing response...' };
                    consecutiveFailures++;
                    if (consecutiveFailures >= 2) {
                        yield { type: 'thinking', text: 'Multiple parse failures — falling back to direct search...' };
                        // Force a web search as fallback
                        try {
                            const fallbackObs = await this.executeReActAction('search_web', { query: task }, sessionId);
                            state.thoughts.push('Parse failure fallback — forcing web search');
                            state.actions.push('search_web [fallback]');
                            state.observations.push(fallbackObs);
                        } catch { /* skip */ }
                    }
                    continue;
                }

                const step = JSON.parse(jsonMatch[1]) as {
                    thought: string;
                    action: string;
                    actionParams: Record<string, unknown>;
                    isComplete: boolean;
                    confidence: number;
                    finalAnswer: string | null;
                    reflection?: string;
                };

                state.thoughts.push(step.thought);
                state.actions.push(step.action);

                yield { type: 'thinking', text: step.thought };
                if (step.reflection) {
                    yield { type: 'thinking', text: `💭 Reflection: ${step.reflection}` };
                }
                yield { type: 'action', agent: 'coordinator', action: step.action, params: step.actionParams };

                // Guard: never finalize without real observations — prevents hallucination
                if (step.isComplete && step.finalAnswer && state.observations.length === 0) {
                    yield { type: 'thinking', text: 'No real data yet — running web search before answering...' };
                    state.thoughts.push(step.thought);
                    state.actions.push('search_web [forced — no observations yet]');
                    try {
                        const forcedObs = await this.executeReActAction(
                            'search_web',
                            { query: task },
                            sessionId,
                        );
                        state.observations.push(forcedObs);
                    } catch (forceErr) {
                        state.observations.push(`Web search failed: ${(forceErr as Error).message}`);
                    }
                    continue;
                }

                // Quality gate: low confidence + has observations → re-search with different angle
                if (step.isComplete && step.finalAnswer && step.confidence < 0.6 && state.iteration < this.config.maxReActIterations - 1) {
                    yield { type: 'thinking', text: `Low confidence (${step.confidence.toFixed(2)}) — searching for more evidence...` };
                    state.observations.push(`[Self-check] Answer confidence too low (${step.confidence}). Need more evidence.`);
                    continue;
                }

                if (step.isComplete && step.finalAnswer) {
                    finalAnswer = step.finalAnswer;
                    yield { type: 'token', text: step.finalAnswer };
                    yield { type: 'done' };
                    return finalAnswer;
                }

                // Execute the action and record observation
                try {
                    const observation = await this.executeReActAction(step.action, step.actionParams, sessionId);
                    state.observations.push(observation);

                    // Track queries that returned no useful results
                    if (step.action === 'search_web' && observation.includes('returned no usable results')) {
                        const query = String(step.actionParams.query ?? '');
                        failedQueries.add(query);
                    }

                    yield { type: 'result', data: { action: step.action, observation: observation.substring(0, 200) } };
                } catch (actionErr) {
                    const errMsg = `Action "${step.action}" failed: ${(actionErr as Error).message}`;
                    state.observations.push(errMsg);
                    yield { type: 'thinking', text: `⚠️ ${errMsg} — adapting strategy...` };
                    consecutiveFailures++;
                }

            } catch (err) {
                yield { type: 'error', message: `ReAct iteration ${state.iteration} failed: ${(err as Error).message}` };
                consecutiveFailures++;
                if (consecutiveFailures >= 3) {
                    yield { type: 'thinking', text: 'Multiple consecutive failures — stopping loop.' };
                    break;
                }
            }
        }

        // Max iterations reached — synthesize best answer from observations
        if (!finalAnswer && state.observations.length > 0) {
            // Use LLM to synthesize a proper answer from all observations instead of just concatenating
            try {
                const synthesisResponse = await chatMessages(
                    [
                        { role: 'system', content: `You are NEXUS. Synthesize a comprehensive, accurate answer from these research observations. Only use information from the observations — never add from training knowledge.\n\nObservations:\n${state.observations.join('\n\n')}` },
                        { role: 'user', content: `Original task: ${task}` },
                    ],
                    'research',
                );
                finalAnswer = synthesisResponse.content;
            } catch {
                finalAnswer = `Based on my research: ${state.observations.filter(o => !o.startsWith('[Self-check]')).join(' ')}`;
            }
            yield { type: 'token', text: finalAnswer };
        }

        yield { type: 'done' };
        return finalAnswer;
    }

    // ─── Action Executor ──────────────────────────────────────────────────────
    private async executeReActAction(
        action: string,
        params: Record<string, unknown>,
        sessionId: string,
    ): Promise<string> {
        switch (action) {
            case 'recall_memory': {
                const query = String(params.query ?? '');
                const memories = await recall(query, 5, sessionId);
                const items = [
                    ...memories.episodic.map((m) => m.text),
                    ...memories.semantic.map((m) => m.text),
                ];
                return items.length ? items.join('\n') : 'No relevant memories found.';
            }

            case 'answer_directly': {
                return String(params.answer ?? 'No answer provided');
            }

            case 'search_web': {
                const query = String(params.query ?? '');
                const url   = String(params.url   ?? '');
                if (!query) return 'No search query provided.';
                try {
                    const research = await performWebResearch(query, url, query);
                    if (research.found && research.summary) {
                        const srcLine = research.sources.length
                            ? `\nSources: ${research.sources.slice(0, 3).join(', ')}`
                            : '';
                        return research.summary + srcLine;
                    }
                    return `Web research for "${query}" returned no usable results.`;
                } catch (err) {
                    return `Web research failed: ${(err as Error).message}`;
                }
            }
            case 'read_file': {
                throw new Error(
                    'File system access is not available in this environment. Reformulate using search_web to find the information online instead.',
                );
            }
            case 'run_code': {
                throw new Error(
                    'Code execution is not available in this environment. Use search_web to find relevant documentation or examples instead.',
                );
            }

            default:
                throw new Error(
                    `Action "${action}" is not available. Use one of: search_web, recall_memory, analyze_page, answer_directly.`,
                );
        }
    }
}

// ─── Singleton ─────────────────────────────────────────────────────────────────
let coordinatorInstance: NexusCoordinator | null = null;

export function getNexusCoordinator(config?: Partial<CoordinatorConfig>): NexusCoordinator {
    if (!coordinatorInstance) {
        coordinatorInstance = new NexusCoordinator(config);
    }
    return coordinatorInstance;
}
