// ─── Configuration Agent ───
// Handles configuration-related queries by searching for guides,
// extracting step-by-step instructions, and generating interactive walkthroughs

import type { 
    ConfigRequest, 
    ConfigResponse, 
    Walkthrough, 
    ExtractedGuide
} from '../types/index.js';
import { searchConfigGuides, fetchPageContent, withRetry } from '../services/webSearch.js';
import { extractGuideFromContent } from './guideExtractor.js';
import { generateWalkthrough } from './walkthroughGenerator.js';

// ─── Configuration Patterns ───

const CONFIG_PATTERNS = [
    /how (do i|to|can i) (configure|setup|set up|change|update|modify|enable|disable)/i,
    /where (is|are|can i find) (the |my )?(settings?|configuration|options?|preferences)/i,
    /help me (configure|setup|find|change|update)/i,
    /(enable|disable|turn on|turn off|activate|deactivate) .*(setting|option|feature|mode)/i,
    /(privacy|security|account|profile|notification) settings?/i,
    /configure .*(oic|ofsc|oci|oracle|facebook|google|microsoft|aws|azure)/i,
    /i (want to|need to|would like to) (change|update|configure|modify)/i,
    /(step[- ]by[- ]step|walkthrough|guide|tutorial) (for|on|to)/i,
    /(settings?|configuration) (for|in|on) (facebook|oracle|google|microsoft)/i,
    /(facebook|oracle|google|microsoft|aws|azure) .*(settings?|configuration|setup)/i,
];

// ─── Application Detection ───

const APPLICATION_PATTERNS: Array<{ pattern: RegExp; name: string }> = [
    { pattern: /facebook|meta|fb/i, name: 'Facebook' },
    { pattern: /instagram|ig/i, name: 'Instagram' },
    { pattern: /oracle integration cloud|oic/i, name: 'Oracle Integration Cloud' },
    { pattern: /oracle field service|ofsc/i, name: 'Oracle Field Service' },
    { pattern: /oracle cloud infrastructure|oci/i, name: 'Oracle Cloud Infrastructure' },
    { pattern: /oracle/i, name: 'Oracle' },
    { pattern: /google|gmail|youtube/i, name: 'Google' },
    { pattern: /microsoft|azure|office 365|outlook/i, name: 'Microsoft' },
    { pattern: /aws|amazon web services/i, name: 'AWS' },
    { pattern: /apple|iphone|ipad|mac/i, name: 'Apple' },
    { pattern: /twitter|x\.com/i, name: 'Twitter' },
    { pattern: /linkedin/i, name: 'LinkedIn' },
    { pattern: /vscode|visual studio code/i, name: 'VS Code' },
    { pattern: /github/i, name: 'GitHub' },
    { pattern: /slack/i, name: 'Slack' },
    { pattern: /zoom/i, name: 'Zoom' },
];

// ─── Main Handler ───

/**
 * Handle a configuration request
 * 1. Detect application and intent
 * 2. Search for relevant guides
 * 3. Extract and structure guide content
 * 4. Generate interactive walkthrough
 */
export async function handleConfigRequest(request: ConfigRequest): Promise<ConfigResponse> {
    const startTime = Date.now();
    
    try {
        // Step 1: Detect application and intent
        const application = detectApplication(request.query, request.context);
        const intent = extractIntent(request.query);
        
        console.log(`[ConfigAgent] Processing: "${request.query}" for ${application}`);
        
        // Step 2: Search for guides
        const searchResults = await withRetry(
            () => searchConfigGuides(request.query, application, { maxResults: 5 }),
            2,
            1000
        );
        
        if (searchResults.length === 0) {
            return {
                success: false,
                intent,
                application,
                error: 'No configuration guides found for your query. Try being more specific.',
            };
        }
        
        console.log(`[ConfigAgent] Found ${searchResults.length} potential guides`);
        
        // Step 3: Extract guides from top results
        const extractedGuides: Array<{ guide: ExtractedGuide; confidence: number }> = [];
        
        for (const result of searchResults.slice(0, 3)) {
            try {
                const content = await fetchPageContent(result.url, { timeout: 8000 });
                const extractionResult = await extractGuideFromContent(
                    content,
                    result.url,
                    request.query
                );
                
                if (extractionResult.success && extractionResult.guide && extractionResult.confidence > 0.5) {
                    extractedGuides.push({
                        guide: extractionResult.guide,
                        confidence: extractionResult.confidence,
                    });
                }
            } catch (error) {
                console.warn(`[ConfigAgent] Failed to extract from ${result.url}:`, (error as Error).message);
            }
        }
        
        if (extractedGuides.length === 0) {
            return {
                success: false,
                intent,
                application,
                error: 'Found guides but could not extract step-by-step instructions. Please try a different query.',
            };
        }
        
        // Sort by confidence
        extractedGuides.sort((a, b) => b.confidence - a.confidence);
        
        // Step 4: Generate walkthrough from best guide
        const bestGuide = extractedGuides[0].guide;
        const walkthrough = await generateWalkthrough(bestGuide, request.query);
        
        const duration = Date.now() - startTime;
        console.log(`[ConfigAgent] Generated walkthrough with ${walkthrough.totalSteps} steps in ${duration}ms`);
        
        // Prepare alternative guides
        const alternativeGuides = extractedGuides.slice(1, 3).map(({ guide }) => ({
            title: guide.title,
            url: guide.source.url,
            source: guide.source.name,
        }));
        
        return {
            success: true,
            intent,
            application,
            walkthrough,
            alternativeGuides,
        };
        
    } catch (error) {
        console.error('[ConfigAgent] Error:', error);
        
        return {
            success: false,
            intent: extractIntent(request.query),
            application: detectApplication(request.query, request.context),
            error: `Failed to process configuration request: ${(error as Error).message}`,
        };
    }
}

// ─── Intent Detection ───

/**
 * Check if a query is a configuration-related query
 */
export function isConfigurationQuery(query: string): boolean {
    return CONFIG_PATTERNS.some(pattern => pattern.test(query));
}

/**
 * Extract the user's intent from their query
 */
function extractIntent(query: string): string {
    // Clean up the query and extract the core intent
    let intent = query
        .replace(/^(how do i|how to|how can i|help me|i want to|i need to|i would like to)\s*/i, '')
        .replace(/\?$/g, '')
        .trim();
    
    // Capitalize first letter
    if (intent.length > 0) {
        intent = intent.charAt(0).toUpperCase() + intent.slice(1);
    }
    
    return intent || 'Configure settings';
}

// ─── Application Detection ───

/**
 * Detect which application the user is asking about
 */
function detectApplication(
    query: string, 
    context?: { url?: string; title?: string }
): string {
    // Check query first
    for (const { pattern, name } of APPLICATION_PATTERNS) {
        if (pattern.test(query)) {
            return name;
        }
    }
    
    // Check context URL
    if (context?.url) {
        const url = context.url.toLowerCase();
        for (const { pattern, name } of APPLICATION_PATTERNS) {
            if (pattern.test(url)) {
                return name;
            }
        }
    }
    
    // Check context title
    if (context?.title) {
        const title = context.title.toLowerCase();
        for (const { pattern, name } of APPLICATION_PATTERNS) {
            if (pattern.test(title)) {
                return name;
            }
        }
    }
    
    return 'Unknown Application';
}

// ─── Utility Functions ───

/**
 * Get a list of supported applications
 */
export function getSupportedApplications(): string[] {
    return APPLICATION_PATTERNS.map(({ name }) => name);
}

/**
 * Build a search query optimized for configuration guides
 */
export function buildConfigSearchQuery(query: string, application: string): string {
    // Remove common filler words
    const cleanedQuery = query
        .replace(/\b(how do i|how to|how can i|help me|i want to|i need to)\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
    
    // Add configuration-specific terms
    const terms = ['configure', 'settings', 'guide', 'tutorial'];
    const hasConfigTerm = terms.some(term => cleanedQuery.toLowerCase().includes(term));
    
    if (hasConfigTerm) {
        return `${application} ${cleanedQuery}`;
    }
    
    return `${application} ${cleanedQuery} configuration settings`;
}

// ─── Export All ───

export default {
    handleConfigRequest,
    isConfigurationQuery,
    getSupportedApplications,
    buildConfigSearchQuery,
};
