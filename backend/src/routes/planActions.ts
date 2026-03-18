import type { FastifyInstance } from 'fastify';
import { parseUserIntent, planPageActions } from '../agents/pageIntelligence.js';
import type { ParsedIntent, PlannedAction } from '../agents/pageIntelligence.js';
import { performWebResearch } from '../agents/webResearch.js';
import type { BrowserSnapshot } from '../agents/pageIntelligence.js';
import { normalizeRegion, getRegionalUrl } from '../config/regionalUrls.js';
import { isSafe } from '../agents/critic.js';
import { workingGet, workingSet, recall } from '../agents/memory.js';
import { classifyPageState, formatPageStateForPlanner } from '../agents/pageState.js';
import { evaluateGoal } from '../agents/goalEvaluator.js';

// ─── Session-scoped intent cache ──────────────────────────────────────────────
// Key: `${sessionId}:${query}` — prevents cross-session cache collisions and
// also backs off to the in-process map when Redis is unavailable.
const planActionsIntentCache = new Map<string, ParsedIntent>();

function intentCacheKey(sessionId: string, query: string): string {
    return `${sessionId}:${query.trim().toLowerCase().slice(0, 120)}`;
}

export async function planActionsRoute(app: FastifyInstance) {
    app.post<{
        Body: {
            query: string;
            browserSnapshot: BrowserSnapshot;
            executedActions?: Array<{ label: string; action: string; elementIdx?: number }>;
            stateFeedback?: string;
            /** User region for location-aware URLs (e.g. IN → amazon.in) */
            region?: string;
            /** Session ID — used for memory scoping and intent cache keying */
            sessionId?: string;
            /** JPEG screenshot of the current page — passed to Vision for every planning round */
            screenshot?: string;
            /** High-level intent description extracted by the Planner agent (from /intent response).
             *  Forwarded here so PageIntelligence can use it as a seed instead of parsing cold. */
            plannerHint?: string;
        };
    }>('/plan-actions', async (request, reply) => {
        const {
            query, browserSnapshot, executedActions, stateFeedback,
            region: regionRaw, sessionId = 'default',
            screenshot, plannerHint,
        } = request.body;

        if (!query || !browserSnapshot) {
            return reply.status(400).send({ error: 'query and browserSnapshot are required' });
        }

        try {
            console.log(`[PlanActions] Query: "${query}" | Session: ${sessionId} | Elements: ${browserSnapshot.activeTab.interactiveElements?.length ?? 0}`);

            // ── Phase 1: Parse intent ─────────────────────────────────────────
            // On continuation rounds, skip re-parsing — intent doesn't change.
            // Order of preference:
            //   a) In-process cache (fastest — already parsed this session)
            //   b) Working memory (Redis — survives server restart within TTL)
            //   c) Re-parse via LLM
            const isContinuation = executedActions && executedActions.length > 0;
            const cacheKey = intentCacheKey(sessionId, query);

            let intent: ParsedIntent;
            if (isContinuation) {
                // Try in-process cache first, then Redis working memory
                const inProcess = planActionsIntentCache.get(cacheKey);
                const fromMemory = inProcess ?? await workingGet<ParsedIntent>(`intent:${cacheKey}`, sessionId).catch(() => null);
                intent = fromMemory ?? await parseUserIntent(query, plannerHint);
            } else {
                intent = await parseUserIntent(query, plannerHint);
                // Cache in-process and persist to working memory (1h TTL)
                planActionsIntentCache.set(cacheKey, intent);
                workingSet(`intent:${cacheKey}`, intent, sessionId, 3600).catch(() => { /* non-fatal */ });
            }

            // ── Phase 1b: Memory recall ───────────────────────────────────────
            // Recall similar past sessions so the planner can benefit from
            // previously learned navigation patterns for this site/task.
            // Non-blocking — failure doesn't break planning.
            let memoryContext: string | undefined;
            if (!isContinuation) {
                try {
                    const memories = await recall(query, 3, sessionId);
                    const relevant = [
                        ...memories.episodic.map(m => m.text),
                        ...memories.semantic.map(m => m.text),
                    ].filter(Boolean).slice(0, 3);
                    if (relevant.length) {
                        memoryContext = `PAST SESSION CONTEXT (similar tasks):\n${relevant.map(m => `- ${m}`).join('\n')}`;
                        console.log(`[PlanActions] Memory: ${relevant.length} relevant past sessions recalled`);
                    }
                } catch { /* memory failure is non-fatal */ }
            }

            // ── Phase 2: Web research ─────────────────────────────────────────
            const needsResearch = !isContinuation && (
                intent.needsWebResearch ||
                intent.taskType === 'research' ||
                // For shopping: only research if needsWebResearch is explicitly true OR
                // we are NOT already on the target e-commerce site.
                // If we're on amazon.in searching baby products, no docs needed — just search.
                (intent.taskType === 'shopping' && (
                    intent.needsWebResearch ||
                    !intent.targetSite ||
                    !browserSnapshot.activeTab.url.toLowerCase().includes(intent.targetSite.toLowerCase())
                ))
            );

            let webContext: string | undefined;
            if (needsResearch) {
                // For shopping/navigation tasks, research the PRODUCT/CONTENT — not the site name.
                // targetSite (e.g. "amazon", "flipkart") identifies WHERE to shop, not WHAT to find.
                // Using targetSite as the search query returns site documentation, not product guides.
                const researchQuery = (intent.taskType === 'shopping' || intent.taskType === 'navigation')
                    ? (intent.searchQuery ?? query)
                    : (intent.targetSite ?? intent.searchQuery ?? query);
                console.log(`[PlanActions] Running web research for: "${researchQuery}" (taskType=${intent.taskType})`);
                const research = await performWebResearch(query, browserSnapshot.activeTab.url, researchQuery);
                if (research.found) {
                    webContext = research.summary;
                    console.log(`[PlanActions] Web research found guide (${research.sources.length} sources)`);
                }
            } else if (isContinuation) {
                console.log(`[PlanActions] Skipping web research on continuation round (${executedActions!.length} prior actions)`);
            }

            // Merge memory context into web context if available
            if (memoryContext) {
                webContext = webContext ? `${webContext}\n\n${memoryContext}` : memoryContext;
            }

            // ── Phase 2b: Page State Classification ──────────────────────────
            // Classify what kind of interaction screen is currently visible
            // (login wall, cookie consent, CAPTCHA, profile picker, etc.).
            // Zero latency — pure pattern matching, no LLM call.
            // Result is injected into stateFeedback as a structured TOON block
            // so the planner can make deterministic decisions about blockers.
            const pageState = classifyPageState(browserSnapshot);
            const pageStateBlock = formatPageStateForPlanner(pageState);
            const enrichedStateFeedback = pageStateBlock
                ? (stateFeedback ? `${pageStateBlock}\n${stateFeedback}` : pageStateBlock)
                : stateFeedback;

            if (pageState.state !== 'normal') {
                console.log(`[PlanActions|PageState] Detected: ${pageState.state} (${(pageState.confidence * 100).toFixed(0)}%) — ${pageState.signals.join(', ')}`);
            }

            // ── Phase 3: Plan concrete actions ───────────────────────────────
            let actions = await planPageActions(
                intent, browserSnapshot, query,
                executedActions, webContext, enrichedStateFeedback,
                screenshot,  // Gap 6: pass screenshot every round
            );

            // ── Phase 4: Apply region to navigate/new_tab URLs ──────────────
            const region = regionRaw != null ? normalizeRegion(regionRaw) : undefined;
            if (region) {
                actions = actions.map((a: PlannedAction) => {
                    if ((a.action === 'navigate' || a.action === 'new_tab') && (a.value || a.selector)) {
                        const url = a.value || a.selector;
                        const resolved = getRegionalUrl(url, region);
                        if (resolved !== url) {
                            return { ...a, ...(a.value ? { value: resolved } : { selector: resolved }) };
                        }
                    }
                    return a;
                });
            }

            // ── Phase 5: Critic safety gate ──────────────────────────────────
            // Run every action through Critic.isSafe() before sending to the extension.
            // → CRITICAL risk: blocked entirely (never reaches the browser)
            // → HIGH risk:     blocked + caller notified via warnings array
            // → MEDIUM risk:   flagged in warnings but allowed to execute
            const safeActions: PlannedAction[] = [];
            const warnings: Array<{ action: string; label: string; riskLevel: string; reasons: string[] }> = [];
            const blockedBycritic: Array<{ action: string; label: string; reasons: string[] }> = [];

            for (const a of actions) {
                if (a.action === 'ask_user' || a.action === 'wait') {
                    safeActions.push(a); // Never block conversational/wait actions
                    continue;
                }
                // Concatenate label + reason + value to give critic full context
                const description = [a.label, a.reason, a.value].filter(Boolean).join(' · ');
                const check = isSafe(description);

                if (check.riskLevel === 'critical' || check.riskLevel === 'high') {
                    blockedBycritic.push({ action: a.action, label: a.label, reasons: check.reasons });
                    console.warn(`[PlanActions|Critic] Blocked ${check.riskLevel} action: "${a.label}"`);
                } else {
                    safeActions.push(a);
                    if (check.riskLevel === 'medium') {
                        warnings.push({ action: a.action, label: a.label, riskLevel: check.riskLevel, reasons: check.reasons });
                        console.warn(`[PlanActions|Critic] Medium-risk action flagged: "${a.label}"`);
                    }
                }
            }
            actions = safeActions;

            // ── Phase 6: Persist plan to working memory ───────────────────────
            // Store the planned actions so future recall() calls can reference
            // what ASTRA did for similar prior tasks.
            if (actions.length > 0) {
                const memText = `Task: "${query}" | Site: ${browserSnapshot.activeTab.url} | Actions: ${actions.map(a => a.label).join(' → ')}`;
                workingSet(`plan:${Date.now()}`, memText, sessionId, 86400).catch(() => { /* non-fatal */ });
            }

            const askAction = actions.find(a => a.action === 'ask_user');

            // ── Phase 7: Goal Evaluation ──────────────────────────────────────
            // When the planner returns no actions, evaluate whether the task is
            // genuinely complete or whether the agent is stuck.
            // Also run when pageState is 'task_complete' as a confirmation check.
            let goalEval: { status: string; confidence: number; reason: string; suggestion?: string } | undefined;
            const shouldEvaluateGoal = actions.length === 0 || pageState.state === 'task_complete';
            if (shouldEvaluateGoal && executedActions && executedActions.length > 0) {
                goalEval = await evaluateGoal(
                    query,
                    executedActions.map(a => ({ label: a.label, success: undefined })),
                    browserSnapshot.activeTab.visibleText ?? '',
                    browserSnapshot.activeTab.url ?? '',
                ).catch(e => {
                    console.warn('[PlanActions|GoalEval] Non-fatal error:', e.message);
                    return undefined;
                });
                if (goalEval) {
                    console.log(`[PlanActions|GoalEval] ${goalEval.status} (${(goalEval.confidence * 100).toFixed(0)}%) — ${goalEval.reason}`);
                }
            }

            return reply.send({
                success: true,
                intent,
                actions,
                pageState: pageState.state !== 'normal' ? {
                    state: pageState.state,
                    confidence: pageState.confidence,
                    actionHint: pageState.actionHint,
                } : undefined,
                goalEval,
                askUser: askAction ? {
                    question: askAction.value || askAction.label,
                    options: askAction.options,
                    category: askAction.category || 'general',
                    context: askAction.reason,
                } : undefined,
                webContext: webContext ? '[Web docs used]' : undefined,
                // Critic feedback surfaced to the extension for logging/UI
                ...(warnings.length > 0 && { warnings }),
                ...(blockedBycritic.length > 0 && { blockedBycritic }),
                summary: `Planned ${actions.length} validated actions.` +
                    `${webContext ? ' (with web research)' : ''}` +
                    `${askAction ? ' (waiting for user input)' : ''}` +
                    `${blockedBycritic.length > 0 ? ` (${blockedBycritic.length} action(s) blocked by safety critic)` : ''}` +
                    `${goalEval ? ` | Goal: ${goalEval.status}` : ''}`,
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error('[PlanActions] Error:', message);
            return reply.status(500).send({ error: message });
        }
    });
}

