// ════════════════════════════════════════════════════════════════════════════
// ASTRA SecurityGuard
// ─ All browser and DOM actions MUST pass through this module before execution.
// ─ Provides: URL validation, selector sanitisation, action allowlisting,
//   rate limiting, privilege escalation prevention, and audit logging.
// ════════════════════════════════════════════════════════════════════════════

import type { BrowserAction, DOMAction, PlannerAction, ActionLogEntry } from '../types/messages.js';

// ─── URL Blocklists ───────────────────────────────────────────────────────────
// Chrome internal pages and extension stores that can never be navigated to
// or injected into through ASTRA-triggered actions.
const BLOCKED_SCHEMES = [
    'javascript:', 'data:', 'vbscript:', 'blob:',
];

const BLOCKED_URL_PREFIXES = [
    'chrome://', 'chrome-extension://', 'edge://', 'about:', 'view-source:',
    'devtools://', 'mozilla://', 'resource://',
];

const BLOCKED_HOSTNAMES = new Set([
    'chrome.google.com', 'chromewebstore.google.com',
    'addons.mozilla.org', 'microsoftedge.microsoft.com',
    'localhost:' ,// override with ALLOWED_LOCAL_PORTS below
]);

// Local ports explicitly allowed for dev backends
const ALLOWED_LOCAL_PORTS = new Set(['3000', '3001', '5173', '8080', '8000']);

// ─── Selector Injection Patterns ─────────────────────────────────────────────
// These patterns in a CSS selector indicate injection attempts.
const SELECTOR_INJECTION_PATTERNS = [
    /<script/i,
    /javascript:/i,
    /on\w+\s*=/i,          // onerror= onclick= etc.
    /expression\s*\(/i,    // CSS expression()
    /import\s*\(/i,
    /url\s*\(\s*["']?javascript/i,
    /\\[0-9a-fA-F]/,       // excessive unicode escapes used to bypass
    /\.\.\//,              // path traversal
];

// ─── Action Allowlist ─────────────────────────────────────────────────────────
const ALLOWED_BROWSER_ACTIONS = new Set<string>([
    'open_tab', 'close_tab', 'switch_tab', 'reload_tab', 'duplicate_tab',
    'pin_tab', 'mute_tab', 'move_tab', 'zoom_tab',
    'navigate', 'go_back', 'go_forward',
    'new_window', 'close_window', 'focus_window',
    'get_all_tabs', 'search_tabs', 'screenshot',
    'bookmark_page', 'download_file',
    // legacy aliases still emitted by old planner versions
    'new_tab',
]);

const ALLOWED_DOM_ACTIONS = new Set<string>([
    'click', 'type', 'hover', 'focus', 'clear', 'select_option',
    'fill_form', 'scroll', 'scroll_to', 'drag_drop', 'wait_for',
    'keyboard', 'extract_data', 'search', 'submit_form',
    'read_page', 'analyze_page',
    // legacy aliases
    'range-set', 'select-option', 'wait',
]);

// ─── Keyboard Key Allowlist ───────────────────────────────────────────────────
// Only named keys are allowed — no arbitrary character injection.
const ALLOWED_KEYS = new Set([
    'Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Space',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    'Home', 'End', 'PageUp', 'PageDown',
    'F1', 'F2', 'F3', 'F4', 'F5', 'F12',
    // modifiers
    'Control', 'Alt', 'Shift', 'Meta',
    // common combos expressed as single tokens
    'Ctrl+C', 'Ctrl+V', 'Ctrl+X', 'Ctrl+A', 'Ctrl+Z', 'Ctrl+Y',
    'Ctrl+F', 'Ctrl+T', 'Ctrl+W', 'Ctrl+R', 'Ctrl+L',
]);

// ─── Rate Limiting ────────────────────────────────────────────────────────────
interface RateWindow { count: number; windowStart: number }
const RATE_MAP = new Map<string, RateWindow>();
const RATE_LIMIT = 30;        // max actions per window
const RATE_WINDOW_MS = 60_000; // 60 s rolling window

function checkRateLimit(sessionId: string): boolean {
    const now = Date.now();
    const entry = RATE_MAP.get(sessionId);
    if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
        RATE_MAP.set(sessionId, { count: 1, windowStart: now });
        return true;
    }
    if (entry.count >= RATE_LIMIT) return false;
    entry.count++;
    return true;
}

// ─── Audit Log ────────────────────────────────────────────────────────────────
const SESSION_LOGS = new Map<string, ActionLogEntry[]>();

export function getAuditLog(sessionId: string): ActionLogEntry[] {
    return SESSION_LOGS.get(sessionId) ?? [];
}

function log(
    sessionId: string,
    action: string,
    label: string,
    success: boolean,
    target?: string,
    blocked?: boolean,
    reason?: string,
): void {
    const entry: ActionLogEntry = { ts: Date.now(), action, label, target, success, blocked, reason };
    const existing = SESSION_LOGS.get(sessionId) ?? [];
    existing.push(entry);
    // Keep last 200 entries per session
    if (existing.length > 200) existing.shift();
    SESSION_LOGS.set(sessionId, existing);
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface ValidationResult {
    allowed: boolean;
    reason?: string;
}

/**
 * Validate a URL string deeply.
 * Returns { allowed: false, reason } when the URL is blocked.
 */
export function validateUrl(rawUrl: string): ValidationResult {
    if (!rawUrl || typeof rawUrl !== 'string') {
        return { allowed: false, reason: 'URL must be a non-empty string' };
    }

    // Strip whitespace (common obfuscation tactic)
    const url = rawUrl.trim();

    // Scheme checks first (before URL parsing to catch malformed inputs)
    const lower = url.toLowerCase();
    for (const scheme of BLOCKED_SCHEMES) {
        if (lower.startsWith(scheme)) {
            return { allowed: false, reason: `Blocked scheme: ${scheme}` };
        }
    }
    for (const prefix of BLOCKED_URL_PREFIXES) {
        if (lower.startsWith(prefix)) {
            return { allowed: false, reason: `Blocked URL prefix: ${prefix}` };
        }
    }

    // Parse and inspect
    let parsed: URL;
    try {
        // Resolve relative URLs against a dummy base so we can inspect
        parsed = new URL(url.includes('://') ? url : `https://${url}`);
    } catch {
        return { allowed: false, reason: 'Malformed URL' };
    }

    // Block non-http/https protocols (after allowing the above explicit blocked list)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { allowed: false, reason: `Disallowed protocol: ${parsed.protocol}` };
    }

    // Blocked hostname check
    for (const blocked of BLOCKED_HOSTNAMES) {
        if (parsed.hostname === blocked) {
            return { allowed: false, reason: `Blocked host: ${blocked}` };
        }
    }

    // Localhost: only allow whitelisted ports
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
        const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
        if (!ALLOWED_LOCAL_PORTS.has(port)) {
            return { allowed: false, reason: `Localhost port ${port} not in allowed list` };
        }
    }

    // Block private / link-local IP ranges (prevent SSRF-style automation)
    if (isPrivateIp(parsed.hostname)) {
        return { allowed: false, reason: `Private IP range navigation blocked: ${parsed.hostname}` };
    }

    return { allowed: true };
}

/**
 * Sanitise and validate a CSS selector string.
 * Throws if the selector appears malicious. Returns the cleaned selector.
 */
export function sanitizeSelector(raw: string): string {
    if (!raw || typeof raw !== 'string') throw new Error('Selector must be a non-empty string');
    if (raw.length > 512) throw new Error('Selector exceeds max length (512)');

    for (const pattern of SELECTOR_INJECTION_PATTERNS) {
        if (pattern.test(raw)) {
            throw new Error(`Selector contains potentially malicious content: ${raw.slice(0, 60)}`);
        }
    }

    // Verify it's valid CSS by asking the browser (content script context — noop in background)
    // background can't do document.querySelector, validation is pattern-only here.
    return raw.trim();
}

/**
 * Sanitise a typed value (text to type into an element).
 * Returns the cleaned value.
 */
export function sanitizeValue(raw: string): string {
    if (typeof raw !== 'string') return '';
    // JavaScript protocol injection guard
    if (/javascript:/i.test(raw)) throw new Error('Value contains disallowed javascript: protocol');
    // Limit length to prevent extremely large payloads
    return raw.slice(0, 2048);
}

/**
 * Validate keyboard key names.
 */
export function validateKeys(keys: string[]): ValidationResult {
    for (const k of keys) {
        if (!ALLOWED_KEYS.has(k)) {
            return { allowed: false, reason: `Key "${k}" is not in the allowed key list` };
        }
    }
    return { allowed: true };
}

/**
 * Primary gate — validate a PlannerAction before execution.
 * Returns { allowed, reason }.
 * Also writes to the session audit log.
 */
export function validateAction(
    action: PlannerAction,
    sessionId = 'default',
): ValidationResult {
    // Rate limit
    if (!checkRateLimit(sessionId)) {
        const r = { allowed: false, reason: 'Rate limit exceeded — too many actions per minute' };
        log(sessionId, action.type, action.label ?? '', false, undefined, true, r.reason);
        return r;
    }

    const type = action.type;

    // Allowlist checks
    if (!ALLOWED_BROWSER_ACTIONS.has(type) && !ALLOWED_DOM_ACTIONS.has(type)) {
        const r = { allowed: false, reason: `Action type "${type}" is not in the allowlist` };
        log(sessionId, type, action.label ?? '', false, undefined, true, r.reason);
        return r;
    }

    // URL-bearing browser actions
    if (
        (type === 'open_tab' || type === 'navigate') &&
        'url' in action
    ) {
        const urlResult = validateUrl((action as { url: string }).url);
        if (!urlResult.allowed) {
            log(sessionId, type, action.label ?? '', false, (action as { url: string }).url, true, urlResult.reason);
            return urlResult;
        }
    }

    if (type === 'download_file' && 'url' in action) {
        const urlResult = validateUrl((action as { url: string }).url);
        if (!urlResult.allowed) {
            log(sessionId, type, action.label ?? '', false, (action as { url: string }).url, true, urlResult.reason);
            return urlResult;
        }
    }

    // Selector validation for DOM actions
    if ('selector' in action && (action as { selector?: string }).selector) {
        try {
            sanitizeSelector((action as { selector: string }).selector);
        } catch (err) {
            const reason = (err as Error).message;
            log(sessionId, type, action.label ?? '', false, (action as { selector: string }).selector, true, reason);
            return { allowed: false, reason };
        }
    }

    // fill_form — validate all field selectors and values
    if (type === 'fill_form' && 'fields' in action) {
        const fields = (action as { fields: Array<{ selector: string; value: string }> }).fields;
        for (const f of fields) {
            try {
                sanitizeSelector(f.selector);
                sanitizeValue(f.value);
            } catch (err) {
                const reason = (err as Error).message;
                log(sessionId, type, action.label ?? '', false, f.selector, true, reason);
                return { allowed: false, reason };
            }
        }
    }

    // Keyboard key validation
    if (type === 'keyboard' && 'keys' in action) {
        const kr = validateKeys((action as { keys: string[] }).keys);
        if (!kr.allowed) {
            log(sessionId, type, action.label ?? '', false, undefined, true, kr.reason);
            return kr;
        }
    }

    // Value sanitisation
    if ('value' in action && typeof (action as { value?: string }).value === 'string') {
        try {
            sanitizeValue((action as { value: string }).value);
        } catch (err) {
            const reason = (err as Error).message;
            log(sessionId, type, action.label ?? '', false, undefined, true, reason);
            return { allowed: false, reason };
        }
    }

    // Zoom factor bounds
    if (type === 'zoom_tab' && 'factor' in action) {
        const f = (action as { factor: number }).factor;
        if (f < 0.25 || f > 5) {
            const reason = 'Zoom factor out of range [0.25, 5]';
            log(sessionId, type, action.label ?? '', false, undefined, true, reason);
            return { allowed: false, reason };
        }
    }

    log(sessionId, type, action.label ?? '', true);
    return { allowed: true };
}

/**
 * Check whether a URL is restricted (no content script allowed).
 * This is the definitive, security-authoritative implementation.
 * The background/index.ts should call this instead of its own copy.
 */
export function isRestrictedUrl(url: string): boolean {
    if (!url) return true;
    const lower = url.toLowerCase();

    const BLOCKED = [
        'chrome://', 'chrome-extension://', 'edge://', 'about:', 'data:',
        'javascript:', 'mozilla://', 'view-source:', 'devtools://',
    ];
    const BLOCKED_SUB = [
        'chrome.google.com/webstore', 'chromewebstore.google.com',
        'chrome.google.com/extensions', 'newtab',
    ];

    return BLOCKED.some(p => lower.startsWith(p)) || BLOCKED_SUB.some(s => lower.includes(s));
}

// ─── Private Helpers ─────────────────────────────────────────────────────────

function isPrivateIp(hostname: string): boolean {
    // 10.x.x.x, 172.16-31.x.x, 192.168.x.x, 169.254.x.x (link-local), ::1
    const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
    if (ipv4) {
        const [, a, b] = ipv4.map(Number);
        if (a === 10) return true;
        if (a === 172 && b >= 16 && b <= 31) return true;
        if (a === 192 && b === 168) return true;
        if (a === 169 && b === 254) return true;
        // block but allow localhost explicitly via ALLOWED_LOCAL_PORTS above
        if (a === 127) return true;
    }
    if (hostname === '::1' || hostname === '[::1]') return true;
    return false;
}
