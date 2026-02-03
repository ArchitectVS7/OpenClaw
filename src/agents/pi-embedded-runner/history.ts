import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { estimateTokens } from "@mariozechner/pi-coding-agent";
import type { OpenClawConfig } from "../../config/config.js";

const THREAD_SUFFIX_REGEX = /^(.*)(?::(?:thread|topic):\d+)$/i;

function stripThreadSuffix(value: string): string {
  const match = value.match(THREAD_SUFFIX_REGEX);
  return match?.[1] ?? value;
}

/**
 * Limits conversation history to the last N user turns (and their associated
 * assistant responses). This reduces token usage for long-running DM sessions.
 */
export function limitHistoryTurns(
  messages: AgentMessage[],
  limit: number | undefined,
): AgentMessage[] {
  if (!limit || limit <= 0 || messages.length === 0) {
    return messages;
  }

  let userCount = 0;
  let lastUserIndex = messages.length;

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      userCount++;
      if (userCount > limit) {
        return messages.slice(lastUserIndex);
      }
      lastUserIndex = i;
    }
  }
  return messages;
}

/**
 * Extract provider + user ID from a session key and look up dmHistoryLimit.
 * Supports per-DM overrides and provider defaults.
 */
export function getDmHistoryLimitFromSessionKey(
  sessionKey: string | undefined,
  config: OpenClawConfig | undefined,
): number | undefined {
  if (!sessionKey || !config) {
    return undefined;
  }

  const parts = sessionKey.split(":").filter(Boolean);
  const providerParts = parts.length >= 3 && parts[0] === "agent" ? parts.slice(2) : parts;

  const provider = providerParts[0]?.toLowerCase();
  if (!provider) {
    return undefined;
  }

  const kind = providerParts[1]?.toLowerCase();
  const userIdRaw = providerParts.slice(2).join(":");
  const userId = stripThreadSuffix(userIdRaw);
  if (kind !== "dm") {
    return undefined;
  }

  const getLimit = (
    providerConfig:
      | {
          dmHistoryLimit?: number;
          dms?: Record<string, { historyLimit?: number }>;
        }
      | undefined,
  ): number | undefined => {
    if (!providerConfig) {
      return undefined;
    }
    if (userId && providerConfig.dms?.[userId]?.historyLimit !== undefined) {
      return providerConfig.dms[userId].historyLimit;
    }
    return providerConfig.dmHistoryLimit;
  };

  const resolveProviderConfig = (
    cfg: OpenClawConfig | undefined,
    providerId: string,
  ): { dmHistoryLimit?: number; dms?: Record<string, { historyLimit?: number }> } | undefined => {
    const channels = cfg?.channels;
    if (!channels || typeof channels !== "object") {
      return undefined;
    }
    const entry = (channels as Record<string, unknown>)[providerId];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return undefined;
    }
    return entry as { dmHistoryLimit?: number; dms?: Record<string, { historyLimit?: number }> };
  };

  return getLimit(resolveProviderConfig(config, provider));
}

/**
 * Options for token-based history limiting.
 */
export interface LimitHistoryByTokensOptions {
  /** Number of recent user turns to always preserve (default: 5). */
  preserveRecentTurns?: number;
}

/**
 * Limits conversation history by token count instead of turn count.
 *
 * This is more accurate than turn-based limiting because a single turn
 * can contain vastly different token counts (e.g., a simple "yes" vs.
 * a 50k token tool result).
 *
 * Algorithm:
 * 1. Always preserve the last N user turns (and their responses)
 * 2. From older messages, keep as many as fit in the remaining budget
 * 3. Drop oldest messages first when over budget
 */
export function limitHistoryByTokens(
  messages: AgentMessage[],
  budgetTokens: number,
  options?: LimitHistoryByTokensOptions,
): AgentMessage[] {
  if (messages.length === 0 || budgetTokens <= 0) {
    return [];
  }

  const preserveRecentTurns = options?.preserveRecentTurns ?? 5;

  // Calculate total tokens
  const totalTokens = messages.reduce((sum, msg) => sum + estimateTokens(msg), 0);

  // If already under budget, return all messages
  if (totalTokens <= budgetTokens) {
    return messages;
  }

  // Find split point: messages to always preserve (recent turns)
  const { recentStartIndex, recentTokens } = findRecentTurnsSplit(messages, preserveRecentTurns);

  // If even recent messages exceed budget, we need to truncate them too
  if (recentTokens > budgetTokens) {
    // Keep as many recent messages as fit
    return truncateMessagesToFit(messages.slice(recentStartIndex), budgetTokens);
  }

  // Calculate remaining budget for older messages
  const remainingBudget = budgetTokens - recentTokens;
  const olderMessages = messages.slice(0, recentStartIndex);
  const recentMessages = messages.slice(recentStartIndex);

  if (olderMessages.length === 0 || remainingBudget <= 0) {
    return recentMessages;
  }

  // From older messages, keep as many as fit (from most recent backwards)
  const keptOlder = truncateMessagesToFit(olderMessages, remainingBudget);

  return [...keptOlder, ...recentMessages];
}

/**
 * Find the index where recent turns start (preserving N user turns from the end).
 */
function findRecentTurnsSplit(
  messages: AgentMessage[],
  preserveTurns: number,
): { recentStartIndex: number; recentTokens: number } {
  if (preserveTurns <= 0) {
    return { recentStartIndex: messages.length, recentTokens: 0 };
  }

  let userCount = 0;
  let recentStartIndex = messages.length;
  let recentTokens = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    recentTokens += estimateTokens(msg);

    if (msg.role === "user") {
      userCount++;
      if (userCount >= preserveTurns) {
        recentStartIndex = i;
        break;
      }
    }
    recentStartIndex = i;
  }

  return { recentStartIndex, recentTokens };
}

/**
 * Truncate messages to fit within a token budget, keeping most recent first.
 * Drops oldest messages when over budget.
 */
function truncateMessagesToFit(messages: AgentMessage[], budgetTokens: number): AgentMessage[] {
  if (messages.length === 0 || budgetTokens <= 0) {
    return [];
  }

  // Calculate tokens for each message
  const messageTokens = messages.map((msg) => estimateTokens(msg));
  const totalTokens = messageTokens.reduce((sum, t) => sum + t, 0);

  if (totalTokens <= budgetTokens) {
    return messages;
  }

  // Find how many messages to drop from the start
  let tokensToRemove = totalTokens - budgetTokens;
  let dropCount = 0;

  for (let i = 0; i < messages.length && tokensToRemove > 0; i++) {
    tokensToRemove -= messageTokens[i];
    dropCount++;
  }

  // Ensure we don't split user/assistant pairs (try to start on a user message)
  let adjustedDropCount = dropCount;
  for (let i = dropCount; i < messages.length; i++) {
    if (messages[i].role === "user") {
      adjustedDropCount = i;
      break;
    }
  }

  return messages.slice(adjustedDropCount);
}
