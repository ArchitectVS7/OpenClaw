```markdown
# OpenClaw — Personal AI Assistant

OpenClaw is a self-hosted personal AI assistant that integrates with messaging platforms you already use (WhatsApp, Telegram, Slack, Discord, Google Chat, Signal, iMessage, Microsoft Teams, and more). Built on Node.js with support for Claude and GPT models, it provides a local-first, always-on experience with voice capabilities and interactive Canvas rendering.

<p align="center">
    <picture>
        <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/openclaw-logo-text-dark.png">
        <img src="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/openclaw-logo-text.png" alt="OpenClaw" width="500">
    </picture>
</p>

<p align="center">
  <a href="https://github.com/openclaw/openclaw/actions/workflows/ci.yml?branch=main"><img src="https://img.shields.io/github/actions/workflow/status/openclaw/openclaw/ci.yml?branch=main&style=for-the-badge" alt="CI status"></a>
  <a href="https://github.com/openclaw/openclaw/releases"><img src="https://img.shields.io/github/v/release/openclaw/openclaw?include_prereleases&style=for-the-badge" alt="GitHub release"></a>
  <a href="https://discord.gg/clawd"><img src="https://img.shields.io/discord/1456350064065904867?label=Discord&logo=discord&logoColor=white&color=5865F2&style=for-the-badge" alt="Discord"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
</p>

**Quick Links:** [Website](https://openclaw.ai) · [Documentation](https://docs.openclaw.ai) · [Getting Started](https://docs.openclaw.ai/start/getting-started) · [Discord Community](https://discord.gg/clawd)

## Installation

### Prerequisites

- **Node.js**: v18 or higher
- **Package Manager**: npm, pnpm, or bun
- **Operating System**: macOS, Linux, or Windows (via WSL2 recommended)
- **AI Service**: Anthropic or OpenAI account with API credentials

### Quick Start with Wizard

The fastest way to get started is using the interactive onboarding wizard:

```bash
npm install -g openclaw
openclaw onboard
```

This wizard guides you through:
- Gateway configuration
- Workspace setup
- Channel connections (WhatsApp, Telegram, Slack, Discord, etc.)
- AI model selection and API key configuration
- Skill enablement

### Manual Installation

1. Clone the repository:
```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
```

2. Install dependencies:
```bash
npm install
# or
pnpm install
# or
bun install
```

3. Build the project:
```bash
npm run build
```

4. Start the daemon:
```bash
openclaw daemon
```

### Docker Installation

For containerized deployments, see the [Docker documentation](https://docs.openclaw.ai/install/docker).

### System Updates

To update to the latest version:
```bash
npm update -g openclaw
```

For detailed upgrade instructions, see [Updating OpenClaw](https://docs.openclaw.ai/install/updating).

## Usage

### Core Commands

Start the interactive CLI setup:
```bash
openclaw onboard
```

Launch the daemon (runs the assistant in the background):
```bash
openclaw daemon
```

Check configuration and status:
```bash
openclaw config
```

View available skills:
```bash
openclaw skills list
```

### Model Configuration

OpenClaw supports multiple AI providers. Configure via the wizard or environment variables:

```bash
# Anthropic (Claude)
export ANTHROPIC_API_KEY=your-key-here

# OpenAI (ChatGPT/Codex)
export OPENAI_API_KEY=your-key-here
```

**Recommended setup**: Anthropic Claude Pro/Max with Claude 3.5 Sonnet or newer for best performance with long contexts and prompt-injection resistance.

### Channel Integration

After setup, OpenClaw monitors configured channels for messages. It responds naturally across:

- **Chat Apps**: WhatsApp (via Baileys), Telegram, Slack, Discord, Google Chat, Signal, iMessage, Microsoft Teams
- **Extensions**: BlueBubbles, Matrix, Zalo, Zalo Personal, WebChat
- **Voice**: macOS, iOS, Android with speech recognition and synthesis
- **Interactive**: Canvas UI for real-time control and visualization

### Skills & Extensions

OpenClaw supports extensible skills for custom functionality. Skills are located in the `skills/` directory and loaded automatically during daemon startup.

Enable or disable skills through the configuration:
```bash
openclaw onboard  # Re-run wizard to modify skills
```

## Project Structure

OpenClaw follows a modular architecture:

```
openclaw/
├── dist/                    # Compiled JavaScript output
│   ├── acp/                # Agent Control Protocol
│   ├── agents/             # AI agent implementations
│   ├── auto-reply/         # Automatic response handlers
│   ├── browser/            # Browser integration module
│   ├── canvas-host/        # Interactive Canvas rendering
│   ├── channels/           # Channel adapters (WhatsApp, Telegram, etc.)
│   ├── cli/                # Command-line interface
│   ├── commands/           # CLI command definitions
│   ├── compat/             # Compatibility modules
│   ├── config/             # Configuration management
│   ├── control-ui/         # Web-based control dashboard
│   ├── cron/               # Scheduled task execution
│   ├── daemon/             # Background service
│   ├── discord/            # Discord-specific integration
│   ├── gateway/            # API gateway and routing
│   ├── hooks/              # Lifecycle and event hooks
│   ├── imessage/           # iMessage bridge
│   ├── infra/              # Infrastructure utilities
│   ├── line/               # LINE messenger integration
│   └── ...                 # Additional modules
├── extensions/             # Third-party extensions and plugins
├── skills/                 # Extensible AI skills and capabilities
├── docs/                   # Documentation files
├── scripts/                # Build and utility scripts
├── patches/                # Dependency patches
├── git-hooks/              # Git workflow hooks
├── openclaw.mjs            # CLI entry point
├── package.json            # Project metadata and dependencies
├── CHANGELOG.md            # Version history
└── LICENSE                 # MIT License
```

### Key Modules

- **`channels/`**: Protocol handlers for each messaging platform
- **`agents/`**: Core AI reasoning and response generation
- **`daemon/`**: Long-running process for message monitoring and responses
- **`cli/`**: User-facing command interface and wizard
- **`canvas-host/`**: Real-time interactive UI component
- **`gateway/`**: Request routing and API management
- **`skills/`**: Pluggable capability modules for extensibility

## Model Recommendations

For optimal performance, use:

- **Long-context tasks**: Claude 3.5 Sonnet or Claude 3.5 Opus
- **Code generation**: Claude Opus or Claude 3.5 Sonnet
- **General chat**: Claude Sonnet or GPT-4o
- **Budget-friendly**: Claude Haiku or GPT-4o Mini

Anthropic models offer superior prompt-injection resistance and context management compared to alternatives.

## Configuration

OpenClaw stores configuration in a workspace-based system. The onboarding wizard creates and manages these settings automatically.

Key configuration areas:
- **API Keys**: AI service credentials
- **Channels**: Which messaging platforms to monitor
- **Skills**: Which capabilities to enable
- **Daemon**: Service runtime options

## Troubleshooting

For common issues and their solutions, see the [FAQ](https://docs.openclaw.ai/start/faq).

For development testing and validation, use the included UAT test harness:
```bash
npm run test:uat
```

## Support

- **Documentation**: [docs.openclaw.ai](https://docs.openclaw.ai)
- **Community**: [Discord server](https://discord.gg/clawd)
- **Issues**: [GitHub Issues](https://github.com/openclaw/openclaw/issues)
- **Wiki**: [DeepWiki OpenClaw guide](https://deepwiki.com/openclaw/openclaw)

## License

MIT — See [LICENSE](LICENSE) file for details.

## Contributing

Contributions are welcome! Please see the documentation for development setup and contribution guidelines.

---

**Current Version**: 2026.1.30

OpenClaw is actively developed. Check [releases](https://github.com/openclaw/openclaw/releases) for the latest updates.
```