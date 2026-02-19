import type { FastifyInstance } from 'fastify';
import type { ExecuteRequest, ExecuteResponse, StepResult } from '../types/index.js';
import { executeBrowserStep } from '../agents/browser.js';
import { executeSummarizerStep } from '../agents/summarizer.js';
import { executeMemoryStep } from '../agents/memory.js';

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
                // Check dependency
                if (step.dependsOn && !completedSteps.has(step.dependsOn)) {
                    const depResult = completedSteps.get(step.dependsOn);
                    if (depResult && !depResult.success) {
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
