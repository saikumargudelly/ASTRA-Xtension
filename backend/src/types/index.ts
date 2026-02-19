// ─── Shared Backend Types ───

// Agent action step in a plan
export interface AgentStep {
    id: string;
    agent: 'browser' | 'summarizer' | 'memory';
    action: string;
    params: Record<string, unknown>;
    dependsOn?: string;
}

// Planner output
export interface StepPlan {
    intent: string;
    category: 'browse' | 'research' | 'summarize' | 'memory' | 'composite';
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
