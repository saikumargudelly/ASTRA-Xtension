// ─── Plan Analyzer ───
// Analyzes step plans to determine parallel execution opportunities

import type { AgentStep } from '../../types/index.js';
import type { 
  PlanAnalysis, 
  ExecutionGroup, 
  DependencyGraph, 
  DependencyNode 
} from './types.js';

// ─── Main Analysis Function ───

/**
 * Analyzes a step plan and creates execution groups for parallel execution
 */
export function analyzePlan(steps: AgentStep[]): PlanAnalysis {
  // Build dependency graph
  const graph = buildDependencyGraph(steps);
  
  // Create execution groups based on dependency levels
  const executionGroups = createExecutionGroups(steps, graph);
  
  // Find critical path (longest path through the graph)
  const criticalPath = findCriticalPath(graph);
  
  // Calculate metrics
  const estimatedDuration = estimateTotalDuration(executionGroups);
  const parallelismLevel = Math.max(...executionGroups.map(g => g.steps.length));
  const independentSteps = Array.from(graph.roots);

  return {
    executionGroups,
    criticalPath,
    estimatedDuration,
    parallelismLevel,
    totalSteps: steps.length,
    independentSteps,
  };
}

// ─── Dependency Graph Construction ───

/**
 * Builds a dependency graph from step definitions
 */
function buildDependencyGraph(steps: AgentStep[]): DependencyGraph {
  const nodes = new Map<string, DependencyNode>();
  const stepMap = new Map<string, AgentStep>();
  
  // First pass: create all nodes
  for (const step of steps) {
    stepMap.set(step.id, step);
    nodes.set(step.id, {
      stepId: step.id,
      step,
      dependencies: new Set(),
      dependents: new Set(),
      depth: 0,
    });
  }
  
  // Second pass: establish dependencies
  for (const step of steps) {
    const node = nodes.get(step.id)!;
    
    if (step.dependsOn) {
      // Handle both single and multiple dependencies
      const deps = Array.isArray(step.dependsOn) 
        ? step.dependsOn 
        : [step.dependsOn];
      
      for (const depId of deps) {
        if (nodes.has(depId)) {
          node.dependencies.add(depId);
          nodes.get(depId)!.dependents.add(step.id);
        }
      }
    }
  }
  
  // Calculate depths using topological sort
  calculateDepths(nodes);
  
  // Find roots (no dependencies) and leaves (no dependents)
  const roots = new Set<string>();
  const leaves = new Set<string>();
  
  for (const [id, node] of nodes) {
    if (node.dependencies.size === 0) {
      roots.add(id);
    }
    if (node.dependents.size === 0) {
      leaves.add(id);
    }
  }
  
  const maxDepth = Math.max(...Array.from(nodes.values()).map(n => n.depth));
  
  return {
    nodes,
    roots,
    leaves,
    maxDepth,
  };
}

/**
 * Calculates the depth of each node (how many steps must complete before it)
 */
function calculateDepths(nodes: Map<string, DependencyNode>): void {
  const visited = new Set<string>();
  const visiting = new Set<string>();
  
  function visit(nodeId: string): number {
    if (visited.has(nodeId)) {
      return nodes.get(nodeId)!.depth;
    }
    
    if (visiting.has(nodeId)) {
      // Circular dependency detected - this shouldn't happen with valid plans
      console.warn(`[PlanAnalyzer] Circular dependency detected at ${nodeId}`);
      return 0;
    }
    
    visiting.add(nodeId);
    const node = nodes.get(nodeId)!;
    
    if (node.dependencies.size === 0) {
      node.depth = 0;
    } else {
      let maxDepDepth = 0;
      for (const depId of node.dependencies) {
        maxDepDepth = Math.max(maxDepDepth, visit(depId) + 1);
      }
      node.depth = maxDepDepth;
    }
    
    visiting.delete(nodeId);
    visited.add(nodeId);
    
    return node.depth;
  }
  
  // Visit all nodes
  for (const nodeId of nodes.keys()) {
    visit(nodeId);
  }
}

// ─── Execution Group Creation ───

/**
 * Creates execution groups where steps in the same group can run in parallel
 */
function createExecutionGroups(
  steps: AgentStep[], 
  graph: DependencyGraph
): ExecutionGroup[] {
  // Group steps by their depth level
  const depthGroups = new Map<number, AgentStep[]>();
  
  for (const [id, node] of graph.nodes) {
    const depth = node.depth;
    if (!depthGroups.has(depth)) {
      depthGroups.set(depth, []);
    }
    depthGroups.get(depth)!.push(node.step);
  }
  
  // Convert to execution groups
  const executionGroups: ExecutionGroup[] = [];
  const sortedDepths = Array.from(depthGroups.keys()).sort((a, b) => a - b);
  
  for (let i = 0; i < sortedDepths.length; i++) {
    const depth = sortedDepths[i];
    const groupSteps = depthGroups.get(depth)!;
    
    // Determine which groups this group depends on
    const dependsOnGroups: string[] = [];
    if (i > 0) {
      dependsOnGroups.push(`group_${sortedDepths[i - 1]}`);
    }
    
    executionGroups.push({
      groupId: `group_${depth}`,
      steps: groupSteps,
      canRunInParallel: groupSteps.length > 1,
      dependsOnGroups,
      estimatedDuration: estimateGroupDuration(groupSteps),
    });
  }
  
  return executionGroups;
}

// ─── Critical Path Analysis ───

/**
 * Finds the critical path through the dependency graph
 * (the longest path that determines minimum execution time)
 */
function findCriticalPath(graph: DependencyGraph): string[] {
  if (graph.nodes.size === 0) return [];
  
  // Start from leaves and work backwards
  const path: string[] = [];
  let current: string | null = null;
  
  // Find the leaf with the highest depth
  for (const leafId of graph.leaves) {
    const leafNode = graph.nodes.get(leafId)!;
    if (current === null) {
      current = leafId;
    } else {
      const currentNode = graph.nodes.get(current);
      if (currentNode && leafNode.depth > currentNode.depth) {
        current = leafId;
      }
    }
  }
  
  if (!current) return [];
  
  // Trace back through the deepest dependencies
  while (current) {
    path.unshift(current);
    const currentNode = graph.nodes.get(current);
    
    if (!currentNode) break;
    
    // Find the dependency with the highest depth
    let nextDep: string | null = null;
    let maxDepth = -1;
    
    for (const depId of currentNode.dependencies) {
      const depNode = graph.nodes.get(depId);
      if (depNode && depNode.depth > maxDepth) {
        maxDepth = depNode.depth;
        nextDep = depId;
      }
    }
    
    current = nextDep;
  }
  
  return path;
}

// ─── Duration Estimation ───

/**
 * Estimates duration for a single step based on its action type
 */
function estimateStepDuration(step: AgentStep): number {
  const baseDurations: Record<string, number> = {
    // Browser actions
    'scroll': 500,
    'click': 300,
    'type': 500,
    'wait': (step.params.duration as number) || 1000,
    'read_page': 2000,
    'analyze_page': 5000,
    'search': 2000,
    'open_tab': 1500,
    'close_tab': 200,
    'switch_tab': 300,
    
    // Memory actions
    'store': 500,
    'retrieve': 800,
    
    // Summarizer actions
    'summarize': 3000,
    'bullets': 2000,
    
    // Config actions
    'get_walkthrough': 8000,
  };
  
  return baseDurations[step.action] || 2000;
}

/**
 * Estimates total duration for a group of steps
 * (returns the max since they run in parallel)
 */
function estimateGroupDuration(steps: AgentStep[]): number {
  if (steps.length === 0) return 0;
  return Math.max(...steps.map(estimateStepDuration));
}

/**
 * Estimates total execution duration
 * (sum of group durations since groups run sequentially)
 */
function estimateTotalDuration(groups: ExecutionGroup[]): number {
  return groups.reduce((sum, group) => sum + (group.estimatedDuration || 0), 0);
}

// ─── Utility Functions ───

/**
 * Validates that a plan has no circular dependencies
 */
export function validatePlan(steps: AgentStep[]): { valid: boolean; error?: string } {
  const stepIds = new Set(steps.map(s => s.id));
  
  // Check for missing dependencies
  for (const step of steps) {
    if (step.dependsOn) {
      const deps = Array.isArray(step.dependsOn) ? step.dependsOn : [step.dependsOn];
      for (const depId of deps) {
        if (!stepIds.has(depId)) {
          return { 
            valid: false, 
            error: `Step "${step.id}" depends on non-existent step "${depId}"` 
          };
        }
      }
    }
  }
  
  // Check for circular dependencies using DFS
  const visited = new Set<string>();
  const recursionStack = new Set<string>();
  
  function hasCycle(stepId: string, stepMap: Map<string, AgentStep>): boolean {
    if (recursionStack.has(stepId)) return true;
    if (visited.has(stepId)) return false;
    
    visited.add(stepId);
    recursionStack.add(stepId);
    
    const step = stepMap.get(stepId);
    if (step?.dependsOn) {
      const deps = Array.isArray(step.dependsOn) ? step.dependsOn : [step.dependsOn];
      for (const depId of deps) {
        if (hasCycle(depId, stepMap)) return true;
      }
    }
    
    recursionStack.delete(stepId);
    return false;
  }
  
  const stepMap = new Map(steps.map(s => [s.id, s]));
  
  for (const step of steps) {
    if (hasCycle(step.id, stepMap)) {
      return { valid: false, error: 'Circular dependency detected in plan' };
    }
  }
  
  return { valid: true };
}

/**
 * Gets the execution order as a flat array (for debugging)
 */
export function getExecutionOrder(groups: ExecutionGroup[]): string[][] {
  return groups.map(group => group.steps.map(s => s.id));
}

export default {
  analyzePlan,
  validatePlan,
  getExecutionOrder,
};
