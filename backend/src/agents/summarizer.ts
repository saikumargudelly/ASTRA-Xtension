import { chat } from '../services/llm.js';
import type { AgentStep, StepResult } from '../types/index.js';

// ─── Summarizer Agent ───

const SUMMARIZE_SYSTEM_PROMPT = `You are a concise summarizer. Given text content, produce a clear, informative summary.
Rules:
- Be concise but comprehensive
- Preserve key facts, numbers, and names
- Use neutral tone
- Do not add information not present in the source`;

const BULLETS_SYSTEM_PROMPT = `You are a concise summarizer. Given text content, produce a bullet-point summary.
Rules:
- Each bullet should be one clear, self-contained point
- Start each bullet with "•"
- Be concise but informative
- Preserve key facts, numbers, and names
- Do not add information not present in the source`;

export async function executeSummarizerStep(step: AgentStep): Promise<StepResult> {
    const start = Date.now();

    try {
        switch (step.action) {
            case 'summarize':
                return await summarize(step, start);
            case 'bullets':
                return await bullets(step, start);
            default:
                throw new Error(`Unknown summarizer action: ${step.action}`);
        }
    } catch (err) {
        return {
            stepId: step.id,
            success: false,
            error: err instanceof Error ? err.message : String(err),
            durationMs: Date.now() - start,
        };
    }
}

async function summarize(step: AgentStep, start: number): Promise<StepResult> {
    const text = String(step.params.text ?? '');
    const maxLength = Number(step.params.maxLength ?? 300);

    if (!text) {
        throw new Error('summarize requires text content');
    }

    const prompt = `Summarize the following text in approximately ${maxLength} characters:\n\n${text}`;
    const summary = await chat(SUMMARIZE_SYSTEM_PROMPT, prompt);

    return {
        stepId: step.id,
        success: true,
        data: { summary, originalLength: text.length },
        durationMs: Date.now() - start,
    };
}

async function bullets(step: AgentStep, start: number): Promise<StepResult> {
    const text = String(step.params.text ?? '');
    const count = Number(step.params.count ?? 5);

    if (!text) {
        throw new Error('bullets requires text content');
    }

    const prompt = `Create exactly ${count} bullet points summarizing the following text:\n\n${text}`;
    const result = await chat(BULLETS_SYSTEM_PROMPT, prompt);

    return {
        stepId: step.id,
        success: true,
        data: { bullets: result, bulletCount: count, originalLength: text.length },
        durationMs: Date.now() - start,
    };
}

// ─── Direct Summarization (for /summarize endpoint) ───
export async function summarizeText(
    text: string,
    mode: 'summarize' | 'bullets',
    options?: { maxLength?: number; bulletCount?: number },
): Promise<string> {
    if (mode === 'summarize') {
        const maxLen = options?.maxLength ?? 300;
        const prompt = `Summarize the following text in approximately ${maxLen} characters:\n\n${text}`;
        return chat(SUMMARIZE_SYSTEM_PROMPT, prompt);
    } else {
        const count = options?.bulletCount ?? 5;
        const prompt = `Create exactly ${count} bullet points summarizing the following text:\n\n${text}`;
        return chat(BULLETS_SYSTEM_PROMPT, prompt);
    }
}
