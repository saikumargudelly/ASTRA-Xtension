# ASTRA Orchestrator Agent Architecture Design

## Executive Summary

This document outlines the architecture for implementing an **Orchestrator Agent** in ASTRA to enable:
- Centralized agent coordination
- Parallel execution of independent steps
- Agent-to-agent communication
- Dynamic re-planning and error recovery
- Result aggregation and streaming

---

## Current Architecture Analysis

### Existing Agent Inventory

| Agent | Role | Status |
|-------|------|--------|
| **Planner** | Creates step-by-step execution plans from user intent | ✅ Active |
| **Browser** | Executes browser actions: scroll, click, type, search, analyze_page | ✅ Active |
| **Analyzer** | Analyzes page content, ranks search results, matches filters | ✅ Active |
| **Memory** | Stores and retrieves information using SQLite + ChromaDB | ✅ Active |
| **Summarizer** | Summarizes text content into concise formats | ✅ Active |
| **Vision** | Analyzes screenshots for screen state and UI elements | ✅ Active |
| **Config** | Handles configuration queries and generates walkthroughs | ⚠️ Not integrated in execute flow |
| **Guide Extractor** | Extracts step-by-step guides from web content | 🔧 Sub-agent of Config |
| **Walkthrough Generator** | Creates interactive walkthroughs from guides | 🔧 Sub-agent of Config |

### Current Flow

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Extension  │────►│   /intent    │────►│   Planner    │
└──────────────┘     └──────────────┘     └──────────────┘
                            │                     │
                            │                     ▼
                            │              ┌──────────────┐
                            │              │  StepPlan    │
                            │              └──────────────┘
                            │                     │
                            ▼                     ▼
                     ┌──────────────┐     ┌──────────────┐
                     │   /execute   │────►│  Sequential  │
                     └──────────────┘     │  Execution   │
                                          └──────────────┘
                                                 │
                    ┌────────────────────────────┼────────────────────────────┐
                    ▼                            ▼                            ▼
             ┌──────────────┐             ┌──────────────┐             ┌──────────────┐
             │   Browser    │             │  Summarizer  │             │    Memory    │
             │    Agent     │             │    Agent     │             │    Agent     │
             └──────────────┘             └──────────────┘             └──────────────┘
```

### Problems Identified

1. **No Orchestrator**: Steps are executed sequentially in `/execute` route without coordination
2. **Missing Config Agent**: Config agent is defined in types but not handled in execute switch
3. **No Parallel Execution**: Independent steps must wait for previous steps to complete
4. **No Agent Communication**: Agents cannot share results or request help from each other
5. **No Dynamic Re-planning**: If a step fails, the system cannot adapt
6. **No Result Aggregation**: Results from multiple agents are not combined intelligently

---

## Proposed Architecture

### Orchestrator Agent Design

The Orchestrator Agent will serve as the central coordinator for all agent activities.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           ORCHESTRATOR AGENT                                     │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐ │
│  │ Plan Analyzer  │  │ Execution      │  │ Communication  │  │ Result         │ │
│  │                │  │ Engine         │  │ Bus            │  │ Aggregator     │ │
│  └────────────────┘  └────────────────┘  └────────────────┘  └────────────────┘ │
│           │                   │                   │                   │          │
│           └───────────────────┴───────────────────┴───────────────────┘          │
│                                      │                                           │
│                        ┌─────────────┴─────────────┐                            │
│                        │    Agent Registry         │                            │
│                        └─────────────┬─────────────┘                            │
│                                      │                                           │
└──────────────────────────────────────┼───────────────────────────────────────────┘
                                       │
        ┌──────────────────────────────┼──────────────────────────────┐
        │                              │                              │
        ▼                              ▼                              ▼
┌───────────────┐              ┌───────────────┐              ┌───────────────┐
│  Browser      │              │  Analyzer     │              │  Memory       │
│  Agent        │              │  Agent        │              │  Agent        │
└───────────────┘              └───────────────┘              └───────────────┘
        │                              │                              │
        ▼                              ▼                              ▼
┌───────────────┐              ┌───────────────┐              ┌───────────────┐
│  Summarizer   │              │  Vision       │              │  Config       │
│  Agent        │              │  Agent        │              │  Agent        │
└───────────────┘              └───────────────┘              └───────────────┘
```

### Core Components

#### 1. Plan Analyzer

Analyzes the StepPlan to determine:
- Step dependencies using DAG analysis
- Parallel execution opportunities
- Critical path identification
- Resource requirements

```typescript
interface PlanAnalysis {
  executionGroups: ExecutionGroup[];  // Groups of steps that can run in parallel
  criticalPath: string[];             // Sequence of steps on critical path
  estimatedDuration: number;          // Total estimated duration in ms
  parallelismLevel: number;           // Max concurrent steps possible
}

interface ExecutionGroup {
  groupId: string;
  steps: AgentStep[];
  canRunInParallel: boolean;
  dependsOnGroups: string[];
}
```

#### 2. Execution Engine

Manages the actual execution of steps:
- Executes steps in parallel when possible
- Handles timeouts and retries
- Manages execution context
- Tracks progress

```typescript
interface ExecutionContext {
  sessionId: string;
  userId?: string;
  startTime: number;
  completedSteps: Map<string, StepResult>;
  failedSteps: Map<string, Error>;
  activeSteps: Set<string>;
}

interface ExecutionOptions {
  maxConcurrency: number;        // Default: 3
  timeout: number;               // Default: 30000ms
  retryCount: number;            // Default: 2
  retryDelay: number;            // Default: 1000ms
  enableStreaming: boolean;      // Default: true
}
```

#### 3. Communication Bus

Enables agent-to-agent communication:
- Message passing between agents
- Event broadcasting
- Result sharing
- Request/response patterns

```typescript
interface AgentMessage {
  id: string;
  from: string;              // Agent name
  to: string | 'broadcast';  // Target agent or broadcast
  type: 'request' | 'response' | 'event' | 'error';
  payload: unknown;
  correlationId?: string;    // For request/response matching
  timestamp: number;
}

interface CommunicationBus {
  send(message: AgentMessage): Promise<void>;
  subscribe(agent: string, handler: MessageHandler): void;
  broadcast(event: string, data: unknown): void;
}
```

#### 4. Result Aggregator

Combines results from multiple agents:
- Merges partial results
- Resolves conflicts
- Formats final output
- Generates summaries

```typescript
interface AggregatedResult {
  success: boolean;
  summary: string;
  data: Record<string, unknown>;
  stepResults: Map<string, StepResult>;
  artifacts: ResultArtifact[];
  duration: number;
}

interface ResultArtifact {
  type: 'summary' | 'ranked_list' | 'walkthrough' | 'memory' | 'screenshot';
  content: unknown;
  sourceAgent: string;
}
```

#### 5. Agent Registry

Central registry for all agents:
- Agent discovery
- Capability mapping
- Health monitoring
- Load balancing

```typescript
interface AgentRegistry {
  agents: Map<string, AgentInfo>;
  capabilities: Map<string, string[]>;  // capability -> agent names
}

interface AgentInfo {
  name: string;
  actions: string[];
  status: 'idle' | 'busy' | 'error';
  lastActivity: number;
  metrics: AgentMetrics;
}
```

---

## Execution Flow

### Step 1: Plan Reception

```
Extension ──► /orchestrate ──► Orchestrator.receivePlan(plan)
                                        │
                                        ▼
                                 ┌──────────────┐
                                 │ Plan Analyzer│
                                 └──────────────┘
                                        │
                                        ▼
                              Execution Groups Created
```

### Step 2: Parallel Execution

```
┌─────────────────────────────────────────────────────────────────┐
│                      EXECUTION ENGINE                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Group 1: [search] ─────────────────────────────► Browser Agent │
│                                                                 │
│  Group 2: [wait] ───────────────────────────────► Browser Agent │
│           (depends on Group 1)                                  │
│                                                                 │
│  Group 3: [analyze_page] ───────────────────────► Analyzer      │
│           [store_memory] ───────────────────────► Memory        │
│           (parallel execution, both depend on Group 2)          │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Step 3: Result Aggregation

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Analyzer   │────►│   Result     │◄────│    Memory    │
│   Result     │     │  Aggregator  │     │    Result    │
└──────────────┘     └──────────────┘     └──────────────┘
                            │
                            ▼
                     ┌──────────────┐
                     │  Aggregated  │
                     │   Result     │
                     └──────────────┘
                            │
                            ▼
                     ┌──────────────┐
                     │  Extension   │
                     └──────────────┘
```

---

## Agent Communication Patterns

### Pattern 1: Request/Response

```
┌──────────────┐                      ┌──────────────┐
│   Analyzer   │───request───────────►│    Vision    │
│    Agent     │                      │    Agent     │
│              │◄──response───────────│              │
└──────────────┘                      └──────────────┘

Example: Analyzer needs visual context
{
  from: 'analyzer',
  to: 'vision',
  type: 'request',
  payload: { action: 'analyze_screenshot', screenshot: 'base64...' }
}
```

### Pattern 2: Event Broadcasting

```
┌──────────────┐                      ┌──────────────┐
│   Browser    │───event──────────────►│ Orchestrator │
│    Agent     │      page_loaded      │              │
└──────────────┘                       └──────────────┘
        │                                      │
        │                              broadcast│
        │                                      ▼
        │                              ┌──────────────┐
        │                              │   Analyzer   │
        │                              │    Agent     │
        │                              └──────────────┘
        │                                      │
        │                                      ▼
        │                              ┌──────────────┐
        │                              │    Memory    │
        │                              │    Agent     │
        │                              └──────────────┘
```

### Pattern 3: Collaborative Problem Solving

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Planner    │────►│ Orchestrator │────►│   Browser    │
│    Agent     │     │              │     │    Agent     │
└──────────────┘     │              │     └──────────────┘
                     │              │
                     │    re-plan   │     ┌──────────────┐
                     │◄──on error───┼────►│   Analyzer   │
                     │              │     │    Agent     │
                     │              │     └──────────────┘
                     ▼              │
              ┌──────────────┐      │
              │  New Plan    │      │
              │  Generated   │      │
              └──────────────┘      │
                     │              │
                     └──────────────┘
```

---

## New API Endpoints

### POST /orchestrate

Main orchestration endpoint replacing `/execute`.

```typescript
// Request
interface OrchestrateRequest {
  plan: StepPlan;
  prompt: string;
  options?: ExecutionOptions;
  context?: {
    sessionId?: string;
    url?: string;
    title?: string;
    screenshot?: string;
  };
}

// Response
interface OrchestrateResponse {
  success: boolean;
  executionId: string;
  summary: string;
  data: unknown;
  steps: StepResult[];
  artifacts: ResultArtifact[];
  duration: number;
}
```

### GET /orchestrate/:id/status

Check execution status for long-running operations.

```typescript
interface ExecutionStatus {
  executionId: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  progress: {
    total: number;
    completed: number;
    failed: number;
    current: string;  // Current step description
  };
  results?: StepResult[];
  estimatedTimeRemaining?: number;
}
```

### WebSocket /orchestrate/:id/stream

Real-time streaming of execution progress.

```typescript
interface StreamEvent {
  type: 'step_start' | 'step_complete' | 'step_error' | 'execution_complete';
  timestamp: number;
  data: {
    stepId?: string;
    agent?: string;
    action?: string;
    result?: StepResult;
    error?: string;
  };
}
```

---

## Implementation Plan

### Phase 1: Core Orchestrator

1. Create `backend/src/agents/orchestrator.ts`
2. Implement Plan Analyzer with DAG-based dependency resolution
3. Implement Execution Engine with parallel execution
4. Create Agent Registry

### Phase 2: Communication Bus

1. Create `backend/src/agents/communication.ts`
2. Implement message passing
3. Add event broadcasting
4. Create agent subscription system

### Phase 3: Result Aggregation

1. Create `backend/src/agents/aggregator.ts`
2. Implement result merging logic
3. Add artifact generation
4. Create summary generation

### Phase 4: API Integration

1. Create `backend/src/routes/orchestrate.ts`
2. Add WebSocket support for streaming
3. Update extension to use new endpoints
4. Add execution status endpoint

### Phase 5: Error Recovery

1. Implement retry logic
2. Add dynamic re-planning
3. Create fallback strategies
4. Add timeout handling

---

## File Structure

```
backend/src/
├── agents/
│   ├── orchestrator/
│   │   ├── index.ts              # Main orchestrator entry point
│   │   ├── planAnalyzer.ts       # DAG analysis and grouping
│   │   ├── executionEngine.ts    # Parallel execution
│   │   ├── agentRegistry.ts      # Agent discovery and health
│   │   └── types.ts              # Orchestrator-specific types
│   ├── communication/
│   │   ├── bus.ts                # Message bus implementation
│   │   ├── messages.ts           # Message types
│   │   └── events.ts             # Event definitions
│   ├── aggregator/
│   │   ├── index.ts              # Result aggregation
│   │   └── formatters.ts         # Output formatters
│   ├── analyzer.ts               # Existing
│   ├── browser.ts                # Existing
│   ├── config.ts                 # Existing (needs integration)
│   ├── guideExtractor.ts         # Existing
│   ├── memory.ts                 # Existing
│   ├── planner.ts                # Existing
│   ├── summarizer.ts             # Existing
│   ├── vision.ts                 # Existing
│   └── walkthroughGenerator.ts   # Existing
├── routes/
│   ├── orchestrate.ts            # NEW: Main orchestration route
│   └── ...                       # Existing routes
└── types/
    └── index.ts                  # Updated with new types
```

---

## Performance Improvements

| Metric | Current | With Orchestrator | Improvement |
|--------|---------|-------------------|-------------|
| Sequential execution | 3 steps = 3x time | Parallel where possible | ~40-60% faster |
| Error recovery | Fail entire plan | Retry + re-plan | Higher success rate |
| Agent communication | None | Full message bus | New capability |
| Result quality | Last step only | Aggregated from all | Better outputs |
| Streaming | None | Real-time WebSocket | Better UX |

---

## Backward Compatibility

The orchestrator will maintain backward compatibility:

1. `/execute` endpoint remains functional for simple use cases
2. `/orchestrate` is the new recommended endpoint
3. Existing agents require minimal changes
4. Extension can gradually migrate to new API

---

## Questions for Review

1. **Concurrency Level**: Should we limit max parallel steps to 3, or make it configurable?
2. **Streaming Priority**: Should WebSocket streaming be implemented in Phase 1 or Phase 4?
3. **Config Agent**: Should Config agent be a first-class agent or remain a sub-system?
4. **Memory Integration**: Should the Orchestrator automatically store execution history in Memory agent?

---

## Next Steps

After architecture approval:
1. Switch to Code mode
2. Implement Phase 1: Core Orchestrator
3. Add tests for parallel execution
4. Integrate with existing routes
5. Update extension to use new endpoints