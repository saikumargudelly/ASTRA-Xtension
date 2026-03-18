// ─── Error Taxonomy & Circuit Breakers ────────────────────────────────────────
// Classifies errors into four categories and decides retry behaviour.
// This prevents the execution engine from infinitely retrying unrecoverable
// failures and gives the LLM structured failure context to replan from.
//
// USAGE (in executionEngine.ts):
//   const cls = classifyError(err, step.agent, attempt);
//   if (!shouldRetry(cls, context.options)) break; // circuit breaker
//   step.result.error = formatErrorForLLM(cls, step.id); // feed back to LLM

// ─── Public Types ─────────────────────────────────────────────────────────────

/**
 * Four error classes — each requires a distinct recovery strategy.
 *
 * TRANSIENT      Network blip, timeout, rate-limit (429) → retry up to N times.
 * RECOVERABLE    Stale selector, element occluded, auth redirect → retry once.
 * INTERRUPTABLE  CAPTCHA, unexpected 2FA, manual action needed → pause, no retry.
 * TERMINAL       Permission denied, paywall, restricted URL → stop immediately.
 */
export type ErrorClass = 'TRANSIENT' | 'RECOVERABLE' | 'INTERRUPTABLE' | 'TERMINAL';

export interface ErrorClassification {
    /** The classified error category. */
    class: ErrorClass;
    /** The original error object. */
    error: Error;
    /** Agent that produced the error. */
    agent: string;
    /** Which attempt number this occurred on (1-indexed). */
    attempt: number;
    /** Short human-readable reason used in logs and LLM feedback. */
    reason: string;
}

export interface RetryOptions {
    /** Total number of re-attempts allowed for TRANSIENT errors (not counting the first try). */
    retryCount: number;
}

// ─── Classification Rules ─────────────────────────────────────────────────────
// Evaluated in order — first match wins.

interface ClassificationRule {
    class: ErrorClass;
    reason: string;
    /** Returns true if this rule matches the given error. */
    test: (msg: string, agent: string) => boolean;
}

const CLASSIFICATION_RULES: ClassificationRule[] = [
    // ── TERMINAL: stop immediately, never retry ───────────────────────────────
    {
        class: 'TERMINAL',
        reason: 'Action blocked on restricted URL — content scripts cannot run here',
        test: (msg) => msg.includes('restricted') || msg.includes('chrome://') || msg.includes('chrome-extension://'),
    },
    {
        class: 'TERMINAL',
        reason: 'Permission denied — the browser refused the requested action',
        test: (msg) => msg.includes('permission denied') || msg.includes('not allowed') || msg.includes('access denied'),
    },
    {
        class: 'TERMINAL',
        reason: 'Paywall or subscription gate — task cannot proceed without payment',
        test: (msg) => msg.includes('paywall') || msg.includes('subscription required') || msg.includes('premium only'),
    },
    {
        class: 'TERMINAL',
        reason: 'Unknown action type — the agent or skill does not exist',
        test: (msg, agent) => msg.includes('unknown agent') || msg.includes('unknown action') || msg.includes('no executor for agent'),
    },

    // ── INTERRUPTABLE: pause immediately, signal handoff, never retry ─────────
    {
        class: 'INTERRUPTABLE',
        reason: 'CAPTCHA challenge detected — requires human intervention to solve',
        test: (msg) => /captcha|recaptcha|hcaptcha|verify you are human/i.test(msg),
    },
    {
        class: 'INTERRUPTABLE',
        reason: '2FA or MFA required — awaiting human-supplied one-time code',
        test: (msg) => /2fa|two.factor|one.time.code|otp|authenticator/i.test(msg),
    },
    {
        class: 'INTERRUPTABLE',
        reason: 'Manual action required — agent cannot proceed autonomously',
        test: (msg) => msg.includes('ask_user') || msg.includes('manual intervention') || msg.includes('requires human'),
    },

    // ── RECOVERABLE: retry once with a remediation attempt ───────────────────
    {
        class: 'RECOVERABLE',
        reason: 'Element not found — selector may be stale or dynamic; will retry with description-based fallback',
        test: (msg) =>
            msg.includes('not found') ||
            msg.includes('no element') ||
            msg.includes('cannot find') ||
            msg.includes('queryselector') ||
            msg.includes('stale element') ||
            msg.includes('element is not attached'),
    },
    {
        class: 'RECOVERABLE',
        reason: 'Authentication redirect — page navigated to login wall; will apply credential injection',
        test: (msg) => msg.includes('login_wall') || msg.includes('auth redirect') || msg.includes('sign in required'),
    },
    {
        class: 'RECOVERABLE',
        reason: 'Element occluded — a modal or overlay is blocking the target; will attempt dismissal',
        test: (msg) => msg.includes('occluded') || msg.includes('intercepted') || msg.includes('blocked by overlay'),
    },
    {
        class: 'RECOVERABLE',
        reason: 'Target tab detached — tab was replaced during navigation; will re-acquire',
        test: (msg) => msg.includes('receiving end does not exist') || msg.includes('could not establish connection') || msg.includes('no active tab'),
    },

    // ── TRANSIENT: retry up to retryCount times ───────────────────────────────
    {
        class: 'TRANSIENT',
        reason: 'Network timeout — transient connectivity issue; retrying',
        test: (msg) => /timeout|etimedout|timed out|econnreset|socket hang up/i.test(msg),
    },
    {
        class: 'TRANSIENT',
        reason: 'Rate-limited (429) — backing off before retry',
        test: (msg) => msg.includes('429') || /rate.?limit|too many requests/i.test(msg),
    },
    {
        class: 'TRANSIENT',
        reason: 'Transient network error — will retry',
        test: (msg) => /econnrefused|enotfound|fetch failed|failed to fetch|network error/i.test(msg),
    },
    {
        class: 'TRANSIENT',
        reason: 'LLM service error — upstream provider returned 5xx; retrying',
        test: (msg) => /5\d\d server error|service unavailable|bad gateway|internal server error/i.test(msg),
    },
];

// ─── Classifier ───────────────────────────────────────────────────────────────

/**
 * Classifies an error into one of the four error classes.
 * Evaluates CLASSIFICATION_RULES in order — first match wins.
 * Falls back to TRANSIENT for unknown errors (safest assumption: retry once).
 */
export function classifyError(
    err: Error,
    agent: string,
    attempt: number,
): ErrorClassification {
    const msg = (err.message ?? '').toLowerCase();

    for (const rule of CLASSIFICATION_RULES) {
        if (rule.test(msg, agent.toLowerCase())) {
            return {
                class: rule.class,
                error: err,
                agent,
                attempt,
                reason: rule.reason,
            };
        }
    }

    // Unknown errors: treat as transient (retry-able) once
    return {
        class: 'TRANSIENT',
        error: err,
        agent,
        attempt,
        reason: `Unclassified error — defaulting to TRANSIENT: ${err.message}`,
    };
}

// ─── Circuit Breaker ──────────────────────────────────────────────────────────

/**
 * Determines whether a step should be retried based on its error classification.
 *
 * | Class         | Retry policy                           |
 * |---------------|----------------------------------------|
 * | TRANSIENT     | Yes — up to options.retryCount times   |
 * | RECOVERABLE   | Yes — exactly once (attempt 1 only)    |
 * | INTERRUPTABLE | Never — requires human handoff         |
 * | TERMINAL      | Never — immediate stop                 |
 */
export function shouldRetry(
    classification: ErrorClassification,
    options: RetryOptions,
): boolean {
    switch (classification.class) {
        case 'TRANSIENT':
            return classification.attempt <= options.retryCount;
        case 'RECOVERABLE':
            return classification.attempt === 1; // exactly one remediation attempt
        case 'INTERRUPTABLE':
        case 'TERMINAL':
            return false;
    }
}

// ─── LLM Feedback Formatter ───────────────────────────────────────────────────

/**
 * Serialises an error classification into a structured string that is passed
 * back to the LLM as the step `error` field on failure.
 *
 * Instead of: "Element not found: #add-to-cart"
 * Returns:    "[RECOVERABLE] Element not found — selector may be stale or dynamic;
 *              retried with description-based fallback. step: step_3, agent: browser"
 *
 * This gives the LLM enough context to write a corrective plan rather than
 * blindly repeating the same action.
 */
export function formatErrorForLLM(
    classification: ErrorClassification,
    stepId: string,
): string {
    const { class: cls, reason, error, agent, attempt } = classification;
    return [
        `[${cls}] ${reason}`,
        `Raw error: ${error.message}`,
        `Step: ${stepId} | Agent: ${agent} | Attempt: ${attempt}`,
        cls === 'INTERRUPTABLE'
            ? 'ACTION REQUIRED: This error cannot be resolved automatically. A human must intervene before this step can continue.'
            : cls === 'TERMINAL'
                ? 'FATAL: This step cannot be retried. Replan to avoid this action entirely or inform the user.'
                : '',
    ]
        .filter(Boolean)
        .join('\n');
}
