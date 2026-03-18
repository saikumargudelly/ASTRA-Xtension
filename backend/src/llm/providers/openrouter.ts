// ─── OpenRouter Provider ────────────────────────────────────────────────────────
// Wraps the OpenAI SDK but points to OpenRouter's API endpoint.
// Allows using any model available on OpenRouter (e.g., openrouter/hunter-alpha).

import OpenAI from 'openai';
import type { LLMMessage, LLMResponse } from '../../types/index.js';
import type { StreamEvent } from '../streaming.js';

let client: OpenAI | null = null;

function getClient(): OpenAI {
    if (!client) {
        const apiKey = process.env.OPENROUTER_API_KEY;
        if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set');
        
        client = new OpenAI({ 
            baseURL: "https://openrouter.ai/api/v1",
            apiKey,
            defaultHeaders: {
                "HTTP-Referer": "http://localhost:3001", // Required by OpenRouter rankings
                "X-Title": "ASTRA-Xtension", // Required by OpenRouter rankings
            }
        });
    }
    return client;
}

// ─── Standard Chat ─────────────────────────────────────────────────────────────
export async function chat(
    messages: LLMMessage[],
    model = process.env.OPENROUTER_MODEL || 'openrouter/hunter-alpha',
    maxTokens = 8192,
    temperature = 0.3,
): Promise<LLMResponse> {
    const openai = getClient();

    const response = await openai.chat.completions.create({
        model,
        max_tokens: maxTokens,
        temperature,
        messages: messages.map((m) => ({
            role: m.role,
            content: typeof m.content === 'string'
                ? m.content
                : m.content.map((c) =>
                    c.type === 'image_url'
                        ? { type: 'image_url' as const, image_url: c.image_url! }
                        : { type: 'text' as const, text: c.text ?? '' },
                ),
        })) as OpenAI.ChatCompletionMessageParam[],
    });

    const choice = response.choices[0];
    return {
        content: choice?.message?.content ?? '',
        tokensUsed: {
            prompt: response.usage?.prompt_tokens ?? 0,
            completion: response.usage?.completion_tokens ?? 0,
            total: response.usage?.total_tokens ?? 0,
        },
    };
}

// ─── Streaming Chat ────────────────────────────────────────────────────────────
export async function* chatStream(
    messages: LLMMessage[],
    model = process.env.OPENROUTER_MODEL || 'openrouter/hunter-alpha',
    maxTokens = 8192,
): AsyncGenerator<StreamEvent> {
    const openai = getClient();

    const stream = await openai.chat.completions.create({
        model,
        max_tokens: maxTokens,
        stream: true,
        messages: messages.map((m) => ({
            role: m.role,
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        })) as OpenAI.ChatCompletionMessageParam[],
    });

    for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) {
            yield { type: 'token', text: delta };
        }
    }

    yield { type: 'done' };
}

export function isAvailable(): boolean {
    return !!process.env.OPENROUTER_API_KEY;
}
