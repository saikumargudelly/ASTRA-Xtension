// ─── NEXUS LLM Service ────────────────────────────────────────────────────────
// Unified LLM interface that routes through the LLM Router.
// Maintains backward-compatibility with the existing chat() / chatVision() API
// used by all existing agents (planner, analyzer, etc.).

import 'dotenv/config';
import type { LLMMessage, LLMResponse } from '../types/index.js';
import { getLLMRouter, type TaskType, type RouterConstraints } from '../llm/router.js';
import type { StreamEvent } from '../llm/streaming.js';

// ─── Helpers ───────────────────────────────────────────────────────────────────
function stripThinkTags(text: string): string {
    let stripped = text.replace(/<think>[\s\S]*?<\/think>\s*/gi, '').trim();
    // Unclosed <think> (e.g. Groq/Llama): remove from <think> to next [REASONING]/[ACTIONS]/[NOTES] or end
    const unclosed = stripped.search(/<think>/i);
    if (unclosed >= 0) {
        const tail = stripped.slice(unclosed);
        const next = tail.search(/\n\s*\[(REASONING|ACTIONS|NOTES)\]/i);
        stripped = (next >= 0 ? stripped.slice(0, unclosed) + tail.slice(next) : stripped.slice(0, unclosed)).trim();
    }
    return stripped || text.trim();
}

// ─── Dispatch to correct provider ─────────────────────────────────────────────
async function dispatchChat(
    messages: LLMMessage[],
    taskType: TaskType = 'simple-qa',
    constraints: RouterConstraints = {},
): Promise<LLMResponse> {
    const router = getLLMRouter();
    const config = router.route(taskType, constraints);

    console.log(`[LLMRouter] Routing '${taskType}' → ${config.provider}/${config.model}`);

    try {
        switch (config.provider) {
            case 'groq': {
                const { chat } = await import('../llm/providers/groq.js');
                return await chat(messages, config.model, config.maxTokens, config.temperature);
            }
            case 'anthropic': {
                const { chat } = await import('../llm/providers/anthropic.js');
                return await chat(messages, config.model, config.maxTokens, config.temperature);
            }
            case 'openai': {
                const { chat } = await import('../llm/providers/openai.js');
                return await chat(messages, config.model, config.maxTokens, config.temperature);
            }
            case 'ollama': {
                const { chat } = await import('../llm/providers/ollama.js');
                return await chat(messages, config.model, config.maxTokens, config.temperature);
            }
            default: {
                // fireworks fallback
                const { chat } = await import('../llm/providers/fireworks.js');
                return await chat(messages, config.model, config.maxTokens, config.temperature);
            }
        }
    } catch (err) {
        // Mark provider unavailable, retry with fallback
        router.markProviderUnavailable(config.provider);
        console.warn(`[LLMRouter] ${config.provider} failed, using fallback`);

        const fallbackConfig = router.route(taskType, constraints);
        if (fallbackConfig.provider === config.provider) {
            throw err; // No different fallback available
        }

        const { chat } = await import(`../llm/providers/${fallbackConfig.provider}.js`);
        return await chat(messages, fallbackConfig.model, fallbackConfig.maxTokens);
    }
}

// ─── Backward-Compatible API ───────────────────────────────────────────────────

/**
 * Simple chat — used by planner, analyzer, summarizer.
 * Routes to the cheapest / fastest model unless overridden.
 */
export async function chat(
    systemPrompt: string,
    userPrompt: string,
    taskType: TaskType = 'simple-qa',
): Promise<string> {
    const messages: LLMMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
    ];
    const response = await dispatchChat(messages, taskType);
    return stripThinkTags(response.content);
}

/**
 * Vision chat — routes to GPT-4o or Fireworks vision model.
 */
export async function chatVision(
    systemPrompt: string,
    userPrompt: string,
    imageUrl: string,
): Promise<string> {
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
    const response = await dispatchChat(messages, 'vision');
    return stripThinkTags(response.content);
}

/**
 * Full message array chat — used by the coordinator/ReAct loop.
 */
export async function chatMessages(
    messages: LLMMessage[],
    taskType: TaskType = 'planning',
    constraints: RouterConstraints = {},
): Promise<LLMResponse> {
    return dispatchChat(messages, taskType, constraints);
}

/**
 * Streaming chat — yields StreamEvent tokens in real time.
 */
export async function* chatStream(
    messages: LLMMessage[],
    taskType: TaskType = 'planning',
    constraints: RouterConstraints = {},
): AsyncGenerator<StreamEvent> {
    const router = getLLMRouter();
    const config = router.route(taskType, constraints);

    console.log(`[LLMRouter] Streaming '${taskType}' → ${config.provider}/${config.model}`);

    switch (config.provider) {
        case 'groq': {
            const { chatStream } = await import('../llm/providers/groq.js');
            yield* chatStream(messages, config.model, config.maxTokens);
            break;
        }
        case 'anthropic': {
            const { chatStream } = await import('../llm/providers/anthropic.js');
            yield* chatStream(messages, config.model, config.maxTokens);
            break;
        }
        case 'openai': {
            const { chatStream } = await import('../llm/providers/openai.js');
            yield* chatStream(messages, config.model, config.maxTokens);
            break;
        }
        case 'ollama': {
            const { chatStream } = await import('../llm/providers/ollama.js');
            yield* chatStream(messages, config.model);
            break;
        }
        default: {
            const { chatStream } = await import('../llm/providers/fireworks.js');
            yield* chatStream(messages, config.model, config.maxTokens);
            break;
        }
    }
}

console.log('[NEXUS] LLM service ready — multi-provider routing active');
