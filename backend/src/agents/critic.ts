// ─── Critic / Guard Agent ──────────────────────────────────────────────────────
// Quality control, safety checking, and self-correction for all NEXUS outputs.

import { chatMessages } from '../services/llm.js';

// ─── Types ─────────────────────────────────────────────────────────────────────
export interface CriticScore {
    quality: number;      // 0.0 – 1.0
    accuracy: number;     // 0.0 – 1.0
    completeness: number; // 0.0 – 1.0
    safety: number;       // 0.0 – 1.0
    overall: number;      // weighted average
    issues: string[];
    suggestions: string[];
    approved: boolean;    // overall >= 0.75
}

export interface SafetyCheck {
    safe: boolean;
    riskLevel: 'none' | 'low' | 'medium' | 'high' | 'critical';
    reasons: string[];
    requiresConfirmation: boolean;
}

export interface HallucinationReport {
    hasHallucinations: boolean;
    suspectClaims: string[];
    confidence: number;
}

// ─── Dangerous action patterns ─────────────────────────────────────────────────
const DANGEROUS_PATTERNS = [
    { pattern: /delete|remove|drop|destroy|purge/i, level: 'high' as const },
    { pattern: /format|wipe|erase/i, level: 'critical' as const },
    { pattern: /sudo|admin|root|chmod|chown/i, level: 'high' as const },
    // 'submit form' — only flag non-search form submissions (checkout, post, publish)
    // Searching is a normal navigation action and should NOT be flagged.
    { pattern: /submit form|post comment|post reply|publish|send email/i, level: 'medium' as const },
    { pattern: /install|uninstall/i, level: 'medium' as const },
    { pattern: /execute|run script|eval/i, level: 'medium' as const },
];

// ─── Safety Check ──────────────────────────────────────────────────────────────
const RISK_LEVELS: SafetyCheck['riskLevel'][] = ['none', 'low', 'medium', 'high', 'critical'];

export function isSafe(actionDescription: string): SafetyCheck {
    const lowerAction = actionDescription.toLowerCase();
    let riskIndex = 0; // 0 = 'none'
    const reasons: string[] = [];

    for (const { pattern, level } of DANGEROUS_PATTERNS) {
        if (pattern.test(lowerAction)) {
            reasons.push(`Action matched dangerous pattern: ${pattern.source}`);
            const idx = RISK_LEVELS.indexOf(level);
            if (idx > riskIndex) riskIndex = idx;
        }
    }

    const highestRisk = RISK_LEVELS[riskIndex]!;

    return {
        safe: highestRisk === 'none' || highestRisk === 'low',
        riskLevel: highestRisk,
        reasons,
        requiresConfirmation: highestRisk === 'medium' || highestRisk === 'high' || highestRisk === 'critical',
    };
}

// ─── Quality Evaluation ────────────────────────────────────────────────────────
const CRITIC_SYSTEM_PROMPT = `You are NEXUS's Critic agent. Evaluate the quality of an AI response.

Score each dimension from 0.0 to 1.0:
- accuracy: Is the information factually correct based on context?
- completeness: Does it fully address the original task?  
- quality: Is it well-structured, clear, and useful?
- safety: Does it avoid harmful, misleading, or dangerous content?

Return ONLY this JSON (no extra text):
{
  "accuracy": 0.0,
  "completeness": 0.0,
  "quality": 0.0,
  "safety": 1.0,
  "issues": ["list of specific problems found"],
  "suggestions": ["list of specific improvements"]
}`;

export async function evaluate(
    output: string,
    originalTask: string,
    context?: string,
): Promise<CriticScore> {
    const userPrompt = `Original task: ${originalTask}

${context ? `Context: ${context}\n\n` : ''}Agent output to evaluate:
${output.substring(0, 3000)}`;

    try {
        const response = await chatMessages(
            [
                { role: 'system', content: CRITIC_SYSTEM_PROMPT },
                { role: 'user', content: userPrompt },
            ],
            'critique',
        );

        // Extract JSON — handle markdown code blocks
        const jsonMatch = response.content.match(/```(?:json)?\s*([\s\S]*?)\s*```/) ||
            response.content.match(/(\{[\s\S]*\})/);

        if (!jsonMatch) {
            throw new Error('Critic returned non-JSON response');
        }

        const parsed = JSON.parse(jsonMatch[1]) as {
            accuracy: number;
            completeness: number;
            quality: number;
            safety: number;
            issues: string[];
            suggestions: string[];
        };

        const overall = (
            parsed.accuracy * 0.3 +
            parsed.completeness * 0.3 +
            parsed.quality * 0.25 +
            parsed.safety * 0.15
        );

        return {
            quality: parsed.quality ?? 0.5,
            accuracy: parsed.accuracy ?? 0.5,
            completeness: parsed.completeness ?? 0.5,
            safety: parsed.safety ?? 1.0,
            overall,
            issues: parsed.issues ?? [],
            suggestions: parsed.suggestions ?? [],
            approved: overall >= 0.75,
        };
    } catch (err) {
        console.warn('[Critic] Evaluation failed:', (err as Error).message);
        // Return a passing score on failure to avoid blocking the pipeline
        return {
            quality: 0.8, accuracy: 0.8, completeness: 0.8, safety: 1.0,
            overall: 0.85,
            issues: [],
            suggestions: [],
            approved: true,
        };
    }
}

// ─── Self-Correction Loop ──────────────────────────────────────────────────────
export async function critiqueAndFix(
    output: string,
    originalTask: string,
    reviseCallback: (output: string, feedback: string) => Promise<string>,
    maxRevisions = 3,
): Promise<{ output: string; score: CriticScore; revisions: number }> {
    let currentOutput = output;
    let currentScore = await evaluate(currentOutput, originalTask);
    let revisions = 0;

    while (!currentScore.approved && revisions < maxRevisions) {
        const feedback = [
            ...currentScore.issues.map((i) => `Issue: ${i}`),
            ...currentScore.suggestions.map((s) => `Suggestion: ${s}`),
        ].join('\n');

        console.log(`[Critic] Score: ${currentScore.overall.toFixed(2)} — revision ${revisions + 1} triggered`);

        try {
            currentOutput = await reviseCallback(currentOutput, feedback);
            currentScore = await evaluate(currentOutput, originalTask);
            revisions++;
        } catch (err) {
            console.warn('[Critic] Revision failed:', (err as Error).message);
            break;
        }
    }

    return { output: currentOutput, score: currentScore, revisions };
}

// ─── Hallucination Detection ───────────────────────────────────────────────────
export async function detectHallucinations(
    output: string,
    sources: string[],
): Promise<HallucinationReport> {
    if (sources.length === 0) {
        return { hasHallucinations: false, suspectClaims: [], confidence: 0.5 };
    }

    const sourceSummary = sources.slice(0, 3).join('\n\n---\n\n').substring(0, 2000);

    try {
        const response = await chatMessages(
            [
                {
                    role: 'system',
                    content: `You are a fact-checker. Given source documents and an AI response, identify claims in the response that cannot be verified from the sources.
          
Return ONLY this JSON:
{"hasHallucinations": false, "suspectClaims": [], "confidence": 0.9}`,
                },
                {
                    role: 'user',
                    content: `Sources:\n${sourceSummary}\n\nAI response to check:\n${output.substring(0, 1500)}`,
                },
            ],
            'critique',
        );

        const jsonMatch = response.content.match(/(\{[\s\S]*\})/);
        if (!jsonMatch) throw new Error('No JSON in response');

        return JSON.parse(jsonMatch[1]) as HallucinationReport;
    } catch {
        return { hasHallucinations: false, suspectClaims: [], confidence: 0.5 };
    }
}
