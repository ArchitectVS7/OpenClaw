import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { estimateMessagesTokens, summarizeInStages } from "./compaction.js";
import { estimateTextTokens } from "./context-budget.js";

/**
 * Configuration for rolling conversation summarization.
 */
export interface RollingSummaryConfig {
  /** Enable rolling summarization (default: false). */
  enabled: boolean;
  /** Number of recent turns to keep verbatim (default: 5). */
  windowSize: number;
  /** Max tokens for the summary text (default: 2000). */
  summaryMaxTokens: number;
  /** Summarize when history exceeds this many tokens (default: 30000). */
  triggerThreshold: number;
}

/**
 * Default rolling summary configuration.
 */
export const DEFAULT_ROLLING_SUMMARY_CONFIG: RollingSummaryConfig = {
  enabled: false,
  windowSize: 5,
  summaryMaxTokens: 2000,
  triggerThreshold: 30_000,
};

/**
 * Result of building context with rolling summarization.
 */
export interface RollingSummaryResult {
  /** Recent messages kept verbatim. */
  recentMessages: AgentMessage[];
  /** Summary of older conversation (empty if not needed). */
  summaryText: string;
  /** Total estimated tokens of the result. */
  totalTokens: number;
  /** Whether summarization was performed. */
  didSummarize: boolean;
  /** Number of messages that were summarized. */
  summarizedMessageCount: number;
}

/**
 * Session file entry for storing rolling summaries.
 */
export interface RollingSummaryEntry {
  type: "summary";
  data: {
    /** The summary text. */
    text: string;
    /** Turn indices covered by this summary (for reference). */
    coversTurns: number[];
    /** Timestamp when summary was created. */
    createdAt: number;
    /** Model used for summarization. */
    model?: string;
    /** Token count of summarized content. */
    originalTokens?: number;
  };
}

const SUMMARY_INSTRUCTIONS =
  "Summarize this conversation, preserving: key decisions made, open questions, " +
  "user preferences discovered, important context mentioned, and any pending tasks or TODOs. " +
  "Be concise but complete.";

/**
 * Handles rolling summarization of conversation history.
 *
 * When conversation history exceeds a token threshold, older messages
 * are summarized while recent messages are kept verbatim. This reduces
 * token usage while preserving context.
 */
export class RollingSummarizer {
  private config: RollingSummaryConfig;

  constructor(config?: Partial<RollingSummaryConfig>) {
    this.config = { ...DEFAULT_ROLLING_SUMMARY_CONFIG, ...config };
  }

  /**
   * Check if summarization should be triggered.
   */
  shouldSummarize(messages: AgentMessage[], budgetTokens?: number): boolean {
    if (!this.config.enabled) {
      return false;
    }

    const totalTokens = estimateMessagesTokens(messages);
    const threshold = budgetTokens
      ? Math.min(this.config.triggerThreshold, budgetTokens * 0.8)
      : this.config.triggerThreshold;

    return totalTokens > threshold;
  }

  /**
   * Build context with summarization if needed.
   *
   * Returns recent messages plus a summary of older conversation,
   * fitting within the specified budget.
   */
  async buildContextWithSummary(params: {
    messages: AgentMessage[];
    budget: number;
    model: NonNullable<ExtensionContext["model"]>;
    apiKey: string;
    signal?: AbortSignal;
    existingSummary?: string;
  }): Promise<RollingSummaryResult> {
    const { messages, budget, model, apiKey, signal, existingSummary } = params;

    // If summarization is disabled or not needed, return all messages
    if (!this.shouldSummarize(messages, budget)) {
      return {
        recentMessages: messages,
        summaryText: existingSummary ?? "",
        totalTokens: estimateMessagesTokens(messages) + estimateTextTokens(existingSummary ?? ""),
        didSummarize: false,
        summarizedMessageCount: 0,
      };
    }

    // Find the split point: keep last N user turns
    const { recentMessages, olderMessages } = this.splitByTurns(messages);

    // If nothing to summarize, return as-is
    if (olderMessages.length === 0) {
      return {
        recentMessages: messages,
        summaryText: existingSummary ?? "",
        totalTokens: estimateMessagesTokens(messages) + estimateTextTokens(existingSummary ?? ""),
        didSummarize: false,
        summarizedMessageCount: 0,
      };
    }

    // Calculate how much budget we have for the summary
    const recentTokens = estimateMessagesTokens(recentMessages);
    const summaryBudget = Math.min(
      this.config.summaryMaxTokens,
      Math.max(500, budget - recentTokens - 1000), // Leave buffer for response
    );

    // Generate summary of older messages
    const abortController = new AbortController();
    const effectiveSignal = signal ?? abortController.signal;

    try {
      const summaryText = await summarizeInStages({
        messages: olderMessages,
        model,
        apiKey,
        signal: effectiveSignal,
        reserveTokens: summaryBudget,
        maxChunkTokens: Math.floor(model.contextWindow * 0.3),
        contextWindow: model.contextWindow,
        customInstructions: SUMMARY_INSTRUCTIONS,
        previousSummary: existingSummary,
      });

      const summaryTokens = estimateTextTokens(summaryText);
      const totalTokens = recentTokens + summaryTokens;

      return {
        recentMessages,
        summaryText,
        totalTokens,
        didSummarize: true,
        summarizedMessageCount: olderMessages.length,
      };
    } catch (error) {
      // On failure, fall back to truncating without summary
      console.warn(
        `Rolling summary failed: ${error instanceof Error ? error.message : String(error)}`,
      );

      return {
        recentMessages,
        summaryText: existingSummary ?? "",
        totalTokens: recentTokens + estimateTextTokens(existingSummary ?? ""),
        didSummarize: false,
        summarizedMessageCount: 0,
      };
    }
  }

  /**
   * Split messages into recent (kept verbatim) and older (to summarize).
   */
  private splitByTurns(messages: AgentMessage[]): {
    recentMessages: AgentMessage[];
    olderMessages: AgentMessage[];
  } {
    if (messages.length === 0) {
      return { recentMessages: [], olderMessages: [] };
    }

    // Count user turns from the end
    let userTurnCount = 0;
    let splitIndex = messages.length;

    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        userTurnCount++;
        if (userTurnCount > this.config.windowSize) {
          // Split at this user message (include it in older)
          splitIndex = i + 1;
          break;
        }
        splitIndex = i;
      }
    }

    // Handle edge case: if we haven't found enough turns
    if (splitIndex <= 0) {
      return { recentMessages: messages, olderMessages: [] };
    }

    return {
      recentMessages: messages.slice(splitIndex),
      olderMessages: messages.slice(0, splitIndex),
    };
  }

  /**
   * Create a summary entry for session file storage.
   */
  createSummaryEntry(params: {
    text: string;
    coversTurns: number[];
    model?: string;
    originalTokens?: number;
  }): RollingSummaryEntry {
    return {
      type: "summary",
      data: {
        text: params.text,
        coversTurns: params.coversTurns,
        createdAt: Date.now(),
        model: params.model,
        originalTokens: params.originalTokens,
      },
    };
  }

  /**
   * Format summary for injection into conversation context.
   */
  formatSummaryForContext(summaryText: string): string {
    if (!summaryText.trim()) {
      return "";
    }

    return `<prior-conversation-summary>
${summaryText}
</prior-conversation-summary>`;
  }

  /**
   * Get the current configuration.
   */
  getConfig(): Readonly<RollingSummaryConfig> {
    return this.config;
  }
}

/**
 * Create a rolling summarizer from OpenClaw config.
 */
export function createRollingSummarizerFromConfig(
  contextManagement?: {
    rollingSummary?: {
      enabled?: boolean;
      windowSize?: number;
      summaryMaxTokens?: number;
      triggerThreshold?: number;
    };
  } | null,
): RollingSummarizer {
  if (!contextManagement?.rollingSummary) {
    return new RollingSummarizer();
  }

  const cfg = contextManagement.rollingSummary;
  // Only include defined values to allow defaults to apply
  const config: Partial<RollingSummaryConfig> = {};
  if (cfg.enabled !== undefined) {
    config.enabled = cfg.enabled;
  }
  if (cfg.windowSize !== undefined) {
    config.windowSize = cfg.windowSize;
  }
  if (cfg.summaryMaxTokens !== undefined) {
    config.summaryMaxTokens = cfg.summaryMaxTokens;
  }
  if (cfg.triggerThreshold !== undefined) {
    config.triggerThreshold = cfg.triggerThreshold;
  }
  return new RollingSummarizer(config);
}
