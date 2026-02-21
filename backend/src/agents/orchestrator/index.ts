// ─── Orchestrator Agent ───
// Central coordinator for all agent activities

import type { AgentStep, StepResult } from '../../types/index.js';
import type {
  OrchestrateRequest,
  OrchestrateResponse,
  ExecutionOptions,
  ExecutionContext,
  PlanAnalysis,
  AggregatedResult,
  OrchestratorEvent,
} from './types.js';
import { DEFAULT_EXECUTION_OPTIONS } from './types.js';
import { analyzePlan, validatePlan } from './planAnalyzer.js';
import { getAgentRegistry } from './agentRegistry.js';
import { getExecutionEngine } from './executionEngine.js';
import { getCommunicationBus } from './communicationBus.js';
import { getResultAggregator } from './resultAggregator.js';
import { storeMemoryDirect } from '../memory.js';

// ─── Orchestrator Class ───

export class Orchestrator {
  private options: ExecutionOptions;
  private activeExecutions: Map<string, ExecutionContext> = new Map();
  
  constructor(options: Partial<ExecutionOptions> = {}) {
    this.options = { ...DEFAULT_EXECUTION_OPTIONS, ...options };
  }
  
  // ─── Main Orchestration ───
  
  /**
   * Orchestrate the execution of a plan
   */
  async orchestrate(request: OrchestrateRequest): Promise<OrchestrateResponse> {
    const executionId = `exec_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const startTime = Date.now();
    
    console.log(`[Orchestrator] Starting execution ${executionId}`);
    console.log(`[Orchestrator] Intent: ${request.plan.intent}`);
    console.log(`[Orchestrator] Steps: ${request.plan.steps.length}`);
    
    // Step 1: Validate the plan
    const validation = validatePlan(request.plan.steps);
    if (!validation.valid) {
      return this.createErrorResponse(executionId, validation.error || 'Invalid plan', startTime);
    }
    
    // Step 2: Analyze the plan for parallel execution
    const analysis = analyzePlan(request.plan.steps);
    console.log(`[Orchestrator] Plan analysis: ${analysis.executionGroups.length} groups, max parallelism ${analysis.parallelismLevel}`);
    
    // Step 3: Get execution engine and set up event handling
    const engine = getExecutionEngine({ ...this.options, ...request.options });
    const aggregator = getResultAggregator();
    
    // Track events for streaming
    const events: OrchestratorEvent[] = [];
    const unsubscribe = engine.subscribe((event) => {
      events.push(event);
      this.handleEvent(event, request);
    });
    
    try {
      // Step 4: Execute the plan
      const stepResults = await engine.executePlan(
        executionId,
        analysis.executionGroups,
        request.prompt,
        request.options,
      );
      
      // Step 5: Get the execution context
      const context = engine.getContext(executionId);
      if (!context) {
        return this.createErrorResponse(executionId, 'Execution context not found', startTime);
      }
      
      // Step 6: Aggregate results
      const aggregated = aggregator.aggregate(executionId, context);
      
      // Step 7: Store execution history (if enabled)
      if (this.options.storeHistory) {
        await this.storeExecutionHistory(executionId, request, aggregated);
      }
      
      // Step 8: Format and return response
      const response = aggregator.formatForResponse(aggregated);
      
      console.log(`[Orchestrator] Execution ${executionId} completed in ${Date.now() - startTime}ms`);
      
      return response;
      
    } catch (error) {
      console.error(`[Orchestrator] Execution ${executionId} failed:`, error);
      return this.createErrorResponse(
        executionId, 
        `Execution failed: ${(error as Error).message}`,
        startTime,
      );
    } finally {
      unsubscribe();
    }
  }
  
  // ─── Event Handling ───
  
  /**
   * Handle execution events (for side effects like memory storage)
   */
  private handleEvent(event: OrchestratorEvent, request: OrchestrateRequest): void {
    switch (event.type) {
      case 'step_complete':
        // Could emit to WebSocket here
        console.log(`[Orchestrator] Step ${event.stepId} completed`);
        break;
        
      case 'step_error':
        console.error(`[Orchestrator] Step ${event.stepId} failed:`, event.error);
        break;
        
      case 'execution_complete':
        console.log(`[Orchestrator] Execution ${event.executionId} ${event.success ? 'succeeded' : 'failed'}`);
        break;
    }
  }
  
  // ─── History Storage ───
  
  /**
   * Store execution history in memory agent
   */
  private async storeExecutionHistory(
    executionId: string,
    request: OrchestrateRequest,
    result: AggregatedResult,
  ): Promise<void> {
    try {
      await storeMemoryDirect(
        `Execution ${executionId}: ${request.plan.intent}`,
        {
          type: 'execution_history',
          executionId,
          prompt: request.prompt,
          intent: request.plan.intent,
          category: request.plan.category,
          success: result.success.toString(),
          duration: result.duration.toString(),
          stepCount: result.metadata.totalSteps.toString(),
          timestamp: new Date().toISOString(),
        },
      );
    } catch (error) {
      console.warn('[Orchestrator] Failed to store execution history:', error);
    }
  }
  
  // ─── Utility Methods ───
  
  /**
   * Create an error response
   */
  private createErrorResponse(
    executionId: string,
    error: string,
    startTime: number,
  ): OrchestrateResponse {
    return {
      success: false,
      executionId,
      summary: `❌ ${error}`,
      data: { error },
      steps: [],
      artifacts: [],
      duration: Date.now() - startTime,
      metadata: {
        totalSteps: 0,
        successfulSteps: 0,
        failedSteps: 1,
        parallelismUsed: 0,
      },
    };
  }
  
  /**
   * Get execution status
   */
  getStatus(executionId: string): ReturnType<ReturnType<typeof getExecutionEngine>['getStatus']> {
    const engine = getExecutionEngine();
    return engine.getStatus(executionId);
  }
  
  /**
   * Cancel an execution
   */
  cancel(executionId: string): boolean {
    const engine = getExecutionEngine();
    return engine.cancel(executionId);
  }
  
  /**
   * Get orchestrator statistics
   */
  getStats(): {
    registry: ReturnType<ReturnType<typeof getAgentRegistry>['getStats']>;
    bus: ReturnType<ReturnType<typeof getCommunicationBus>['getStats']>;
    activeExecutions: number;
  } {
    return {
      registry: getAgentRegistry().getStats(),
      bus: getCommunicationBus().getStats(),
      activeExecutions: this.activeExecutions.size,
    };
  }
}

// ─── Singleton Instance ───

let orchestratorInstance: Orchestrator | null = null;

/**
 * Get the singleton orchestrator instance
 */
export function getOrchestrator(options?: Partial<ExecutionOptions>): Orchestrator {
  if (!orchestratorInstance) {
    orchestratorInstance = new Orchestrator(options);
  }
  return orchestratorInstance;
}

/**
 * Reset the orchestrator (for testing)
 */
export function resetOrchestrator(): void {
  orchestratorInstance = null;
}

// ─── Convenience Functions ───

/**
 * Orchestrate a plan (convenience function)
 */
export async function orchestrate(request: OrchestrateRequest): Promise<OrchestrateResponse> {
  return getOrchestrator().orchestrate(request);
}

// ─── Re-export Types and Components ───

export { analyzePlan, validatePlan } from './planAnalyzer.js';
export { getAgentRegistry } from './agentRegistry.js';
export { getExecutionEngine } from './executionEngine.js';
export { getCommunicationBus } from './communicationBus.js';
export { getResultAggregator } from './resultAggregator.js';
export * from './types.js';

export default getOrchestrator;
