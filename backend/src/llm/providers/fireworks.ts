// ─── Fireworks Provider ────────────────────────────────────────────────────────
// Wraps the existing Fireworks AI API (migrated from services/llm.ts).
// Used as PRIMARY for all text tasks (fast + reliable + no aggressive rate limits).

import type { LLMMessage, LLMResponse } from '../../types/index.js';
import type { StreamEvent } from '../streaming.js';

const FIREWORKS_BASE = 'https://api.fireworks.ai/inference/v1';
const TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;

function getApiKey(): string {
    const key = process.env.FIREWORKS_API_KEY;
    if (!key) throw new Error('FIREWORKS_API_KEY is not set');
    return key;
}

// ─── Standard Chat ─────────────────────────────────────────────────────────────
export async function chat(
    messages: LLMMessage[],
    model = 'accounts/fireworks/models/qwen3-8b',
    maxTokens = 1024,
    temperature = 0.4,
): Promise<LLMResponse> {
    let lastError: Error | null = null;
    
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
        
        try {
            const response = await fetch(`${FIREWORKS_BASE}/chat/completions`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${getApiKey()}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model,
                    max_tokens: maxTokens,
                    temperature,
                    messages: messages.map((m) => ({
                        role: m.role,
                        // Preserve multimodal content arrays (vision) — only stringify if not already valid
                        content: m.content,
                    })),
                }),
                signal: controller.signal,
            });
            
            clearTimeout(timeout);

            if (!response.ok) {
                const errText = await response.text();
                // Rate limit - wait and retry
                if (response.status === 429) {
                    throw new Error(`429_RATE_LIMIT: ${errText.substring(0, 200)}`);
                }
                throw new Error(`Fireworks request failed: ${response.status} ${errText.substring(0, 200)}`);
            }

            const data = (await response.json()) as {
                choices: Array<{ message: { content: string } }>;
                usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
            };

            return {
                content: data.choices[0]?.message?.content ?? '',
                tokensUsed: {
                    prompt: data.usage.prompt_tokens,
                    completion: data.usage.completion_tokens,
                    total: data.usage.total_tokens,
                },
            };
        } catch (err) {
            clearTimeout(timeout);
            lastError = err instanceof Error ? err : new Error(String(err));
            
            if (attempt < MAX_RETRIES) {
                const delayMs = lastError.message.includes('429_RATE_LIMIT') ? 2000 : 500;
                console.warn(`[Fireworks] Attempt ${attempt} failed, retrying in ${delayMs}ms:`, lastError.message.substring(0, 100));
                await new Promise(r => setTimeout(r, delayMs));
            }
        }
    }
    
    throw new Error(`Fireworks API failed after ${MAX_RETRIES} attempts: ${lastError?.message}`);
}

// ─── Streaming Chat ────────────────────────────────────────────────────────────
export async function* chatStream(
    messages: LLMMessage[],
    model = 'accounts/fireworks/models/qwen3-8b',
    maxTokens = 1024,
): AsyncGenerator<StreamEvent> {
    const response = await fetch(`${FIREWORKS_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${getApiKey()}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            stream: true,
            messages: messages.map((m) => ({
                role: m.role,
                content: m.content,
            })),
        }),
    });

    if (!response.ok || !response.body) {
        throw new Error(`Fireworks stream failed: ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const lines = decoder.decode(value).split('\n');
        for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (data === '[DONE]') {
                yield { type: 'done' };
                return;
            }
            try {
                const chunk = JSON.parse(data) as {
                    choices: Array<{ delta: { content?: string } }>;
                };
                const text = chunk.choices[0]?.delta?.content;
                if (text) yield { type: 'token', text };
            } catch {
                // Skip malformed SSE lines
            }
        }
    }
}

export function isAvailable(): boolean {
    return !!process.env.FIREWORKS_API_KEY;
}
