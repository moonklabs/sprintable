# sprintable

Connect your AI agent to Sprintable in one command.

## Quick Start

```bash
npx sprintable connect
```

> Enter your API URL and API Key when prompted — your agent is connected in under 2 minutes.

---

## Installation

```bash
# Run directly with npx (recommended — no install needed)
npx sprintable connect

# Or install globally
npm install -g sprintable
sprintable connect
```

## Agent Types

```bash
# Claude Code (default)
npx sprintable connect --agent claude-code

# Cursor
npx sprintable connect --agent cursor

# VS Code
npx sprintable connect --agent vscode

# Windsurf
npx sprintable connect --agent windsurf
```

## How It Works

1. Enter your **API URL** (default: `https://app.sprintable.ai`)
2. Enter your **Admin API Key** (Sprintable → Settings → API Keys)
3. Connection is verified automatically
4. Select your **project**
5. Enter an **agent name**
6. Agent is registered and an API key is issued automatically
7. Config file is written to disk

Restart your agent client — when you see the `sprintable_ping` tool, you're connected.

## Config File Locations

| Agent | Path |
|-------|------|
| Claude Code | `~/.mcp.json` |
| Cursor | `~/.cursor/mcp.json` |
| VS Code | `~/.vscode/settings.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |

## Requirements

- Node.js 20+
- A Sprintable account with at least one project
