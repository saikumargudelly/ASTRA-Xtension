// ─── Walkthrough Generator Agent ───
// Converts extracted guides into interactive walkthrough format

import { chat } from '../services/llm.js';
import type {
    ExtractedGuide,
    Walkthrough,
    WalkthroughStep,
    UIElement,
    NavigationHint
} from '../types/index.js';

// ─── System Prompt ───

const WALKTHROUGH_SYSTEM_PROMPT = `You are a technical writer creating user-friendly, interactive walkthroughs from configuration guides.

Your walkthroughs are:
1. Clear and actionable - each step has a single, specific action
2. Well-organized - steps flow logically from start to finish
3. Helpful - includes tips and warnings where appropriate
4. User-focused - written for non-technical users when possible

You always return valid TOON (Token-Oriented Object Notation) with the exact structure requested.`;

// ─── Main Generator Function ───

/**
 * Generate an interactive walkthrough from an extracted guide
 */
export async function generateWalkthrough(
    guide: ExtractedGuide,
    userQuery: string
): Promise<Walkthrough> {
    // If guide already has well-structured steps, convert directly
    if (guide.steps.length >= 2 && guide.steps[0].instruction) {
        return convertGuideToWalkthrough(guide);
    }

    // Otherwise, use LLM to enhance the walkthrough
    return enhanceWithLLM(guide, userQuery);
}

// ─── Direct Conversion ───

function convertGuideToWalkthrough(guide: ExtractedGuide): Walkthrough {
    const steps: WalkthroughStep[] = guide.steps.map((step, index) => ({
        stepNumber: index + 1,
        title: step.title || `Step ${index + 1}`,
        instruction: step.instruction,
        tips: step.tips || [],
        warnings: step.warnings || [],
        estimatedSeconds: estimateStepTime(step),
        uiElements: step.uiElements,
        navigation: step.navigation,
    }));

    return {
        id: generateWalkthroughId(guide.id),
        title: guide.title,
        description: guide.summary || `Learn how to ${guide.title.toLowerCase()}`,
        application: guide.application,
        totalSteps: steps.length,
        estimatedTime: guide.estimatedTime || estimateTotalTime(steps),
        steps,
        source: guide.source,
        lastUpdated: new Date().toISOString(),
    };
}

// ─── LLM Enhancement ───

async function enhanceWithLLM(
    guide: ExtractedGuide,
    userQuery: string
): Promise<Walkthrough> {
    const prompt = buildEnhancementPrompt(guide, userQuery);

    try {
        const rawResponse = await chat(WALKTHROUGH_SYSTEM_PROMPT, prompt);
        const enhanced = parseToonToWalkthroughRecord(rawResponse);

        const steps = parseSteps(enhanced.steps as Record<string, unknown>[]);

        return {
            id: generateWalkthroughId(guide.id),
            title: (enhanced.title as string) || guide.title,
            description: (enhanced.description as string) || guide.summary,
            application: guide.application,
            totalSteps: steps.length,
            estimatedTime: (enhanced.estimatedTime as string) || estimateTotalTime(steps),
            steps,
            source: guide.source,
            lastUpdated: new Date().toISOString(),
        };
    } catch (error) {
        console.warn('[WalkthroughGenerator] LLM enhancement failed, using direct conversion:', error);
        return convertGuideToWalkthrough(guide);
    }
}

// ─── Prompt Building ───

function buildEnhancementPrompt(guide: ExtractedGuide, userQuery: string): string {
    const guideJson = JSON.stringify({
        title: guide.title,
        summary: guide.summary,
        application: guide.application,
        steps: guide.steps.map(s => ({
            title: s.title,
            instruction: s.instruction,
            tips: s.tips,
            warnings: s.warnings,
            uiElements: s.uiElements,
            navigation: s.navigation,
        })),
    }, null, 2);

    return `Convert this configuration guide into an interactive walkthrough.

USER'S QUESTION: ${userQuery}

GUIDE DATA:
${guideJson}

Create a user-friendly walkthrough with these enhancements:
1. Clear, actionable step titles (imperative verbs like "Open", "Click", "Select")
2. Detailed instructions with specific UI element names
3. Tips for common mistakes or shortcuts
4. Warnings for irreversible actions
5. Estimated time per step

Return ONLY valid TOON (Token-Oriented Object Notation):

[WALKTHROUGH_TOON]
title: Walkthrough title (action-oriented)
description: Brief overview of what this walkthrough accomplishes
estimatedTime: Total time estimate (e.g., '5 minutes')

[STEPS]
stepNumber: 1
title: Clear, action-oriented title
instruction: Detailed instruction with specific UI elements
tips: Helpful tip for this step | Another tip
warnings: Important warning if applicable
estimatedSeconds: 30
uiElements.type: button
uiElements.label: Text on the UI element
uiElements.location: Where to find it
uiElements.action: What to do with it
navigation.path: Settings | Privacy | Security
navigation.url: Direct URL if available
navigation.shortcut: Keyboard shortcut if available
---
stepNumber: 2
title: ...
[/STEPS]
[/WALKTHROUGH_TOON]

CRITICAL RULES:
1. Each step MUST directly address the user's question: "${userQuery}"
2. Each step should be a SINGLE action with a clear action verb
3. Use EXACT UI element names from the guide - do not paraphrase
4. Navigation paths must be complete from a known starting point
5. Include tips for tricky steps
6. Include warnings for destructive/irreversible actions
7. Estimate realistic time for each step (30 seconds to 2 minutes typically)
8. Steps must be in logical order from start to finish
9. Use pipe | to separate array items (tips, warnings, paths)

ACCURACY REQUIREMENTS:
- UI element labels must match exactly what appears in the application
- Navigation paths must show the complete menu path
- Instructions must be specific enough to follow without guessing
- The walkthrough must directly answer: "${userQuery}"

Return ONLY the TOON block.`;
}

// ─── TOON Parsing ───

function parseToonToWalkthroughRecord(rawResponse: string): Record<string, unknown> {
    const record: Record<string, unknown> = {
        title: '',
        description: '',
        estimatedTime: '',
        steps: []
    };

    const lines = rawResponse.split('\n');
    let inStepsBlock = false;
    let currentStep: any = null;

    for (let line of lines) {
        line = line.trim();
        if (!line || line.startsWith('[WALKTHROUGH_TOON]') || line.startsWith('[/WALKTHROUGH_TOON]')) continue;

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
                } else if (key === 'estimatedSeconds' || key === 'stepNumber') {
                    currentStep[key] = parseInt(val, 10);
                } else if (key.startsWith('uiElements.')) {
                    currentStep.uiElements = currentStep.uiElements || [{}];
                    currentStep.uiElements[0][key.split('.')[1]] = val;
                } else if (key.startsWith('navigation.')) {
                    currentStep.navigation = currentStep.navigation || {};
                    if (key === 'navigation.path') {
                        currentStep.navigation.path = val.split('|').map(s => s.trim()).filter(Boolean);
                    } else {
                        currentStep.navigation[key.split('.')[1]] = val;
                    }
                } else {
                    currentStep[key] = val;
                }
            } else {
                record[key] = val;
            }
        }
    }

    return record;
}

// ─── Step Parsing ───

function parseSteps(rawSteps: Record<string, unknown>[]): WalkthroughStep[] {
    if (!Array.isArray(rawSteps)) return [];

    return rawSteps
        .filter(step => step.title && step.instruction)
        .map((step, index) => ({
            stepNumber: (step.stepNumber as number) || index + 1,
            title: step.title as string,
            instruction: step.instruction as string,
            tips: (step.tips as string[]) || [],
            warnings: (step.warnings as string[]) || [],
            estimatedSeconds: step.estimatedSeconds as number | undefined,
            uiElements: parseUIElements(step.uiElements as Record<string, unknown>[]),
            navigation: parseNavigation(step.navigation as Record<string, unknown>),
        }));
}

function parseUIElements(raw?: Record<string, unknown>[]): UIElement[] | undefined {
    if (!Array.isArray(raw) || raw.length === 0) return undefined;

    return raw.map(el => ({
        type: el.type as UIElement['type'],
        label: el.label as string,
        location: el.location as string | undefined,
        action: el.action as string | undefined,
    }));
}

function parseNavigation(raw?: Record<string, unknown>): NavigationHint | undefined {
    if (!raw) return undefined;

    return {
        path: (raw.path as string[]) || [],
        url: raw.url as string | undefined,
        shortcut: raw.shortcut as string | undefined,
    };
}

// ─── Time Estimation ───

function estimateStepTime(step: { instruction: string; uiElements?: UIElement[] }): number {
    // Base time: 15 seconds
    let seconds = 15;

    // Add time based on instruction length
    const wordCount = step.instruction.split(/\s+/).length;
    seconds += Math.min(wordCount * 0.5, 30); // Max 30 seconds for reading

    // Add time for navigation
    if (step.uiElements && step.uiElements.length > 0) {
        seconds += step.uiElements.length * 5; // 5 seconds per UI interaction
    }

    // Cap at 2 minutes per step
    return Math.min(seconds, 120);
}

function estimateTotalTime(steps: WalkthroughStep[]): string {
    const totalSeconds = steps.reduce((sum, step) => sum + (step.estimatedSeconds || 30), 0);
    const minutes = Math.ceil(totalSeconds / 60);

    if (minutes < 1) return 'Less than 1 minute';
    if (minutes === 1) return '1 minute';
    if (minutes <= 5) return `${minutes} minutes`;
    if (minutes <= 10) return `${minutes} minutes`;
    return `${Math.ceil(minutes / 5) * 5} minutes`;
}

// ─── ID Generation ───

function generateWalkthroughId(guideId: string): string {
    const timestamp = Date.now().toString(36);
    return `wt_${guideId.replace('guide_', '')}_${timestamp}`;
}

// ─── Export All ───

export default {
    generateWalkthrough,
};
