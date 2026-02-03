import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { estimateTokens } from "@mariozechner/pi-coding-agent";
import { DEFAULT_CONTEXT_TOKENS } from "./defaults.js";

/**
 * Token budget allocation for a single API call.
 */
export interface ContextBudget {
  /** Total model context window (tokens). */
  total: number;
  /** Reserved for system prompt (tokens). */
  systemPrompt: number;
  /** Reserved for bootstrap files (tokens). */
  bootstrap: number;
  /** Reserved for conversation history (tokens). */
  history: number;
  /** Reserved for model response (tokens). */
  response: number;
  /** Unallocated reserve (tokens). */
  reserve: number;
}

/**
 * Configuration for context budget allocation ratios.
 * All ratios should sum to <= 1.0.
 */
export interface ContextBudgetConfig {
  /** Ratio of context window for system prompt (default: 0.15). */
  systemPromptRatio: number;
  /** Ratio of context window for bootstrap files (default: 0.10). */
  bootstrapRatio: number;
  /** Ratio of context window for conversation history (default: 0.45). */
  historyRatio: number;
  /** Ratio of context window for model response (default: 0.20). */
  responseRatio: number;
  /** Minimum tokens reserved for response (default: 4096). */
  minResponseTokens: number;
}

/**
 * Default budget configuration values.
 */
export const DEFAULT_CONTEXT_BUDGET_CONFIG: ContextBudgetConfig = {
  systemPromptRatio: 0.15,
  bootstrapRatio: 0.1,
  historyRatio: 0.45,
  responseRatio: 0.2,
  minResponseTokens: 4096,
};

/**
 * Manages token budget allocation for context management.
 *
 * The budget system ensures that each API call stays within the model's
 * context window by allocating portions to:
 * - System prompt (instructions, tool definitions, etc.)
 * - Bootstrap files (SOUL.md, MEMORY.md, etc.)
 * - Conversation history (past messages)
 * - Response (model output + tool results)
 */
export class ContextBudgetManager {
  private config: ContextBudgetConfig;

  constructor(config?: Partial<ContextBudgetConfig>) {
    this.config = { ...DEFAULT_CONTEXT_BUDGET_CONFIG, ...config };
  }

  /**
   * Compute the full budget allocation for a given context window.
   */
  computeBudget(contextWindow: number): ContextBudget {
    const total = Math.max(1, Math.floor(contextWindow));

    // Calculate base allocations from ratios
    let systemPrompt = Math.floor(total * this.config.systemPromptRatio);
    let bootstrap = Math.floor(total * this.config.bootstrapRatio);
    let history = Math.floor(total * this.config.historyRatio);
    let response = Math.floor(total * this.config.responseRatio);

    // Ensure minimum response tokens
    if (response < this.config.minResponseTokens) {
      const deficit = this.config.minResponseTokens - response;
      response = this.config.minResponseTokens;
      // Reduce history to compensate (it's the most flexible)
      history = Math.max(0, history - deficit);
    }

    // Calculate reserve (unallocated tokens)
    const allocated = systemPrompt + bootstrap + history + response;
    const reserve = Math.max(0, total - allocated);

    return {
      total,
      systemPrompt,
      bootstrap,
      history,
      response,
      reserve,
    };
  }

  /**
   * Compute the remaining history budget after accounting for actual
   * system prompt and bootstrap usage.
   *
   * This is called after the system prompt and bootstrap files are built,
   * allowing dynamic reallocation of unused budget to history.
   */
  computeHistoryBudget(used: {
    systemPrompt: number;
    bootstrap: number;
    contextWindow?: number;
  }): number {
    const contextWindow = used.contextWindow ?? DEFAULT_CONTEXT_TOKENS;
    const budget = this.computeBudget(contextWindow);

    // Calculate how much was actually used vs budgeted
    const systemPromptDelta = budget.systemPrompt - used.systemPrompt;
    const bootstrapDelta = budget.bootstrap - used.bootstrap;

    // Reclaim unused budget for history
    const reclaimable = Math.max(0, systemPromptDelta) + Math.max(0, bootstrapDelta);

    // Final history budget = base + reclaimed + reserve
    return budget.history + reclaimable + budget.reserve;
  }

  /**
   * Validate that a proposed context fits within the model's window.
   * Returns the overflow amount (0 if fits).
   */
  validateContextFits(params: {
    systemPromptTokens: number;
    bootstrapTokens: number;
    historyTokens: number;
    contextWindow?: number;
  }): { fits: boolean; overflow: number; budget: ContextBudget } {
    const contextWindow = params.contextWindow ?? DEFAULT_CONTEXT_TOKENS;
    const budget = this.computeBudget(contextWindow);

    const totalUsed =
      params.systemPromptTokens + params.bootstrapTokens + params.historyTokens + budget.response;

    const overflow = Math.max(0, totalUsed - budget.total);

    return {
      fits: overflow === 0,
      overflow,
      budget,
    };
  }

  /**
   * Get the current configuration.
   */
  getConfig(): Readonly<ContextBudgetConfig> {
    return this.config;
  }
}

/**
 * Estimate token count for a single message.
 * Re-exported from pi-coding-agent for convenience.
 */
export function estimateMessageTokens(message: AgentMessage): number {
  return estimateTokens(message);
}

/**
 * Estimate total tokens for an array of messages.
 */
export function estimateMessagesTokens(messages: AgentMessage[]): number {
  return messages.reduce((sum, msg) => sum + estimateTokens(msg), 0);
}

/**
 * Estimate tokens for a text string using the standard 4 chars/token heuristic.
 */
export function estimateTextTokens(text: string): number {
  // Standard heuristic: ~4 characters per token
  return Math.ceil(text.length / 4);
}

/**
 * Create a budget manager from OpenClaw config.
 */
export function createBudgetManagerFromConfig(
  contextManagement?: {
    budget?: {
      systemPromptRatio?: number;
      bootstrapRatio?: number;
      historyRatio?: number;
      responseRatio?: number;
      minResponseTokens?: number;
    };
  } | null,
): ContextBudgetManager {
  if (!contextManagement?.budget) {
    return new ContextBudgetManager();
  }

  const budget = contextManagement.budget;
  // Only include defined values to allow defaults to apply
  const config: Partial<ContextBudgetConfig> = {};
  if (budget.systemPromptRatio !== undefined) {
    config.systemPromptRatio = budget.systemPromptRatio;
  }
  if (budget.bootstrapRatio !== undefined) {
    config.bootstrapRatio = budget.bootstrapRatio;
  }
  if (budget.historyRatio !== undefined) {
    config.historyRatio = budget.historyRatio;
  }
  if (budget.responseRatio !== undefined) {
    config.responseRatio = budget.responseRatio;
  }
  if (budget.minResponseTokens !== undefined) {
    config.minResponseTokens = budget.minResponseTokens;
  }
  return new ContextBudgetManager(config);
}
