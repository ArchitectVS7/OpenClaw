import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  ContextBudgetManager,
  createBudgetManagerFromConfig,
  DEFAULT_CONTEXT_BUDGET_CONFIG,
  estimateMessagesTokens,
  estimateTextTokens,
} from "./context-budget.js";

describe("ContextBudgetManager", () => {
  describe("computeBudget", () => {
    it("should compute budget with default ratios", () => {
      const manager = new ContextBudgetManager();
      const budget = manager.computeBudget(200_000);

      expect(budget.total).toBe(200_000);
      expect(budget.systemPrompt).toBe(30_000); // 15%
      expect(budget.bootstrap).toBe(20_000); // 10%
      expect(budget.history).toBe(90_000); // 45%
      expect(budget.response).toBe(40_000); // 20%
      // Reserve = 200k - 180k = 20k (10% unallocated)
      expect(budget.reserve).toBe(20_000);
    });

    it("should compute budget with custom ratios", () => {
      const manager = new ContextBudgetManager({
        systemPromptRatio: 0.2,
        bootstrapRatio: 0.05,
        historyRatio: 0.5,
        responseRatio: 0.25,
      });
      const budget = manager.computeBudget(100_000);

      expect(budget.total).toBe(100_000);
      expect(budget.systemPrompt).toBe(20_000);
      expect(budget.bootstrap).toBe(5_000);
      expect(budget.history).toBe(50_000);
      expect(budget.response).toBe(25_000);
      expect(budget.reserve).toBe(0);
    });

    it("should enforce minimum response tokens", () => {
      const manager = new ContextBudgetManager({
        responseRatio: 0.01, // Would be 100 tokens on 10k window
        minResponseTokens: 2000,
      });
      const budget = manager.computeBudget(10_000);

      expect(budget.response).toBe(2000);
      // History should be reduced to compensate
      expect(budget.history).toBeLessThan(10_000 * DEFAULT_CONTEXT_BUDGET_CONFIG.historyRatio);
    });

    it("should handle small context windows", () => {
      const manager = new ContextBudgetManager();
      const budget = manager.computeBudget(8_000);

      expect(budget.total).toBe(8_000);
      expect(budget.response).toBeGreaterThanOrEqual(manager.getConfig().minResponseTokens);
    });

    it("should handle edge case of zero context window", () => {
      const manager = new ContextBudgetManager();
      const budget = manager.computeBudget(0);

      expect(budget.total).toBe(1); // Minimum of 1
    });
  });

  describe("computeHistoryBudget", () => {
    it("should compute remaining history budget after actual usage", () => {
      const manager = new ContextBudgetManager();
      const historyBudget = manager.computeHistoryBudget({
        systemPrompt: 20_000, // Under budget (30k allocated)
        bootstrap: 5_000, // Under budget (20k allocated)
        contextWindow: 200_000,
      });

      // Base history (90k) + reclaimed (10k + 15k) + reserve (20k) = 135k
      expect(historyBudget).toBe(135_000);
    });

    it("should not reclaim when over budget", () => {
      const manager = new ContextBudgetManager();
      const historyBudget = manager.computeHistoryBudget({
        systemPrompt: 40_000, // Over budget (30k allocated)
        bootstrap: 25_000, // Over budget (20k allocated)
        contextWindow: 200_000,
      });

      // Base history (90k) + reclaimed (0) + reserve (20k) = 110k
      // Note: We don't reduce below base + reserve when over budget
      expect(historyBudget).toBe(110_000);
    });

    it("should use default context window when not specified", () => {
      const manager = new ContextBudgetManager();
      const historyBudget = manager.computeHistoryBudget({
        systemPrompt: 10_000,
        bootstrap: 10_000,
      });

      // Should work with default 200k window
      expect(historyBudget).toBeGreaterThan(0);
    });
  });

  describe("validateContextFits", () => {
    it("should validate when context fits", () => {
      const manager = new ContextBudgetManager();
      const result = manager.validateContextFits({
        systemPromptTokens: 20_000,
        bootstrapTokens: 10_000,
        historyTokens: 50_000,
        contextWindow: 200_000,
      });

      expect(result.fits).toBe(true);
      expect(result.overflow).toBe(0);
    });

    it("should detect overflow when context exceeds window", () => {
      const manager = new ContextBudgetManager();
      const result = manager.validateContextFits({
        systemPromptTokens: 100_000,
        bootstrapTokens: 50_000,
        historyTokens: 100_000,
        contextWindow: 200_000,
      });

      expect(result.fits).toBe(false);
      expect(result.overflow).toBeGreaterThan(0);
    });
  });

  describe("getConfig", () => {
    it("should return current configuration", () => {
      const manager = new ContextBudgetManager({ historyRatio: 0.6 });
      const config = manager.getConfig();

      expect(config.historyRatio).toBe(0.6);
      expect(config.systemPromptRatio).toBe(DEFAULT_CONTEXT_BUDGET_CONFIG.systemPromptRatio);
    });
  });
});

describe("createBudgetManagerFromConfig", () => {
  it("should create manager with default config when no contextManagement", () => {
    const manager = createBudgetManagerFromConfig(undefined);
    expect(manager.getConfig()).toEqual(DEFAULT_CONTEXT_BUDGET_CONFIG);
  });

  it("should create manager with default config when contextManagement is null", () => {
    const manager = createBudgetManagerFromConfig(null);
    expect(manager.getConfig()).toEqual(DEFAULT_CONTEXT_BUDGET_CONFIG);
  });

  it("should create manager with custom budget config", () => {
    const manager = createBudgetManagerFromConfig({
      budget: {
        historyRatio: 0.55,
        minResponseTokens: 8192,
      },
    });

    expect(manager.getConfig().historyRatio).toBe(0.55);
    expect(manager.getConfig().minResponseTokens).toBe(8192);
    // Unset values should use defaults
    expect(manager.getConfig().systemPromptRatio).toBe(
      DEFAULT_CONTEXT_BUDGET_CONFIG.systemPromptRatio,
    );
  });
});

describe("estimateTextTokens", () => {
  it("should estimate tokens using 4 chars per token", () => {
    expect(estimateTextTokens("")).toBe(0);
    expect(estimateTextTokens("test")).toBe(1);
    expect(estimateTextTokens("hello world")).toBe(3); // 11 chars / 4 = 2.75 -> 3
    expect(estimateTextTokens("a".repeat(100))).toBe(25);
  });
});

describe("estimateMessagesTokens", () => {
  it("should estimate total tokens for multiple messages", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "Hello", timestamp: Date.now() },
      { role: "assistant", content: [{ type: "text", text: "Hi there!" }] },
    ];

    const tokens = estimateMessagesTokens(messages);
    expect(tokens).toBeGreaterThan(0);
  });

  it("should return 0 for empty array", () => {
    expect(estimateMessagesTokens([])).toBe(0);
  });
});
