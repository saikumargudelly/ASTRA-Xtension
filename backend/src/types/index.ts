// ─── Shared Backend Types ───

// Agent action step in a plan
export interface AgentStep {
    id: string;
    agent: 'browser' | 'summarizer' | 'memory' | 'config' | 'analyzer' | 'vision';
    action: string;
    params: Record<string, unknown>;
    dependsOn?: string;
}

// Planner output
export interface StepPlan {
    intent: string;
    category: 'browse' | 'research' | 'summarize' | 'memory' | 'configuration' | 'composite';
    steps: AgentStep[];
    reasoning: string;
}

// Intent endpoint request/response
export interface IntentRequest {
    prompt: string;
    context?: {
        url?: string;
        title?: string;
    };
    screenshot?: string; // base64 JPEG — for vision-informed planning
}

export interface IntentResponse {
    plan: StepPlan;
}

// Execute endpoint request/response
export interface ExecuteRequest {
    plan: StepPlan;
    prompt: string;
}

export interface ExecuteResponse {
    success: boolean;
    data: unknown;
    summary?: string;
    steps: StepResult[];
}

export interface StepResult {
    stepId: string;
    success: boolean;
    data?: unknown;
    error?: string;
    durationMs: number;
}

// Summarize endpoint
export interface SummarizeRequest {
    text: string;
    mode: 'summarize' | 'bullets';
    maxLength?: number;
    bulletCount?: number;
}

export interface SummarizeResponse {
    result: string;
}

// Memory endpoints
export interface MemoryStoreRequest {
    text: string;
    metadata?: Record<string, string>;
}

export interface MemoryQueryRequest {
    query: string;
    topK?: number;
}

export interface MemoryEntry {
    id: string;
    text: string;
    metadata?: Record<string, string>;
    score?: number;
    createdAt: string;
}

// LLM Service
export interface LLMMessage {
    role: 'system' | 'user' | 'assistant';
    content: string | Array<{
        type: 'text' | 'image_url';
        text?: string;
        image_url?: { url: string };
    }>;
}

export interface LLMResponse {
    content: string;
    tokensUsed: {
        prompt: number;
        completion: number;
        total: number;
    };
}

// Browser actions (sent to extension)
export type BrowserAction =
    | { type: 'scroll'; direction: 'up' | 'down'; amount?: number; selector?: string }
    | { type: 'click'; selector: string }
    | { type: 'type'; selector: string; value: string }
    | { type: 'wait'; duration: number }
    | { type: 'read_page'; selector?: string; maxDepth?: number }
    | { type: 'analyze_page'; maxScrolls?: number; scrollDelay?: number }
    | { type: 'search'; value: string };

// Analyze endpoint
export interface AnalyzeRequest {
    prompt: string;
    pageData: PageAnalysisPayload | null;
    screenshot?: string;
}

export interface RankedResult {
    rank: number;
    title: string;
    url?: string;
    snippet?: string;
    rating?: string;      // e.g. "4.8 stars", "94% positive"
    reviewCount?: string; // e.g. "12,400 reviews"
    reason?: string;      // Why ASTRA picked this one
    badge?: string;       // e.g. "Best Seller", "Highest Rated", "Most Reviewed"
}

export interface AnalyzeResponse {
    success: boolean;
    summary: string;
    rankedResults?: RankedResult[];
    data: {
        pageTitle: string;
        pageUrl: string;
        contentLength: number;
        sectionsFound: number;
        linksFound: number;
        formsFound: number;
        tablesFound: number;
        imagesFound: number;
        scrollCoverage: number;
        screenshotCaptured: boolean;
    };
}

export interface PageAnalysisPayload {
    url: string;
    title: string;
    fullText: string;
    meta?: Record<string, string | undefined>;
    sections?: Array<{ heading: string; level: number; text: string }>;
    links?: Array<{ text: string; href: string; isExternal: boolean }>;
    forms?: Array<{ action?: string; inputs: Array<Record<string, string | undefined>> }>;
    tables?: Array<{ headers: string[]; rows: string[][]; rowCount: number }>;
    images?: Array<{ src: string; alt?: string }>;
    scrollDepth?: number;
    totalHeight?: number;
    viewportHeight?: number;
    viewportSnapshots?: Array<{
        scrollY: number;
        visibleText: string;
        visibleElements: number;
    }>;
    restricted?: boolean;
}

// ─── Configuration Assistant Types ───

// Web Search Types
export interface WebSearchResult {
    title: string;
    url: string;
    snippet: string;
    source: string;        // Domain name
    relevanceScore?: number;
    publishedDate?: string;
    thumbnail?: string;
}

export interface WebSearchOptions {
    maxResults?: number;
    excludeDomains?: string[];
    includeDomains?: string[];
    region?: string;
    safeSearch?: boolean;
    timeRange?: 'day' | 'week' | 'month' | 'year';
}

// Guide Extraction Types
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

export interface ExtractedStep {
    order: number;
    title: string;
    instruction: string;
    tips?: string[];
    warnings?: string[];
    prerequisites?: string[];
    uiElements?: UIElement[];
    navigation?: NavigationHint;
}

export interface ExtractedGuide {
    id: string;
    title: string;
    source: {
        url: string;
        name: string;
        credibility: 'official' | 'community' | 'blog' | 'unknown';
    };
    application: string;
    summary: string;
    steps: ExtractedStep[];
    prerequisites?: string[];
    requirements?: string[];
    relatedTopics?: string[];
    difficulty?: 'beginner' | 'intermediate' | 'advanced';
    estimatedTime?: string;
    lastVerified?: string;
}

// Walkthrough Types
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

// Config Endpoint Types
export interface ConfigRequest {
    query: string;
    context?: {
        url?: string;
        title?: string;
    };
}

export interface ConfigResponse {
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
}

export interface WalkthroughProgressRequest {
    walkthroughId: string;
    currentStep: number;
    action: 'next' | 'previous' | 'complete';
}

export interface WalkthroughProgressResponse {
    success: boolean;
    currentStep: number;
    totalSteps: number;
    step?: WalkthroughStep;
    isComplete: boolean;
}
