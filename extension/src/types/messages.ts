// ════════════════════════════════════════════════════════════════════════════
// ASTRA – Browser-Centric Message & Action Type System
// ─ Every cross-boundary message is narrowly typed so security validation can
//   be applied at every boundary (popup ↔ background ↔ content script).
// ════════════════════════════════════════════════════════════════════════════

export type MessageType =
    // Popup ↔ Background
    | 'SUBMIT_COMMAND'
    | 'COMMAND_RESULT'
    | 'COMMAND_PROGRESS'
    | 'COMMAND_ERROR'
    | 'COMMAND_FOLLOW_UP'
    | 'FOLLOW_UP_RESPONSE'
    // Background ↔ Content Script (DOM)
    | 'EXECUTE_DOM_ACTION'
    | 'DOM_ACTION_RESULT'
    | 'READ_DOM'
    | 'DOM_DATA'
    | 'ANALYZE_PAGE'
    | 'PAGE_ANALYSIS'
    | 'FIND_ELEMENT'
    | 'HIGHLIGHT_RESULTS'
    | 'DISCOVER_FILTERS'
    | 'CLICK_ELEMENT'
    | 'HOVER_ELEMENT'
    | 'FILL_FORM'
    | 'EXTRACT_DATA'
    | 'WAIT_FOR_ELEMENT'
    | 'KEYBOARD_SHORTCUT'
    | 'GET_PAGE_SNAPSHOT'
    // Background → Content Script (follow-up overlay)
    | 'SHOW_FOLLOW_UP'
    | 'HIDE_FOLLOW_UP'
    // Background → Popup
    | 'CONFIG_REQUEST'
    | 'CONFIG_RESPONSE'
    | 'BROWSER_STATE_UPDATE';

// Popup → Background
export interface SubmitCommandMessage {
    type: 'SUBMIT_COMMAND';
    payload: {
        prompt: string;
        sessionId?: string;
        /** Browser locale for location-aware URLs (e.g. en-IN → open amazon.in) */
        locale?: string;
    };
}

// Background → Popup
export interface CommandResultMessage {
    type: 'COMMAND_RESULT';
    payload: {
        success: boolean;
        data: unknown;
        summary?: string;
        rankedResults?: RankedResult[];
        actionLog?: ActionLogEntry[];
    };
}

// Background → Popup
export interface CommandProgressMessage {
    type: 'COMMAND_PROGRESS';
    payload: {
        step: number;
        totalSteps: number;
        description: string;
        status: 'pending' | 'running' | 'done' | 'error';
        agentName?: string;
    };
}

// Background → Popup
export interface CommandErrorMessage {
    type: 'COMMAND_ERROR';
    payload: {
        message: string;
        code?: string;
        securityViolation?: boolean;
    };
}

// Background → Popup: Agent needs user input to continue (e.g. "Which Netflix profile?")
export interface CommandFollowUpMessage {
    type: 'COMMAND_FOLLOW_UP';
    payload: {
        question: string;
        options?: string[];   // Quick-select options extracted from the page
        context?: string;     // What the agent is currently doing
        category?: 'profile_select' | 'login_required' | 'cookie_consent' | 'captcha' | 'age_verify' | 'disambiguation' | 'general';
    };
}

// Popup → Background: User's answer to a follow-up question
export interface FollowUpResponseMessage {
    type: 'FOLLOW_UP_RESPONSE';
    payload: {
        answer: string;
    };
}

// Background → Content Script: Show a follow-up question overlay on the page
export interface ShowFollowUpMessage {
    type: 'SHOW_FOLLOW_UP';
    payload: {
        question: string;
        options?: string[];
        context?: string;
        category?: 'profile_select' | 'login_required' | 'cookie_consent' | 'captcha' | 'age_verify' | 'disambiguation' | 'general';
    };
}

// Background → Content Script: Remove the follow-up overlay
export interface HideFollowUpMessage {
    type: 'HIDE_FOLLOW_UP';
}

// ─── Browser-Level Actions ───────────────────────────────────────────────────
// These run in the background service worker using chrome.* APIs.
// The LLM planner picks from this exact union — no freeform strings allowed.
export type BrowserAction =
    // Tab lifecycle
    | { type: 'open_tab';       url: string;       active?: boolean; incognito?: boolean }
    | { type: 'close_tab';      tabId?: number }
    | { type: 'switch_tab';     tabId: number }
    | { type: 'reload_tab';     tabId?: number;    bypassCache?: boolean }
    | { type: 'duplicate_tab';  tabId?: number }
    | { type: 'pin_tab';        tabId?: number;    pinned: boolean }
    | { type: 'mute_tab';       tabId?: number;    muted: boolean }
    | { type: 'move_tab';       tabId: number;     index: number }
    | { type: 'zoom_tab';       tabId?: number;    factor: number }
    // Navigation
    | { type: 'navigate';       url: string;       tabId?: number }
    | { type: 'go_back';        tabId?: number }
    | { type: 'go_forward';     tabId?: number }
    // Window management
    | { type: 'new_window';     url?: string;      incognito?: boolean }
    | { type: 'close_window';   windowId?: number }
    | { type: 'focus_window';   windowId: number }
    // Browser queries
    | { type: 'get_all_tabs' }
    | { type: 'search_tabs';    query: string }
    | { type: 'screenshot';     tabId?: number }
    // Bookmarks / Downloads
    | { type: 'bookmark_page';  title?: string;    url?: string }
    | { type: 'download_file';  url: string;       filename?: string };

// ─── DOM-Level Actions ───────────────────────────────────────────────────────
// These are forwarded to the content script and execute inside the page.
export type DOMAction =
    | { type: 'click';          selector: string;  label?: string }
    | { type: 'type';           selector: string;  value: string }
    | { type: 'hover';          selector: string }
    | { type: 'focus';          selector: string }
    | { type: 'clear';          selector: string }
    | { type: 'select_option';  selector: string;  value: string }
    | { type: 'fill_form';      fields: Array<{ selector: string; value: string; label?: string }> }
    | { type: 'scroll';         direction?: 'up' | 'down'; amount?: number; selector?: string }
    | { type: 'scroll_to';      selector: string }
    | { type: 'drag_drop';      fromSelector: string; toSelector: string }
    | { type: 'wait_for';       selector: string;  timeout?: number }
    | { type: 'keyboard';       keys: string[] }
    | { type: 'extract_data';   selector: string;  attribute?: string }
    | { type: 'search';         value: string }
    | { type: 'submit_form';    selector?: string }
    | { type: 'wait';            duration?: number }
    | { type: 'read_page' }
    | { type: 'analyze_page' }
    | { type: 'press_enter';    selector?: string };

// ─── Planner Action (union returned by LLM /plan-actions route) ─────────────
// Includes ask_user for conversational follow-ups when the agent needs user input
export type AskUserAction = {
    type: 'ask_user';
    value: string;        // The question to ask
    options?: string[];   // Quick-select choices from the page
    category?: 'profile_select' | 'login_required' | 'cookie_consent' | 'captcha' | 'age_verify' | 'disambiguation' | 'general';
    reason?: string;
};

export type PlannerAction = ((BrowserAction | DOMAction | AskUserAction) & {
    label: string;
    elementIdx?: number;
    selector?: string;  // DOM actions only
    value?: string;
});

// Background → Content Script
export interface ExecuteDOMActionMessage {
    type: 'EXECUTE_DOM_ACTION';
    payload: {
        action: 'click' | 'type' | 'scroll' | 'wait' | 'search' | 'press_enter' | 'focus' | 'clear' | 'select_option' | 'range-set';
        selector?: string;
        value?: string;
        duration?: number;
        direction?: 'up' | 'down';
        amount?: number;
    };
}

// Content Script → Background
export interface DOMActionResultMessage {
    type: 'DOM_ACTION_RESULT';
    payload: {
        success: boolean;
        data?: unknown;
        error?: string;
    };
}

// Background → Content Script
export interface ReadDOMMessage {
    type: 'READ_DOM';
    payload: {
        selector?: string;
        maxDepth?: number;
        includeText?: boolean;
    };
}

// Content Script → Background
export interface DOMDataMessage {
    type: 'DOM_DATA';
    payload: {
        url: string;
        title: string;
        elements: DOMElement[];
    };
}

// Background → Content Script: Show visual ASTRA result badges on-page
export interface HighlightResultsMessage {
    type: 'HIGHLIGHT_RESULTS';
    payload: {
        query: string;
        results: Array<{
            rank: number;
            title: string;
            url?: string;
            snippet?: string;
            rating?: string;
            reviewCount?: string;
            reason?: string;
            badge?: string;
        }>;
    };
}

// Background → Content Script: Discover all filter/sort UI elements
export interface DiscoverFiltersMessage {
    type: 'DISCOVER_FILTERS';
    payload: Record<string, never>;
}

// Background → Content Script: Click a specific element with cursor animation
export interface ClickElementMessage {
    type: 'CLICK_ELEMENT';
    payload: { selector: string; label?: string };
}

// Background → Content Script: Hover over an element
export interface HoverElementMessage {
    type: 'HOVER_ELEMENT';
    payload: { selector: string; label?: string };
}

// Background → Content Script: Fill multiple form fields atomically
export interface FillFormMessage {
    type: 'FILL_FORM';
    payload: { fields: Array<{ selector: string; value: string; label?: string }> };
}

// Background → Content Script: Extract structured data from the page
export interface ExtractDataMessage {
    type: 'EXTRACT_DATA';
    payload: { selector: string; attribute?: string; multiple?: boolean };
}

// Background → Content Script: Wait for a dynamic element to appear
export interface WaitForElementMessage {
    type: 'WAIT_FOR_ELEMENT';
    payload: { selector: string; timeout?: number; visible?: boolean };
}

// Background → Content Script: Send keyboard shortcut to the page
export interface KeyboardShortcutMessage {
    type: 'KEYBOARD_SHORTCUT';
    payload: { keys: string[] };
}

// Background → Content Script: Get full interactive element snapshot
export interface GetPageSnapshotMessage {
    type: 'GET_PAGE_SNAPSHOT';
    payload: Record<string, never>;
}

// ─── Browser State ──────────────────────────────────────────────────────────
export interface TabInfo {
    tabId: number; windowId: number; title: string; url: string;
    active: boolean; pinned: boolean; muted: boolean; loading: boolean; audible: boolean;
}

export interface BrowserStateUpdateMessage {
    type: 'BROWSER_STATE_UPDATE';
    payload: { tabs: TabInfo[]; activeTabId: number | null };
}

// ─── Action Audit Log ────────────────────────────────────────────────────────
export interface ActionLogEntry {
    ts: number; action: string; label: string; target?: string;
    success: boolean; blocked?: boolean; reason?: string;
}

// ─── Ranked Results ──────────────────────────────────────────────────────────
export interface RankedResult {
    rank: number; title: string; url?: string; rating?: string;
    reviewCount?: string; snippet?: string; reason?: string; badge?: string; price?: string;
}

// Content Script response shape for GET_PAGE_SNAPSHOT
export interface PageSnapshotElement {
    idx: number;
    type: string;
    label: string;
    selector: string;
    value?: string;
    section?: string;
    role?: string;
    min?: string;
    max?: string;
    options?: string[];
}

// Background → Content Script: Find a page element by description (vision-assisted)
export interface FindElementMessage {
    type: 'FIND_ELEMENT';
    payload: {
        description: string;
        elementType?: string;
    };
}

// Background → Content Script
export interface AnalyzePageMessage {
    type: 'ANALYZE_PAGE';
    payload: {
        maxScrolls?: number;        // Max number of scroll steps (default 10)
        scrollDelay?: number;       // Ms between scrolls (default 500)
        includeStructure?: boolean; // Include DOM structure (default true)
    };
}

// Content Script → Background
export interface PageAnalysisMessage {
    type: 'PAGE_ANALYSIS';
    payload: PageAnalysisData;
}

export interface PageAnalysisData {
    url: string;
    title: string;
    meta: PageMeta;
    fullText: string;             // All readable text from the entire page
    sections: PageSection[];       // Content organized by sections/headings
    links: PageLink[];             // All links on the page
    forms: PageForm[];             // All forms and inputs
    tables: PageTable[];           // All tables
    images: PageImage[];           // All images with alt text
    scrollDepth: number;           // How far down the page we scrolled (%)
    totalHeight: number;           // Page height in px
    viewportHeight: number;        // Viewport height in px
    viewportSnapshots: ViewportSnapshot[]; // New: Content at each scroll position
    restricted?: boolean; // New: If true, page content was blocked by browser security
}

export interface PageMeta {
    description?: string;
    keywords?: string;
    ogTitle?: string;
    ogDescription?: string;
    canonical?: string;
    language?: string;
}

export interface PageSection {
    heading: string;
    level: number;         // h1=1, h2=2, etc.
    text: string;          // Text content under this heading
}

export interface PageLink {
    text: string;
    href: string;
    isExternal: boolean;
}

export interface PageForm {
    action?: string;
    inputs: Array<{
        type: string;
        name?: string;
        placeholder?: string;
        label?: string;
        value?: string;
    }>;
}

export interface PageTable {
    headers: string[];
    rows: string[][];
    rowCount: number;
}

export interface PageImage {
    src: string;
    alt?: string;
    width?: number;
    height?: number;
}

export interface ViewportSnapshot {
    scrollY: number;        // Scroll position
    visibleText: string;    // Text visible in this viewport
    visibleElements: number; // Count of visible interactive elements
}

export interface DOMElement {
    tag: string;
    id?: string;
    className?: string;
    text?: string;
    href?: string;
    value?: string;
    children?: DOMElement[];
    attributes?: Record<string, string>;
    rect?: { top: number; left: number; width: number; height: number };
}

// ─── Configuration Assistant Types ───

// Popup → Background
export interface ConfigRequestMessage {
    type: 'CONFIG_REQUEST';
    payload: {
        query: string;
        context?: {
            url?: string;
            title?: string;
        };
    };
}

// Background → Popup
export interface ConfigResponseMessage {
    type: 'CONFIG_RESPONSE';
    payload: {
        success: boolean;
        intent: string;
        application: string;
        walkthrough?: Walkthrough;
        alternativeGuides?: Array<{
            title: string;
            url: string;
            source: string;
        }>;
        error?: string;
    };
}

export interface Walkthrough {
    id: string;
    title: string;
    description: string;
    application: string;
    totalSteps: number;
    estimatedTime?: string;
    steps: WalkthroughStep[];
    source: {
        url: string;
        name: string;
    };
    lastUpdated: string;
}

export interface WalkthroughStep {
    stepNumber: number;
    title: string;
    instruction: string;
    tips?: string[];
    warnings?: string[];
    estimatedSeconds?: number;
    screenshot?: string;
    uiElements?: UIElement[];
    navigation?: NavigationHint;
}

export interface UIElement {
    type: 'button' | 'menu' | 'input' | 'link' | 'tab' | 'dropdown' | 'checkbox' | 'toggle';
    label: string;
    location?: string;
    action?: string;
}

export interface NavigationHint {
    path: string[];
    url?: string;
    shortcut?: string;
}

export type ExtensionMessage =
    | SubmitCommandMessage
    | CommandResultMessage
    | CommandProgressMessage
    | CommandErrorMessage
    | CommandFollowUpMessage
    | FollowUpResponseMessage
    | ExecuteDOMActionMessage
    | DOMActionResultMessage
    | ReadDOMMessage
    | DOMDataMessage
    | AnalyzePageMessage
    | PageAnalysisMessage
    | FindElementMessage
    | HighlightResultsMessage
    | DiscoverFiltersMessage
    | ClickElementMessage
    | HoverElementMessage
    | FillFormMessage
    | ExtractDataMessage
    | WaitForElementMessage
    | KeyboardShortcutMessage
    | GetPageSnapshotMessage
    | ShowFollowUpMessage
    | HideFollowUpMessage
    | ConfigRequestMessage
    | ConfigResponseMessage
    | BrowserStateUpdateMessage;
