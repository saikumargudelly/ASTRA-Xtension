import { chat } from '../services/llm.js';

// ─── Summarizer Agent ───────────────────────────────────────────────────────
// Simplified: removed dead `executeSummarizerStep` dispatch (called only by
// the now-deleted /execute route). Kept the two prompts and `summarizeText`.

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

export async function summarizeText(
    text: string,
    mode: 'summarize' | 'bullets',
    options?: { maxLength?: number; bulletCount?: number },
): Promise<string> {
    if (mode === 'summarize') {
        const maxLen = options?.maxLength ?? 300;
        return chat(SUMMARIZE_SYSTEM_PROMPT, `Summarize the following text in approximately ${maxLen} characters:\n\n${text}`);
    }
    const count = options?.bulletCount ?? 5;
    return chat(BULLETS_SYSTEM_PROMPT, `Create exactly ${count} bullet points summarizing the following text:\n\n${text}`);
}
