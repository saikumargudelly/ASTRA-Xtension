// ─── NEXUS Chat Route ─────────────────────────────────────────────────────────
// POST /chat — primary streaming endpoint.
// Accepts a message, streams SSE events in real time via the NexusCoordinator.

import type { FastifyInstance } from 'fastify';
import { getNexusCoordinator } from '../coordinator/orchestrator.js';
import { pipeToSSE } from '../llm/streaming.js';

export async function chatRoutes(app: FastifyInstance): Promise<void> {
    // ── POST /chat (SSE streaming) ──────────────────────────────────────────────
    app.post<{
        Body: {
            message: string;
            sessionId?: string;
            context?: {
                url?: string;
                title?: string;
                screenshot?: string;
            };
        };
    }>('/chat', {
        schema: {
            body: {
                type: 'object',
                required: ['message'],
                properties: {
                    message: { type: 'string', minLength: 1, maxLength: 10000 },
                    sessionId: { type: 'string' },
                    context: {
                        type: 'object',
                        properties: {
                            url: { type: 'string' },
                            title: { type: 'string' },
                            screenshot: { type: 'string' },
                        },
                    },
                },
            },
        },
    }, async (request, reply) => {
        const { message, sessionId, context } = request.body;
        const sid = sessionId ?? `session-${Date.now()}`;

        console.log(`[NEXUS /chat] sessionId=${sid} message="${message.substring(0, 80)}..."`);

        const coordinator = getNexusCoordinator();
        const eventStream = coordinator.streamTask({ message, sessionId: sid, context });

        await pipeToSSE(reply, eventStream);
    });

    // ── GET /chat/health ────────────────────────────────────────────────────────
    app.get('/chat/health', async () => ({
        status: 'ok',
        endpoint: '/chat',
        streaming: true,
        timestamp: new Date().toISOString(),
    }));
}
