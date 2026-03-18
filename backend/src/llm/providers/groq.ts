// ─── Groq Provider ────────────────────────────────────────────────────────────
// Uses the Groq OpenAI-compatible API (fast LPU inference, generous free tier).

import type { LLMMessage, LLMResponse } from '../../types/index.js';
import type { StreamEvent } from '../streaming.js';

const GROQ_BASE = process.env.GROQ_API_URL?.replace('/chat/completions', '')
    ?? 'https://api.groq.com/openai/v1';

const MAX_RETRIES = 3;
const TIMEOUT_MS  = 30_000;

// ─── Key Manager ──────────────────────────────────────────────────────────────
// FIX 5: Key rotation is now clean and separate from request logic.
// `getApiKey()` returns the PRIMARY key; `getSecondaryKey()` the backup.
// No inline double-fetch hacks.

function getApiKey(): string {
    const key = process.env.GROQ_API_KEY;
    if (!key) throw new Error('GROQ_API_KEY is not set');
    return key;
}

function getSecondaryKey(): string | null {
    return process.env.GROQ_API_KEY_2 ?? null;
}

// ─── Internal fetch helper ─────────────────────────────────────────────────────
// Single, canonical way to call the Groq API — used by all retry attempts.
interface GroqChatRequest {
    model: string;
    messages: Array<{ role: string; content: string }>;
    temperature: number;
    max_tokens: number;
}

async function makeRequest(apiKey: string, body: GroqChatRequest): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        return await fetch(`${GROQ_BASE}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timeout);
    }
}

// ─── Standard Chat ─────────────────────────────────────────────────────────────
export async function chat(
    messages: LLMMessage[],
    model = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    maxTokens = 8192,
    temperature = 0.3,
): Promise<LLMResponse> {
    let lastError: Error | null = null;

    // FIX 5: Key rotation is baked into the attempt sequence.
    // attempt 1 → primary key
    // attempt 2 → secondary key (if available)
    // attempt 3 → primary key again with full dynamic backoff
    const keys: string[] = [getApiKey()];
    const secondaryKey = getSecondaryKey();
    if (secondaryKey) keys.push(secondaryKey, getApiKey());
    const maxAttempts = Math.min(MAX_RETRIES, keys.length);

    const requestBody: GroqChatRequest = {
        model,
        messages: messages.map((m) => ({
            role: m.role,
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        })),
        temperature,
        max_tokens: maxTokens,
    };

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const activeKey = keys[attempt - 1];
        try {
            const res = await makeRequest(activeKey, requestBody);

            if (!res.ok) {
                const errText = await res.text();

                // Fast-fail 413 — never retry a payload that is too large.
                if (res.status === 413) {
                    throw new Error(`413_PAYLOAD_TOO_LARGE: ${errText.substring(0, 200)}`);
                }

                // 429 — parse the dynamic delay from the response body and let the retry loop sleep.
                if (res.status === 429) {
                    const match = errText.match(/try again in ([0-9.]+)s/);
                    const delayS = match ? parseFloat(match[1]) : 30;
                    throw new Error(`429_RATE_LIMIT:${delayS}`);
                }

                throw new Error(`Groq API ${res.status}: ${errText.substring(0, 300)}`);
            }

            const data = (await res.json()) as {
                choices: Array<{ message: { content: string } }>;
                usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
            };

            return {
                content: data.choices[0]?.message?.content ?? '',
                tokensUsed: {
                    prompt:     data.usage?.prompt_tokens     ?? 0,
                    completion: data.usage?.completion_tokens ?? 0,
                    total:      data.usage?.total_tokens      ?? 0,
                },
            };
        } catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));

            // Fast-fail 413 — do not retry large payloads.
            if (lastError.message.startsWith('413_PAYLOAD_TOO_LARGE')) {
                throw lastError;
            }

            if (attempt < maxAttempts) {
                let delayMs = Math.min(1500 * attempt, 5000);

                // Dynamic backoff based on Groq's suggested wait time from the 429 body.
                if (lastError.message.startsWith('429_RATE_LIMIT:')) {
                    const seconds = parseFloat(lastError.message.split(':')[1]);
                    delayMs = seconds * 1000 + 500; // Exact wait + 500ms safety buffer
                    const keyLabel = secondaryKey && attempt === 1 ? ' (swapping to secondary key)' : '';
                    console.warn(`[Groq] Rate limited${keyLabel}, retrying in ${delayMs}ms`);
                } else {
                    console.warn(`[Groq] Attempt ${attempt} failed, retrying in ${delayMs}ms:`, lastError.message);
                }

                await new Promise((r) => setTimeout(r, delayMs));
            }
        }
    }

    throw new Error(`Groq API failed after ${maxAttempts} attempts: ${lastError?.message}`);
}

// ─── Streaming Chat ────────────────────────────────────────────────────────────
export async function* chatStream(
    messages: LLMMessage[],
    model = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    maxTokens = 8192,
): AsyncGenerator<StreamEvent> {
    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let response: Response;
    try {
        response = await fetch(`${GROQ_BASE}/chat/completions`, {
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
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timeout);
    }

    if (!response.ok || !response.body) {
        const errText = response.body ? await response.text() : '';
        throw new Error(`Groq stream failed (${response.status}): ${errText.substring(0, 200)}`);
    }

    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    const streamAbort = new AbortController();

    // Guard against hung streams
    const streamTimeout = setTimeout(() => streamAbort.abort(), 60_000);
    try {
        while (!streamAbort.signal.aborted) {
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
                } catch { /* skip malformed SSE lines */ }
            }
        }
    } finally {
        clearTimeout(streamTimeout);
        reader.releaseLock();
    }
}

export function isAvailable(): boolean {
    return !!(process.env.GROQ_API_KEY || process.env.GROQ_API_KEY_2);
}
