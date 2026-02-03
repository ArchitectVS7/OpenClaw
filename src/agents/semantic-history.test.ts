import { describe, expect, it, vi } from "vitest";
import {
  createSemanticHistoryRetrieverFromConfig,
  DEFAULT_SEMANTIC_HISTORY_CONFIG,
  type MemorySearchProvider,
  SemanticHistoryRetriever,
} from "./semantic-history.js";

function createMockMemorySearch(
  results: Parameters<MemorySearchProvider["search"]>[1] extends number
    ? ReturnType<MemorySearchProvider["search"]> extends Promise<infer R>
      ? R
      : never
    : never,
): MemorySearchProvider & { searchFn: ReturnType<typeof vi.fn> } {
  const searchFn = vi.fn().mockResolvedValue(results);
  return {
    search: searchFn,
    searchFn,
  };
}

describe("SemanticHistoryRetriever", () => {
  describe("retrieve", () => {
    it("should return empty result when disabled", async () => {
      const retriever = new SemanticHistoryRetriever({ enabled: false });
      const mockSearch = createMockMemorySearch([
        {
          path: "test.md",
          snippet: "test",
          score: 0.9,
          startLine: 1,
          endLine: 1,
          source: "sessions",
        },
      ]);

      const result = await retriever.retrieve("test query", mockSearch, 1000);

      expect(result.didRetrieve).toBe(false);
      expect(result.contexts).toHaveLength(0);
      expect(mockSearch.searchFn).not.toHaveBeenCalled();
    });

    it("should return empty result for empty prompt", async () => {
      const retriever = new SemanticHistoryRetriever({ enabled: true });
      const mockSearch = createMockMemorySearch([]);

      const result = await retriever.retrieve("", mockSearch, 1000);

      expect(result.didRetrieve).toBe(false);
      expect(result.contexts).toHaveLength(0);
    });

    it("should return empty result for zero budget", async () => {
      const retriever = new SemanticHistoryRetriever({ enabled: true });
      const mockSearch = createMockMemorySearch([]);

      const result = await retriever.retrieve("test query", mockSearch, 0);

      expect(result.didRetrieve).toBe(false);
      expect(result.contexts).toHaveLength(0);
    });

    it("should retrieve and filter by relevance score", async () => {
      const retriever = new SemanticHistoryRetriever({
        enabled: true,
        minRelevanceScore: 0.7,
      });

      const mockSearch = createMockMemorySearch([
        {
          path: "high.md",
          snippet: "high relevance",
          score: 0.9,
          startLine: 1,
          endLine: 1,
          source: "sessions",
        },
        {
          path: "low.md",
          snippet: "low relevance",
          score: 0.5,
          startLine: 1,
          endLine: 1,
          source: "sessions",
        },
        {
          path: "medium.md",
          snippet: "medium relevance",
          score: 0.75,
          startLine: 1,
          endLine: 1,
          source: "sessions",
        },
      ]);

      const result = await retriever.retrieve("test query", mockSearch, 10000);

      expect(result.didRetrieve).toBe(true);
      expect(result.contexts).toHaveLength(2);
      expect(result.contexts[0].path).toBe("high.md");
      expect(result.contexts[1].path).toBe("medium.md");
    });

    it("should respect maxRetrievedChunks limit", async () => {
      const retriever = new SemanticHistoryRetriever({
        enabled: true,
        maxRetrievedChunks: 2,
        minRelevanceScore: 0.5,
      });

      const mockSearch = createMockMemorySearch([
        {
          path: "1.md",
          snippet: "first",
          score: 0.9,
          startLine: 1,
          endLine: 1,
          source: "sessions",
        },
        {
          path: "2.md",
          snippet: "second",
          score: 0.85,
          startLine: 1,
          endLine: 1,
          source: "sessions",
        },
        {
          path: "3.md",
          snippet: "third",
          score: 0.8,
          startLine: 1,
          endLine: 1,
          source: "sessions",
        },
        {
          path: "4.md",
          snippet: "fourth",
          score: 0.75,
          startLine: 1,
          endLine: 1,
          source: "sessions",
        },
      ]);

      const result = await retriever.retrieve("test query", mockSearch, 10000);

      expect(result.contexts).toHaveLength(2);
    });

    it("should respect token budget", async () => {
      const retriever = new SemanticHistoryRetriever({
        enabled: true,
        maxRetrievedChunks: 10,
        minRelevanceScore: 0.5,
      });

      // Each snippet is about 25 chars = ~6 tokens
      const mockSearch = createMockMemorySearch([
        {
          path: "1.md",
          snippet: "This is a test snippet 1",
          score: 0.9,
          startLine: 1,
          endLine: 1,
          source: "sessions",
        },
        {
          path: "2.md",
          snippet: "This is a test snippet 2",
          score: 0.85,
          startLine: 1,
          endLine: 1,
          source: "sessions",
        },
        {
          path: "3.md",
          snippet: "This is a test snippet 3",
          score: 0.8,
          startLine: 1,
          endLine: 1,
          source: "sessions",
        },
      ]);

      // Budget of 15 tokens should fit roughly 2 snippets
      const result = await retriever.retrieve("test query", mockSearch, 15);

      expect(result.totalTokens).toBeLessThanOrEqual(15);
    });

    it("should handle search errors gracefully", async () => {
      const retriever = new SemanticHistoryRetriever({ enabled: true });
      const mockSearch: MemorySearchProvider = {
        search: vi.fn().mockRejectedValue(new Error("Search failed")),
      };

      const result = await retriever.retrieve("test query", mockSearch, 1000);

      expect(result.didRetrieve).toBe(false);
      expect(result.contexts).toHaveLength(0);
    });
  });

  describe("formatContextsForInjection", () => {
    it("should return empty string for empty contexts", () => {
      const retriever = new SemanticHistoryRetriever();

      const formatted = retriever.formatContextsForInjection([]);

      expect(formatted).toBe("");
    });

    it("should format contexts with XML tags", () => {
      const retriever = new SemanticHistoryRetriever();

      const formatted = retriever.formatContextsForInjection([
        {
          path: "test.md",
          snippet: "Test content",
          score: 0.85,
          startLine: 1,
          endLine: 5,
          tokens: 10,
        },
      ]);

      expect(formatted).toContain("<relevant-prior-context>");
      expect(formatted).toContain("</relevant-prior-context>");
      expect(formatted).toContain('<context source="test.md" score="0.85">');
      expect(formatted).toContain("Test content");
      expect(formatted).toContain("</context>");
    });

    it("should format multiple contexts", () => {
      const retriever = new SemanticHistoryRetriever();

      const formatted = retriever.formatContextsForInjection([
        { path: "a.md", snippet: "Content A", score: 0.9, startLine: 1, endLine: 1, tokens: 5 },
        { path: "b.md", snippet: "Content B", score: 0.8, startLine: 1, endLine: 1, tokens: 5 },
      ]);

      expect(formatted).toContain("Content A");
      expect(formatted).toContain("Content B");
      expect(formatted.match(/<context/g)).toHaveLength(2);
    });
  });

  describe("getConfig", () => {
    it("should return current configuration", () => {
      const retriever = new SemanticHistoryRetriever({ maxRetrievedChunks: 10 });
      const config = retriever.getConfig();

      expect(config.maxRetrievedChunks).toBe(10);
      expect(config.enabled).toBe(DEFAULT_SEMANTIC_HISTORY_CONFIG.enabled);
    });
  });
});

describe("createSemanticHistoryRetrieverFromConfig", () => {
  it("should create retriever with default config when no contextManagement", () => {
    const retriever = createSemanticHistoryRetrieverFromConfig(undefined);
    expect(retriever.getConfig()).toEqual(DEFAULT_SEMANTIC_HISTORY_CONFIG);
  });

  it("should create retriever with default config when null", () => {
    const retriever = createSemanticHistoryRetrieverFromConfig(null);
    expect(retriever.getConfig()).toEqual(DEFAULT_SEMANTIC_HISTORY_CONFIG);
  });

  it("should create retriever with custom config", () => {
    const retriever = createSemanticHistoryRetrieverFromConfig({
      semanticHistory: {
        enabled: true,
        maxRetrievedChunks: 10,
        minRelevanceScore: 0.8,
      },
    });

    expect(retriever.getConfig().enabled).toBe(true);
    expect(retriever.getConfig().maxRetrievedChunks).toBe(10);
    expect(retriever.getConfig().minRelevanceScore).toBe(0.8);
  });
});
