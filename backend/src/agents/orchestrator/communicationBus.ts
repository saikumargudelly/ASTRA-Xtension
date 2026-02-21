// ─── Communication Bus ───
// Enables agent-to-agent communication via message passing and event broadcasting

import type { AgentMessage, MessageHandler, OrchestratorEvent } from './types.js';

// ─── Communication Bus Class ───

export class CommunicationBus {
  private handlers: Map<string, Set<MessageHandler>> = new Map();
  private eventListeners: Set<(event: OrchestratorEvent) => void> = new Set();
  private messageHistory: AgentMessage[] = [];
  private maxHistorySize: number = 100;
  
  // ─── Message Handling ───
  
  /**
   * Subscribe an agent to receive messages
   */
  subscribe(agent: string, handler: MessageHandler): () => void {
    if (!this.handlers.has(agent)) {
      this.handlers.set(agent, new Set());
    }
    this.handlers.get(agent)!.add(handler);
    
    // Return unsubscribe function
    return () => {
      this.handlers.get(agent)?.delete(handler);
    };
  }
  
  /**
   * Send a message to a specific agent or broadcast
   */
  async send(message: AgentMessage): Promise<void> {
    // Store in history
    this.messageHistory.push(message);
    if (this.messageHistory.length > this.maxHistorySize) {
      this.messageHistory.shift();
    }
    
    if (message.to === 'broadcast') {
      // Broadcast to all agents except sender
      await this.broadcast(message);
    } else if (message.to === 'orchestrator') {
      // Send to orchestrator event listeners
      this.emitOrchestratorEvent(message);
    } else {
      // Send to specific agent
      await this.deliver(message);
    }
  }
  
  /**
   * Deliver a message to a specific agent
   */
  private async deliver(message: AgentMessage): Promise<void> {
    const handlers = this.handlers.get(message.to);
    if (!handlers || handlers.size === 0) {
      console.warn(`[CommunicationBus] No handlers for agent: ${message.to}`);
      return;
    }
    
    for (const handler of handlers) {
      try {
        await handler(message);
      } catch (err) {
        console.error(`[CommunicationBus] Handler error for ${message.to}:`, err);
      }
    }
  }
  
  /**
   * Broadcast a message to all agents except sender
   */
  private async broadcast(message: AgentMessage): Promise<void> {
    for (const [agent, handlers] of this.handlers) {
      if (agent === message.from) continue; // Don't send to self
      
      for (const handler of handlers) {
        try {
          await handler(message);
        } catch (err) {
          console.error(`[CommunicationBus] Broadcast handler error for ${agent}:`, err);
        }
      }
    }
  }
  
  /**
   * Emit an orchestrator event from a message
   */
  private emitOrchestratorEvent(message: AgentMessage): void {
    for (const listener of this.eventListeners) {
      try {
        listener({ type: 'agent_message', message });
      } catch (err) {
        console.error('[CommunicationBus] Event listener error:', err);
      }
    }
  }
  
  // ─── Event Handling ───
  
  /**
   * Subscribe to orchestrator events
   */
  subscribeToEvents(listener: (event: OrchestratorEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }
  
  // ─── Request/Response Pattern ───
  
  /**
   * Send a request and wait for a response
   */
  async request<T = unknown>(
    from: string,
    to: string,
    payload: unknown,
    timeout: number = 30000,
  ): Promise<T> {
    const correlationId = `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Request timeout: no response from ${to}`));
      }, timeout);
      
      // Subscribe for response
      const unsubscribe = this.subscribe(from, async (message) => {
        if (message.correlationId === correlationId && message.type === 'response') {
          clearTimeout(timer);
          unsubscribe();
          resolve(message.payload as T);
        }
      });
      
      // Send request
      this.send({
        id: `msg_${Date.now()}`,
        from,
        to,
        type: 'request',
        payload,
        correlationId,
        timestamp: Date.now(),
      });
    });
  }
  
  /**
   * Respond to a request
   */
  async respond(
    from: string,
    originalMessage: AgentMessage,
    payload: unknown,
  ): Promise<void> {
    await this.send({
      id: `msg_${Date.now()}`,
      from,
      to: originalMessage.from,
      type: 'response',
      payload,
      correlationId: originalMessage.correlationId,
      timestamp: Date.now(),
    });
  }
  
  // ─── Utility Methods ───
  
  /**
   * Get message history for an agent
   */
  getHistory(agent?: string): AgentMessage[] {
    if (!agent) return [...this.messageHistory];
    return this.messageHistory.filter(m => m.from === agent || m.to === agent);
  }
  
  /**
   * Clear message history
   */
  clearHistory(): void {
    this.messageHistory = [];
  }
  
  /**
   * Get statistics about the bus
   */
  getStats(): {
    registeredAgents: number;
    totalHandlers: number;
    messagesInHistory: number;
    eventListeners: number;
  } {
    let totalHandlers = 0;
    for (const handlers of this.handlers.values()) {
      totalHandlers += handlers.size;
    }
    
    return {
      registeredAgents: this.handlers.size,
      totalHandlers,
      messagesInHistory: this.messageHistory.length,
      eventListeners: this.eventListeners.size,
    };
  }
}

// ─── Singleton Instance ───

let busInstance: CommunicationBus | null = null;

/**
 * Get the singleton communication bus instance
 */
export function getCommunicationBus(): CommunicationBus {
  if (!busInstance) {
    busInstance = new CommunicationBus();
  }
  return busInstance;
}

/**
 * Reset the bus (for testing)
 */
export function resetBus(): void {
  busInstance = null;
}

// ─── Helper Functions ───

/**
 * Create a message
 */
export function createMessage(
  from: string,
  to: string | 'broadcast' | 'orchestrator',
  type: AgentMessage['type'],
  payload: unknown,
  correlationId?: string,
): AgentMessage {
  return {
    id: `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    from,
    to,
    type,
    payload,
    correlationId,
    timestamp: Date.now(),
  };
}

/**
 * Create an event message
 */
export function createEvent(
  from: string,
  event: string,
  data: unknown,
): AgentMessage {
  return createMessage(from, 'broadcast', 'event', { event, data });
}

export default getCommunicationBus;
