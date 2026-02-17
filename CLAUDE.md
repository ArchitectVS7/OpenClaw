# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

OpenClaw is a personal AI assistant that runs on your own devices. It answers on channels you already use (WhatsApp, Telegram, Slack, Discord, Signal, iMessage, etc.) and uses a Gateway as the control plane. The project is built in TypeScript with Node.js ≥22.

**Key Architecture Components:**
- **Gateway** (`src/gateway/`): WebSocket server that coordinates AI agent sessions, device connections, and channel routing
- **Agents** (`src/agents/`): Core AI logic including Pi agent integration, context management, and tool execution
- **Channels** (`src/channels/`, `src/telegram/`, `src/whatsapp/`, etc.): Platform integrations for messaging services
- **Config** (`src/config/`): Type-safe configuration system using Zod schemas

## Common Development Commands

### Building
```bash
# Full build (includes UI bundling and TypeScript compilation)
pnpm build

# Build just the TypeScript
pnpm build  # uses tsconfig.json with noEmit: false, outDir: dist

# UI-only build
pnpm ui:build
```

### Testing
```bash
# Run all unit tests (parallel)
pnpm test

# Run tests with coverage
pnpm test:coverage

# Watch mode
pnpm test:watch

# E2E tests
pnpm test:e2e

# Live tests (requires real API credentials)
pnpm test:live

# Docker integration tests (full suite)
pnpm test:docker:all
```

### Linting and Formatting
```bash
# Lint TypeScript
pnpm lint

# Lint with auto-fix
pnpm lint:fix

# Format check
pnpm format

# Format and fix
pnpm format:fix
```

### Running OpenClaw
```bash
# Development mode with auto-reload
pnpm dev

# Run gateway in development mode
pnpm gateway:dev

# Gateway with watch/rebuild
pnpm gateway:watch

# Start built version
pnpm start

# Run agent in RPC mode
pnpm openclaw:rpc
```

### Protocol and Schema Generation
```bash
# Generate gateway protocol schemas
pnpm protocol:gen

# Generate Swift protocol models (for macOS/iOS apps)
pnpm protocol:gen:swift

# Verify protocol is in sync
pnpm protocol:check
```

## Architecture Deep Dive

### Context Management System (VS7)

The VS7 branch introduces an advanced context management system to optimize token usage:

**Key Files:**
- `src/agents/context-budget.ts`: Token budget allocation across system prompt, bootstrap, history, and response
- `src/agents/compaction.ts`: Message history compaction and summarization
- `src/agents/semantic-history.ts`: Semantic retrieval of relevant historical context
- `src/agents/rolling-summary.ts`: Rolling summarization for long conversations

**Configuration:**
```json
{
  "agents": {
    "defaults": {
      "contextManagement": {
        "enabled": true,  // Master toggle for VS7 features
        "summaryMode": "rolling",
        "semanticHistory": {
          "enabled": true,
          "maxRetrievedChunks": 5
        }
      }
    }
  }
}
```

**How It Works:**
1. **Budget Allocation**: Divides context window into system (15%), bootstrap (10%), history (45%), response (20%), reserve (10%)
2. **Compaction**: When history exceeds budget, splits into chunks and summarizes using the model itself
3. **Semantic Retrieval**: Uses vector search to find relevant past conversations
4. **Rolling Summaries**: Maintains running summaries of conversation threads

### Gateway Protocol

The gateway uses a WebSocket-based protocol (v3) with challenge-response authentication:

**Protocol Files:**
- `src/gateway/protocol/schema/frames.ts`: Message frame definitions
- `src/gateway/protocol/schema/primitives.ts`: Base types
- `src/gateway/server-methods/`: RPC method handlers (connect, agent.wait, channels, etc.)

**Key Concepts:**
- **Device Identity**: Ed25519 keypair-based device authentication
- **Session Keys**: Format `agent:main:{sessionKey}` for tracking agent conversations
- **Frame Types**: `method_call`, `response`, `event`, `error`

### Agent Architecture

**Pi Agent Integration:**
- Uses `@mariozechner/pi-agent-core` for the base agent loop
- `src/agents/pi-embedded-runner.ts`: Main runner that orchestrates model calls, tool execution, and context management
- `src/agents/pi-tools.*.ts`: Tool definitions (read, write, bash, etc.)

**Tool Policy:**
- `src/agents/sandbox/tool-policy.ts`: Approval system for dangerous operations
- `src/agents/bash-tools.ts`: Bash command execution with sandboxing
- Supports approval IDs for pre-authorized commands

### Testing VS7 Features

The `Dev/` directory contains a test harness for comparing VS7 vs baseline:

**Key Test Runner:**
- `Dev/src/sequential-toggle-runner.ts`: Toggles `contextManagement.enabled` on/off between runs
- Connects via WebSocket to gateway
- Uses `agent.wait` API for synchronous completion
- Tracks tokens via session metadata API

**Running Tests:**
```bash
cd Dev
npm install

# Run single test
npm run sequential -- --test-id=1.1 --gateway-url=ws://localhost:18791 --token=<gateway-token>

# Run multiple tests
npm run sequential -- --test-ids=1.1,1.2,1.3
```

## Docker Setup

**Important Environment Variables:**
- `ANTHROPIC_API_KEY`: Required for Anthropic models (must be set inline, `.env` may not work)
- `OPENCLAW_GATEWAY_TOKEN`: Gateway auth token
- Docker gateway port mapping: `18791:18789` (external:internal)

**Starting Docker:**
```bash
cd /c/dev/Utils/OpenClaw
ANTHROPIC_API_KEY="sk-ant-..." docker-compose up -d
```

**Re-authenticating Anthropic in Docker:**
```bash
docker exec -it openclaw-openclaw-gateway-1 node dist/index.js models auth anthropic
```

## Configuration System

Configuration is strongly typed with Zod schemas:

**Schema Files:**
- `src/config/zod-schema.*.ts`: Zod validators
- `src/config/types.*.ts`: TypeScript type exports

**Key Config Sections:**
- `agents.defaults`: Default agent behavior, models, context management
- `agents.defaults.contextManagement`: VS7 toggle and settings
- `gateway`: Gateway server settings (port, bind, auth)
- `channels`: Channel-specific config (Telegram, WhatsApp, etc.)

## File Locations

- **Source**: `src/`
- **Built output**: `dist/`
- **Tests**: `src/**/*.test.ts` (unit), `src/**/*.e2e.test.ts` (e2e), `src/**/*.live.test.ts` (live)
- **UI**: `ui/` (separate web-based control UI)
- **Docker config**: `data/openclaw-config/openclaw.json`
- **Workspace**: `data/openclaw-workspace/`

## TypeScript Configuration

- Module system: `NodeNext` (ESM)
- Target: `ES2023`
- Strict mode enabled
- Output: `dist/` (when building)
- Test files excluded from build via `tsconfig.json`

## Branch Strategy

- **main**: Stable baseline (standard Pi agent, no VS7)
- **VS7**: Context management experimental branch
- Current work: Testing and validating VS7 token savings vs baseline

## Key Dependencies

- `@mariozechner/pi-agent-core`: Base AI agent framework
- `@mariozechner/pi-coding-agent`: Coding-specific agent tools
- `@whiskeysockets/baileys`: WhatsApp integration
- `grammy`: Telegram bot framework
- `ws`: WebSocket server/client
- `zod`: Runtime type validation
- `vitest`: Test runner

## Notes

- Always use `pnpm` for dependency management (enforced by `packageManager` field)
- Tests run in parallel with fork pool (see `vitest.config.ts`)
- Windows has special handling in test timeouts and worker counts
- Protocol changes require regenerating Swift models for iOS/macOS apps
- LOC limit per TypeScript file: 500 lines (enforced by `pnpm check:loc`)
