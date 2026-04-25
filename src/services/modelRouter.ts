import 'dotenv/config';

export type ModelProvider = 'gemini' | 'groq';

export interface ModelConfig {
  id: string;
  provider: ModelProvider;
  rpm: number;
  rpd: number;
  tpm: number;
}

interface ModelState {
  usageCount: number;
  isRateLimited: boolean;
  lastUsed: number;
}

/**
 * ModelRouter manages the prioritized list of LLMs and handles 
 * automatic fallback when rate limits are encountered.
 */
class ModelRouter {
  // Ordered by preference: Gemini 3 Flash -> Llama 4 Scout -> Llama 3.3 -> Fallbacks
  private readonly REASONING_MODELS: ModelConfig[] = [
    // 1. Primary: Gemini 3 Flash (per user feedback)
    { id: 'gemini-flash-latest', provider: 'gemini', rpm: 5, rpd: 20, tpm: 250000 },

    // 2. High Context Powerhouse: Llama 4 Scout (Groq)
    { id: 'meta-llama/llama-4-scout-17b-16e-instruct', provider: 'groq', rpm: 30, rpd: 1000, tpm: 30000 },

    // 3. Reliable Fallback: Llama 3.3 70B (Groq)
    { id: 'llama-3.3-70b-versatile', provider: 'groq', rpm: 30, rpd: 1000, tpm: 12000 },

    // 4. Stable Gemini fallbacks
    { id: 'gemini-2.0-flash', provider: 'gemini', rpm: 5, rpd: 20, tpm: 250000 },
    { id: 'gemini-1.5-flash', provider: 'gemini', rpm: 15, rpd: 1500, tpm: 250000 },

    // 6. High-volume Groq fallbacks
    { id: 'llama-3.1-8b-instant', provider: 'groq', rpm: 30, rpd: 14400, tpm: 6000 },
    { id: 'allam-2-7b', provider: 'groq', rpm: 30, rpd: 7000, tpm: 6000 },
  ];

  private states: Map<string, ModelState> = new Map();

  constructor() {
    this.REASONING_MODELS.forEach(m => {
      this.states.set(m.id, {
        usageCount: 0,
        isRateLimited: false,
        lastUsed: 0
      });
    });
  }

  /**
   * Returns the next available model that isn't currently rate limited.
   */
  getNextAvailableModel(): ModelConfig | null {
    for (const model of this.REASONING_MODELS) {
      const state = this.states.get(model.id);
      if (state && !state.isRateLimited) {
        return model;
      }
    }
    return null;
  }

  /**
   * Marks a model as rate limited for the remainder of this session.
   */
  markRateLimited(modelId: string) {
    const state = this.states.get(modelId);
    if (state) {
      state.isRateLimited = true;
      console.log(`⚠️  Model Router: [${modelId}] has been blacklisted due to rate limits.`);
    }
  }

  /**
   * Increments usage count for a model.
   */
  recordUsage(modelId: string) {
    const state = this.states.get(modelId);
    if (state) {
      state.usageCount++;
      state.lastUsed = Date.now();
    }
  }

  /**
   * Returns a snapshot of model usage for reporting.
   */
  getUsageSummary() {
    return this.REASONING_MODELS.map(m => ({
      id: m.id,
      provider: m.provider,
      usage: this.states.get(m.id)?.usageCount || 0,
      status: this.states.get(m.id)?.isRateLimited ? 'RATE_LIMITED' : 'AVAILABLE'
    })).filter(m => m.usage > 0 || m.status === 'RATE_LIMITED');
  }

  /**
   * Resets all rate limit flags (useful between audit phases if needed).
   */
  resetRateLimits() {
    this.REASONING_MODELS.forEach(m => {
      const state = this.states.get(m.id);
      if (state) state.isRateLimited = false;
    });
  }
}

export const modelRouter = new ModelRouter();
