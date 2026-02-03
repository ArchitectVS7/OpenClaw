import type { MemorySearchResult } from "../memory/manager.js";
import { estimateTextTokens } from "./context-budget.js";

/**
 * Configuration for semantic history retrieval.
 */
export interface SemanticHistoryConfig {
  /** Enable semantic history retrieval (default: false). */
  enabled: boolean;
  /** Maximum number of retrieved chunks (default: 5). */
  maxRetrievedChunks: number;
  /** Minimum relevance score (0-1) to include a result (default: 0.6). */
  minRelevanceScore: number;
}

/**
 * Default semantic history configuration.
 */
export const DEFAULT_SEMANTIC_HISTORY_CONFIG: SemanticHistoryConfig = {
  enabled: false,
  maxRetrievedChunks: 5,
  minRelevanceScore: 0.6,
};

/**
 * A chunk of retrieved historical context.
 */
export interface RetrievedContext {
  /** Source session or file path. */
  path: string;
  /** The retrieved text snippet. */
  snippet: string;
  /** Relevance score (0-1). */
  score: number;
  /** Start line in source file. */
  startLine: number;
  /** End line in source file. */
  endLine: number;
  /** Estimated token count. */
  tokens: number;
}

/**
 * Result of semantic history retrieval.
 */
export interface SemanticHistoryResult {
  /** Retrieved context chunks. */
  contexts: RetrievedContext[];
  /** Total estimated tokens of retrieved context. */
  totalTokens: number;
  /** Whether retrieval was performed. */
  didRetrieve: boolean;
}

/**
 * Interface for memory index search operations.
 * This matches the subset of MemoryIndexManager that we need.
 */
export interface MemorySearchProvider {
  search(query: string, limit?: number): Promise<MemorySearchResult[]>;
}

/**
 * Retrieves relevant historical context using semantic search.
 *
 * This class leverages the existing memory index system to find
 * semantically similar past conversations that may be relevant
 * to the current prompt.
 */
export class SemanticHistoryRetriever {
  private config: SemanticHistoryConfig;

  constructor(config?: Partial<SemanticHistoryConfig>) {
    this.config = { ...DEFAULT_SEMANTIC_HISTORY_CONFIG, ...config };
  }

  /**
   * Retrieve relevant historical context for the current prompt.
   *
   * @param currentPrompt - The current user prompt to find relevant history for
   * @param memorySearch - The memory search provider (usually MemoryIndexManager)
   * @param budgetTokens - Maximum tokens to use for retrieved context
   * @returns Retrieved context chunks fitting within the budget
   */
  async retrieve(
    currentPrompt: string,
    memorySearch: MemorySearchProvider,
    budgetTokens: number,
  ): Promise<SemanticHistoryResult> {
    if (!this.config.enabled) {
      return {
        contexts: [],
        totalTokens: 0,
        didRetrieve: false,
      };
    }

    if (!currentPrompt.trim() || budgetTokens <= 0) {
      return {
        contexts: [],
        totalTokens: 0,
        didRetrieve: false,
      };
    }

    try {
      // Search for relevant context
      const results = await memorySearch.search(
        currentPrompt,
        this.config.maxRetrievedChunks * 2, // Fetch extra to account for filtering
      );

      // Filter by minimum relevance score
      const relevant = results.filter((r) => r.score >= this.config.minRelevanceScore);

      // Convert to RetrievedContext and calculate tokens
      const contexts: RetrievedContext[] = [];
      let totalTokens = 0;

      for (const result of relevant) {
        if (contexts.length >= this.config.maxRetrievedChunks) {
          break;
        }

        const tokens = estimateTextTokens(result.snippet);

        // Check if adding this would exceed budget
        if (totalTokens + tokens > budgetTokens) {
          // Try to fit a truncated version
          const availableTokens = budgetTokens - totalTokens;
          if (availableTokens < 100) {
            // Not worth truncating if less than 100 tokens available
            break;
          }
          // Truncate snippet to fit budget
          const truncatedSnippet = truncateToTokens(result.snippet, availableTokens);
          const truncatedTokens = estimateTextTokens(truncatedSnippet);

          contexts.push({
            path: result.path,
            snippet: truncatedSnippet,
            score: result.score,
            startLine: result.startLine,
            endLine: result.endLine,
            tokens: truncatedTokens,
          });
          totalTokens += truncatedTokens;
          break;
        }

        contexts.push({
          path: result.path,
          snippet: result.snippet,
          score: result.score,
          startLine: result.startLine,
          endLine: result.endLine,
          tokens,
        });
        totalTokens += tokens;
      }

      return {
        contexts,
        totalTokens,
        didRetrieve: true,
      };
    } catch (error) {
      console.warn(
        `Semantic history retrieval failed: ${error instanceof Error ? error.message : String(error)}`,
      );

      return {
        contexts: [],
        totalTokens: 0,
        didRetrieve: false,
      };
    }
  }

  /**
   * Format retrieved contexts for injection into the conversation.
   */
  formatContextsForInjection(contexts: RetrievedContext[]): string {
    if (contexts.length === 0) {
      return "";
    }

    const lines = ["<relevant-prior-context>"];

    for (const ctx of contexts) {
      lines.push(`<context source="${ctx.path}" score="${ctx.score.toFixed(2)}">`);
      lines.push(ctx.snippet);
      lines.push("</context>");
    }

    lines.push("</relevant-prior-context>");

    return lines.join("\n");
  }

  /**
   * Get the current configuration.
   */
  getConfig(): Readonly<SemanticHistoryConfig> {
    return this.config;
  }
}

/**
 * Truncate text to approximately fit within a token budget.
 */
function truncateToTokens(text: string, maxTokens: number): string {
  // Approximate: 4 chars per token
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) {
    return text;
  }

  // Try to truncate at a sentence or word boundary
  const truncated = text.slice(0, maxChars);
  const lastPeriod = truncated.lastIndexOf(".");
  const lastNewline = truncated.lastIndexOf("\n");
  const lastSpace = truncated.lastIndexOf(" ");

  // Prefer period, then newline, then space
  const breakPoint = Math.max(lastPeriod, lastNewline, lastSpace);
  if (breakPoint > maxChars * 0.5) {
    return truncated.slice(0, breakPoint + 1) + "...";
  }

  return truncated + "...";
}

/**
 * Create a semantic history retriever from OpenClaw config.
 */
export function createSemanticHistoryRetrieverFromConfig(
  contextManagement?: {
    semanticHistory?: {
      enabled?: boolean;
      maxRetrievedChunks?: number;
      minRelevanceScore?: number;
    };
  } | null,
): SemanticHistoryRetriever {
  if (!contextManagement?.semanticHistory) {
    return new SemanticHistoryRetriever();
  }

  const cfg = contextManagement.semanticHistory;
  return new SemanticHistoryRetriever({
    enabled: cfg.enabled,
    maxRetrievedChunks: cfg.maxRetrievedChunks,
    minRelevanceScore: cfg.minRelevanceScore,
  });
}
