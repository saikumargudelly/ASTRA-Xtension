import 'dotenv/config';
import type { LLMMessage, LLMResponse } from '../types/index.js';

// ─── Fireworks.ai Configuration ───
const QWEN_API_URL = process.env.QWEN_API_URL || 'https://api.fireworks.ai/inference/v1/chat/completions';
const QWEN_API_KEY = process.env.QWEN_API_KEY || '';
const QWEN_MODEL = process.env.QWEN_MODEL || 'accounts/fireworks/models/qwen3-8b';
const MAX_RETRIES = 3;
const TIMEOUT_MS = 60000;
const VISION_MODEL = process.env.VISION_MODEL || ''; // Optional: set to a vision-capable model

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

    // Use specific vision model
    const response = await callQwen(messages, VISION_MODEL);
    return stripThinkTags(response.content);
}

// ─── Chat JSON (structured output) ───
export async function chatJSON<T = unknown>(
    systemPrompt: string,
    userPrompt: string,
): Promise<T> {
    const jsonSystemPrompt = `${systemPrompt}\n\nIMPORTANT: You MUST respond with valid JSON only. No markdown, no code fences, no explanatory text. Only output the JSON object.`;

    const response = await chat(jsonSystemPrompt, userPrompt);

    // Extract JSON from response (handle markdown fences if present)
    let jsonStr = response.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fenceMatch) {
        jsonStr = fenceMatch[1].trim();
    }

    try {
        return JSON.parse(jsonStr) as T;
    } catch (err) {
        throw new Error(`Failed to parse LLM JSON response: ${jsonStr.substring(0, 200)}`);
    }
}

// ─── Strip Qwen <think> tags ───
function stripThinkTags(text: string): string {
    // Qwen-3 models use <think>...</think> for chain-of-thought reasoning
    // Strip these tags and return only the actual content after them
    const stripped = text.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
    return stripped || text.trim();
}

// ─── Core Fireworks.ai API Call ───
async function callQwen(
    messages: LLMMessage[],
    modelOverride?: string
): Promise<LLMResponse> {
    let lastError: Error | null = null;
    const model = modelOverride || QWEN_MODEL;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

            const res = await fetch(QWEN_API_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${QWEN_API_KEY}`,
                    'Accept': 'application/json',
                },
                body: JSON.stringify({
                    model: model,
                    messages,
                    temperature: 0.7,
                    max_tokens: 4096,
                }),
                signal: controller.signal,
            });

            clearTimeout(timeout);

            if (!res.ok) {
                const body = await res.text();
                throw new Error(`Fireworks API ${res.status}: ${body.substring(0, 300)}`);
            }

            const data = await res.json() as {
                choices: Array<{ message: { content: string } }>;
                usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
            };

            const content = data.choices?.[0]?.message?.content ?? '';
            const usage = data.usage;

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
                const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
                await new Promise((resolve) => setTimeout(resolve, delay));
            }
        }
    }

    throw new Error(`Fireworks API failed after ${MAX_RETRIES} retries: ${lastError?.message}`);
}

console.log(`[ASTRA] LLM service ready (${QWEN_MODEL.split('/').pop()})`);
