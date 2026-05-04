# Quick Start

Run Sprintable locally — PostgreSQL + FastAPI + Next.js, one command.

## Prerequisites

- [Docker Desktop 4.x+](https://www.docker.com/products/docker-desktop/)

## 1. Clone

```bash
git clone https://github.com/moonklabs/sprintable.git
cd sprintable
```

## 2. Configure Environment

```bash
cp .env.example .env
```

The defaults in `.env.example` are ready for local use. Key variables:

```bash
APP_BASE_URL=http://localhost:3108
POSTGRES_DB=sprintable
POSTGRES_USER=sprintable
POSTGRES_PASSWORD=change-me
JWT_SECRET=change-me-in-development
SECRET_KEY=change-me-in-development
NEXT_PUBLIC_FASTAPI_URL=http://localhost:8000
```

> **Note**: Set `JWT_SECRET` and `SECRET_KEY` to strong random values before any shared or production deployment.

## 3. Start

```bash
docker compose up -d
```

Visit `http://localhost:3108`. The database is initialized automatically on first run.

## 4. Connect an AI Agent (Optional)

To use the MCP server with Claude Code, Codex, Windsurf, or Cursor:

1. Generate an API key in **Settings → Agents**
2. Add Sprintable as an MCP server:

```json
{
  "mcpServers": {
    "sprintable": {
      "type": "http",
      "url": "http://localhost:3108/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_AGENT_API_KEY"
      }
    }
  }
}
```

The agent can now read and write stories, memos, standups, and docs.
Configure the webhook URL in **Settings → Agents → Webhook URL** so Sprintable can wake your agent when a memo is assigned.

## 5. Verify

| Check | Expected |
|-------|---------|
| `http://localhost:3108` | Dashboard loads |
| `http://localhost:3108/api/health` | `{"status":"ok"}` |
| Create a story in the Kanban board | Persisted in PostgreSQL |

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `connection refused` on port 3108 | Docker not running — start Docker Desktop |
| Port already in use | `lsof -i :3108` and kill the process |
| Database connection error | Check `POSTGRES_PASSWORD` in `.env` matches the container |
| Agent webhook not firing | Confirm agent is active in Settings → Agents |
