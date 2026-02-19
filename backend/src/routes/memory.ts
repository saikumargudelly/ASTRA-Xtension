import type { FastifyInstance } from 'fastify';
import { storeMemoryDirect, queryMemoryDirect } from '../agents/memory.js';
import type { MemoryStoreRequest, MemoryQueryRequest, MemoryEntry } from '../types/index.js';

export async function memoryRoutes(app: FastifyInstance) {
    // POST /memory/store
    app.post<{ Body: MemoryStoreRequest }>(
        '/memory/store',
        async (request, reply) => {
            const { text, metadata } = request.body;

            if (!text || typeof text !== 'string') {
                return reply.status(400).send({ error: 'text is required' });
            }

            try {
                const result = await storeMemoryDirect(text, metadata);
                return { success: true, id: result.id };
            } catch (err) {
                const message = err instanceof Error ? err.message : 'Store failed';
                return reply.status(500).send({ error: message });
            }
        },
    );

    // GET /memory/query
    app.get<{ Querystring: MemoryQueryRequest; Reply: { results: MemoryEntry[] } }>(
        '/memory/query',
        async (request, reply) => {
            const { query, topK } = request.query;

            if (!query || typeof query !== 'string') {
                return reply.status(400).send({ error: 'query parameter is required' } as unknown as { results: MemoryEntry[] });
            }

            try {
                const results = await queryMemoryDirect(query, topK);
                return { results };
            } catch (err) {
                const message = err instanceof Error ? err.message : 'Query failed';
                return reply.status(500).send({ error: message } as unknown as { results: MemoryEntry[] });
            }
        },
    );
}
