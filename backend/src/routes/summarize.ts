import type { FastifyInstance } from 'fastify';
import { summarizeText } from '../agents/summarizer.js';
import type { SummarizeRequest, SummarizeResponse } from '../types/index.js';

export async function summarizeRoutes(app: FastifyInstance) {
    app.post<{ Body: SummarizeRequest; Reply: SummarizeResponse }>(
        '/summarize',
        async (request, reply) => {
            const { text, mode, maxLength, bulletCount } = request.body;

            if (!text || typeof text !== 'string') {
                return reply.status(400).send({ error: 'text is required' } as unknown as SummarizeResponse);
            }

            if (!mode || !['summarize', 'bullets'].includes(mode)) {
                return reply.status(400).send({
                    error: 'mode must be "summarize" or "bullets"',
                } as unknown as SummarizeResponse);
            }

            try {
                const result = await summarizeText(text, mode, { maxLength, bulletCount });
                return { result };
            } catch (err) {
                const message = err instanceof Error ? err.message : 'Summarization failed';
                return reply.status(500).send({ error: message } as unknown as SummarizeResponse);
            }
        },
    );
}
