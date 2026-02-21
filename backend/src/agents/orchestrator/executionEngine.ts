// ─── Execution Engine ───
// Handles parallel execution of agent steps with retry logic and timeout handling

import type { AgentStep, StepResult } from '../../types/index.js';
import type { 
  ExecutionContext, 
  ExecutionOptions, 
  ExecutionGroup,
  ExecutionStatus,
  OrchestratorEvent,
} from './types.js';
import { DEFAULT_EXECUTION_OPTIONS } from './types.js';
import { getAgentRegistry } from './agentRegistry.js';

// ─── Agent Imports ───
import { executeBrowserStep } from '../browser.js';
import { executeSummarizerStep } from '../summarizer.js';
import { executeMemoryStep } from '../memory.js';
import { handleConfigRequest } from '../config.js';
import { analyzePageContent, analyzeSearchResults, matchFiltersToConstraints } from '../analyzer.js';
import { analyzeScreen, analyzeResults } from '../vision.js';

// ─── Agent Executor Map ───

type AgentExecutor = (step: AgentStep, context: ExecutionContext) => Promise<StepResult>;

const agentExecutors: Record<string, AgentExecutor> = {
  browser: async (step) => executeBrowserStep(step),
  summarizer: async (step) => executeSummarizerStep(step),
  memory: async (step) => executeMemoryStep(step),
  config: async (step, ctx) => {
    const result = await handleConfigRequest({
      query: String(step.params.query || ctx.prompt),
    });
    return {
      stepId: step.id,
      success: result.success,
      data: result,
      durationMs: 0,
    };
  },
  analyzer: async (step) => {
    // Analyzer is typically called through analyze_page action
    // This provides direct access for complex workflows
    const action = step.action;
    if (action === 'analyze_search_results') {
      const result = await analyzeSearchResults(
        String(step.params.query || ''),
        step.params.pageData as any,
      );
      return {
        stepId: step.id,
        success: true,
        data: result,
        durationMs: 0,
      };
    }
    if (action === 'match_filters') {
      const result = await matchFiltersToConstraints(
        String(step.params.query || ''),
        step.params.filters as any,
      );
      return {
        stepId: step.id,
        success: true,
        data: result,
        durationMs: 0,
      };
    }
    // Default: analyze page content
    const result = await analyzePageContent(
      String(step.params.prompt || ''),
      step.params.pageData as any,
      step.params.screenshot as string | undefined,
    );
    return {
      stepId: step.id,
      success: true,
      data: result,
      durationMs: 0,
    };
  },
  vision: async (step) => {
    if (step.action === 'analyze_results') {
      const result = await analyzeResults(
        String(step.params.screenshot || ''),
        String(step.params.query || ''),
        step.params.pageText as string | undefined,
      );
      return {
        stepId: step.id,
        success: true,
        data: result,
        durationMs: 0,
      };
    }
    // Default: analyze screen
    const result = await analyzeScreen(
      String(step.params.screenshot || ''),
      String(step.params.query || ''),
    );
    return {
      stepId: step.id,
      success: true,
      data: result,
      durationMs: 0,
    };
  },
};

// ─── Execution Engine Class ───

export class ExecutionEngine {
  private contexts: Map<string, ExecutionContext> = new Map();
  private eventListeners: Set<(event: OrchestratorEvent) => void> = new Set();
  private options: ExecutionOptions;
  
  constructor(options: Partial<ExecutionOptions> = {}) {
    this.options = { ...DEFAULT_EXECUTION_OPTIONS, ...options };
  }
  
  // ─── Event Handling ───
  
  /**
   * Subscribe to execution events
   */
  subscribe(listener: (event: OrchestratorEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }
  
  /**
   * Emit an event to all listeners
   */
  private emit(event: OrchestratorEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('[ExecutionEngine] Event listener error:', err);
      }
    }
  }
  
  // ─── Context Management ───
  
  /**
   * Create a new execution context
   */
  createContext(
    executionId: string,
    prompt: string,
    options?: Partial<ExecutionOptions>,
  ): ExecutionContext {
    const ctx: ExecutionContext = {
      executionId,
      sessionId: `session_${Date.now()}`,
      startTime: Date.now(),
      prompt,
      completedSteps: new Map(),
      failedSteps: new Map(),
      activeSteps: new Set(),
      pendingSteps: new Set(),
      currentGroup: 0,
      status: 'pending',
      options: { ...this.options, ...options },
    };
    
    this.contexts.set(executionId, ctx);
    return ctx;
  }
  
  /**
   * Get an existing execution context
   */
  getContext(executionId: string): ExecutionContext | undefined {
    return this.contexts.get(executionId);
  }
  
  /**
   * Get execution status
   */
  getStatus(executionId: string): ExecutionStatusResponse | null {
    const ctx = this.contexts.get(executionId);
    if (!ctx) return null;
    
    const total = ctx.completedSteps.size + ctx.failedSteps.size + ctx.activeSteps.size + ctx.pendingSteps.size;
    
    return {
      executionId,
      status: ctx.status,
      progress: {
        total,
        completed: ctx.completedSteps.size,
        failed: ctx.failedSteps.size,
        current: Array.from(ctx.activeSteps).join(', ') || 'idle',
      },
      results: Array.from(ctx.completedSteps.values()),
      startTime: ctx.startTime,
      duration: Date.now() - ctx.startTime,
    };
  }
  
  // ─── Step Execution ───
  
  /**
   * Execute a single step with retry logic
   */
  private async executeStep(
    step: AgentStep,
    context: ExecutionContext,
  ): Promise<StepResult> {
    const registry = getAgentRegistry();
    const startTime = Date.now();
    
    // Check if agent exists
    if (!registry.canExecute(step.agent, step.action)) {
      // Try to find an executor anyway (some agents have dynamic actions)
      if (!agentExecutors[step.agent]) {
        return {
          stepId: step.id,
          success: false,
          error: `Unknown agent: ${step.agent}`,
          durationMs: Date.now() - startTime,
        };
      }
    }
    
    const executor = agentExecutors[step.agent];
    if (!executor) {
      return {
        stepId: step.id,
        success: false,
        error: `No executor for agent: ${step.agent}`,
        durationMs: Date.now() - startTime,
      };
    }
    
    // Execute with retry logic
    let lastError: Error | null = null;
    const maxAttempts = context.options.retryCount + 1;
    
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        registry.setStatus(step.agent, 'busy');
        
        // Execute with timeout
        const result = await this.withTimeout(
          executor(step, context),
          context.options.timeout,
          `Step ${step.id} timed out after ${context.options.timeout}ms`,
        );
        
        registry.recordSuccess(step.agent, result.durationMs);
        return result;
        
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        
        if (attempt < maxAttempts) {
          console.warn(`[ExecutionEngine] Step ${step.id} failed (attempt ${attempt}/${maxAttempts}), retrying...`);
          await this.delay(context.options.retryDelay);
        }
      }
    }
    
    // All retries failed
    registry.recordFailure(step.agent, lastError?.message || 'Unknown error', Date.now() - startTime);
    
    return {
      stepId: step.id,
      success: false,
      error: lastError?.message || 'Unknown error',
      durationMs: Date.now() - startTime,
    };
  }
  
  /**
   * Execute a group of steps (potentially in parallel)
   */
  private async executeGroup(
    group: ExecutionGroup,
    context: ExecutionContext,
  ): Promise<StepResult[]> {
    const results: StepResult[] = [];
    
    // Mark steps as active
    for (const step of group.steps) {
      context.activeSteps.add(step.id);
      context.pendingSteps.delete(step.id);
    }
    
    // Emit group start event
    this.emit({
      type: 'group_complete',
      executionId: context.executionId,
      groupId: group.groupId,
    });
    
    // Execute steps in parallel if allowed
    if (group.canRunInParallel && group.steps.length > 1) {
      const parallelResults = await Promise.all(
        group.steps.map(step => this.executeStepWithEvents(step, context))
      );
      results.push(...parallelResults);
    } else {
      // Execute sequentially
      for (const step of group.steps) {
        const result = await this.executeStepWithEvents(step, context);
        results.push(result);
      }
    }
    
    return results;
  }
  
  /**
   * Execute a step and emit events
   */
  private async executeStepWithEvents(
    step: AgentStep,
    context: ExecutionContext,
  ): Promise<StepResult> {
    this.emit({
      type: 'step_start',
      executionId: context.executionId,
      stepId: step.id,
      agent: step.agent,
    });
    
    const result = await this.executeStep(step, context);
    
    // Update context
    context.activeSteps.delete(step.id);
    if (result.success) {
      context.completedSteps.set(step.id, result);
    } else {
      context.failedSteps.set(step.id, new Error(result.error || 'Unknown error'));
    }
    
    if (result.success) {
      this.emit({
        type: 'step_complete',
        executionId: context.executionId,
        stepId: step.id,
        result,
      });
    } else {
      this.emit({
        type: 'step_error',
        executionId: context.executionId,
        stepId: step.id,
        error: new Error(result.error || 'Unknown error'),
      });
    }
    
    return result;
  }
  
  // ─── Main Execution ───
  
  /**
   * Execute a plan (list of execution groups)
   */
  async executePlan(
    executionId: string,
    groups: ExecutionGroup[],
    prompt: string,
    options?: Partial<ExecutionOptions>,
  ): Promise<StepResult[]> {
    const context = this.createContext(executionId, prompt, options);
    const allResults: StepResult[] = [];
    
    // Initialize pending steps
    for (const group of groups) {
      for (const step of group.steps) {
        context.pendingSteps.add(step.id);
      }
    }
    
    context.status = 'running';
    
    this.emit({
      type: 'execution_start',
      executionId,
      plan: { groups, prompt },
    });
    
    try {
      // Execute groups in order
      for (let i = 0; i < groups.length; i++) {
        context.currentGroup = i;
        
        // Check if dependencies are satisfied
        const group = groups[i];
        const depsSatisfied = group.dependsOnGroups.every(depGroupId => {
          const depGroup = groups.find(g => g.groupId === depGroupId);
          if (!depGroup) return true;
          return depGroup.steps.every(s => 
            context.completedSteps.has(s.id) || context.failedSteps.has(s.id)
          );
        });
        
        if (!depsSatisfied) {
          console.warn(`[ExecutionEngine] Group ${group.groupId} dependencies not satisfied, skipping`);
          continue;
        }
        
        const groupResults = await this.executeGroup(group, context);
        allResults.push(...groupResults);
        
        // Check for critical failures
        const criticalFailures = groupResults.filter(r => !r.success);
        if (criticalFailures.length > 0 && group.steps.some(s => s.id === groups[groups.length - 1].steps[0]?.id)) {
          // If the last group failed, we might want to stop
          console.warn(`[ExecutionEngine] Critical failures in group ${group.groupId}`);
        }
      }
      
      context.status = context.failedSteps.size > 0 ? 'failed' : 'completed';
      
    } catch (err) {
      context.status = 'failed';
      console.error('[ExecutionEngine] Execution failed:', err);
    }
    
    this.emit({
      type: 'execution_complete',
      executionId,
      success: context.status === 'completed',
    });
    
    return allResults;
  }
  
  // ─── Utility Methods ───
  
  /**
   * Wrap a promise with a timeout
   */
  private withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), ms);
      promise
        .then(result => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch(err => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }
  
  /**
   * Delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  /**
   * Cancel an execution
   */
  cancel(executionId: string): boolean {
    const ctx = this.contexts.get(executionId);
    if (!ctx || ctx.status !== 'running') return false;
    
    ctx.status = 'cancelled';
    return true;
  }
  
  /**
   * Clean up old contexts
   */
  cleanup(maxAge: number = 3600000): void {
    const now = Date.now();
    for (const [id, ctx] of this.contexts) {
      if (now - ctx.startTime > maxAge) {
        this.contexts.delete(id);
      }
    }
  }
}

// ─── Singleton Instance ───

let engineInstance: ExecutionEngine | null = null;

/**
 * Get the singleton execution engine instance
 */
export function getExecutionEngine(options?: Partial<ExecutionOptions>): ExecutionEngine {
  if (!engineInstance) {
    engineInstance = new ExecutionEngine(options);
  }
  return engineInstance;
}

/**
 * Reset the engine (for testing)
 */
export function resetEngine(): void {
  engineInstance = null;
}

// ─── Types for Status Response ───

interface ExecutionStatusResponse {
  executionId: string;
  status: ExecutionStatus;
  progress: {
    total: number;
    completed: number;
    failed: number;
    current: string;
  };
  results?: StepResult[];
  startTime: number;
  duration: number;
}

export default getExecutionEngine;
