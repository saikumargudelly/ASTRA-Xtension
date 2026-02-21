// ─── Result Aggregator ───
// Combines results from multiple agents into unified output

import type { StepResult } from '../../types/index.js';
import type { 
  AggregatedResult, 
  ResultArtifact, 
  ExecutionContext,
} from './types.js';

// ─── Result Aggregator Class ───

export class ResultAggregator {
  // ─── Main Aggregation ───
  
  /**
   * Aggregate results from an execution context
   */
  aggregate(
    executionId: string,
    context: ExecutionContext,
  ): AggregatedResult {
    const stepResults = context.completedSteps;
    const failedSteps = context.failedSteps;
    
    // Extract artifacts from step results
    const artifacts = this.extractArtifacts(stepResults);
    
    // Generate summary
    const summary = this.generateSummary(stepResults, failedSteps, artifacts);
    
    // Merge data from all steps
    const data = this.mergeStepData(stepResults);
    
    // Calculate metadata
    const metadata = {
      totalSteps: stepResults.size + failedSteps.size,
      successfulSteps: stepResults.size,
      failedSteps: failedSteps.size,
      parallelismUsed: this.calculateParallelismUsed(context),
    };
    
    return {
      success: failedSteps.size === 0,
      executionId,
      summary,
      data,
      stepResults,
      artifacts,
      duration: Date.now() - context.startTime,
      metadata,
    };
  }
  
  // ─── Artifact Extraction ───
  
  /**
   * Extract typed artifacts from step results
   */
  private extractArtifacts(
    stepResults: Map<string, StepResult>,
  ): ResultArtifact[] {
    const artifacts: ResultArtifact[] = [];
    
    for (const [stepId, result] of stepResults) {
      if (!result.success || !result.data) continue;
      
      const data = result.data as Record<string, unknown>;
      
      // Check for specific artifact types based on data structure
      const artifact = this.detectArtifactType(stepId, result);
      if (artifact) {
        artifacts.push(artifact);
      }
    }
    
    return artifacts;
  }
  
  /**
   * Detect the type of artifact from step result data
   */
  private detectArtifactType(
    stepId: string,
    result: StepResult,
  ): ResultArtifact | null {
    const data = result.data as Record<string, unknown>;
    if (!data) return null;
    
    // Ranked results from analyzer
    if (data.rankedResults && Array.isArray(data.rankedResults)) {
      return {
        type: 'ranked_list',
        content: data.rankedResults,
        sourceAgent: this.extractAgentFromStepId(stepId),
        sourceStep: stepId,
        timestamp: Date.now(),
      };
    }
    
    // Summary from summarizer or analyzer
    if (data.summary && typeof data.summary === 'string') {
      return {
        type: 'summary',
        content: data.summary,
        sourceAgent: this.extractAgentFromStepId(stepId),
        sourceStep: stepId,
        timestamp: Date.now(),
      };
    }
    
    // Walkthrough from config agent
    if (data.walkthrough && typeof data.walkthrough === 'object') {
      return {
        type: 'walkthrough',
        content: data.walkthrough,
        sourceAgent: this.extractAgentFromStepId(stepId),
        sourceStep: stepId,
        timestamp: Date.now(),
      };
    }
    
    // Search results
    if (data.results && Array.isArray(data.results)) {
      return {
        type: 'search_results',
        content: data.results,
        sourceAgent: this.extractAgentFromStepId(stepId),
        sourceStep: stepId,
        timestamp: Date.now(),
      };
    }
    
    // Analysis result
    if (data.pageType || data.mainContentDescription || data.topResults) {
      return {
        type: 'analysis',
        content: data,
        sourceAgent: this.extractAgentFromStepId(stepId),
        sourceStep: stepId,
        timestamp: Date.now(),
      };
    }
    
    // Memory result
    if (data.results && data.count !== undefined) {
      return {
        type: 'memory',
        content: data.results,
        sourceAgent: this.extractAgentFromStepId(stepId),
        sourceStep: stepId,
        timestamp: Date.now(),
      };
    }
    
    // Browser action result - check for action type
    if (data.action && typeof data.action === 'object') {
      const action = data.action as Record<string, unknown>;
      if (action.type === 'analyze_page') {
        return {
          type: 'analysis',
          content: data,
          sourceAgent: 'browser',
          sourceStep: stepId,
          timestamp: Date.now(),
        };
      }
    }
    
    return null;
  }
  
  /**
   * Extract agent name from step ID (best effort)
   */
  private extractAgentFromStepId(stepId: string): string {
    // Step IDs are typically just numbers, so we can't extract agent
    // This would need to be passed in the result
    return 'unknown';
  }
  
  // ─── Summary Generation ───
  
  /**
   * Generate a human-readable summary of the execution
   */
  private generateSummary(
    stepResults: Map<string, StepResult>,
    failedSteps: Map<string, Error>,
    artifacts: ResultArtifact[],
  ): string {
    const parts: string[] = [];
    
    if (failedSteps.size > 0) {
      parts.push(`❌ ${failedSteps.size} step(s) failed.`);
    }
    
    if (stepResults.size > 0) {
      parts.push(`✅ ${stepResults.size} step(s) completed successfully.`);
    }
    
    // Summarize artifacts
    const artifactTypes = new Set(artifacts.map(a => a.type));
    if (artifactTypes.has('ranked_list')) {
      parts.push('📊 Ranked results generated.');
    }
    if (artifactTypes.has('walkthrough')) {
      parts.push('📋 Walkthrough created.');
    }
    if (artifactTypes.has('summary')) {
      parts.push('📝 Summary generated.');
    }
    if (artifactTypes.has('analysis')) {
      parts.push('🔍 Page analysis completed.');
    }
    
    return parts.join(' ') || 'Execution completed.';
  }
  
  // ─── Data Merging ───
  
  /**
   * Merge data from all step results
   */
  private mergeStepData(
    stepResults: Map<string, StepResult>,
  ): Record<string, unknown> {
    const merged: Record<string, unknown> = {};
    
    for (const [stepId, result] of stepResults) {
      if (!result.success || !result.data) continue;
      
      const data = result.data as Record<string, unknown>;
      
      // Merge top-level keys, with later steps overwriting
      for (const [key, value] of Object.entries(data)) {
        // Special handling for arrays - concatenate instead of overwrite
        if (Array.isArray(value) && Array.isArray(merged[key])) {
          merged[key] = [...(merged[key] as unknown[]), ...value];
        } else if (typeof value === 'object' && value !== null && 
                   typeof merged[key] === 'object' && merged[key] !== null) {
          // Merge objects
          merged[key] = { ...(merged[key] as Record<string, unknown>), ...value };
        } else {
          merged[key] = value;
        }
      }
    }
    
    return merged;
  }
  
  // ─── Parallelism Calculation ───
  
  /**
   * Calculate the maximum parallelism used during execution
   */
  private calculateParallelismUsed(context: ExecutionContext): number {
    // This is a simplified calculation
    // In reality, we'd track this during execution
    return Math.min(context.options.maxConcurrency, context.completedSteps.size);
  }
  
  // ─── Formatting ───
  
  /**
   * Format aggregated result for API response
   */
  formatForResponse(result: AggregatedResult): {
    success: boolean;
    executionId: string;
    summary: string;
    data: unknown;
    steps: StepResult[];
    artifacts: ResultArtifact[];
    duration: number;
    metadata: {
      totalSteps: number;
      successfulSteps: number;
      failedSteps: number;
      parallelismUsed: number;
    };
  } {
    return {
      success: result.success,
      executionId: result.executionId,
      summary: result.summary,
      data: result.data,
      steps: Array.from(result.stepResults.values()),
      artifacts: result.artifacts,
      duration: result.duration,
      metadata: result.metadata,
    };
  }
  
  /**
   * Get the primary artifact (most relevant result)
   */
  getPrimaryArtifact(artifacts: ResultArtifact[]): ResultArtifact | null {
    if (artifacts.length === 0) return null;
    
    // Priority order for primary artifact
    const priority: ResultArtifact['type'][] = [
      'walkthrough',
      'ranked_list',
      'summary',
      'analysis',
      'search_results',
      'memory',
      'screenshot',
    ];
    
    for (const type of priority) {
      const artifact = artifacts.find(a => a.type === type);
      if (artifact) return artifact;
    }
    
    return artifacts[0];
  }
}

// ─── Singleton Instance ───

let aggregatorInstance: ResultAggregator | null = null;

/**
 * Get the singleton result aggregator instance
 */
export function getResultAggregator(): ResultAggregator {
  if (!aggregatorInstance) {
    aggregatorInstance = new ResultAggregator();
  }
  return aggregatorInstance;
}

/**
 * Reset the aggregator (for testing)
 */
export function resetAggregator(): void {
  aggregatorInstance = null;
}

export default getResultAggregator;
