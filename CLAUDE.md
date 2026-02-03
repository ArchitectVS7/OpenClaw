# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**OpenClaw** is a personal AI assistant platform built around a centralized WebSocket-based Gateway that orchestrates messaging channels (WhatsApp, Telegram, Slack, Discord, Signal, iMessage, etc.), AI agents (Pi agent), and various peripheral services. It enables a single-user assistant experience that feels local, fast, and always-on.

The Gateway acts as a unified control plane for sessions, channels, tools, and events, with optional companion apps for macOS, iOS, and Android.

## Development Commands

### Runtime Requirements
- **Node ≥22.12.0** (baseline; keep both Node and Bun paths working)
- Prefer **pnpm** for builds from source
- **Bun** is optional but supported for TypeScript execution

### Setup
```bash
pnpm install
pnpm ui:build       # Auto-installs UI deps on first run
pnpm build          # TypeScript compilation to dist/
```

### Development
```bash
pnpm openclaw ...   # Run CLI via tsx (direct TypeScript execution)
pnpm dev            # Run CLI in dev mode
pnpm gateway:watch  # Auto-reload gateway on TS changes
```

### Linting and Formatting
```bash
pnpm lint           # oxlint (type-aware)
pnpm format         # oxfmt (check mode)
pnpm format:fix     # oxfmt (write mode)
pnpm lint:fix       # oxlint --fix && oxfmt --write
```

### Testing
```bash
pnpm test                # Run unit tests (vitest)
pnpm test:watch          # Watch mode
pnpm test:coverage       # Coverage with thresholds (70% lines/branches/functions/statements)
pnpm test:live           # Live tests with real API keys (OPENCLAW_LIVE_TEST=1)
pnpm test:e2e            # End-to-end tests
pnpm test:all            # Full gate: lint + build + test + e2e + live + docker
```

Coverage thresholds: 70% lines, 70% functions, 55% branches, 70% statements (see `vitest.config.ts`).

### Running a Single Test
```bash
pnpm vitest run src/path/to/file.test.ts
```

### Building Platform-Specific Apps
```bash
# macOS app
pnpm mac:package        # Package macOS app (defaults to current arch)

# iOS
pnpm ios:gen            # Generate Xcode project
pnpm ios:open           # Open in Xcode
pnpm ios:build          # Build for simulator
pnpm ios:run            # Build and run

# Android
pnpm android:assemble   # Build debug APK
pnpm android:install    # Install debug APK
pnpm android:run        # Install and launch
```

## High-Level Architecture

OpenClaw follows a **session-centric, event-driven architecture** with a central Gateway acting as the control plane.

### Core Components

**Gateway (Control Plane)**
- WebSocket server at `ws://127.0.0.1:18789` (loopback by default)
- Manages sessions, channels, agents, tools, config, and events
- Implements RPC-style methods: `agent.*`, `chat.*`, `send.*`, `sessions.*`, `config.*`, `channels.*`, `nodes.*`
- Broadcasts events to all connected clients (health, presence, agent events, cron runs)
- Source: `src/gateway/`

**Messaging Channels**
- Core channels: WhatsApp (Baileys), Telegram (grammY), Discord, Slack, Signal, iMessage
- Extension channels: BlueBubbles, Microsoft Teams, Matrix, Zalo (via plugins in `extensions/`)
- Each channel implements account management, message routing, command gating, media handling
- Source: `src/channels/`, `src/telegram/`, `src/discord/`, `src/slack/`, `src/signal/`, `src/imessage/`, `src/whatsapp/`

**Agent Runtime (Pi Agent)**
- Executes AI reasoning and tool execution loop
- RPC-based communication with Gateway
- Manages model selection, failover, session history, streaming responses
- Supports multi-agent coordination via `sessions_*` tools
- Source: `src/agents/`

**Plugin System**
- Registers tools, channels, providers (OAuth/API keys), hooks, services, gateway handlers, CLI commands
- Global registry pattern with `setActivePluginRegistry()`
- Source: `src/plugins/`, `src/plugin-sdk/`

**Sessions**
- Session files stored in `~/.openclaw/sessions/` (JSONL format with message history)
- Each session has: sessionKey, message history, model/agent preferences, per-session overrides
- Sessions loaded on-demand and cached in gateway memory
- Source: `src/sessions/`

### Message Flow

```
Inbound Message (WhatsApp/Telegram/etc.)
    ↓
Channel Receives → Routes to Session
    ↓
Gateway Broadcast Event (chat.delta, chat.message_end)
    ↓
Pi Agent (RPC Mode) Processes
    ↓
Tool Execution (Browser/Canvas/Nodes/System.run)
    ↓
Response Streaming (Block-level deltas)
    ↓
Outbound Routing (Same channel or alternative)
    ↓
Media Pipeline (Images/Audio/Video processing)
```

### Important Integration Points

**Channel → Gateway → Agent Loop**
- Channels emit `ChatEventBroadcast` events (`chat.delta`, `chat.message_end`)
- Gateway subscribes to agent events via `createAgentEventHandler()`
- Agent events trigger session updates and outbound message routing

**Config-Driven Routing**
- YAML/JSON5 config file loading and validation (`src/config/`)
- Per-channel account configuration
- Per-session routing rules (mention gating, group isolation, activation modes)
- Multi-agent assignment (agents map to workspace directories)
- Config changes trigger hot-reload via `startGatewayConfigReloader()`

**Provider Integration (OAuth/Keys)**
- OAuth flows and credential management (`src/providers/`)
- Credentials stored at `~/.openclaw/credentials/`
- Failover model: multiple auth profiles with round-robin/last-used ordering

**Node/Device Communication**
- Nodes (macOS/iOS/Android) connect as "node" role clients
- Gateway discovers node capabilities via `node.list` and `node.describe`
- Device-local actions (camera, screen recording, system.run) routed via `node.invoke`

### Non-Obvious Architectural Decisions

**Respawning Entry Point**
- `src/entry.ts` respawns process to suppress experimental Node.js warnings
- Normalizes Windows argv handling before CLI parsing

**Embedded Pi Agent Over RPC**
- Agent runs in RPC mode (not in-process)
- Streaming handled at block level (paragraphs/code blocks) rather than character level
- Supports tool streaming and parallel tool execution

**Exec Approval System**
- Bash execution requires explicit approval for security
- Approval forwarding pattern: node initiates, operator approves, node executes
- Approval ID tracking prevents replay attacks

**Lanes/Concurrency Control**
- Sessions can be assigned to concurrency "lanes"
- Prevents unbounded parallelism for expensive operations (model execution, browser control)
- Applied via `applyGatewayLaneConcurrency()`

**Multi-Agent Coordination**
- `sessions_*` tools allow agents to coordinate across sessions
- `sessions_list`, `sessions_history`, `sessions_send` enable cross-session communication

## File Structure

```
src/
├── agents/          # Pi agent runtime, tools, sandbox management
├── browser/         # Browser control (Chrome/Chromium via CDP)
├── canvas-host/     # A2UI canvas host
├── channels/        # Channel manager and routing logic
├── cli/             # CLI entry points and command handlers
├── commands/        # Command implementations (agent, send, gateway, etc.)
├── config/          # Configuration loading, validation, hot-reload
├── cron/            # Scheduled jobs and wakeups
├── daemon/          # Background process management (launchd/systemd)
├── discord/         # Discord channel implementation
├── gateway/         # WebSocket control plane, RPC methods, server
├── hooks/           # Lifecycle hooks (git, user-prompt-submit)
├── imessage/        # iMessage channel (macOS only)
├── infra/           # Infrastructure (Tailscale, Docker, etc.)
├── line/            # LINE channel
├── media/           # Media pipeline (images/audio/video)
├── media-understanding/ # Transcription and media analysis
├── memory/          # Session memory and vector store
├── node-host/       # Node host (device communication)
├── pairing/         # Device pairing and token management
├── plugins/         # Plugin registry and loader
├── plugin-sdk/      # Plugin SDK for extensions
├── process/         # Process management and RPC bridges
├── providers/       # OAuth/API key provider integrations
├── routing/         # Message routing and delivery
├── security/        # Security utilities (sandboxing, permissions)
├── sessions/        # Session management and persistence
├── signal/          # Signal channel
├── slack/           # Slack channel
├── telegram/        # Telegram channel
├── terminal/        # Terminal UI components (palette, tables)
├── tts/             # Text-to-speech (ElevenLabs, node-edge-tts)
├── tui/             # Terminal UI (interactive dashboard)
├── utils/           # Shared utilities
├── web/             # Web UI (Control UI, WebChat)
├── whatsapp/        # WhatsApp channel (Baileys)
└── wizard/          # Onboarding wizard
```

## Key Patterns and Conventions

### TypeScript
- ESM modules (`"type": "module"` in `package.json`)
- Strict type checking enabled
- Target: ES2023, NodeNext module resolution
- Co-located tests: `*.test.ts` next to source files

### Testing
- Framework: Vitest with V8 coverage
- Test naming: match source names with `*.test.ts`; e2e in `*.e2e.test.ts`
- Run full gate before commits: `pnpm lint && pnpm build && pnpm test`
- Pure test additions/fixes generally do NOT need a changelog entry

### Dependency Management
- Use exact versions for patched dependencies (`pnpm.patchedDependencies`)
- No `^` or `~` for patched deps
- Avoid `workspace:*` in plugin `dependencies` (breaks npm install)
- Put `openclaw` in plugin `devDependencies` or `peerDependencies` instead

### File Size Guidelines
- Keep files under ~500 LOC when feasible (not a hard limit)
- Split/refactor as needed for clarity and testability
- Avoid "V2" copies; extract helpers instead

### Tool Schema Guardrails
- Avoid `Type.Union` in tool input schemas (no `anyOf`/`oneOf`/`allOf`)
- Use `stringEnum`/`optionalStringEnum` (Type.Unsafe enum) for string lists
- Use `Type.Optional(...)` instead of `... | null`
- Keep top-level tool schema as `type: "object"` with `properties`
- Avoid raw `format` property names (treated as reserved keyword by some validators)

### Commit and Changelog
- Create commits with `scripts/committer "<msg>" <file...>`
- Follow concise, action-oriented commit messages (e.g., `CLI: add verbose flag to send`)
- Changelog workflow: keep latest released version at top (no `Unreleased`)
- After publishing, bump version and start a new top section
- Include PR # + contributor thanks in changelog entries

## Configuration

Default config location: `~/.openclaw/openclaw.json` (or `.openclaw.json`, `openclaw.yaml`, etc.)

Minimal example:
```json5
{
  agent: {
    model: "anthropic/claude-opus-4-5",
  },
}
```

Full configuration reference: https://docs.openclaw.ai/gateway/configuration

## Common Gotchas

- **Windows paths**: Always use double quotes for paths with spaces in Bash commands
- **Multi-agent safety**: Do NOT create/apply/drop git stash entries, worktrees, or switch branches unless explicitly requested
- **Sandbox mode**: Default tools run on host for `main` session; set `agents.defaults.sandbox.mode: "non-main"` to run non-main sessions in Docker
- **Gateway mode on macOS**: Gateway currently runs only as the menubar app; there is no separate LaunchAgent
- **Rebuild macOS app**: Do not rebuild macOS app over SSH; rebuilds must be run directly on the Mac
- **Version locations**: `package.json`, `apps/android/app/build.gradle.kts`, `apps/ios/Sources/Info.plist`, `apps/macos/Sources/OpenClaw/Resources/Info.plist`
- **A2UI bundle hash**: `src/canvas-host/a2ui/.bundle.hash` is auto-generated; only regenerate via `pnpm canvas:a2ui:bundle` when needed
- **SwiftUI state**: Prefer `Observation` framework (`@Observable`, `@Bindable`) over `ObservableObject`/`@StateObject`

## Security

- **DM pairing**: Default `dmPolicy="pairing"` for unknown senders (Telegram/WhatsApp/Signal/iMessage/Teams/Discord/Slack)
- **Public inbound DMs**: Require explicit opt-in with `dmPolicy="open"` and `"*"` in channel allowlist
- **Exec approval**: Bash execution requires explicit approval; use approval forwarding pattern
- **Sandbox defaults**: Allowlist `bash`, `process`, `read`, `write`, `edit`, `sessions_*`; denylist `browser`, `canvas`, `nodes`, `cron`, `discord`, `gateway`
- Run `openclaw doctor` to surface risky/misconfigured DM policies

## Useful Links

- Full docs: https://docs.openclaw.ai
- Getting started: https://docs.openclaw.ai/start/getting-started
- Architecture overview: https://docs.openclaw.ai/concepts/architecture
- Gateway configuration: https://docs.openclaw.ai/gateway/configuration
- Security guide: https://docs.openclaw.ai/gateway/security
- Troubleshooting: https://docs.openclaw.ai/channels/troubleshooting
