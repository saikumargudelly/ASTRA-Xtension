// ─── Orchestrator Types ───
// Type definitions for the Orchestrator Agent

import type { AgentStep, StepResult } from '../../types/index.js';

// ─── Execution Groups ───

/**
 * A group of steps that can be executed together (in parallel)
 */
export interface ExecutionGroup {
  groupId: string;
  steps: AgentStep[];
  canRunInParallel: boolean;
  dependsOnGroups: string[];
  estimatedDuration?: number;
}

/**
 * Result of plan analysis
 */
export interface PlanAnalysis {
  executionGroups: ExecutionGroup[];
  criticalPath: string[];           // Step IDs on the critical path
  estimatedDuration: number;        // Total estimated duration in ms
  parallelismLevel: number;         // Max concurrent steps possible
  totalSteps: number;
  independentSteps: string[];       // Steps with no dependencies
}

// ─── Execution Context ───

/**
 * Tracks the state of an ongoing execution
 */
export interface ExecutionContext {
  executionId: string;
  sessionId: string;
  startTime: number;
  prompt: string;
  completedSteps: Map<string, StepResult>;
  failedSteps: Map<string, Error>;
  activeSteps: Set<string>;
  pendingSteps: Set<string>;
  currentGroup: number;
  status: ExecutionStatus;
  options: ExecutionOptions;
}

export type ExecutionStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

// ─── Execution Options ───

/**
 * Configuration for execution behavior
 */
export interface ExecutionOptions {
  maxConcurrency: number;           // Default: 3
  timeout: number;                  // Default: 30000ms per step
  retryCount: number;               // Default: 2
  retryDelay: number;               // Default: 1000ms
  enableStreaming: boolean;         // Default: true
  storeHistory: boolean;            // Default: true (auto-store in memory)
}

export const DEFAULT_EXECUTION_OPTIONS: ExecutionOptions = {
  maxConcurrency: 3,
  timeout: 30000,
  retryCount: 2,
  retryDelay: 1000,
  enableStreaming: true,
  storeHistory: true,
};

// ─── Agent Registry ───

/**
 * Information about a registered agent
 */
export interface AgentInfo {
  name: string;
  actions: string[];
  status: 'idle' | 'busy' | 'error';
  lastActivity: number;
  metrics: AgentMetrics;
}

/**
 * Performance metrics for an agent
 */
export interface AgentMetrics {
  totalExecutions: number;
  successfulExecutions: number;
  failedExecutions: number;
  averageDuration: number;
  lastError?: string;
  lastErrorTime?: number;
}

/**
 * Registry containing all available agents
 */
export interface AgentRegistry {
  agents: Map<string, AgentInfo>;
  capabilities: Map<string, string[]>;  // capability -> agent names
}

// ─── Communication Bus ───

/**
 * Message passed between agents
 */
export interface AgentMessage {
  id: string;
  from: string;                     // Agent name
  to: string | 'broadcast' | 'orchestrator';  // Target agent or broadcast
  type: 'request' | 'response' | 'event' | 'error';
  payload: unknown;
  correlationId?: string;           // For request/response matching
  timestamp: number;
}

/**
 * Handler for incoming messages
 */
export type MessageHandler = (message: AgentMessage) => Promise<void> | void;

/**
 * Event types for the communication bus
 */
export type OrchestratorEvent =
  | { type: 'execution_start'; executionId: string; plan: unknown }
  | { type: 'step_start'; executionId: string; stepId: string; agent: string }
  | { type: 'step_complete'; executionId: string; stepId: string; result: StepResult }
  | { type: 'step_error'; executionId: string; stepId: string; error: Error }
  | { type: 'group_complete'; executionId: string; groupId: string }
  | { type: 'execution_complete'; executionId: string; success: boolean }
  | { type: 'agent_message'; message: AgentMessage };

// ─── Result Aggregation ───

/**
 * Aggregated result from multiple agents
 */
export interface AggregatedResult {
  success: boolean;
  executionId: string;
  summary: string;
  data: Record<string, unknown>;
  stepResults: Map<string, StepResult>;
  artifacts: ResultArtifact[];
  duration: number;
  metadata: {
    totalSteps: number;
    successfulSteps: number;
    failedSteps: number;
    parallelismUsed: number;
  };
}

/**
 * A typed artifact produced by an agent
 */
export interface ResultArtifact {
  type: 'summary' | 'ranked_list' | 'walkthrough' | 'memory' | 'screenshot' | 'analysis' | 'search_results';
  content: unknown;
  sourceAgent: string;
  sourceStep: string;
  timestamp: number;
}

// ─── Orchestration Request/Response ───

/**
 * Request to the orchestrate endpoint
 */
export interface OrchestrateRequest {
  plan: {
    intent: string;
    category: string;
    steps: AgentStep[];
    reasoning: string;
  };
  prompt: string;
  options?: Partial<ExecutionOptions>;
  context?: {
    sessionId?: string;
    url?: string;
    title?: string;
    screenshot?: string;
  };
}

/**
 * Response from the orchestrate endpoint
 */
export interface OrchestrateResponse {
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
}

/**
 * Status of an ongoing execution
 */
export interface ExecutionStatusResponse {
  executionId: string;
  status: ExecutionStatus;
  progress: {
    total: number;
    completed: number;
    failed: number;
    current: string;  // Current step or group description
  };
  results?: StepResult[];
  estimatedTimeRemaining?: number;
  startTime: number;
  duration: number;
}

// ─── Dependency Graph ───

/**
 * Node in the dependency graph
 */
export interface DependencyNode {
  stepId: string;
  step: AgentStep;
  dependencies: Set<string>;
  dependents: Set<string>;
  depth: number;          // How many steps must complete before this one
}

/**
 * Graph representation of step dependencies
 */
export interface DependencyGraph {
  nodes: Map<string, DependencyNode>;
  roots: Set<string>;      // Steps with no dependencies
  leaves: Set<string>;     // Steps that nothing depends on
  maxDepth: number;
}
