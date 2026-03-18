// ─── NEXUS LLM Router ──────────────────────────────────────────────────────────
// Routes tasks to the most appropriate LLM provider based on task type,
// cost constraints, and privacy mode.

export type TaskType =
  | 'planning'
  | 'research'
  | 'critique'
  | 'vision'
  | 'screenshot-analysis'
  | 'code'
  | 'debug'
  | 'test'
  | 'simple-qa'
  | 'lookup'
  | 'format'
  | 'browser'
  | 'summarize'
  | 'composite';

export type LLMProviderName = 'groq' | 'fireworks' | 'anthropic' | 'openai' | 'ollama';

export interface LLMConfig {
  provider: LLMProviderName;
  model: string;
  maxTokens?: number;
  temperature?: number;
}

export interface RouterConstraints {
  privacy?: 'low' | 'medium' | 'high';
  budget?: 'cheap' | 'standard' | 'premium';
  latency?: 'fast' | 'standard';
}

interface RoutingRule {
  taskTypes: TaskType[] | ['*'];
  constraints?: Partial<RouterConstraints>;
  config: LLMConfig;
}

// ─── Resolved Model References ────────────────────────────────────────────────
// All model names are resolved from env at startup — never hardcoded.
// Your stack:  GROQ_MODEL=openai/gpt-oss-120b (text)
//              VISION_MODEL=accounts/fireworks/models/qwen3-vl-30b-a3b-instruct (vision)
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const VISION_MODEL = process.env.VISION_MODEL || 'accounts/fireworks/models/qwen3-vl-30b-a3b-instruct';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.1:8b';

// ─── Routing Table ─────────────────────────────────────────────────────────────
// Primary text model: Groq  → GROQ_MODEL (openai/gpt-oss-120b)
// Vision model:       Fireworks → VISION_MODEL (Qwen-VL)
// Privacy mode:       Ollama → OLLAMA_MODEL
const ROUTING_TABLE: RoutingRule[] = [
  // Privacy mode always wins — route to local Ollama
  {
    taskTypes: ['*'],
    constraints: { privacy: 'high' },
    config: { provider: 'ollama', model: OLLAMA_MODEL, temperature: 0.7 },
  },

  // Vision tasks → Fireworks Qwen-VL (QWEN_API_KEY / FIREWORKS_API_KEY)
  {
    taskTypes: ['vision', 'screenshot-analysis'],
    config: { provider: 'fireworks', model: VISION_MODEL, maxTokens: 2048 },
  },

  // All text tasks → Groq GROQ_MODEL (openai/gpt-oss-120b)
  // One capable model handles planning, research, critique, code, and simple QA.
  {
    taskTypes: ['planning', 'research', 'critique', 'composite', 'code', 'debug', 'test',
                'simple-qa', 'lookup', 'format', 'browser', 'summarize'],
    config: { provider: 'groq', model: GROQ_MODEL, maxTokens: 8192, temperature: 0.3 },
  },
];

// Fallback chain — Groq first, then Fireworks (same key), then optional paid providers
const FALLBACK_CHAIN: LLMProviderName[] = ['groq', 'fireworks', 'anthropic', 'openai', 'ollama'];

// ─── Router ────────────────────────────────────────────────────────────────────
export class LLMRouter {
  private unavailableProviders: Set<LLMProviderName> = new Set();

  route(taskType: TaskType, constraints: RouterConstraints = {}): LLMConfig {
    // Check privacy first
    if (constraints.privacy === 'high') {
      return this.withFallback({
        provider: 'ollama',
        model: process.env.OLLAMA_MODEL || 'llama3.1:8b',
      });
    }

    // Find matching rule
    for (const rule of ROUTING_TABLE) {
      const matchesTask =
        (rule.taskTypes as string[]).includes('*') ||
        (rule.taskTypes as TaskType[]).includes(taskType);

      if (!matchesTask) continue;

      // Check constraint matches
      if (rule.constraints) {
        const { privacy, budget, latency } = rule.constraints;
        if (privacy && privacy !== constraints.privacy) continue;
        if (budget && budget !== constraints.budget) continue;
        if (latency && latency !== constraints.latency) continue;
      }

      // Skip unavailable providers
      if (this.unavailableProviders.has(rule.config.provider)) continue;

      return rule.config;
    }

    // Ultimate fallback: first available in chain
    for (const provider of FALLBACK_CHAIN) {
      if (!this.unavailableProviders.has(provider)) {
        // Prevent vision tasks from falling back to text-only models
        if ((taskType === 'vision' || taskType === 'screenshot-analysis') && 
            ['groq', 'ollama'].includes(provider)) {
            continue;
        }
        return this.getDefaultConfig(provider);
      }
    }

    // Last resort: Groq with configured model — always has a key
    return { provider: 'groq', model: GROQ_MODEL, maxTokens: 8192 };
  }

  markProviderUnavailable(provider: LLMProviderName): void {
    this.unavailableProviders.add(provider);
    console.warn(`[LLMRouter] Provider ${provider} marked unavailable`);
  }

  markProviderAvailable(provider: LLMProviderName): void {
    this.unavailableProviders.delete(provider);
  }

  getAvailableProviders(): LLMProviderName[] {
    return FALLBACK_CHAIN.filter((p) => !this.unavailableProviders.has(p));
  }

  private withFallback(config: LLMConfig): LLMConfig {
    if (this.unavailableProviders.has(config.provider)) {
      for (const provider of FALLBACK_CHAIN) {
        if (!this.unavailableProviders.has(provider)) {
          return this.getDefaultConfig(provider);
        }
      }
    }
    return config;
  }

  private getDefaultConfig(provider: LLMProviderName): LLMConfig {
    switch (provider) {
      case 'groq':      return { provider, model: GROQ_MODEL, maxTokens: 8192 };
      case 'fireworks': return { provider, model: VISION_MODEL, maxTokens: 2048 };
      case 'anthropic': return { provider, model: 'claude-sonnet-4-5', maxTokens: 4096 };
      case 'openai':    return { provider, model: 'gpt-4o', maxTokens: 2048 };
      case 'ollama':    return { provider, model: OLLAMA_MODEL };
      default:          return { provider: 'groq', model: GROQ_MODEL, maxTokens: 8192 };
    }
  }
}

// ─── Singleton ─────────────────────────────────────────────────────────────────
let routerInstance: LLMRouter | null = null;
export function getLLMRouter(): LLMRouter {
  if (!routerInstance) routerInstance = new LLMRouter();
  return routerInstance;
}
