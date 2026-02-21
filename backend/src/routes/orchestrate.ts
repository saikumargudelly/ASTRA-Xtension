// ─── Orchestrate Route ───
// API endpoint for orchestrated agent execution

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getOrchestrator, type OrchestrateRequest, type OrchestrateResponse } from '../agents/orchestrator/index.js';

// ─── Route Schema ───

const orchestrateSchema = {
  body: {
    type: 'object',
    required: ['plan', 'prompt'],
    properties: {
      plan: {
        type: 'object',
        required: ['intent', 'category', 'steps'],
        properties: {
          intent: { type: 'string' },
          category: { type: 'string' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id', 'agent', 'action', 'params'],
              properties: {
                id: { type: 'string' },
                agent: { type: 'string' },
                action: { type: 'string' },
                params: { type: 'object' },
                dependsOn: { type: 'string' },
              },
            },
          },
          reasoning: { type: 'string' },
        },
      },
      prompt: { type: 'string' },
      options: {
        type: 'object',
        properties: {
          maxConcurrency: { type: 'number' },
          timeout: { type: 'number' },
          retryCount: { type: 'number' },
          retryDelay: { type: 'number' },
          enableStreaming: { type: 'boolean' },
          storeHistory: { type: 'boolean' },
        },
      },
      context: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          url: { type: 'string' },
          title: { type: 'string' },
          screenshot: { type: 'string' },
        },
      },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        executionId: { type: 'string' },
        summary: { type: 'string' },
        data: { type: 'object' },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              stepId: { type: 'string' },
              success: { type: 'boolean' },
              data: { type: 'object' },
              error: { type: 'string' },
              durationMs: { type: 'number' },
            },
          },
        },
        artifacts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string' },
              content: { type: 'object' },
              sourceAgent: { type: 'string' },
              sourceStep: { type: 'string' },
              timestamp: { type: 'number' },
            },
          },
        },
        duration: { type: 'number' },
        metadata: {
          type: 'object',
          properties: {
            totalSteps: { type: 'number' },
            successfulSteps: { type: 'number' },
            failedSteps: { type: 'number' },
            parallelismUsed: { type: 'number' },
          },
        },
      },
    },
  },
};

// ─── Route Handlers ───

/**
 * Main orchestration handler
 */
async function orchestrateHandler(
  request: FastifyRequest<{ Body: OrchestrateRequest }>,
  reply: FastifyReply,
): Promise<OrchestrateResponse> {
  const startTime = Date.now();
  const { plan, prompt, options, context } = request.body;

  console.log(`[OrchestrateRoute] Processing: "${prompt}"`);
  console.log(`[OrchestrateRoute] Plan: ${plan.intent} (${plan.category})`);

  try {
    // Validate plan has steps
    if (!plan.steps || plan.steps.length === 0) {
      return reply.status(400).send({
        success: false,
        executionId: '',
        summary: 'Plan has no steps to execute',
        data: { error: 'Plan must have at least one step' },
        steps: [],
        artifacts: [],
        duration: Date.now() - startTime,
        metadata: {
          totalSteps: 0,
          successfulSteps: 0,
          failedSteps: 0,
          parallelismUsed: 0,
        },
      });
    }

    // Get orchestrator and execute
    const orchestrator = getOrchestrator(options);
    const response = await orchestrator.orchestrate({
      plan,
      prompt,
      options,
      context,
    });

    const duration = Date.now() - startTime;
    console.log(`[OrchestrateRoute] Completed in ${duration}ms: ${response.success ? 'success' : 'failed'}`);

    return reply.send(response);

  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`[OrchestrateRoute] Error after ${duration}ms:`, error);

    return reply.status(500).send({
      success: false,
      executionId: '',
      summary: `Internal server error: ${(error as Error).message}`,
      data: { error: (error as Error).message },
      steps: [],
      artifacts: [],
      duration,
      metadata: {
        totalSteps: 0,
        successfulSteps: 0,
        failedSteps: 1,
        parallelismUsed: 0,
      },
    });
  }
}

/**
 * Status check handler
 */
async function statusHandler(
  request: FastifyRequest<{ Params: { executionId: string } }>,
  reply: FastifyReply,
): Promise<{ executionId: string; status: string; progress: Record<string, unknown> } | null> {
  const { executionId } = request.params;
  
  const orchestrator = getOrchestrator();
  const status = orchestrator.getStatus(executionId);
  
  if (!status) {
    return reply.status(404).send({
      error: 'Execution not found',
      executionId,
    });
  }
  
  return reply.send(status);
}

/**
 * Cancel execution handler
 */
async function cancelHandler(
  request: FastifyRequest<{ Params: { executionId: string } }>,
  reply: FastifyReply,
): Promise<{ success: boolean; message: string }> {
  const { executionId } = request.params;
  
  const orchestrator = getOrchestrator();
  const cancelled = orchestrator.cancel(executionId);
  
  if (cancelled) {
    return reply.send({
      success: true,
      message: `Execution ${executionId} cancelled`,
    });
  }
  
  return reply.status(400).send({
    success: false,
    message: `Could not cancel execution ${executionId} (not running or not found)`,
  });
}

/**
 * Stats handler
 */
async function statsHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<Record<string, unknown>> {
  const orchestrator = getOrchestrator();
  return reply.send(orchestrator.getStats());
}

// ─── Register Routes ───

export async function orchestrateRoutes(app: FastifyInstance): Promise<void> {
  // Main orchestration endpoint
  app.post('/orchestrate', { schema: orchestrateSchema }, orchestrateHandler);

  // Get execution status
  app.get('/orchestrate/:executionId/status', statusHandler);

  // Cancel an execution
  app.post('/orchestrate/:executionId/cancel', cancelHandler);

  // Get orchestrator stats
  app.get('/orchestrate/stats', statsHandler);

  console.log('[OrchestrateRoute] Routes registered: POST /orchestrate, GET /orchestrate/:id/status, POST /orchestrate/:id/cancel, GET /orchestrate/stats');
}

export default orchestrateRoutes;
