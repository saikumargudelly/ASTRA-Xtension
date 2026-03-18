// ─── Page State Agent ──────────────────────────────────────────────────────────
// Classifies the CURRENT INTERACTION STATE of a web page from a DOM snapshot.
//
// Why this exists:
//   PageIntelligence generates actions but has to guess what kind of "blocker"
//   screen it's on from raw element labels. This agent makes that classification
//   explicit and deterministic — no LLM call, zero latency, runs every round.
//
// Output feeds planActions.ts as a structured `pageState` context block that
// supersedes the loose text in stateFeedback for interaction-state decisions.
//
// Pattern matching is intentionally broad — false positives (calling a normal page
// a "cookie_consent" page) are caught by low confidence and the `actionHint`.

import type { BrowserSnapshot } from './pageIntelligence.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type PageInteractionState =
    | 'normal'           // Regular navigable page — no blockers
    | 'login_wall'       // Login / sign-in form is dominant or blocking progress
    | 'cookie_consent'   // Cookie/GDPR consent banner is present
    | 'captcha'          // CAPTCHA challenge is present
    | 'profile_select'   // Profile chooser (Netflix, Disney+, Hotstar, etc.)
    | 'paywall'          // Subscription or payment gate
    | 'age_verify'       // Age verification modal/gate
    | 'search_results'   // Results list visible (SERP, site search, product list)
    | 'product_page'     // E-commerce product detail page
    | 'checkout'         // Purchase / payment / shipping form
    | 'error_page'       // 404, 500, "page not found" etc.
    | 'loading'          // Page skeleton / spinner — not interactive yet
    | 'task_complete';   // Goal appears to already be achieved (video playing, etc.)

export interface PageState {
    /** Classified page interaction state */
    state: PageInteractionState;
    /** 0.0 – 1.0 — how confident the classifier is. < 0.5 = treat as normal */
    confidence: number;
    /**
     * What the planner should do for this state.
     * Injected verbatim into the planning prompt as a strong hint.
     */
    actionHint: string;
    /**
     * If state is a blocker (cookie consent, login, captcha), the CSS selector
     * or element description most likely to dismiss it.
     */
    blockerSelector?: string;
    /**
     * Raw signals that triggered the classification — for logging/debugging.
     */
    signals: string[];
}

// ─── Signal Matchers ──────────────────────────────────────────────────────────
// Each matcher has:
//   - test: a function that looks at element labels + visible text + URL
//   - state: the PageInteractionState to classify as
//   - weight: how much this signal contributes (additive, capped at 1.0)
//   - actionHint: what the planner should do
//   - selectorHint: (optional) the element selector most likely to dismiss it

interface SignalMatcher {
    name: string;
    test: (labels: string[], text: string, url: string) => boolean;
    state: PageInteractionState;
    weight: number;
    actionHint: string;
    selectorHint?: string;
}

const SIGNAL_MATCHERS: SignalMatcher[] = [
    // ── Cookie / GDPR consent ─────────────────────────────────────────────────
    {
        name: 'cookie_accept_button',
        test: (labels) => labels.some(l =>
            /^(accept all|accept cookies?|agree|i agree|allow all|allow cookies?|got it|ok|okay)/i.test(l)
        ),
        state: 'cookie_consent',
        weight: 0.9,
        actionHint:
            'A cookie consent banner is blocking the page. Click "Accept All" or "Accept Cookies" to dismiss it before taking any other action.',
        selectorHint: '[id*=cookie],[class*=cookie],[id*=consent],[class*=consent]',
    },
    {
        name: 'cookie_text_in_body',
        test: (_, text) =>
            /we use cookies|cookie policy|cookie preferences|gdpr|we value your privacy/i.test(text),
        state: 'cookie_consent',
        weight: 0.5,
        actionHint:
            'Cookie/privacy notice detected. Look for an "Accept" or "Dismiss" button and click it.',
        selectorHint: 'button',
    },

    // ── Login wall ────────────────────────────────────────────────────────────
    {
        name: 'login_form_elements',
        test: (labels) => {
            const hasPassword = labels.some(l => /password/i.test(l));
            const hasEmail = labels.some(l => /email|username|phone|sign.?in|log.?in/i.test(l));
            return hasPassword && hasEmail;
        },
        state: 'login_wall',
        weight: 0.95,
        actionHint:
            'A login form is present. If the user did not ask to log in, use ask_user to request credentials. Otherwise, fill email and password and click Sign In.',
    },
    {
        name: 'login_only_cta',
        test: (labels, text) =>
            !labels.some(l => /search|buy|add to cart|play|watch/i.test(l)) &&
            /sign in|log in|continue with google|continue with facebook/i.test(text),
        state: 'login_wall',
        weight: 0.7,
        actionHint:
            'Only login options are visible. The user must authenticate to proceed.',
    },

    // ── CAPTCHA ────────────────────────────────────────────────────────────────
    {
        name: 'captcha_text',
        test: (_, text) =>
            /captcha|verify you are human|robot|i'm not a robot|recaptcha|hcaptcha/i.test(text),
        state: 'captcha',
        weight: 1.0,
        actionHint:
            'A CAPTCHA challenge is present. ASTRA cannot solve CAPTCHAs automatically. Use ask_user to inform the user and ask them to solve it manually, then continue.',
    },

    // ── Profile selector (Netflix / Disney+ / Hotstar style) ──────────────────
    {
        name: 'profile_buttons_multiple',
        test: (labels, text) => {
            const profileKeywords = labels.filter(l => /^(who('s|s) watching|manage profiles?|add profile)/i.test(l));
            const profileItems = labels.filter(l =>
                l.length < 30 &&               // profile names are short
                !/sign|log|search|play|watch|add|manage|button|input|link/i.test(l)
            );
            return profileKeywords.length > 0 || (profileItems.length >= 2 && /who.?s watching|choose a profile/i.test(text));
        },
        state: 'profile_select',
        weight: 0.9,
        actionHint:
            'A profile selection screen is visible. Use ask_user with the profile names as options to ask the user which profile to use, then click the matching element.',
    },

    // ── Paywall / subscription gate ────────────────────────────────────────────
    {
        name: 'paywall_indicators',
        test: (labels, text) =>
            /subscribe|subscription required|start free trial|unlock|premium only|sign up to (read|watch|listen)/i.test(text) &&
            !labels.some(l => /search/i.test(l)),
        state: 'paywall',
        weight: 0.85,
        actionHint:
            'A paywall or subscription gate is blocking this content. Inform the user that a subscription is required to continue.',
    },

    // ── Age verification ───────────────────────────────────────────────────────
    {
        name: 'age_gate',
        test: (_, text) =>
            /are you (18|21|over 18|of legal age)|confirm your age|date of birth|you must be (18|21)/i.test(text),
        state: 'age_verify',
        weight: 0.95,
        actionHint:
            'An age verification gate is present. Look for a "Yes, I am over 18" or birth date input and fill/click it to proceed.',
    },

    // ── Error page ────────────────────────────────────────────────────────────
    {
        name: 'error_page',
        test: (_, text, url) =>
            /404|page not found|this page doesn't exist|something went wrong|error 5\d\d/i.test(text) ||
            /\/404|\/not-found|\/error/i.test(url),
        state: 'error_page',
        weight: 0.9,
        actionHint:
            'An error page is displayed. Navigate back or try a different URL. Do not continue with the current page.',
    },

    // ── Loading / skeleton ─────────────────────────────────────────────────────
    {
        name: 'empty_interactive',
        test: (labels, text) =>
            labels.length === 0 &&
            (text.length < 100 || /loading\.\.\.|please wait/i.test(text)),
        state: 'loading',
        weight: 0.8,
        actionHint:
            'The page appears to still be loading. Wait 2-3 seconds and retry.',
    },

    // ── Search results page ────────────────────────────────────────────────────
    {
        name: 'search_results_page',
        test: (labels, text, url) => {
            // Require explicit results text OR a search-results URL pattern
            // Avoids false-positives on homepages that have a search box + many buttons
            const hasResultsText = /results for|showing \d+ (results?|items?)|\d+ results? for|items found/i.test(text);
            const hasSearchUrl = /[?&](s|q|query|search_query|keyword)=/i.test(url) || /\/s\?|\/(search|results)\//i.test(url);
            return hasResultsText || hasSearchUrl;
        },
        state: 'search_results',
        weight: 0.75,
        actionHint:
            'Search results are visible. Extract, rank, or interact with the listed results to fulfil the user\'s task.',
    },

    // ── Product page ───────────────────────────────────────────────────────────
    {
        name: 'product_page',
        test: (labels) =>
            labels.some(l => /add to cart|buy now|add to bag|add to basket/i.test(l)),
        state: 'product_page',
        weight: 0.9,
        actionHint:
            'A product detail page is visible. You can add to cart, check price/reviews, or compare options.',
    },

    // ── Checkout / payment ──────────────────────────────────────────────────────
    {
        name: 'checkout_form',
        test: (labels, text) =>
            /place order|confirm order|pay now|complete purchase|payment method|card number|cvv/i.test(text) ||
            labels.some(l => /place order|pay now|confirm purchase/i.test(l)),
        state: 'checkout',
        weight: 0.95,
        actionHint:
            'A checkout or payment form is visible. Proceed carefully — confirm with the user before submitting any payment.',
    },

    // ── Task already complete ──────────────────────────────────────────────────
    {
        name: 'media_playing',
        test: (_, text, url) =>
            /now playing|pause|currently playing/i.test(text) ||
            (/youtube\.com\/watch|netflix\.com\/watch|hotstar\.com\/|primevideo\.com\/detail/.test(url)),
        state: 'task_complete',
        weight: 0.6,
        actionHint:
            'Media appears to be playing or the target content is displayed. Verify if the user\'s goal is achieved.',
    },
];

// ─── Classifier ────────────────────────────────────────────────────────────────

/**
 * Classifies the page's current interaction state from a DOM snapshot.
 * Runs synchronously — no LLM call, ~0ms.
 *
 * Called at the start of every planning round in planActions.ts.
 */
export function classifyPageState(snapshot: BrowserSnapshot): PageState {
    const labels = (snapshot.activeTab.interactiveElements ?? [])
        .map(el => el.label ?? '')
        .filter(Boolean);

    const text = snapshot.activeTab.visibleText ?? '';
    const url = snapshot.activeTab.url ?? '';

    // Accumulate per-state scores
    const scores = new Map<PageInteractionState, number>();
    const signals: string[] = [];
    let topSelectorHint: string | undefined;
    let topActionHint = 'Assess the page and plan the next step toward the user\'s goal.';

    for (const matcher of SIGNAL_MATCHERS) {
        if (matcher.test(labels, text, url)) {
            const prev = scores.get(matcher.state) ?? 0;
            scores.set(matcher.state, Math.min(1.0, prev + matcher.weight));
            signals.push(matcher.name);
            // Update hint for the highest-weight match of this state
            if ((prev + matcher.weight) > (scores.get(matcher.state) ?? 0) - 0.01) {
                topActionHint = matcher.actionHint;
                if (matcher.selectorHint) topSelectorHint = matcher.selectorHint;
            }
        }
    }

    if (scores.size === 0) {
        return {
            state: 'normal',
            confidence: 1.0,
            actionHint: 'Page appears normal. Proceed with the planned action sequence.',
            signals: [],
        };
    }

    // Pick the highest-scored state
    let bestState: PageInteractionState = 'normal';
    let bestScore = 0;
    for (const [state, score] of scores.entries()) {
        if (score > bestScore) {
            bestScore = score;
            bestState = state;
        }
    }

    // Find the correct actionHint for bestState
    const bestMatcher = SIGNAL_MATCHERS
        .filter(m => m.state === bestState)
        .sort((a, b) => b.weight - a.weight)[0];

    return {
        state: bestState,
        confidence: Math.min(1.0, bestScore),
        actionHint: bestMatcher?.actionHint ?? topActionHint,
        blockerSelector: bestMatcher?.selectorHint ?? topSelectorHint,
        signals,
    };
}

/**
 * Formats a PageState result as a TOON context block for injection
 * into the planning system prompt.
 */
export function formatPageStateForPlanner(ps: PageState): string {
    if (ps.state === 'normal' || ps.confidence < 0.5) return '';

    const lines = [
        '\n[PAGE_STATE — detected by ASTRA PageState Classifier]',
        `currentState: ${ps.state}`,
        `confidence: ${(ps.confidence * 100).toFixed(0)}%`,
        `ACTION_REQUIRED: ${ps.actionHint}`,
    ];

    if (ps.blockerSelector) {
        lines.push(`blockerSelector: ${ps.blockerSelector}`);
    }

    lines.push('[/PAGE_STATE]\n');
    return lines.join('\n');
}
