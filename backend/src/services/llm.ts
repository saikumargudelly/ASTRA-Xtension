import 'dotenv/config';
import type { LLMMessage, LLMResponse } from '../types/index.js';

// ─── Groq Configuration ───
const GROQ_API_URL = process.env.GROQ_API_URL || 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_API_KEY_2 = process.env.GROQ_API_KEY_2 || '';
const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';

// ─── Fireworks.ai Configuration (For Vision) ───
const QWEN_API_URL = process.env.QWEN_API_URL || 'https://api.fireworks.ai/inference/v1/chat/completions';
const QWEN_API_KEY = process.env.QWEN_API_KEY || '';
const MAX_RETRIES = 3;
const TIMEOUT_MS = 30000;
const VISION_MODEL = process.env.VISION_MODEL || 'accounts/fireworks/models/qwen3-vl-30b-a3b-instruct';

// Global state to persist key swaps across different API routes entirely
let activeApiKey = GROQ_API_KEY;

if (!GROQ_API_KEY) {
    console.warn('[ASTRA] ⚠ GROQ_API_KEY is not set. Add your Groq API key to backend/.env');
}
if (!QWEN_API_KEY && VISION_MODEL.includes('fireworks')) {
    console.warn('[ASTRA] ⚠ QWEN_API_KEY is not set. Add your Fireworks API key to backend/.env for Vision');
}

// ─── Chat (raw text response) ───
export async function chat(
    systemPrompt: string,
    userPrompt: string,
): Promise<string> {
    const messages: LLMMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
    ];

    // ASTRA generic chat function maps standard OpenAI format
    const response = await callGroq(messages);
    return stripThinkTags(response.content);
}

// ─── Chat with Vision ───
export async function chatVision(
    systemPrompt: string,
    userPrompt: string,
    imageUrl: string,
): Promise<string> {
    if (!VISION_MODEL) {
        throw new Error('VISION_MODEL is not configured in .env');
    }

    const messages: LLMMessage[] = [
        { role: 'system', content: systemPrompt },
        {
            role: 'user',
            content: [
                { type: 'text', text: userPrompt },
                { type: 'image_url', image_url: { url: imageUrl } },
            ],
        },
    ];

    // Vision requests map directly as standard multimodal payloads
    const response = await callQwen(messages, VISION_MODEL);
    return stripThinkTags(response.content);
}

// ─── Chat JSON removed. ASTRA-Xtension migrated to TOON ───

// ─── Strip <think> tags (Legacy Qwen Support) ───
function stripThinkTags(text: string): string {
    // Left as a safety net if deepseek/qwen reasoning models are used on groq
    const stripped = text.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
    return stripped || text.trim();
}

// ─── Core Groq API Call ───
async function callGroq(
    messages: LLMMessage[],
    modelOverride?: string,
    options?: {
        maxTokens?: number;
        temperature?: number;
    },
): Promise<LLMResponse> {
    let lastError: Error | null = null;
    const model = modelOverride || GROQ_MODEL;
    const maxTokens = options?.maxTokens ?? 4096;
    const temperature = options?.temperature ?? 0.7;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

            const requestBody: Record<string, unknown> = {
                model,
                messages,
                temperature,
                max_tokens: maxTokens,
            };

            let res = await fetch(GROQ_API_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${activeApiKey}`,
                    'Accept': 'application/json',
                },
                body: JSON.stringify(requestBody),
                signal: controller.signal,
            });

            clearTimeout(timeout);

            if (!res.ok) {
                if ((res.status === 429 || res.status === 413) && activeApiKey === GROQ_API_KEY && GROQ_API_KEY_2) {
                    console.warn(`[ASTRA] Groq limits hit via ${res.status}. Globally swapping to backup API key (GROQ_API_KEY_2)...`);
                    activeApiKey = GROQ_API_KEY_2;

                    // Immediately retry within the same attempt loop bounds to prevent failure escalations
                    const fallbackController = new AbortController();
                    const fallbackTimeout = setTimeout(() => fallbackController.abort(), TIMEOUT_MS);

                    res = await fetch(GROQ_API_URL, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${activeApiKey}`, // now uses Key 2 natively
                            'Accept': 'application/json',
                        },
                        body: JSON.stringify(requestBody),
                        signal: fallbackController.signal,
                    });

                    clearTimeout(fallbackTimeout);
                }

                if (!res.ok) {
                    const body = await res.text();
                    const apiErr = `Groq API ${res.status}: ${body.substring(0, 300)}`;
                    console.error(`[ASTRA] LLM attempt ${attempt} failed:`, apiErr);
                    throw new Error(apiErr);
                }
            }

            const data = await res.json() as {
                choices: Array<{ message: { content: string } }>;
                usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
            };

            const content = data.choices?.[0]?.message?.content ?? '';
            const usage = data.usage;

            if (!content) {
                throw new Error('Empty response from LLM');
            }

            console.log(`[ASTRA] LLM ok (attempt ${attempt}, ${usage?.total_tokens ?? '?'} tokens)`);

            return {
                content,
                tokensUsed: {
                    prompt: usage?.prompt_tokens ?? 0,
                    completion: usage?.completion_tokens ?? 0,
                    total: usage?.total_tokens ?? 0,
                },
            };
        } catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));

            if (attempt < MAX_RETRIES) {
                const delay = Math.min(1500 * attempt, 5000);
                console.warn(`[ASTRA] LLM attempt ${attempt} failed, retrying in ${delay}ms:`, lastError.message);
                await new Promise((resolve) => setTimeout(resolve, delay));
            }
        }
    }

    throw new Error(`Groq API failed after ${MAX_RETRIES} attempts: ${lastError?.message}`);
}

// ─── Core Fireworks.ai API Call (For Vision) ───
async function callQwen(
    messages: LLMMessage[],
    modelOverride?: string,
    options?: {
        maxTokens?: number;
        temperature?: number;
    },
): Promise<LLMResponse> {
    let lastError: Error | null = null;
    const model = modelOverride || VISION_MODEL;
    const maxTokens = options?.maxTokens ?? 4096;
    const temperature = options?.temperature ?? 0.7;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

            const requestBody: Record<string, unknown> = {
                model,
                messages,
                temperature,
                max_tokens: maxTokens,
            };

            const res = await fetch(QWEN_API_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${QWEN_API_KEY}`,
                    'Accept': 'application/json',
                },
                body: JSON.stringify(requestBody),
                signal: controller.signal,
            });

            clearTimeout(timeout);

            if (!res.ok) {
                const body = await res.text();
                const apiErr = `Fireworks API ${res.status}: ${body.substring(0, 300)}`;
                console.error(`[ASTRA] Vision attempt ${attempt} failed:`, apiErr);
                throw new Error(apiErr);
            }

            const data = await res.json() as {
                choices: Array<{ message: { content: string } }>;
                usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
            };

            const content = data.choices?.[0]?.message?.content ?? '';
            const usage = data.usage;

            if (!content) {
                throw new Error('Empty response from Vision LLM');
            }

            console.log(`[ASTRA] Vision ok (attempt ${attempt}, ${usage?.total_tokens ?? '?'} tokens)`);

            return {
                content,
                tokensUsed: {
                    prompt: usage?.prompt_tokens ?? 0,
                    completion: usage?.completion_tokens ?? 0,
                    total: usage?.total_tokens ?? 0,
                },
            };
        } catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));

            if (attempt < MAX_RETRIES) {
                const delay = Math.min(1500 * attempt, 5000);
                console.warn(`[ASTRA] Vision attempt ${attempt} failed, retrying in ${delay}ms:`, lastError.message);
                await new Promise((resolve) => setTimeout(resolve, delay));
            }
        }
    }

    throw new Error(`Fireworks API failed after ${MAX_RETRIES} attempts: ${lastError?.message}`);
}

console.log(`[ASTRA] LLM service ready (${GROQ_MODEL} / ${VISION_MODEL.split('/').pop()})`);
