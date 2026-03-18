// ─── Anthropic Provider ────────────────────────────────────────────────────────
// Wraps the @anthropic-ai/sdk with NEXUS streaming-capable interface.

import Anthropic from '@anthropic-ai/sdk';
import type { LLMMessage, LLMResponse } from '../../types/index.js';
import type { StreamEvent } from '../streaming.js';

let client: Anthropic | null = null;

function getClient(): Anthropic {
    if (!client) {
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
        client = new Anthropic({ apiKey });
    }
    return client;
}

// ─── Standard Chat ─────────────────────────────────────────────────────────────
export async function chat(
    messages: LLMMessage[],
    model = 'claude-sonnet-4-5',
    maxTokens = 4096,
    temperature = 0.4,
): Promise<LLMResponse> {
    const anthropic = getClient();

    // Separate system messages from the rest
    const systemMsg = messages.find((m) => m.role === 'system');
    const userMessages = messages.filter((m) => m.role !== 'system');

    const content = typeof systemMsg?.content === 'string' ? systemMsg.content : undefined;

    const response = await anthropic.messages.create({
        model,
        max_tokens: maxTokens,
        temperature,
        ...(content ? { system: content } : {}),
        messages: userMessages.map((m) => ({
            role: m.role as 'user' | 'assistant',
            content: typeof m.content === 'string'
                ? m.content
                : m.content.map((c) =>
                    c.type === 'image_url'
                        ? {
                            type: 'image' as const,
                            source: {
                                type: 'base64' as const,
                                media_type: 'image/jpeg' as const,
                                data: c.image_url!.url.replace(/^data:image\/\w+;base64,/, ''),
                            },
                        }
                        : { type: 'text' as const, text: c.text ?? '' },
                ),
        })),
    });

    const textContent = response.content.find((c) => c.type === 'text');
    return {
        content: textContent?.type === 'text' ? textContent.text : '',
        tokensUsed: {
            prompt: response.usage.input_tokens,
            completion: response.usage.output_tokens,
            total: response.usage.input_tokens + response.usage.output_tokens,
        },
    };
}

// ─── Streaming Chat ────────────────────────────────────────────────────────────
export async function* chatStream(
    messages: LLMMessage[],
    model = 'claude-sonnet-4-5',
    maxTokens = 4096,
): AsyncGenerator<StreamEvent> {
    const anthropic = getClient();

    const systemMsg = messages.find((m) => m.role === 'system');
    const userMessages = messages.filter((m) => m.role !== 'system');
    const systemContent = typeof systemMsg?.content === 'string' ? systemMsg.content : undefined;

    const stream = anthropic.messages.stream({
        model,
        max_tokens: maxTokens,
        ...(systemContent ? { system: systemContent } : {}),
        messages: userMessages.map((m) => ({
            role: m.role as 'user' | 'assistant',
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        })),
    });

    for await (const event of stream) {
        if (
            event.type === 'content_block_delta' &&
            event.delta.type === 'text_delta'
        ) {
            yield { type: 'token', text: event.delta.text };
        }
    }

    yield { type: 'done' };
}

export function isAvailable(): boolean {
    return !!process.env.ANTHROPIC_API_KEY;
}
