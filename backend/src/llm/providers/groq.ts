// ─── Groq Provider ────────────────────────────────────────────────────────────
// Uses the Groq OpenAI-compatible API (fast LPU inference, generous free tier).
// Migrated from the original services/llm.ts Groq implementation.

import type { LLMMessage, LLMResponse } from '../../types/index.js';
import type { StreamEvent } from '../streaming.js';

const GROQ_BASE = process.env.GROQ_API_URL?.replace('/chat/completions', '')
    ?? 'https://api.groq.com/openai/v1';

const MAX_RETRIES = 3;
const TIMEOUT_MS = 30000;

function getApiKey(): string {
    const key = process.env.GROQ_API_KEY ?? process.env.GROQ_API_KEY_2;
    if (!key) throw new Error('GROQ_API_KEY is not set');
    return key;
}

// ─── Standard Chat ─────────────────────────────────────────────────────────────
export async function chat(
    messages: LLMMessage[],
    model = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    maxTokens = 8192,
    temperature = 0.3,
): Promise<LLMResponse> {
    let lastError: Error | null = null;
    let activeKey = process.env.GROQ_API_KEY ?? '';

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

            let res = await fetch(`${GROQ_BASE}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${activeKey}`,
                },
                body: JSON.stringify({
                    model,
                    messages: messages.map((m) => ({
                        role: m.role,
                        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
                    })),
                    temperature,
                    max_tokens: maxTokens,
                }),
                signal: controller.signal,
            });

            clearTimeout(timeout);

            if (!res.ok) {
                const errText = await res.text();
                
                // Fast-fail 413 Payload Too Large
                if (res.status === 413) {
                    throw new Error(`413_PAYLOAD_TOO_LARGE: Groq API Payload Too Large. ${errText.substring(0, 200)}`);
                }

                // Auto-swap to backup key on rate limit
                if (res.status === 429) {
                    if (activeKey !== process.env.GROQ_API_KEY_2 && process.env.GROQ_API_KEY_2) {
                        console.warn(`[Groq] Rate limited (429), swapping to GROQ_API_KEY_2`);
                        activeKey = process.env.GROQ_API_KEY_2;
                        
                        const res2 = await fetch(`${GROQ_BASE}/chat/completions`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${activeKey}` },
                            body: JSON.stringify({
                                model, messages: messages.map((m) => ({
                                    role: m.role,
                                    content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
                                })),
                                temperature, max_tokens: maxTokens,
                            }),
                        });
                        
                        if (res2.ok) {
                            res = res2; // Use successful second response
                        } else {
                            const errText2 = await res2.text();
                            const match = errText2.match(/try again in ([0-9.]+)s/);
                            if (match) {
                                throw new Error(`429_RATE_LIMIT:${match[1]}`);
                            }
                            throw new Error(`Groq API ${res2.status}: ${errText2.substring(0, 300)}`);
                        }
                    } else {
                        // Keys exhausted, try to parse retry delay
                        const match = errText.match(/try again in ([0-9.]+)s/);
                        if (match) {
                            throw new Error(`429_RATE_LIMIT:${match[1]}`);
                        }
                    }
                }
                
                if (!res.ok) {
                    throw new Error(`Groq API ${res.status}: ${errText.substring(0, 300)}`);
                }
            }

            const data = (await res.json()) as {
                choices: Array<{ message: { content: string } }>;
                usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
            };

            return {
                content: data.choices[0]?.message?.content ?? '',
                tokensUsed: {
                    prompt: data.usage?.prompt_tokens ?? 0,
                    completion: data.usage?.completion_tokens ?? 0,
                    total: data.usage?.total_tokens ?? 0,
                },
            };
        } catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));
            
            // Fast fail 413 - DO NOT retry large payloads
            if (lastError.message.startsWith('413_PAYLOAD_TOO_LARGE')) {
                throw lastError;
            }

            if (attempt < MAX_RETRIES) {
                let delay = Math.min(1500 * attempt, 5000);
                
                // Dynamic backoff based on 429 response
                if (lastError.message.startsWith('429_RATE_LIMIT:')) {
                    const seconds = parseFloat(lastError.message.split(':')[1]);
                    delay = (seconds * 1000) + 500; // Exact wait time + 500ms safety buffer
                    lastError = new Error(`Groq API 429 Rate Limited. Re-syncing in ${seconds}s.`);
                }

                console.warn(`[Groq] Attempt ${attempt} failed, retrying in ${delay}ms:`, lastError.message);
                await new Promise((r) => setTimeout(r, delay));
            }
        }
    }

    throw new Error(`Groq API failed after ${MAX_RETRIES} attempts: ${lastError?.message}`);
}

// ─── Streaming Chat ────────────────────────────────────────────────────────────
export async function* chatStream(
    messages: LLMMessage[],
    model = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    maxTokens = 8192,
): AsyncGenerator<StreamEvent> {
    const response = await fetch(`${GROQ_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${getApiKey()}`,
        },
        body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            stream: true,
            messages: messages.map((m) => ({
                role: m.role,
                content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
            })),
        }),
    });

    if (!response.ok || !response.body) {
        throw new Error(`Groq stream failed: ${response.status}`);
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
            } catch { /* skip malformed lines */ }
        }
    }
}

export function isAvailable(): boolean {
    return !!(process.env.GROQ_API_KEY || process.env.GROQ_API_KEY_2);
}
