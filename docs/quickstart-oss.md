# OSS Quick Start

Run Sprintable locally in OSS mode — SQLite only, no Supabase or Docker required.

## Prerequisites

- Node.js >=22.5.0 (required for built-in `node:sqlite`)
- pnpm 9+

## 1. Clone and Install

```bash
git clone https://github.com/moonklabs/sprintable.git
cd sprintable
pnpm install
```

## 2. Configure Environment

```bash
cp .env.example apps/web/.env.local
```

The defaults in `.env.example` are ready for local OSS use. The key variables:

```bash
APP_BASE_URL=http://localhost:3108
OSS_MODE=true
NEXT_PUBLIC_OSS_MODE=true
SQLITE_PATH=./.data/sprintable.db
AGENT_API_KEY_SECRET=change-me-in-development
PM_API_URL=http://localhost:3108
```

> **Note**: `AGENT_API_KEY_SECRET` is used to sign agent API keys. Change it before any shared or production deployment.

## 3. Start the Dev Server

```bash
pnpm dev
```

Visit `http://localhost:3108`. The SQLite database is created automatically at `.data/sprintable.db` on first run.

## 4. Connect an AI Agent (Optional)

To use the MCP server with Claude Code, Codex, Windsurf, or Cursor:

1. Generate an API key in **Settings → Agents**
2. Start the MCP server:

```bash
PM_API_URL=http://localhost:3108 \
pnpm --filter @sprintable/mcp-server start
```

3. Point your agent at `http://localhost:3108/api/mcp` with the generated API key.

The agent can now read and write stories, memos, standups, and docs.
Completed actions are delivered back to you via webhook — configure **Settings → Agents → Webhook URL** to `http://localhost:3108/api/webhooks/agent-runtime` (or your preferred endpoint).

## 5. Verify

| Check | Expected |
|-------|---------|
| `http://localhost:3108` | Dashboard loads, no login required |
| `http://localhost:3108/api/health` | `{"status":"ok"}` |
| Create a story in the Kanban board | Persisted in `.data/sprintable.db` |

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `node:sqlite not found` | Upgrade to Node.js >=22.5.0 |
| `SQLITE_BUSY` | Another process is using the DB. Restart dev server. |
| Login page appears | Confirm `OSS_MODE=true` and `NEXT_PUBLIC_OSS_MODE=true` are both set |
| Settings → Usage shows error | Normal — usage tracking is disabled in OSS mode |
