// ─── Message Types: Popup ↔ Background ↔ Content ───

export type MessageType =
    | 'SUBMIT_COMMAND'
    | 'COMMAND_RESULT'
    | 'COMMAND_PROGRESS'
    | 'COMMAND_ERROR'
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
    | 'CONFIG_REQUEST'
    | 'CONFIG_RESPONSE';

// Popup → Background
export interface SubmitCommandMessage {
    type: 'SUBMIT_COMMAND';
    payload: {
        prompt: string;
        sessionId?: string;
    };
}

// Background → Popup
export interface CommandResultMessage {
    type: 'COMMAND_RESULT';
    payload: {
        success: boolean;
        data: unknown;
        summary?: string;
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
    };
}

// Background → Popup
export interface CommandErrorMessage {
    type: 'COMMAND_ERROR';
    payload: {
        message: string;
        code?: string;
    };
}

// Background → Content Script
export interface ExecuteDOMActionMessage {
    type: 'EXECUTE_DOM_ACTION';
    payload: {
        action: 'click' | 'type' | 'scroll' | 'wait' | 'search';
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
    payload: {
        selector: string;
        label?: string;
    };
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
    | ConfigRequestMessage
    | ConfigResponseMessage;
