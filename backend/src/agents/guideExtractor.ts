// ─── Guide Extractor Agent ───
// Extracts structured step-by-step guides from web page content using LLM

import { chat } from '../services/llm.js';
import type {
    ExtractedGuide,
    ExtractedStep,
    UIElement,
    NavigationHint
} from '../types/index.js';

// ─── Types ───

export interface ExtractionOptions {
    maxSteps?: number;
    includeImages?: boolean;
    language?: string;
    focusArea?: string;
}

export interface ExtractionResult {
    success: boolean;
    guide?: ExtractedGuide;
    error?: string;
    confidence: number;
}

// ─── System Prompt ───

const EXTRACTION_SYSTEM_PROMPT = `You are an expert technical documentation parser specializing in extracting configuration guides from web content. Your job is to identify, extract, and structure step-by-step instructions from various types of web pages.

You excel at:
1. Identifying configuration steps even in poorly formatted content
2. Extracting UI element names (buttons, menus, settings)
3. Recognizing prerequisites and requirements
4. Preserving important warnings and tips
5. Filtering out ads, navigation, and unrelated content

You always return valid TOON (Token-Oriented Object Notation) with the exact structure requested.`;

// ─── Main Extraction Function ───

/**
 * Extract a structured guide from web page content
 */
export async function extractGuideFromContent(
    content: string,
    url: string,
    userQuery: string,
    options: ExtractionOptions = {}
): Promise<ExtractionResult> {
    const {
        maxSteps = 15,
        includeImages = false,
        focusArea
    } = options;

    // Step 1: Pre-process content
    const processedContent = preprocessContent(content, maxSteps);

    // Step 2: Build extraction prompt
    const extractionPrompt = buildExtractionPrompt(
        processedContent,
        userQuery,
        { maxSteps, includeImages, focusArea }
    );

    try {
        // Step 3: Extract guide using LLM (TOON format)
        const rawResponse = await chat(EXTRACTION_SYSTEM_PROMPT, extractionPrompt);
        const parsedGuide = parseToonToExtractionRecord(rawResponse);

        // Step 4: Validate and post-process
        const guide = validateAndEnrichGuide(parsedGuide, url);

        return {
            success: true,
            guide,
            confidence: calculateConfidence(guide, userQuery),
        };

    } catch (error) {
        console.error('[GuideExtractor] Extraction failed:', error);

        return {
            success: false,
            error: (error as Error).message,
            confidence: 0,
        };
    }
}

// ─── Content Pre-processing ───

/**
 * Clean and prepare content for LLM processing
 */
function preprocessContent(content: string, maxSteps: number): string {
    let processed = content;

    // Remove common noise patterns
    const noisePatterns = [
        /Cookie Policy.*?accept/gis,
        /Subscribe to our newsletter.*?/gi,
        /Follow us on (Twitter|Facebook|LinkedIn|Instagram)/gi,
        /Advertisement/gi,
        /Related Articles.*?(?=\n\n|\Z)/gis,
        /Comments.*?(?=\n\n|\Z)/gis,
        /Share this article.*?(?=\n\n|\Z)/gis,
        /Sign up for.*?/gi,
        /Log in to.*?/gi,
    ];

    for (const pattern of noisePatterns) {
        processed = processed.replace(pattern, '');
    }

    // Truncate if too long (keep ~8000 chars for LLM context)
    if (processed.length > 8000) {
        // Try to find a good breaking point
        const breakPoints = ['\n\n', '\n', '. ', ' '];
        for (const bp of breakPoints) {
            const idx = processed.lastIndexOf(bp, 8000);
            if (idx > 6000) {
                processed = processed.slice(0, idx);
                break;
            }
        }
    }

    return processed.trim();
}

// ─── Prompt Building ───

function buildExtractionPrompt(
    content: string,
    userQuery: string,
    options: { maxSteps: number; includeImages: boolean; focusArea?: string }
): string {
    return `Extract a step-by-step configuration guide from the following web page content.

USER'S QUESTION: ${userQuery}
${options.focusArea ? `FOCUS AREA: ${options.focusArea}` : ''}

PAGE CONTENT:
${content}

---

Analyze the content and extract a structured guide. Return ONLY valid TOON (Token-Oriented Object Notation):

[GUIDE_TOON]
title: Clear, descriptive title for this guide
application: The application being configured (e.g., Facebook, Oracle Cloud, VS Code)
summary: 1-2 sentence overview of what this guide accomplishes
difficulty: beginner or intermediate or advanced
estimatedTime: Estimated time to complete (e.g., '5 minutes')
prerequisites: Prerequisite 1 | Prerequisite 2
requirements: Requirement 1 | Requirement 2
relatedTopics: Topic 1 | Topic 2

[STEPS]
title: Clear, action-oriented step title
instruction: Detailed instruction with specific UI elements mentioned
tips: Helpful tip 1 | Helpful tip 2
warnings: Important warning 1
uiElements.type: button
uiElements.label: Text shown on element
navigation.path: Settings | Privacy | Security
---
title: Next action step
instruction: Next instructions
[/STEPS]
[/GUIDE_TOON]

EXTRACTION RULES:
1. CRITICAL: Only include steps that DIRECTLY answer the user's question: "${userQuery}"
2. Each step must be a SINGLE, actionable instruction with a clear action verb
3. Extract EXACT text for UI elements (button labels, menu names) - do not paraphrase
4. Steps must be in LOGICAL order - start from where the user currently is
5. Preserve ALL warnings and important notes as pipe-separated items
6. If content is not a guide (e.g., product page, error page), output empty [STEPS]
7. Maximum ${options.maxSteps} steps - prioritize the most important ones
8. If multiple methods exist, choose the most straightforward one
9. Include navigation paths when available, pipe-separated (e.g., Settings | Privacy | Security)
10. Mark difficulty based on technical complexity

STEP QUALITY REQUIREMENTS:
- Each step title should start with an action verb (Click, Open, Select, Enable, etc.)
- Each instruction should be specific enough that a user can follow it without guessing
- UI element labels must match EXACTLY what appears on screen
- Navigation paths should show the complete paths

ACCURACY CHECKS:
- Does this guide DIRECTLY answer: "${userQuery}"?
- Can a user follow these steps without additional context?
- Are the UI element names exactly as they appear in the application?

Return ONLY the TOON block, no additional text.`;
}

// ─── TOON Parsing ───

function parseToonToExtractionRecord(rawResponse: string): Record<string, unknown> {
    const record: Record<string, unknown> = {
        title: '',
        application: '',
        summary: '',
        difficulty: 'beginner',
        estimatedTime: '',
        prerequisites: [],
        requirements: [],
        relatedTopics: [],
        steps: []
    };

    const lines = rawResponse.split('\n');
    let inStepsBlock = false;
    let currentStep: any = null;

    for (let line of lines) {
        line = line.trim();
        if (!line || line.startsWith('[GUIDE_TOON]') || line.startsWith('[/GUIDE_TOON]')) continue;

        if (line === '[STEPS]') {
            inStepsBlock = true;
            currentStep = {};
            continue;
        }

        if (line === '[/STEPS]') {
            if (currentStep && Object.keys(currentStep).length > 0) {
                (record.steps as any[]).push(currentStep);
            }
            inStepsBlock = false;
            currentStep = null;
            continue;
        }

        if (inStepsBlock && line === '---') {
            if (currentStep && Object.keys(currentStep).length > 0) {
                (record.steps as any[]).push(currentStep);
                currentStep = {};
            }
            continue;
        }

        const colonIdx = line.indexOf(':');
        if (colonIdx > 0) {
            const key = line.substring(0, colonIdx).trim();
            const val = line.substring(colonIdx + 1).trim();

            if (val === 'null' || val === 'None' || !val) continue;

            if (inStepsBlock && currentStep) {
                if (key === 'tips' || key === 'warnings') {
                    currentStep[key] = val.split('|').map(s => s.trim()).filter(Boolean);
                } else if (key === 'uiElements.type') {
                    currentStep.uiElements = currentStep.uiElements || [{}];
                    currentStep.uiElements[0].type = val;
                } else if (key === 'uiElements.label') {
                    currentStep.uiElements = currentStep.uiElements || [{}];
                    currentStep.uiElements[0].label = val;
                } else if (key === 'navigation.path') {
                    currentStep.navigation = currentStep.navigation || {};
                    currentStep.navigation.path = val.split('|').map(s => s.trim()).filter(Boolean);
                } else {
                    currentStep[key] = val;
                }
            } else {
                if (key === 'prerequisites' || key === 'requirements' || key === 'relatedTopics') {
                    record[key] = val.split('|').map(s => s.trim()).filter(Boolean);
                } else {
                    record[key] = val;
                }
            }
        }
    }

    // Default to 'beginner' if missing
    if (!record.difficulty) {
        record.difficulty = 'beginner';
    }

    return record;
}

// ─── Validation and Enrichment ───

function validateAndEnrichGuide(
    rawGuide: Record<string, unknown>,
    sourceUrl: string
): ExtractedGuide {
    // Validate required fields
    if (!rawGuide.title || !Array.isArray(rawGuide.steps)) {
        throw new Error('Invalid guide structure: missing required fields');
    }

    // Extract domain for source info
    const domain = extractDomain(sourceUrl);
    const credibility = assessCredibility(domain);

    // Generate unique ID
    const id = generateGuideId(sourceUrl, rawGuide.title as string);

    // Validate and clean steps
    const steps = (rawGuide.steps as ExtractedStep[])
        .filter(step => step.title && step.instruction)
        .map((step, index) => ({
            ...step,
            order: index + 1,
            tips: step.tips?.filter(Boolean) || [],
            warnings: step.warnings?.filter(Boolean) || [],
        }));

    return {
        id,
        title: rawGuide.title as string,
        source: {
            url: sourceUrl,
            name: domain,
            credibility,
        },
        application: (rawGuide.application as string) || 'Unknown',
        summary: (rawGuide.summary as string) || '',
        steps,
        prerequisites: (rawGuide.prerequisites as string[]) || [],
        requirements: (rawGuide.requirements as string[]) || [],
        relatedTopics: (rawGuide.relatedTopics as string[]) || [],
        difficulty: (rawGuide.difficulty as 'beginner' | 'intermediate' | 'advanced') || 'beginner',
        estimatedTime: (rawGuide.estimatedTime as string) || undefined,
        lastVerified: new Date().toISOString(),
    };
}

// ─── Credibility Assessment ───

function assessCredibility(domain: string): 'official' | 'community' | 'blog' | 'unknown' {
    const officialPatterns = [
        /support\./i,
        /help\./i,
        /docs\./i,
        /documentation\./i,
        /\.oracle\.com$/i,
        /\.facebook\.com$/i,
        /\.meta\.com$/i,
        /\.google\.com$/i,
        /\.microsoft\.com$/i,
        /\.apple\.com$/i,
    ];

    const communityPatterns = [
        /stackoverflow\.com$/i,
        /reddit\.com$/i,
        /superuser\.com$/i,
        /serverfault\.com$/i,
        /community\./i,
        /forum\./i,
    ];

    if (officialPatterns.some(p => p.test(domain))) {
        return 'official';
    }

    if (communityPatterns.some(p => p.test(domain))) {
        return 'community';
    }

    if (/blog|medium|wordpress|substack/i.test(domain)) {
        return 'blog';
    }

    return 'unknown';
}

// ─── Confidence Calculation ───

function calculateConfidence(guide: ExtractedGuide, userQuery: string): number {
    let score = 0.5; // Base score

    // More steps = more complete guide
    if (guide.steps.length >= 3) score += 0.1;
    if (guide.steps.length >= 5) score += 0.1;

    // Official source = higher confidence
    if (guide.source.credibility === 'official') score += 0.15;

    // Has prerequisites = more thorough
    if (guide.prerequisites && guide.prerequisites.length > 0) score += 0.05;

    // Has warnings = more complete
    const hasWarnings = guide.steps.some(s => s.warnings && s.warnings.length > 0);
    if (hasWarnings) score += 0.05;

    // UI elements extracted = more actionable
    const hasUIElements = guide.steps.some(s => s.uiElements && s.uiElements.length > 0);
    if (hasUIElements) score += 0.1;

    // Query relevance (simple keyword check)
    const queryTerms = userQuery.toLowerCase().split(/\s+/);
    const guideText = `${guide.title} ${guide.summary}`.toLowerCase();
    const matchCount = queryTerms.filter(term => guideText.includes(term)).length;
    score += Math.min(0.15, matchCount * 0.03);

    return Math.min(1, score);
}

// ─── Helper Functions ───

function extractDomain(url: string): string {
    try {
        const parsed = new URL(url);
        return parsed.hostname.replace('www.', '');
    } catch {
        return 'unknown';
    }
}

function generateGuideId(url: string, title: string): string {
    const hash = Buffer.from(`${url}:${title}`).toString('base64').slice(0, 12);
    return `guide_${hash}`;
}

// ─── Export All ───

export default {
    extractGuideFromContent,
};
