import type { FastifyInstance } from 'fastify';
import type { AnalyzeRequest, AnalyzeResponse } from '../types/index.js';
import { analyzePageContent, matchFiltersToConstraints } from '../agents/analyzer.js';

export async function analyzeRoutes(app: FastifyInstance) {
    app.post<{ Body: AnalyzeRequest }>('/analyze', async (request, reply) => {
        const { prompt, pageData, screenshot } = request.body;

        if (!prompt) {
            return reply.status(400).send({ error: 'prompt is required', success: false } as unknown as AnalyzeResponse);
        }

        try {
            const result = await analyzePageContent(prompt, pageData, screenshot);

            const response: AnalyzeResponse = {
                success: true,
                summary: result.summary,
                rankedResults: result.rankedResults,
                data: {
                    pageTitle: pageData?.title ?? 'Unknown',
                    pageUrl: pageData?.url ?? 'Unknown',
                    contentLength: pageData?.fullText?.length ?? 0,
                    sectionsFound: pageData?.sections?.length ?? 0,
                    linksFound: pageData?.links?.length ?? 0,
                    formsFound: pageData?.forms?.length ?? 0,
                    tablesFound: pageData?.tables?.length ?? 0,
                    imagesFound: pageData?.images?.length ?? 0,
                    scrollCoverage: pageData?.scrollDepth ?? 0,
                    screenshotCaptured: !!screenshot,
                },
            };

            return reply.send(response);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return reply.status(500).send({ error: message });
        }
    });

    // ─── Smart Filter Matcher ───
    app.post<{ Body: { query: string; filters: Array<{ type: string; label: string; selector: string; currentValue?: string; options?: string[] }> } }>(
        '/match-filters',
        async (request, reply) => {
            const { query, filters } = request.body;
            if (!query || !filters) {
                return reply.status(400).send({ error: 'query and filters are required' });
            }

            try {
                const result = await matchFiltersToConstraints(query, filters);
                return reply.send({ success: true, ...result });
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                return reply.status(500).send({ error: message });
            }
        },
    );
}
