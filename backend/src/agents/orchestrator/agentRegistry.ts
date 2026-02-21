// ─── Agent Registry ───
// Central registry for all agents with capability mapping and health monitoring

import type { AgentInfo, AgentMetrics, AgentRegistry as IAgentRegistry } from './types.js';

// ─── Agent Definitions ───

/**
 * Static definition of available agents and their capabilities
 */
const AGENT_DEFINITIONS: Record<string, { actions: string[]; description: string }> = {
  browser: {
    actions: ['scroll', 'click', 'type', 'wait', 'read_page', 'analyze_page', 'search', 'open_tab', 'close_tab', 'switch_tab'],
    description: 'Executes browser automation actions',
  },
  analyzer: {
    actions: ['analyze_page', 'analyze_search_results', 'match_filters'],
    description: 'Analyzes page content and search results',
  },
  memory: {
    actions: ['store', 'retrieve'],
    description: 'Stores and retrieves information from memory',
  },
  summarizer: {
    actions: ['summarize', 'bullets'],
    description: 'Summarizes text content',
  },
  config: {
    actions: ['get_walkthrough', 'check_config'],
    description: 'Handles configuration queries and generates walkthroughs',
  },
  vision: {
    actions: ['analyze_screen', 'analyze_results'],
    description: 'Analyzes screenshots for screen state',
  },
  planner: {
    actions: ['plan'],
    description: 'Creates execution plans from user intent',
  },
  guideExtractor: {
    actions: ['extract_guide'],
    description: 'Extracts step-by-step guides from web content',
  },
  walkthroughGenerator: {
    actions: ['generate_walkthrough'],
    description: 'Creates interactive walkthroughs from guides',
  },
};

// ─── Registry Class ───

/**
 * Agent Registry implementation
 */
class AgentRegistryImpl {
  private agents: Map<string, AgentInfo> = new Map();
  private capabilities: Map<string, string[]> = new Map();
  
  constructor() {
    this.initializeAgents();
  }
  
  /**
   * Initialize all agents with default state
   */
  private initializeAgents(): void {
    for (const [name, definition] of Object.entries(AGENT_DEFINITIONS)) {
      this.agents.set(name, {
        name,
        actions: definition.actions,
        status: 'idle',
        lastActivity: Date.now(),
        metrics: {
          totalExecutions: 0,
          successfulExecutions: 0,
          failedExecutions: 0,
          averageDuration: 0,
        },
      });
      
      // Map capabilities to agents
      for (const action of definition.actions) {
        if (!this.capabilities.has(action)) {
          this.capabilities.set(action, []);
        }
        this.capabilities.get(action)!.push(name);
      }
    }
  }
  
  /**
   * Get information about a specific agent
   */
  getAgent(name: string): AgentInfo | undefined {
    return this.agents.get(name);
  }
  
  /**
   * Get all registered agents
   */
  getAllAgents(): AgentInfo[] {
    return Array.from(this.agents.values());
  }
  
  /**
   * Get agents that can perform a specific action
   */
  getAgentsForAction(action: string): string[] {
    return this.capabilities.get(action) || [];
  }
  
  /**
   * Check if an agent exists and can perform an action
   */
  canExecute(agent: string, action: string): boolean {
    const agentInfo = this.agents.get(agent);
    if (!agentInfo) return false;
    return agentInfo.actions.includes(action);
  }
  
  /**
   * Update agent status
   */
  setStatus(agent: string, status: 'idle' | 'busy' | 'error'): void {
    const agentInfo = this.agents.get(agent);
    if (agentInfo) {
      agentInfo.status = status;
      agentInfo.lastActivity = Date.now();
    }
  }
  
  /**
   * Record a successful execution
   */
  recordSuccess(agent: string, duration: number): void {
    const agentInfo = this.agents.get(agent);
    if (agentInfo) {
      agentInfo.metrics.totalExecutions++;
      agentInfo.metrics.successfulExecutions++;
      
      // Update average duration using rolling average
      const prevAvg = agentInfo.metrics.averageDuration;
      const count = agentInfo.metrics.totalExecutions;
      agentInfo.metrics.averageDuration = prevAvg + (duration - prevAvg) / count;
      
      agentInfo.status = 'idle';
      agentInfo.lastActivity = Date.now();
    }
  }
  
  /**
   * Record a failed execution
   */
  recordFailure(agent: string, error: string, duration: number): void {
    const agentInfo = this.agents.get(agent);
    if (agentInfo) {
      agentInfo.metrics.totalExecutions++;
      agentInfo.metrics.failedExecutions++;
      agentInfo.metrics.lastError = error;
      agentInfo.metrics.lastErrorTime = Date.now();
      
      // Update average duration
      const prevAvg = agentInfo.metrics.averageDuration;
      const count = agentInfo.metrics.totalExecutions;
      agentInfo.metrics.averageDuration = prevAvg + (duration - prevAvg) / count;
      
      agentInfo.status = 'idle';
      agentInfo.lastActivity = Date.now();
    }
  }
  
  /**
   * Get registry statistics
   */
  getStats(): {
    totalAgents: number;
    idleAgents: number;
    busyAgents: number;
    errorAgents: number;
    totalCapabilities: number;
  } {
    let idle = 0, busy = 0, error = 0;
    
    for (const agent of this.agents.values()) {
      if (agent.status === 'idle') idle++;
      else if (agent.status === 'busy') busy++;
      else if (agent.status === 'error') error++;
    }
    
    return {
      totalAgents: this.agents.size,
      idleAgents: idle,
      busyAgents: busy,
      errorAgents: error,
      totalCapabilities: this.capabilities.size,
    };
  }
  
  /**
   * Get the registry as a plain object (for serialization)
   */
  toObject(): IAgentRegistry {
    return {
      agents: new Map(this.agents),
      capabilities: new Map(this.capabilities),
    };
  }
  
  /**
   * Check health of all agents
   */
  healthCheck(): { healthy: boolean; agents: Record<string, { status: string; lastActivity: number }> } {
    const now = Date.now();
    const agentStatuses: Record<string, { status: string; lastActivity: number }> = {};
    let healthy = true;
    
    for (const [name, info] of this.agents) {
      agentStatuses[name] = {
        status: info.status,
        lastActivity: info.lastActivity,
      };
      
      // Consider unhealthy if error status or no activity for 5 minutes
      if (info.status === 'error' || (now - info.lastActivity) > 300000) {
        healthy = false;
      }
    }
    
    return { healthy, agents: agentStatuses };
  }
}

// ─── Singleton Instance ───

let registryInstance: AgentRegistryImpl | null = null;

/**
 * Get the singleton agent registry instance
 */
export function getAgentRegistry(): AgentRegistryImpl {
  if (!registryInstance) {
    registryInstance = new AgentRegistryImpl();
  }
  return registryInstance;
}

/**
 * Reset the registry (for testing)
 */
export function resetRegistry(): void {
  registryInstance = null;
}

// ─── Exports ───

export { AgentRegistryImpl };
export default getAgentRegistry;
