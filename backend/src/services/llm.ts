import 'dotenv/config';
import type { LLMMessage, LLMResponse } from '../types/index.js';

// ─── Fireworks.ai Configuration ───
const QWEN_API_URL = process.env.QWEN_API_URL || 'https://api.fireworks.ai/inference/v1/chat/completions';
const QWEN_API_KEY = process.env.QWEN_API_KEY || '';
const QWEN_MODEL = process.env.QWEN_MODEL || 'accounts/fireworks/models/qwen3-8b';
const MAX_RETRIES = 3;
const TIMEOUT_MS = 30000;
const VISION_MODEL = process.env.VISION_MODEL || '';

if (!QWEN_API_KEY) {
    console.warn('[ASTRA] ⚠ QWEN_API_KEY is not set. Add your Fireworks.ai API key to backend/.env');
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

    // For regular text responses, allow thinking (it produces richer answers)
    const response = await callQwen(messages);
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

    // Vision models: disable thinking for speed (vision calls are already slow)
    const response = await callQwen(messages, VISION_MODEL);
    return stripThinkTags(response.content);
}

// ─── Chat JSON removed. ASTRA-Xtension migrated to TOON ───

// ─── Strip Qwen <think> tags ───
function stripThinkTags(text: string): string {
    // Qwen3 models use <think>...</think> for chain-of-thought reasoning
    const stripped = text.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
    return stripped || text.trim();
}

// ─── Core Fireworks.ai API Call ───
async function callQwen(
    messages: LLMMessage[],
    modelOverride?: string,
    options?: {
        maxTokens?: number;
        temperature?: number;
    },
): Promise<LLMResponse> {
    let lastError: Error | null = null;
    const model = modelOverride || QWEN_MODEL;
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
                console.error(`[ASTRA] LLM attempt ${attempt} failed:`, apiErr);
                throw new Error(apiErr);
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

    throw new Error(`Fireworks API failed after ${MAX_RETRIES} attempts: ${lastError?.message}`);
}

console.log(`[ASTRA] LLM service ready (${QWEN_MODEL.split('/').pop()}, thinking-aware)`);
