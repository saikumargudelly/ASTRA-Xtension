import type { FastifyInstance } from 'fastify';
import { parseUserIntent, planPageActions } from '../agents/pageIntelligence.js';
import type { ParsedIntent, PlannedAction } from '../agents/pageIntelligence.js';
import { performWebResearch } from '../agents/webResearch.js';
import type { BrowserSnapshot } from '../agents/pageIntelligence.js';
import { normalizeRegion, getRegionalUrl } from '../config/regionalUrls.js';
import { isSafe } from '../agents/critic.js';
import { classifyPageState, formatPageStateForPlanner } from '../agents/pageState.js';
import { evaluateGoal } from '../agents/goalEvaluator.js';

const COMPLEX_PLATFORM_HINT = /(ofsc|oracle|oic|oci|salesforce|sap|servicenow|workday|jira|confluence|azure|aws|gcp|cloud)/i;

// ─── Session-scoped intent cache ──────────────────────────────────────────────
// Key: `${sessionId}:${query}` — prevents cross-session cache collisions and
// also backs off to the in-process map when Redis is unavailable.
const planActionsIntentCache = new Map<string, ParsedIntent>();

function intentCacheKey(sessionId: string, query: string): string {
    return `${sessionId}:${query.trim().toLowerCase().slice(0, 120)}`;
}

/**
 * Validate actions against semantic red flags.
 * Prevents LLM from selecting clearly wrong elements (layout controls, resizers, etc.)
 */
function validateActionsSemantics(actions: PlannedAction[], browserSnapshot: BrowserSnapshot): PlannedAction[] {
    return actions.filter(action => {
        // CRITICAL: Block typing into layout controls
        if (action.action === 'type' || action.action === 'click') {
            const selector = (action.selector || '').toLowerCase();
            const label = (action.label || '').toLowerCase();
            
            // Red flags that indicate wrong element selection
            const isBadSelector = selector.includes('layout') && selector.includes('resizer') ||
                                  selector.includes('splitter') ||
                                  selector.includes('layout__input') ||
                                  selector.includes('divider');
            
            const isBadLabel = label.includes('resize') && (label.includes('nav') || label.includes('main')) ||
                               label.includes('layout') && label.includes('resizer') ||
                               label.includes('layout resizer');
            
            if (isBadSelector || isBadLabel) {
                console.warn(`[PlanActions|SEMANTIC_REJECT] ${action.action} into "${label}" (${selector.slice(0, 60)}) - REJECTED as layout control`);
                return false; // REJECT this action
            }
        }
        return true; // ACCEPT
    });
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
            const startTime = Date.now();
            console.log(`[PlanActions] Query: "${query}" | Session: ${sessionId} | Elements: ${browserSnapshot.activeTab.interactiveElements?.length ?? 0}`);

            // ── Phase 1: Parse intent ─────────────────────────────────────────
            // On continuation rounds, skip re-parsing — intent doesn't change.
            // Order of preference:
            //   a) In-process cache (fastest — already parsed this session)
            //   b) Working memory (Redis — survives server restart within TTL)
            //   c) Re-parse via LLM
            const isContinuation = executedActions && executedActions.length > 0;
            const cacheKey = intentCacheKey(sessionId, query);

            const phase1Start = Date.now();
            let intent: ParsedIntent;
            if (isContinuation) {
                // Use in-process cache on continuation rounds — intent doesn't change mid-task
                intent = planActionsIntentCache.get(cacheKey) ?? await parseUserIntent(query, plannerHint);
            } else {
                intent = await parseUserIntent(query, plannerHint);
                planActionsIntentCache.set(cacheKey, intent);
            }
            const phase1Duration = Date.now() - phase1Start;
            const logEntry1 = JSON.stringify({location:'planActions.ts:phase1', timestamp: new Date().toISOString(), sessionId, event: 'intent_parse', duration_ms: phase1Duration, cached: isContinuation});
            console.log(`[PERF] ${logEntry1}`);



            // ── Phase 2: Web research ─────────────────────────────────────────
            const phase2Start = Date.now();
            const isComplexNavigation = intent.taskType === 'navigation' && (
                COMPLEX_PLATFORM_HINT.test(intent.targetSite ?? '') || COMPLEX_PLATFORM_HINT.test(query)
            );
            const needsResearch = !isContinuation && (
                intent.taskType === 'research' ||
                // For shopping: only research if needsWebResearch is explicitly true OR
                // we are NOT already on the target e-commerce site.
                // If we're on amazon.in searching baby products, no docs needed — just search.
                (intent.taskType === 'shopping' && (
                    intent.needsWebResearch ||
                    !intent.targetSite ||
                    !browserSnapshot.activeTab.url.toLowerCase().includes(intent.targetSite.toLowerCase())
                )) ||
                // For navigation/form tasks, web research is useful only on complex enterprise platforms.
                (intent.needsWebResearch && (intent.taskType === 'form_fill' || isComplexNavigation))
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
            const phase2Duration = Date.now() - phase2Start;
            const logEntry2 = JSON.stringify({location:'planActions.ts:phase2', timestamp: new Date().toISOString(), sessionId, event: 'web_research', duration_ms: phase2Duration, needed: needsResearch, sources: webContext ? 'yes' : 'none'});
            console.log(`[PERF] ${logEntry2}`);


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
            const phase3Start = Date.now();
            let actions = await planPageActions(
                intent, browserSnapshot, query,
                executedActions, webContext, enrichedStateFeedback,
                screenshot,  // Gap 6: pass screenshot every round
            );

            // ── Phase 3.5: Semantic validation ───────────────────────────────
            // Reject actions that target clearly wrong elements (layout controls, resizers)
            const actionsBeforeValidation = actions.length;
            actions = validateActionsSemantics(actions, browserSnapshot);
            if (actionsBeforeValidation !== actions.length) {
                console.log(`[PlanActions|SemanticFilter] Rejected ${actionsBeforeValidation - actions.length} invalid actions`);
            }

            const phase3Duration = Date.now() - phase3Start;
            const logEntry3 = JSON.stringify({location:'planActions.ts:phase3', timestamp: new Date().toISOString(), sessionId, event: 'plan_actions', duration_ms: phase3Duration, actionCount: actions.length, hadScreenshot: !!screenshot});
            console.log(`[PERF] ${logEntry3}`);

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
            const phase5Start = Date.now();
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
            const phase5Duration = Date.now() - phase5Start;
            const logEntry5 = JSON.stringify({location:'planActions.ts:phase5', timestamp: new Date().toISOString(), sessionId, event: 'critic', duration_ms: phase5Duration, blocked: blockedBycritic.length, warned: warnings.length});
            console.log(`[PERF] ${logEntry5}`);


            const askAction = actions.find(a => a.action === 'ask_user');

            // ── Phase 7: Goal Evaluation ──────────────────────────────────────
            // When the planner returns no actions, evaluate whether the task is
            // genuinely complete or whether the agent is stuck.
            // Also run when pageState is 'task_complete' as a confirmation check.
            const phase7Start = Date.now();
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
            const phase7Duration = Date.now() - phase7Start;
            const logEntry7 = JSON.stringify({location:'planActions.ts:phase7', timestamp: new Date().toISOString(), sessionId, event: 'goal_eval', duration_ms: phase7Duration, ran: shouldEvaluateGoal});
            console.log(`[PERF] ${logEntry7}`);

            // ─── DEBUG LOGGING ───
            const totalDuration = Date.now() - startTime;
            const debugLog = {
                location: 'planActions.ts:response',
                timestamp: new Date().toISOString(),
                sessionId,
                query,
                actionsCount: actions.length,
                actions: actions.map(a => ({ action: a.action, label: a.label, selector: a.selector?.substring(0, 50), value: a.value?.substring(0, 50), category: a.category })),
                askUser: askAction ? { question: askAction.value || askAction.label, options: askAction.options, category: askAction.category } : null,
                pageState: pageState.state,
                totalDuration_ms: totalDuration,
            };
            console.log(`[DEBUG|PlanActions] ${JSON.stringify(debugLog)}`);

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

