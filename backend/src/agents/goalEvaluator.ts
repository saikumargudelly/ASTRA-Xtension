// ─── Goal Evaluator Agent ──────────────────────────────────────────────────────
// Determines whether the user's original task has been fulfilled given the
// current page state and execution history.
//
// Why this exists:
//   The planner loop currently terminates when the planner returns an empty
//   action list — which can mean either "task complete" OR "I'm stuck".
//   The GoalEvaluator makes this distinction explicit, enabling:
//     1. Clean task completion detection → loop exits with success
//     2. Stuck detection → loop retries with a different strategy
//     3. Partial completion → loop continues with remaining steps
//
// Designed to be fast: TOON output, ~1 LLM call per evaluation.
// Called at most once per round, only when actions.length === 0 OR
// after every N actions when a check is needed (controlled by caller).

import { chat } from '../services/llm.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type GoalStatus =
    | 'complete'      // Task is fully done — the page shows the expected outcome
    | 'in_progress'   // Some progress made but not finished — keep going
    | 'stuck'         // Actions not advancing — planner needs a new strategy
    | 'failed';       // Task cannot be completed (blocked, not found, etc.)

export interface GoalEvaluation {
    status: GoalStatus;
    /** 0.0 – 1.0 — confidence in the classification */
    confidence: number;
    /** Why the evaluator reached this conclusion */
    reason: string;
    /** If status === 'stuck', what the evaluator suggests trying next */
    suggestion?: string;
}

// ─── Fast heuristic pre-check (no LLM) ────────────────────────────────────────
// Runs before the LLM call and short-circuits in obvious cases.

const COMPLETION_SIGNALS: Array<{ pattern: RegExp; hint: string }> = [
    { pattern: /order confirmed|order placed|thank you for your (order|purchase)/i, hint: 'Purchase order confirmed' },
    { pattern: /message sent|your message has been sent/i, hint: 'Message sent successfully' },
    { pattern: /successfully (signed|logged) (in|out)/i, hint: 'Auth action completed' },
    { pattern: /now playing|currently playing|video is playing/i, hint: 'Media playback started' },
    { pattern: /successfully (saved|updated|deleted|removed|uploaded)/i, hint: 'Data mutation completed' },
    { pattern: /download (started|complete)/i, hint: 'Download action completed' },
    { pattern: /form (submitted|sent)|submission (received|confirmed)/i, hint: 'Form submitted' },
    { pattern: /search results for|showing \d+ result/i, hint: 'Search results displayed' },
];

const STUCK_SIGNALS: Array<{ pattern: RegExp; hint: string }> = [
    { pattern: /page not found|404/i, hint: '404 error page' },
    { pattern: /access denied|permission denied|forbidden/i, hint: 'Access denied' },
    { pattern: /something went wrong|unexpected error/i, hint: 'Site error' },
    { pattern: /captcha|are you human/i, hint: 'CAPTCHA blocker' },
    { pattern: /requires login|please sign in to continue/i, hint: 'Auth gate' },
];

function heuristicEval(
    originalQuery: string,
    visibleText: string,
    currentUrl: string,
    executedCount: number,
): GoalEvaluation | null {

    const text = visibleText.toLowerCase();

    // Check completion signals
    for (const sig of COMPLETION_SIGNALS) {
        if (sig.pattern.test(visibleText)) {
            return {
                status: 'complete',
                confidence: 0.95,
                reason: `Completion indicator detected: ${sig.hint}`,
            };
        }
    }

    // Check stuck signals (only relevant if some actions were attempted)
    if (executedCount > 0) {
        for (const sig of STUCK_SIGNALS) {
            if (sig.pattern.test(visibleText)) {
                return {
                    status: 'stuck',
                    confidence: 0.9,
                    reason: `Blocker detected: ${sig.hint}`,
                    suggestion: 'Navigate back or try a different approach to bypass the blocker.',
                };
            }
        }
    }

    return null; // No heuristic match — proceed to LLM evaluation
}

// ─── LLM Evaluator ────────────────────────────────────────────────────────────

const GOAL_EVAL_SYSTEM_PROMPT = `You are ASTRA's Goal Evaluator. Your job is to determine whether a browser automation task has been completed.

You are given:
1. The user's original task/query
2. A list of actions ASTRA has executed
3. The current page URL and visible text

Return ONLY this TOON block (no extra text):
[GOAL_EVAL]
status: complete|in_progress|stuck|failed
confidence: 0.0
reason: brief one-line explanation
suggestion: what to try next (only required if status is stuck or failed)
[/GOAL_EVAL]

STATUS DEFINITIONS:
- complete:     The page content confirms the task is fully done (results shown, purchase made, video playing, etc.)
- in_progress:  Progress is being made but more actions are needed (navigating, loading, mid-flow)
- stuck:        Multiple actions taken but not advancing — something is blocking progress
- failed:       Task cannot be completed on this page/session (wrong site, blocked, 404, etc.)

RULES:
- Be conservative: only say "complete" if the page CLEARLY shows task completion.
- Never say "complete" just because actions were executed — results must be visible.
- "stuck" means the agent should try a DIFFERENT strategy, not retry the same.`;

/**
 * Evaluates whether the original task has been fulfilled.
 *
 * @param originalQuery  The user's original natural language request
 * @param executedActions  Array of actions taken so far (label + success)
 * @param visibleText  Current page visible text (from DOM snapshot)
 * @param currentUrl  Current page URL
 */
export async function evaluateGoal(
    originalQuery: string,
    executedActions: Array<{ label: string; success?: boolean }>,
    visibleText: string,
    currentUrl: string,
): Promise<GoalEvaluation> {
    // 1. Fast heuristic check first (no LLM latency)
    const heuristic = heuristicEval(originalQuery, visibleText, currentUrl, executedActions.length);
    if (heuristic) {
        console.log(`[GoalEvaluator] Heuristic result: ${heuristic.status} — ${heuristic.reason}`);
        return heuristic;
    }

    // 2. LLM evaluation
    const actionSummary = executedActions.length === 0
        ? 'No actions executed yet.'
        : executedActions.map((a, i) =>
            `${i + 1}. ${a.label}${a.success === false ? ' [FAILED]' : ''}`
        ).join('\n');

    const userPrompt = [
        `ORIGINAL TASK: "${originalQuery}"`,
        ``,
        `EXECUTED ACTIONS (${executedActions.length} total):`,
        actionSummary,
        ``,
        `CURRENT PAGE:`,
        `URL: ${currentUrl}`,
        `VISIBLE TEXT (first 800 chars):`,
        visibleText.slice(0, 800),
    ].join('\n');

    try {
        const response = await chat(GOAL_EVAL_SYSTEM_PROMPT, userPrompt, 'simple-qa');

        // Parse TOON response
        const block = response.match(/\[GOAL_EVAL\]([\s\S]*?)\[\/GOAL_EVAL\]/i)?.[1] ?? response;
        const result: GoalEvaluation = { status: 'in_progress', confidence: 0.5, reason: 'LLM parse fallback' };

        for (const line of block.split('\n').map(l => l.trim()).filter(Boolean)) {
            const colon = line.indexOf(':');
            if (colon < 0) continue;
            const key = line.slice(0, colon).trim().toLowerCase();
            const val = line.slice(colon + 1).trim();

            if (key === 'status' && ['complete', 'in_progress', 'stuck', 'failed'].includes(val)) {
                result.status = val as GoalStatus;
            } else if (key === 'confidence') {
                const n = parseFloat(val);
                if (!isNaN(n)) result.confidence = Math.min(1, Math.max(0, n));
            } else if (key === 'reason') {
                result.reason = val;
            } else if (key === 'suggestion') {
                result.suggestion = val;
            }
        }

        console.log(`[GoalEvaluator] LLM result: ${result.status} (${(result.confidence * 100).toFixed(0)}%) — ${result.reason}`);
        return result;

    } catch (err) {
        // Non-fatal — default to in_progress so the loop continues
        console.warn('[GoalEvaluator] LLM call failed, defaulting to in_progress:', (err as Error).message);
        return { status: 'in_progress', confidence: 0.5, reason: 'Evaluation failed — continuing' };
    }
}
