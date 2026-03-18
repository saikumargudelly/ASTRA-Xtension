// ════════════════════════════════════════════════════════════════════════════
// ASTRA Action Telemetry & Diagnostics
// ─ Track action success rates, latencies, error patterns
// ─ Generate diagnostic reports for debugging
// ─ Feed insights into retry strategy decisions
// ════════════════════════════════════════════════════════════════════════════

export interface ActionMetrics {
    name: string;
    attempts: number;
    successes: number;
    failures: number;
    totalDurationMs: number;
    minDurationMs: number;
    maxDurationMs: number;
    avgDurationMs: number;
    commonErrors: Record<string, number>;
    lastExecutedAt: number;
    lastErrorAt?: number;
}

export interface SessionTelemetry {
    sessionId: string;
    startTime: number;
    endTime?: number;
    totalActions: number;
    successfulActions: number;
    failedActions: number;
    averageLatencyMs: number;
    actionMetrics: Map<string, ActionMetrics>;
}

/**
 * Telemetry collector for a single session.
 * Tracks success rates, latencies, and error patterns.
 */
export class TelemetryCollector {
    private readonly sessionId: string;
    private readonly startTime = Date.now();
    private readonly metrics = new Map<string, ActionMetrics>();
    private totalActionTime = 0;
    private totalActions = 0;

    constructor(sessionId: string) {
        this.sessionId = sessionId;
    }

    /**
     * Record an action execution.
     */
    recordAction(
        actionName: string,
        success: boolean,
        durationMs: number,
        error?: string
    ): void {
        const existing = this.metrics.get(actionName) || {
            name: actionName,
            attempts: 0,
            successes: 0,
            failures: 0,
            totalDurationMs: 0,
            minDurationMs: Infinity,
            maxDurationMs: 0,
            avgDurationMs: 0,
            commonErrors: {},
            lastExecutedAt: 0,
        };

        existing.attempts++;
        existing.lastExecutedAt = Date.now();

        if (success) {
            existing.successes++;
        } else {
            existing.failures++;
            existing.lastErrorAt = Date.now();
            if (error) {
                existing.commonErrors[error] = (existing.commonErrors[error] || 0) + 1;
            }
        }

        existing.totalDurationMs += durationMs;
        existing.minDurationMs = Math.min(existing.minDurationMs, durationMs);
        existing.maxDurationMs = Math.max(existing.maxDurationMs, durationMs);
        existing.avgDurationMs = existing.totalDurationMs / existing.attempts;

        this.metrics.set(actionName, existing);
        this.totalActionTime += durationMs;
        this.totalActions++;
    }

    /**
     * Get metrics for a specific action.
     */
    getActionMetrics(actionName: string): ActionMetrics | undefined {
        return this.metrics.get(actionName);
    }

    /**
     * Get success rate for an action (0-1).
     */
    getSuccessRate(actionName: string): number {
        const metrics = this.metrics.get(actionName);
        if (!metrics || metrics.attempts === 0) return 0;
        return metrics.successes / metrics.attempts;
    }

    /**
     * Get all metrics.
     */
    getAllMetrics(): Map<string, ActionMetrics> {
        return new Map(this.metrics);
    }

    /**
     * Generate a telemetry report.
     */
    generateReport(): SessionTelemetry {
        const successfulActions = Array.from(this.metrics.values()).reduce(
            (sum, m) => sum + m.successes,
            0
        );
        const failedActions = Array.from(this.metrics.values()).reduce(
            (sum, m) => sum + m.failures,
            0
        );

        return {
            sessionId: this.sessionId,
            startTime: this.startTime,
            endTime: Date.now(),
            totalActions: this.totalActions,
            successfulActions,
            failedActions,
            averageLatencyMs: this.totalActions > 0 ? this.totalActionTime / this.totalActions : 0,
            actionMetrics: this.metrics,
        };
    }

    /**
     * Get actions with success rate below threshold.
     * Useful for identifying problematic actions.
     */
    getUnreliableActions(thresholdRate: number = 0.8): ActionMetrics[] {
        return Array.from(this.metrics.values()).filter(
            m => m.attempts > 0 && (m.successes / m.attempts) < thresholdRate
        );
    }

    /**
     * Get top N slowest actions.
     */
    getSlowestActions(limit: number = 5): ActionMetrics[] {
        return Array.from(this.metrics.values())
            .sort((a, b) => b.avgDurationMs - a.avgDurationMs)
            .slice(0, limit);
    }

    /**
     * Get most common error patterns.
     */
    getMostCommonErrors(limit: number = 10): Array<{ error: string; count: number; actions: string[] }> {
        const errorMap = new Map<string, { count: number; actions: Set<string> }>();

        for (const [actionName, metrics] of this.metrics.entries()) {
            for (const [error, count] of Object.entries(metrics.commonErrors)) {
                const existing = errorMap.get(error) || { count: 0, actions: new Set() };
                existing.count += count;
                existing.actions.add(actionName);
                errorMap.set(error, existing);
            }
        }

        return Array.from(errorMap.entries())
            .map(([error, { count, actions }]) => ({
                error,
                count,
                actions: Array.from(actions),
            }))
            .sort((a, b) => b.count - a.count)
            .slice(0, limit);
    }

    /**
     * Export metrics as JSON for external analysis.
     */
    exportJSON(): string {
        const report = this.generateReport();
        const metricsArray = Array.from(report.actionMetrics.values());
        return JSON.stringify(
            {
                ...report,
                actionMetrics: metricsArray,
            },
            null,
            2
        );
    }
}

/**
 * Global telemetry registry (one per session).
 */
let globalTelemetry: TelemetryCollector | null = null;

/**
 * Initialize global telemetry for a session.
 */
export function initTelemetry(sessionId: string): TelemetryCollector {
    globalTelemetry = new TelemetryCollector(sessionId);
    return globalTelemetry;
}

/**
 * Get global telemetry collector.
 */
export function getTelemetry(): TelemetryCollector | null {
    return globalTelemetry;
}

/**
 * Record action with automatic telemetry.
 */
export function recordActionTelemetry(
    actionName: string,
    success: boolean,
    durationMs: number,
    error?: string
): void {
    globalTelemetry?.recordAction(actionName, success, durationMs, error);
}

/**
 * Format a telemetry report for human reading.
 */
export function formatTelemetryReport(telemetry: SessionTelemetry): string {
    const lines: string[] = [
        '═══════════════════════════════════════════',
        '🔍 ASTRA Action Telemetry Report',
        '═══════════════════════════════════════════',
        '',
        `Session ID: ${telemetry.sessionId}`,
        `Duration: ${Math.round((telemetry.endTime! - telemetry.startTime) / 1000)}s`,
        `Total Actions: ${telemetry.totalActions}`,
        `✅ Successful: ${telemetry.successfulActions} (${((telemetry.successfulActions / telemetry.totalActions) * 100).toFixed(1)}%)`,
        `❌ Failed: ${telemetry.failedActions} (${((telemetry.failedActions / telemetry.totalActions) * 100).toFixed(1)}%)`,
        `⏱️  Average Latency: ${telemetry.averageLatencyMs.toFixed(0)}ms`,
        '',
        '📊 Top 5 Actions:',
    ];

    const sorted = Array.from(telemetry.actionMetrics.values())
        .sort((a, b) => b.attempts - a.attempts)
        .slice(0, 5);

    for (const metric of sorted) {
        const rate = ((metric.successes / metric.attempts) * 100).toFixed(1);
        lines.push(`  • ${metric.name}: ${metric.attempts} attempts, ${rate}% success, avg ${metric.avgDurationMs.toFixed(0)}ms`);
    }

    lines.push('');
    lines.push('⚠️  Slowest Actions:');
    const slowest = Array.from(telemetry.actionMetrics.values())
        .sort((a, b) => b.avgDurationMs - a.avgDurationMs)
        .slice(0, 3);

    for (const metric of slowest) {
        lines.push(`  • ${metric.name}: ${metric.avgDurationMs.toFixed(0)}ms (${metric.attempts} attempts)`);
    }

    lines.push('');
    lines.push('═══════════════════════════════════════════');

    return lines.join('\n');
}
