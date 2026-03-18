// ─── OpenAI Provider ───────────────────────────────────────────────────────────
// Wraps the openai SDK — primarily used for GPT-4o vision tasks.

import OpenAI from 'openai';
import type { LLMMessage, LLMResponse } from '../../types/index.js';
import type { StreamEvent } from '../streaming.js';

let client: OpenAI | null = null;

function getClient(): OpenAI {
    if (!client) {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
        client = new OpenAI({ apiKey });
    }
    return client;
}

// ─── Standard Chat ─────────────────────────────────────────────────────────────
export async function chat(
    messages: LLMMessage[],
    model = 'gpt-4o',
    maxTokens = 2048,
    temperature = 0.4,
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
    model = 'gpt-4o',
    maxTokens = 2048,
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
    return !!process.env.OPENAI_API_KEY;
}
