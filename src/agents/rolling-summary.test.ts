import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import {
  createRollingSummarizerFromConfig,
  DEFAULT_ROLLING_SUMMARY_CONFIG,
  RollingSummarizer,
} from "./rolling-summary.js";

// Mock the compaction module
vi.mock("./compaction.js", () => ({
  estimateMessagesTokens: (messages: AgentMessage[]) => {
    // Simple mock: ~100 tokens per message
    return messages.length * 100;
  },
  summarizeInStages: vi.fn().mockResolvedValue("Summary of earlier conversation."),
}));

function createUserMessage(text: string, timestamp = Date.now()): AgentMessage {
  return { role: "user", content: text, timestamp };
}

function createAssistantMessage(text: string): AgentMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

describe("RollingSummarizer", () => {
  describe("shouldSummarize", () => {
    it("should return false when disabled", () => {
      const summarizer = new RollingSummarizer({ enabled: false });
      const messages = Array(100).fill(createUserMessage("test"));

      expect(summarizer.shouldSummarize(messages)).toBe(false);
    });

    it("should return false when under threshold", () => {
      const summarizer = new RollingSummarizer({
        enabled: true,
        triggerThreshold: 50_000,
      });
      // 10 messages * 100 tokens = 1000 tokens (under threshold)
      const messages = Array(10)
        .fill(null)
        .map(() => createUserMessage("test"));

      expect(summarizer.shouldSummarize(messages)).toBe(false);
    });

    it("should return true when over threshold", () => {
      const summarizer = new RollingSummarizer({
        enabled: true,
        triggerThreshold: 500, // Very low threshold
      });
      // 10 messages * 100 tokens = 1000 tokens (over threshold)
      const messages = Array(10)
        .fill(null)
        .map(() => createUserMessage("test"));

      expect(summarizer.shouldSummarize(messages)).toBe(true);
    });

    it("should use budget-based threshold when provided", () => {
      const summarizer = new RollingSummarizer({
        enabled: true,
        triggerThreshold: 50_000,
      });
      // 10 messages * 100 tokens = 1000 tokens
      const messages = Array(10)
        .fill(null)
        .map(() => createUserMessage("test"));

      // Budget of 1000 * 0.8 = 800, which is under the message total (1000)
      expect(summarizer.shouldSummarize(messages, 1000)).toBe(true);
    });
  });

  describe("buildContextWithSummary", () => {
    it("should return all messages when summarization not needed", async () => {
      const summarizer = new RollingSummarizer({
        enabled: false,
      });

      const messages = [createUserMessage("Hello"), createAssistantMessage("Hi!")];

      const result = await summarizer.buildContextWithSummary({
        messages,
        budget: 100_000,
        model: { contextWindow: 200_000 } as Parameters<
          typeof summarizer.buildContextWithSummary
        >[0]["model"],
        apiKey: "test-key",
      });

      expect(result.recentMessages).toEqual(messages);
      expect(result.didSummarize).toBe(false);
      expect(result.summarizedMessageCount).toBe(0);
    });

    it("should split and summarize when over threshold", async () => {
      const summarizer = new RollingSummarizer({
        enabled: true,
        windowSize: 2,
        triggerThreshold: 500, // Very low to trigger on few messages
      });

      // Create 10 turns
      const messages: AgentMessage[] = [];
      for (let i = 0; i < 10; i++) {
        messages.push(createUserMessage(`Question ${i}`));
        messages.push(createAssistantMessage(`Answer ${i}`));
      }

      const result = await summarizer.buildContextWithSummary({
        messages,
        budget: 100_000,
        model: { contextWindow: 200_000 } as Parameters<
          typeof summarizer.buildContextWithSummary
        >[0]["model"],
        apiKey: "test-key",
      });

      // Should keep last 2 user turns (4 messages: user, assistant, user, assistant)
      expect(result.recentMessages.length).toBeLessThan(messages.length);
      expect(result.didSummarize).toBe(true);
      expect(result.summarizedMessageCount).toBeGreaterThan(0);
    });

    it("should preserve existing summary on failure", async () => {
      // Reset and set up a failing mock
      const { summarizeInStages } = await import("./compaction.js");
      vi.mocked(summarizeInStages).mockRejectedValueOnce(new Error("API error"));

      const summarizer = new RollingSummarizer({
        enabled: true,
        windowSize: 2,
        triggerThreshold: 500,
      });

      const messages: AgentMessage[] = [];
      for (let i = 0; i < 10; i++) {
        messages.push(createUserMessage(`Question ${i}`));
        messages.push(createAssistantMessage(`Answer ${i}`));
      }

      const existingSummary = "Previous summary text";
      const result = await summarizer.buildContextWithSummary({
        messages,
        budget: 100_000,
        model: { contextWindow: 200_000 } as Parameters<
          typeof summarizer.buildContextWithSummary
        >[0]["model"],
        apiKey: "test-key",
        existingSummary,
      });

      expect(result.summaryText).toBe(existingSummary);
      expect(result.didSummarize).toBe(false);
    });
  });

  describe("createSummaryEntry", () => {
    it("should create a valid summary entry", () => {
      const summarizer = new RollingSummarizer();

      const entry = summarizer.createSummaryEntry({
        text: "Test summary",
        coversTurns: [0, 1, 2],
        model: "claude-opus-4-5",
        originalTokens: 5000,
      });

      expect(entry.type).toBe("summary");
      expect(entry.data.text).toBe("Test summary");
      expect(entry.data.coversTurns).toEqual([0, 1, 2]);
      expect(entry.data.model).toBe("claude-opus-4-5");
      expect(entry.data.originalTokens).toBe(5000);
      expect(entry.data.createdAt).toBeGreaterThan(0);
    });
  });

  describe("formatSummaryForContext", () => {
    it("should format summary with XML tags", () => {
      const summarizer = new RollingSummarizer();

      const formatted = summarizer.formatSummaryForContext("Test summary content");

      expect(formatted).toContain("<prior-conversation-summary>");
      expect(formatted).toContain("Test summary content");
      expect(formatted).toContain("</prior-conversation-summary>");
    });

    it("should return empty string for empty summary", () => {
      const summarizer = new RollingSummarizer();

      expect(summarizer.formatSummaryForContext("")).toBe("");
      expect(summarizer.formatSummaryForContext("   ")).toBe("");
    });
  });

  describe("getConfig", () => {
    it("should return current configuration", () => {
      const summarizer = new RollingSummarizer({ windowSize: 10 });
      const config = summarizer.getConfig();

      expect(config.windowSize).toBe(10);
      expect(config.enabled).toBe(DEFAULT_ROLLING_SUMMARY_CONFIG.enabled);
    });
  });
});

describe("createRollingSummarizerFromConfig", () => {
  it("should create summarizer with default config when no contextManagement", () => {
    const summarizer = createRollingSummarizerFromConfig(undefined);
    expect(summarizer.getConfig()).toEqual(DEFAULT_ROLLING_SUMMARY_CONFIG);
  });

  it("should create summarizer with default config when null", () => {
    const summarizer = createRollingSummarizerFromConfig(null);
    expect(summarizer.getConfig()).toEqual(DEFAULT_ROLLING_SUMMARY_CONFIG);
  });

  it("should create summarizer with custom config", () => {
    const summarizer = createRollingSummarizerFromConfig({
      rollingSummary: {
        enabled: true,
        windowSize: 10,
        summaryMaxTokens: 5000,
      },
    });

    expect(summarizer.getConfig().enabled).toBe(true);
    expect(summarizer.getConfig().windowSize).toBe(10);
    expect(summarizer.getConfig().summaryMaxTokens).toBe(5000);
    // Unset values should use defaults
    expect(summarizer.getConfig().triggerThreshold).toBe(
      DEFAULT_ROLLING_SUMMARY_CONFIG.triggerThreshold,
    );
  });
});
