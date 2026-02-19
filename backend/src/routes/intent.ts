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
                return reply.status(500).send({ error: message } as unknown as IntentResponse);
            }
        },
    );
}
