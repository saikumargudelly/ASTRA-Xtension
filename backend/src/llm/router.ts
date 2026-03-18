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

export type LLMProviderName = 'openrouter' | 'groq' | 'fireworks' | 'anthropic' | 'openai' | 'ollama';

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
// All model names resolved from env at startup — never hardcoded here.
const OPENROUTER_MODEL     = process.env.OPENROUTER_MODEL     || 'openrouter/hunter-alpha'; // user-requested default
const GROQ_MODEL           = process.env.GROQ_MODEL           || 'llama-3.3-70b-versatile';
const VISION_MODEL         = process.env.VISION_MODEL         || 'accounts/fireworks/models/qwen3-vl-30b-a3b-instruct';
const FIREWORKS_TEXT_MODEL = process.env.FIREWORKS_TEXT_MODEL || 'accounts/fireworks/models/llama-v3p1-8b-instruct';
const OLLAMA_MODEL         = process.env.OLLAMA_MODEL         || 'llama3.1:8b';

const VISION_TASK_TYPES: TaskType[] = ['vision', 'screenshot-analysis'];

// ─── Routing Table ─────────────────────────────────────────────────────────────
// PRIORITY: OpenRouter for ALL text tasks (most reliable)
// Fireworks for vision only (fast vision model)
// Groq as fallback (free tier but aggressive rate limits)
const ROUTING_TABLE: RoutingRule[] = [
  // Privacy mode always wins — route to local Ollama
  {
    taskTypes: ['*'],
    constraints: { privacy: 'high' },
    config: { provider: 'ollama', model: OLLAMA_MODEL, temperature: 0.7 },
  },

  // Vision tasks → Fireworks Qwen-VL (fast vision model)
  {
    taskTypes: ['vision', 'screenshot-analysis'],
    config: { provider: 'fireworks', model: VISION_MODEL, maxTokens: 2048 },
  },

  // All text tasks → OpenRouter (PRIMARY - most reliable)
  {
    taskTypes: ['planning', 'research', 'critique', 'composite', 'code', 'debug', 'test',
                'simple-qa', 'lookup', 'format', 'browser', 'summarize'],
    config: { provider: 'openrouter', model: OPENROUTER_MODEL, maxTokens: 8192, temperature: 0.3 },
  },

  // Default fallback (only if no more-specific rule matched).
  {
    taskTypes: ['*'],
    config: { provider: 'fireworks', model: FIREWORKS_TEXT_MODEL, maxTokens: 4096, temperature: 0.3 },
  },
];

// Fallback chain — ordered by reliability
// OpenRouter first (most reliable), then Fireworks (fast), then Groq (rate-limited)
const FALLBACK_CHAIN: LLMProviderName[] = ['openrouter', 'fireworks', 'groq', 'anthropic', 'openai', 'ollama'];

// ─── Router ────────────────────────────────────────────────────────────────────
export class LLMRouter {
  // FIX 3: TTL-based cooldown — providers recover automatically after the TTL expires.
  // Replaced permanent Set<provider> with Map<provider, expiry_timestamp>.
  private unavailableUntil: Map<LLMProviderName, number> = new Map();

  private isUnavailable(provider: LLMProviderName): boolean {
    const until = this.unavailableUntil.get(provider);
    if (!until) return false;
    if (Date.now() >= until) {
      // TTL expired — provider is available again
      this.unavailableUntil.delete(provider);
      return false;
    }
    return true;
  }

  route(taskType: TaskType, constraints: RouterConstraints = {}): LLMConfig {
    // Check privacy first
    if (constraints.privacy === 'high') {
      return this.withFallback(
        { provider: 'ollama', model: process.env.OLLAMA_MODEL || 'llama3.1:8b' },
        taskType,
      );
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
      if (this.isUnavailable(rule.config.provider)) continue;

      return rule.config;
    }

    // Ultimate fallback: first available in chain
    for (const provider of FALLBACK_CHAIN) {
      if (this.isUnavailable(provider)) continue;

      if (VISION_TASK_TYPES.includes(taskType) && (provider === 'groq' || provider === 'ollama')) {
        continue;
      }

      return this.getDefaultConfig(provider, taskType);
    }

    // Absolute last resort
    if (VISION_TASK_TYPES.includes(taskType)) {
      return { provider: 'openrouter', model: OPENROUTER_MODEL, maxTokens: 2048 };
    }
    return { provider: 'openrouter', model: OPENROUTER_MODEL, maxTokens: 8192 };
  }

  /**
   * Mark a provider as temporarily unavailable.
   */
  markProviderUnavailable(provider: LLMProviderName, ttlMs = 60_000): void {
    this.unavailableUntil.set(provider, Date.now() + ttlMs);
    console.warn(`[LLMRouter] Provider ${provider} marked unavailable for ${ttlMs / 1000}s`);
  }

  /** Explicitly re-enable a provider before its TTL expires */
  markProviderAvailable(provider: LLMProviderName): void {
    this.unavailableUntil.delete(provider);
    console.log(`[LLMRouter] Provider ${provider} marked available`);
  }

  getAvailableProviders(): LLMProviderName[] {
    return FALLBACK_CHAIN.filter((p) => !this.isUnavailable(p));
  }

  private withFallback(config: LLMConfig, taskType: TaskType): LLMConfig {
    if (this.isUnavailable(config.provider)) {
      for (const provider of FALLBACK_CHAIN) {
        if (!this.isUnavailable(provider)) {
          return this.getDefaultConfig(provider, taskType);
        }
      }
    }
    return config;
  }

  private getDefaultConfig(provider: LLMProviderName, taskType: TaskType = 'simple-qa'): LLMConfig {
    const isVisionTask = VISION_TASK_TYPES.includes(taskType);
    switch (provider) {
      case 'openrouter':
        return { provider, model: OPENROUTER_MODEL, maxTokens: isVisionTask ? 2048 : 8192, temperature: 0.3 };
      case 'groq':
        return { provider, model: GROQ_MODEL, maxTokens: 8192 };
      case 'fireworks':
        // NOTE: Fireworks text models have max_tokens limit of 4096
        return isVisionTask
          ? { provider, model: VISION_MODEL, maxTokens: 2048 }
          : { provider, model: FIREWORKS_TEXT_MODEL, maxTokens: 4096, temperature: 0.3 };
      case 'anthropic':
        return { provider, model: 'claude-sonnet-4-5', maxTokens: 4096 };
      case 'openai':
        return { provider, model: 'gpt-4o', maxTokens: 4096 };
      case 'ollama':
        return { provider, model: OLLAMA_MODEL };
      default:
        return { provider: 'openrouter', model: OPENROUTER_MODEL, maxTokens: 8192 };
    }
  }
}

// ─── Singleton ─────────────────────────────────────────────────────────────────
let routerInstance: LLMRouter | null = null;
export function getLLMRouter(): LLMRouter {
  if (!routerInstance) routerInstance = new LLMRouter();
  return routerInstance;
}
