// ─── Ollama Provider ───────────────────────────────────────────────────────────
// HTTP client for local Ollama. Used in privacy/local-only mode.
// Ollama must be running at OLLAMA_URL (default: http://localhost:11434).

import type { LLMMessage, LLMResponse } from '../../types/index.js';
import type { StreamEvent } from '../streaming.js';

const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

function getBaseUrl(): string {
    return (process.env.OLLAMA_URL ?? DEFAULT_OLLAMA_URL).replace(/\/$/, '');
}

// ─── Standard Chat ─────────────────────────────────────────────────────────────
export async function chat(
    messages: LLMMessage[],
    model = 'llama3.1:8b',
    maxTokens = 2048,
    temperature = 0.7,
): Promise<LLMResponse> {
    const url = `${getBaseUrl()}/api/chat`;

    const body = {
        model,
        messages: messages.map((m) => ({
            role: m.role,
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        })),
        stream: false,
        options: {
            temperature,
            num_predict: maxTokens,
        },
    };

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        throw new Error(`Ollama request failed: ${response.status} ${await response.text()}`);
    }

    const data = (await response.json()) as {
        message: { content: string };
        prompt_eval_count?: number;
        eval_count?: number;
    };

    return {
        content: data.message?.content ?? '',
        tokensUsed: {
            prompt: data.prompt_eval_count ?? 0,
            completion: data.eval_count ?? 0,
            total: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
        },
    };
}

// ─── Streaming Chat ────────────────────────────────────────────────────────────
export async function* chatStream(
    messages: LLMMessage[],
    model = 'llama3.1:8b',
): AsyncGenerator<StreamEvent> {
    const url = `${getBaseUrl()}/api/chat`;

    const body = {
        model,
        messages: messages.map((m) => ({
            role: m.role,
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        })),
        stream: true,
    };

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

    if (!response.ok || !response.body) {
        throw new Error(`Ollama stream request failed: ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const lines = decoder.decode(value).split('\n').filter(Boolean);
        for (const line of lines) {
            try {
                const chunk = JSON.parse(line) as {
                    message?: { content: string };
                    done?: boolean;
                };
                if (chunk.message?.content) {
                    yield { type: 'token', text: chunk.message.content };
                }
                if (chunk.done) {
                    yield { type: 'done' };
                    return;
                }
            } catch {
                // Skip malformed JSON lines
            }
        }
    }
}

// ─── Health Check ──────────────────────────────────────────────────────────────
export async function isAvailable(): Promise<boolean> {
    try {
        const res = await fetch(`${getBaseUrl()}/api/tags`, { signal: AbortSignal.timeout(2000) });
        return res.ok;
    } catch {
        return false;
    }
}
