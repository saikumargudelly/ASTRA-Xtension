// ─── Configuration Route ───
// API endpoint for configuration assistance

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { handleConfigRequest, isConfigurationQuery } from '../agents/config.js';
import type { ConfigRequest, ConfigResponse } from '../types/index.js';

// ─── Route Schema ───

const configSchema = {
    body: {
        type: 'object',
        required: ['query'],
        properties: {
            query: { type: 'string' },
            context: {
                type: 'object',
                properties: {
                    url: { type: 'string' },
                    title: { type: 'string' },
                },
            },
        },
    },
    response: {
        200: {
            type: 'object',
            properties: {
                success: { type: 'boolean' },
                intent: { type: 'string' },
                application: { type: 'string' },
                walkthrough: {
                    type: 'object',
                    properties: {
                        id: { type: 'string' },
                        title: { type: 'string' },
                        description: { type: 'string' },
                        application: { type: 'string' },
                        totalSteps: { type: 'number' },
                        estimatedTime: { type: 'string' },
                        steps: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    stepNumber: { type: 'number' },
                                    title: { type: 'string' },
                                    instruction: { type: 'string' },
                                    tips: { type: 'array', items: { type: 'string' } },
                                    warnings: { type: 'array', items: { type: 'string' } },
                                    estimatedSeconds: { type: 'number' },
                                },
                            },
                        },
                        source: {
                            type: 'object',
                            properties: {
                                url: { type: 'string' },
                                name: { type: 'string' },
                            },
                        },
                        lastUpdated: { type: 'string' },
                    },
                },
                alternativeGuides: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            title: { type: 'string' },
                            url: { type: 'string' },
                            source: { type: 'string' },
                        },
                    },
                },
                error: { type: 'string' },
            },
        },
    },
};

// ─── Route Handler ───

async function configHandler(
    request: FastifyRequest<{ Body: ConfigRequest }>,
    reply: FastifyReply
): Promise<ConfigResponse> {
    const startTime = Date.now();
    const { query, context } = request.body;

    console.log(`[ConfigRoute] Processing: "${query}"`);

    try {
        // Validate query
        if (!query || query.trim().length === 0) {
            return reply.status(400).send({
                success: false,
                intent: '',
                application: '',
                error: 'Query is required',
            });
        }

        // Check if this is a configuration query
        if (!isConfigurationQuery(query)) {
            console.log(`[ConfigRoute] Query "${query}" is not a configuration query`);
            // Still process it, but log for debugging
        }

        // Handle the configuration request
        const response = await handleConfigRequest({ query, context });

        const duration = Date.now() - startTime;
        console.log(`[ConfigRoute] Completed in ${duration}ms: ${response.success ? 'success' : response.error}`);

        return reply.send(response);

    } catch (error) {
        const duration = Date.now() - startTime;
        console.error(`[ConfigRoute] Error after ${duration}ms:`, error);

        return reply.status(500).send({
            success: false,
            intent: '',
            application: '',
            error: `Internal server error: ${(error as Error).message}`,
        });
    }
}

// ─── Check Endpoint ───

async function checkConfigHandler(
    request: FastifyRequest<{ Body: { query: string } }>,
    reply: FastifyReply
): Promise<{ isConfig: boolean }> {
    const { query } = request.body;
    return reply.send({
        isConfig: isConfigurationQuery(query),
    });
}

// ─── Register Routes ───

export async function configRoutes(app: FastifyInstance): Promise<void> {
    // Main configuration endpoint
    app.post('/config', { schema: configSchema }, configHandler);

    // Check if a query is a configuration query
    app.post('/config/check', async (
        request: FastifyRequest<{ Body: { query: string } }>,
        reply: FastifyReply
    ) => {
        const { query } = request.body;
        return reply.send({
            isConfig: isConfigurationQuery(query),
        });
    });

    console.log('[ConfigRoute] Routes registered: POST /config, POST /config/check');
}

export default configRoutes;
