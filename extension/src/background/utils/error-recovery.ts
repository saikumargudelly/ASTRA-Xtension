// ════════════════════════════════════════════════════════════════════════════
// ASTRA Error Recovery & Resilience System
// ─ Exponential backoff with jitter
// ─ Circuit breaker pattern to prevent cascading failures
// ─ Adaptive retry strategy based on error classification
// ════════════════════════════════════════════════════════════════════════════

export type ErrorCategory =
    | 'transient'          // Selector stale, timing issue - retry is safe
    | 'network'            // Network timeout, offline - exponential backoff
    | 'element_not_found'  // Selector no longer valid - needs fallback
    | 'javascript'         // Skill threw exception - likely unrecoverable
    | 'permission'         // Auth/CSRF - user intervention needed
    | 'unknown';           // Unclear - safe retry

export interface RetryStrategy {
    maxRetries: number;
    baseDelayMs: number;
    exponentialBase: number;
    jitterPercent: number;
    backoffMultiplier: number;
}

export interface CircuitBreakerConfig {
    failureThreshold: number;    // Consecutive failures before opening
    successThreshold: number;    // Successes to close circuit
    halfOpenTimeout: number;     // Time before trying again (ms)
}

export const DEFAULT_RETRY_STRATEGY: RetryStrategy = {
    maxRetries: 3,
    baseDelayMs: 100,
    exponentialBase: 2,
    jitterPercent: 0.2,
    backoffMultiplier: 1.5,
};

export const DEFAULT_CIRCUIT_BREAKER: CircuitBreakerConfig = {
    failureThreshold: 3,
    successThreshold: 2,
    halfOpenTimeout: 5_000,
};

/**
 * Classify error to determine appropriate retry strategy.
 */
export function classifyError(error: string | unknown): ErrorCategory {
    const msg = (typeof error === 'string' ? error : String(error)).toLowerCase();

    // Transient timing issues
    if (
        msg.includes('stale') ||
        msg.includes('detached') ||
        msg.includes('timeout') ||
        msg.includes('not attached')
    ) {
        return 'transient';
    }

    // Element not found (selector gone)
    if (
        msg.includes('not found') ||
        msg.includes('queryselector') ||
        msg.includes('no element') ||
        msg.includes('no target')
    ) {
        return 'element_not_found';
    }

    // Network issues
    if (
        msg.includes('network') ||
        msg.includes('offline') ||
        msg.includes('econnrefused') ||
        msg.includes('enotfound')
    ) {
        return 'network';
    }

    // Permission/auth issues
    if (
        msg.includes('permission') ||
        msg.includes('unauthorized') ||
        msg.includes('csrf') ||
        msg.includes('forbidden')
    ) {
        return 'permission';
    }

    // JavaScript errors in skill
    if (msg.includes('syntax') || msg.includes('error')) {
        return 'javascript';
    }

    return 'unknown';
}

/**
 * Calculate backoff delay with exponential growth and jitter.
 * @param attempt Zero-indexed attempt number
 * @param strategy Retry configuration
 * @returns Delay in milliseconds
 */
export function calculateBackoffDelay(
    attempt: number,
    strategy: RetryStrategy = DEFAULT_RETRY_STRATEGY,
): number {
    if (attempt === 0) return 0; // No delay on first attempt

    // Exponential: baseDelay × (exponentialBase ^ (attempt - 1))
    const exponentialDelay = strategy.baseDelayMs * Math.pow(
        strategy.exponentialBase,
        attempt - 1
    );

    // Jitter: ±jitterPercent of delay to avoid thundering herd
    const jitterAmount = exponentialDelay * strategy.jitterPercent;
    const jitter = (Math.random() - 0.5) * 2 * jitterAmount;

    // Add backoff multiplier for safety
    const totalDelay = Math.min(
        exponentialDelay + jitter,
        exponentialDelay * strategy.backoffMultiplier
    );

    return Math.max(50, Math.floor(totalDelay));
}

/**
 * Circuit breaker state machine.
 * Prevents retry storms by failing fast after repeated failures.
 */
export class CircuitBreaker {
    private state: 'closed' | 'open' | 'half-open' = 'closed';
    private failureCount = 0;
    private successCount = 0;
    private nextAttemptTime = 0;
    private readonly config: CircuitBreakerConfig;

    constructor(config: Partial<CircuitBreakerConfig> = {}) {
        this.config = { ...DEFAULT_CIRCUIT_BREAKER, ...config };
    }

    /**
     * Check if call is allowed.
     * @returns true if call may proceed, false if circuit is open
     */
    canExecute(): boolean {
        if (this.state === 'closed') return true;
        if (this.state === 'open' && Date.now() >= this.nextAttemptTime) {
            this.state = 'half-open';
            this.successCount = 0;
            return true;
        }
        return this.state === 'half-open';
    }

    /**
     * Record a successful execution.
     */
    recordSuccess(): void {
        this.failureCount = 0;

        if (this.state === 'half-open') {
            this.successCount++;
            if (this.successCount >= this.config.successThreshold) {
                this.state = 'closed';
                this.successCount = 0;
            }
        }
    }

    /**
     * Record a failed execution.
     */
    recordFailure(): void {
        this.failureCount++;

        if (this.failureCount >= this.config.failureThreshold) {
            this.state = 'open';
            this.nextAttemptTime = Date.now() + this.config.halfOpenTimeout;
        }
    }

    /**
     * Get current state for debugging.
     */
    getState(): { state: string; failureCount: number; canExecute: boolean } {
        return {
            state: this.state,
            failureCount: this.failureCount,
            canExecute: this.canExecute(),
        };
    }

    /**
     * Manually reset circuit breaker.
     */
    reset(): void {
        this.state = 'closed';
        this.failureCount = 0;
        this.successCount = 0;
    }
}

/**
 * Execute function with adaptive exponential backoff retry.
 * @param fn Function to retry
 * @param options Retry strategy configuration
 * @returns Result of function call
 */
export async function executeWithRetry<T>(
    fn: (attempt: number) => Promise<T>,
    options: {
        maxRetries?: number;
        baseDelayMs?: number;
        exponentialBase?: number;
        jitterPercent?: number;
        errorFilter?: (err: unknown) => boolean; // If false, stop retrying
        onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
    } = {},
): Promise<T> {
    const strategy: RetryStrategy = {
        maxRetries: options.maxRetries ?? DEFAULT_RETRY_STRATEGY.maxRetries,
        baseDelayMs: options.baseDelayMs ?? DEFAULT_RETRY_STRATEGY.baseDelayMs,
        exponentialBase: options.exponentialBase ?? DEFAULT_RETRY_STRATEGY.exponentialBase,
        jitterPercent: options.jitterPercent ?? DEFAULT_RETRY_STRATEGY.jitterPercent,
        backoffMultiplier: DEFAULT_RETRY_STRATEGY.backoffMultiplier,
    };

    let lastError: unknown;

    for (let attempt = 0; attempt <= strategy.maxRetries; attempt++) {
        try {
            return await fn(attempt);
        } catch (err) {
            lastError = err;

            // Check if error is retryable
            if (options.errorFilter && !options.errorFilter(err)) {
                throw err;
            }

            if (attempt < strategy.maxRetries) {
                const delayMs = calculateBackoffDelay(attempt, strategy);
                options.onRetry?.(attempt, err, delayMs);
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }
    }

    throw lastError;
}

/**
 * User-friendly error message generator.
 * Converts technical errors to actionable suggestions.
 */
export function getUserFriendlyMessage(error: string): string {
    const lower = error.toLowerCase();

    if (lower.includes('not found') || lower.includes('queryselector')) {
        return 'Element not found. Try scrolling to ensure it\'s visible, or wait for the page to load.';
    }

    if (lower.includes('timeout')) {
        return 'Action timed out. The page may be slow or unresponsive. Try again in a moment.';
    }

    if (lower.includes('network') || lower.includes('offline')) {
        return 'Network error. Check your connection and try again.';
    }

    if (lower.includes('permission') || lower.includes('unauthorized')) {
        return 'Permission denied. You may need to log in or complete a security challenge.';
    }

    if (lower.includes('stale') || lower.includes('detached')) {
        return 'Page changed unexpectedly. Retrying...';
    }

    return 'Action failed. Please try again.';
}
