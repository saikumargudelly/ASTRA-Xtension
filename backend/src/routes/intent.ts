import type { FastifyInstance } from 'fastify';
import { planIntent } from '../agents/planner.js';
import type { IntentRequest, IntentResponse } from '../types/index.js';
import { getDb } from '../db/sqlite.js';

export async function intentRoutes(app: FastifyInstance) {
    app.post<{ Body: IntentRequest & { screenshot?: string }; Reply: IntentResponse }>(
        '/intent',
        async (request, reply) => {
            const { prompt, context, screenshot } = request.body;

            if (!prompt || typeof prompt !== 'string') {
                return reply.status(400).send({ error: 'prompt is required' } as unknown as IntentResponse);
            }

            try {
                const plan = await planIntent({ prompt, context, screenshot });

                // Log command to DB
                const db = getDb();
                db.prepare(
                    'INSERT INTO commands (session_id, prompt, plan_json, status) VALUES (?, ?, ?, ?)',
                ).run('default-session', prompt, JSON.stringify(plan), 'planned');

                return { plan };
            } catch (err) {
                const message = err instanceof Error ? err.message : 'Planning failed';
                console.error('[ASTRA] /intent error:', message);

                // Produce a user-friendly message based on the error type
                let clientMessage = message;
                if (message.includes('invalid JSON') || message.includes('JSON parse')) {
                    clientMessage = 'LLM response could not be parsed as JSON. Please retry.';
                } else if (message.includes('API failed') || message.includes('Fireworks')) {
                    clientMessage = 'LLM API error — check your QWEN_API_KEY in backend/.env';
                } else if (message.includes('timed out') || message.includes('AbortError')) {
                    clientMessage = 'LLM request timed out. The model may be busy — please retry.';
                }

                return reply.status(500).send({ error: clientMessage } as unknown as IntentResponse);
            }
        },
    );
}
