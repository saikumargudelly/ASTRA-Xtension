import type { FastifyInstance } from 'fastify';
import type { ExecuteRequest, ExecuteResponse, StepResult } from '../types/index.js';
import { executeBrowserStep } from '../agents/browser.js';
import { executeSummarizerStep } from '../agents/summarizer.js';
import { executeMemoryStep } from '../agents/memory.js';
import { handleConfigRequest } from '../agents/config.js';
import { analyzePageContent, analyzeSearchResults, matchFiltersToConstraints } from '../agents/analyzer.js';
import { analyzeScreen, analyzeResults } from '../agents/vision.js';

export async function executeRoutes(app: FastifyInstance) {
    app.post<{ Body: ExecuteRequest; Reply: ExecuteResponse }>(
        '/execute',
        async (request, reply) => {
            const { plan, prompt } = request.body;

            if (!plan || !Array.isArray(plan.steps)) {
                return reply.status(400).send({
                    error: 'Valid plan with steps is required',
                } as unknown as ExecuteResponse);
            }

            const stepResults: StepResult[] = [];
            const completedSteps = new Map<string, StepResult>();

            // Execute steps in order, respecting dependencies
            for (const step of plan.steps) {
                // Check dependency — skip step if dep hasn't run or failed
                if (step.dependsOn) {
                    const depResult = completedSteps.get(step.dependsOn);
                    if (!depResult) {
                        // Dependency step has not run (likely due to ordering bug or skip)
                        stepResults.push({
                            stepId: step.id,
                            success: false,
                            error: `Dependency "${step.dependsOn}" has not been executed`,
                            durationMs: 0,
                        });
                        continue;
                    }
                    if (!depResult.success) {
                        stepResults.push({
                            stepId: step.id,
                            success: false,
                            error: `Dependency "${step.dependsOn}" failed`,
                            durationMs: 0,
                        });
                        continue;
                    }
                }

                let result: StepResult;
                const startTime = Date.now();

                switch (step.agent) {
                    case 'browser':
                        result = await executeBrowserStep(step);
                        break;
                    case 'summarizer':
                        result = await executeSummarizerStep(step);
                        break;
                    case 'memory':
                        result = await executeMemoryStep(step);
                        break;
                    case 'config':
                        try {
                            const configResult = await handleConfigRequest({
                                query: String(step.params.query || prompt),
                            });
                            result = {
                                stepId: step.id,
                                success: configResult.success,
                                data: configResult,
                                durationMs: Date.now() - startTime,
                            };
                        } catch (err) {
                            result = {
                                stepId: step.id,
                                success: false,
                                error: (err as Error).message,
                                durationMs: Date.now() - startTime,
                            };
                        }
                        break;
                    case 'analyzer':
                        try {
                            let analyzerResult;
                            if (step.action === 'analyze_search_results') {
                                analyzerResult = await analyzeSearchResults(
                                    String(step.params.query || ''),
                                    step.params.pageData as any,
                                );
                            } else if (step.action === 'match_filters') {
                                analyzerResult = await matchFiltersToConstraints(
                                    String(step.params.query || ''),
                                    step.params.filters as any,
                                );
                            } else {
                                analyzerResult = await analyzePageContent(
                                    String(step.params.prompt || prompt),
                                    step.params.pageData as any,
                                    step.params.screenshot as string | undefined,
                                );
                            }
                            result = {
                                stepId: step.id,
                                success: true,
                                data: analyzerResult,
                                durationMs: Date.now() - startTime,
                            };
                        } catch (err) {
                            result = {
                                stepId: step.id,
                                success: false,
                                error: (err as Error).message,
                                durationMs: Date.now() - startTime,
                            };
                        }
                        break;
                    case 'vision':
                        try {
                            let visionResult;
                            if (step.action === 'analyze_results') {
                                visionResult = await analyzeResults(
                                    String(step.params.screenshot || ''),
                                    String(step.params.query || ''),
                                    step.params.pageText as string | undefined,
                                );
                            } else {
                                visionResult = await analyzeScreen(
                                    String(step.params.screenshot || ''),
                                    String(step.params.query || ''),
                                );
                            }
                            result = {
                                stepId: step.id,
                                success: true,
                                data: visionResult,
                                durationMs: Date.now() - startTime,
                            };
                        } catch (err) {
                            result = {
                                stepId: step.id,
                                success: false,
                                error: (err as Error).message,
                                durationMs: Date.now() - startTime,
                            };
                        }
                        break;
                    default:
                        result = {
                            stepId: step.id,
                            success: false,
                            error: `Unknown agent: ${step.agent}`,
                            durationMs: 0,
                        };
                }

                stepResults.push(result);
                completedSteps.set(step.id, result);
            }

            const allSucceeded = stepResults.every((r) => r.success);
            const lastData = stepResults[stepResults.length - 1]?.data;

            return {
                success: allSucceeded,
                data: lastData,
                summary: allSucceeded
                    ? `Successfully executed ${stepResults.length} steps for: ${prompt}`
                    : `Completed ${stepResults.filter((r) => r.success).length}/${stepResults.length} steps`,
                steps: stepResults,
            };
        },
    );
}
