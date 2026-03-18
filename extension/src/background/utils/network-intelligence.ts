// ════════════════════════════════════════════════════════════════════════════
// ASTRA Network Intelligence & Monitoring
// ─ GraphQL query tracking (Apollo, Relay)
// ─ SPA routing detection (Vue, React, Angular)
// ─ Infinite scroll vs pagination detection
// ─ Resource waterfall analysis
// ════════════════════════════════════════════════════════════════════════════

export interface NetworkRequest {
    url: string;
    method: string;
    type: 'xhr' | 'fetch' | 'graphql' | 'websocket' | 'other';
    startTime: number;
    endTime?: number;
    status?: number;
    size?: number;
}

export interface NetworkProfile {
    totalRequests: number;
    xhrCount: number;
    fetchCount: number;
    graphqlCount: number;
    totalSize: number;
    averageLatency: number;
    slowestRequest?: NetworkRequest;
    hasGraphQL: boolean;
    hasSPA: boolean;
    isMobile: boolean;
}

/**
 * Detect if page is a Single Page Application.
 */
export function detectSPA(): {
    isSPA: boolean;
    framework?: 'vue' | 'react' | 'angular' | 'svelte' | 'unknown';
    version?: string;
} {
    const windowObj = window as any;

    // Vue
    if (windowObj.__vue__) {
        return { isSPA: true, framework: 'vue', version: windowObj.__VUE__?.version };
    }

    // React
    if (windowObj.__REACT_DEVTOOLS_GLOBAL_HOOK__ || document.querySelector('[data-reactroot], [data-react-root]')) {
        return { isSPA: true, framework: 'react' };
    }

    // Angular
    if (windowObj.ng) {
        return { isSPA: true, framework: 'angular' };
    }

    // Svelte
    if (windowObj.__svelte) {
        return { isSPA: true, framework: 'svelte' };
    }

    // Check for SPA indicators
    if (windowObj.fetch.__instrumented || windowObj.XMLHttpRequest.__instrumented) {
        return { isSPA: true, framework: 'unknown' };
    }

    return { isSPA: false };
}

/**
 * Detect if GraphQL is being used on the page.
 */
export function hasGraphQL(): boolean {
    const windowObj = window as any;

    // Apollo Client
    if (windowObj.__APOLLO_CLIENT__) return true;

    // Relay
    if (windowObj.__RELAY_STORE__) return true;

    // Generic GraphQL detection (check local storage, window objects)
    if (windowObj.ApolloClient || windowObj.Relay) return true;

    // Check for graphql URLs in requests
    return false; // Need runtime monitoring for this
}

/**
 * Monitor network requests in real-time (for internal use).
 */
export class NetworkMonitor {
    private requests: NetworkRequest[] = [];
    private xhrHooked = false;
    private fetchHooked = false;

    constructor() {
        this.hookXHR();
        this.hookFetch();
    }

    private hookXHR(): void {
        if (this.xhrHooked) return;

        const originalOpen = XMLHttpRequest.prototype.open;
        const originalSend = XMLHttpRequest.prototype.send;

        XMLHttpRequest.prototype.open = function (method: string, url: string) {
            (this as any).__method = method;
            (this as any).__url = url;
            return originalOpen.apply(this, arguments as any);
        };

        XMLHttpRequest.prototype.send = function () {
            const request: NetworkRequest = {
                url: (this as any).__url || '',
                method: (this as any).__method || 'GET',
                type: this.readyState === 4 ? 'xhr' : 'xhr',
                startTime: Date.now(),
            };

            const originalOnReadyStateChange = this.onreadystatechange;
            this.onreadystatechange = function () {
                if (this.readyState === 4) {
                    request.endTime = Date.now();
                    request.status = this.status;
                }
                return originalOnReadyStateChange?.apply(this, arguments as any);
            };

            return originalSend.apply(this, arguments as any);
        };

        this.xhrHooked = true;
    }

    private hookFetch(): void {
        if (this.fetchHooked) return;

        const originalFetch = window.fetch;

        window.fetch = async function (...args: any[]) {
            const url = typeof args[0] === 'string' ? args[0] : args[0]?.url ?? '';
            const method = args[1]?.method ?? 'GET';

            const request: NetworkRequest = {
                url,
                method,
                type: url.includes('graphql') ? 'graphql' : 'fetch',
                startTime: Date.now(),
            };

            try {
                const response = await originalFetch.apply(this, args as [URL | RequestInfo, RequestInit?]);
                request.endTime = Date.now();
                request.status = response.status;
                request.size = response.headers.get('content-length')
                    ? parseInt(response.headers.get('content-length')!, 10)
                    : undefined;
                return response;
            } catch (err) {
                request.endTime = Date.now();
                throw err;
            }
        };

        (window.fetch as any).__instrumented = true;
        this.fetchHooked = true;
    }

    /**
     * Get network profile.
     */
    getProfile(): NetworkProfile {
        const xhrReqs = this.requests.filter(r => r.type === 'xhr');
        const fetchReqs = this.requests.filter(r => r.type === 'fetch');
        const gqlReqs = this.requests.filter(r => r.type === 'graphql');

        const allWithDuration = this.requests.filter(r => r.endTime);
        const latencies = allWithDuration.map(r => (r.endTime! - r.startTime));
        const avgLatency = latencies.reduce((a, b) => a + b, 0) / (latencies.length || 1);

        const slowest = this.requests.reduce((max, r) => {
            const dur = (r.endTime! - r.startTime);
            const maxDur = (max.endTime! - max.startTime);
            return dur > maxDur ? r : max;
        });

        return {
            totalRequests: this.requests.length,
            xhrCount: xhrReqs.length,
            fetchCount: fetchReqs.length,
            graphqlCount: gqlReqs.length,
            totalSize: this.requests.reduce((sum, r) => sum + (r.size ?? 0), 0),
            averageLatency: avgLatency,
            slowestRequest: slowest,
            hasGraphQL: gqlReqs.length > 0,
            hasSPA: detectSPA().isSPA,
            isMobile: window.innerWidth < 768,
        };
    }

    /**
     * Wait until network is idle (no pending requests).
     */
    async waitForNetworkIdle(timeoutMs: number = 5000, idleThresholdMs: number = 500): Promise<void> {
        const startTime = Date.now();

        while (Date.now() - startTime < timeoutMs) {
            const pending = this.requests.filter(r => !r.endTime);

            if (pending.length === 0) {
                // Check if idle for threshold duration
                await new Promise(resolve => setTimeout(resolve, idleThresholdMs));
                const stillPending = this.requests.filter(r => !r.endTime);

                if (stillPending.length === 0) {
                    return;
                }
            }

            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }

    /**
     * Clear request history.
     */
    clear(): void {
        this.requests = [];
    }
}

/**
 * Detect framework-specific routing changes.
 * Useful for waiting for SPA navigation to complete.
 */
export async function waitForSPANavigation(
    timeoutMs: number = 5000,
    checkInterval: number = 100
): Promise<void> {
    const startTime = Date.now();
    const initialUrl = window.location.href;

    return new Promise((resolve, reject) => {
        let changeDetected = false;

        const checkUrl = () => {
            if (window.location.href !== initialUrl) {
                changeDetected = true;
                // Wait briefly for page to stabilize
                setTimeout(() => {
                    resolve();
                }, 500);
                return;
            }

            if (Date.now() - startTime > timeoutMs) {
                reject(new Error(`SPA navigation timeout after ${timeoutMs}ms`));
                return;
            }

            setTimeout(checkUrl, checkInterval);
        };

        checkUrl();
    });
}

/**
 * Detect if page is loading (show loading indicator).
 */
export function detectLoading(): boolean {
    // Common loading indicators
    const selectors = [
        '[class*="loading"]',
        '[class*="spinner"]',
        '[class*="progress"]',
        '[role="progressbar"]',
        '.sk-loader', // Skeleton loader
        '[data-testid*="loading"]',
        '[aria-busy="true"]',
    ];

    for (const selector of selectors) {
        try {
            const el = document.querySelector(selector);
            if (el && isElementVisible(el)) {
                return true;
            }
        } catch {
            continue;
        }
    }

    return false;
}

/**
 * Wait until page stops loading.
 */
export async function waitUntilNotLoading(
    timeoutMs: number = 15000,
    checkInterval: number = 200
): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
        if (!detectLoading() && document.readyState === 'complete') {
            // Confirm not loading for a brief period
            await new Promise(resolve => setTimeout(resolve, 500));
            if (!detectLoading()) return;
        }

        await new Promise(resolve => setTimeout(resolve, checkInterval));
    }
}

/**
 * Check if element is visible.
 */
function isElementVisible(element: Element): boolean {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);

    return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        parseFloat(style.opacity) > 0
    );
}

/**
 * Global network monitor instance.
 */
export let globalNetworkMonitor: NetworkMonitor | null = null;

/**
 * Initialize global network monitoring.
 */
export function initNetworkMonitoring(): NetworkMonitor {
    if (!globalNetworkMonitor) {
        globalNetworkMonitor = new NetworkMonitor();
    }
    return globalNetworkMonitor;
}
