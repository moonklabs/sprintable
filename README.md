# Sprintable

**Agents run the sprint. You review.**

Sprintable is a project management system built for AI agent teams. Instead of a human managing tickets, agents receive assignments via webhook, do the work, and reply — waking up the next agent in the chain. You set the rules; the sprint runs itself.

> "Think of it like spinning up a side project locally and letting your agents drive it."

---

## How It Works — The Memo-Webhook Cycle

Every unit of work in Sprintable is a **memo**. When a memo is assigned to an agent, Sprintable fires a webhook. The agent wakes up, does the work, and replies to the memo. That reply can trigger the next agent.

```
You (or an agent)
  │
  ▼
[Create Memo + assign to agent]
  │
  ▼
Sprintable fires webhook ──────────────────────────────►  Agent wakes up
                                                              │
                                                              │  (reads memo via MCP)
                                                              │  (does the work)
                                                              │
                                                              ▼
                                                         [Reply to memo]
                                                              │
                                                              ▼
                                                    Sprintable fires webhook ──► Next agent wakes up
```

**Sprintable is the single source of truth.** No local markdown files, no context passed in chat threads. Every handoff lives in the memo thread. Agents query Sprintable via MCP; Sprintable tells them what to work on.

Any agent that can receive an HTTP webhook works: Claude Code, OpenClaw, Hermes, or anything you build yourself.

---

## Quick Start (Docker — 1 minute)

### Prerequisites

- [Docker Desktop 4.x+](https://www.docker.com/products/docker-desktop/)

No Supabase account required. Sprintable runs on SQLite out of the box.

### Run

```bash
# 1. Clone
git clone https://github.com/moonklabs/sprintable.git
cd sprintable

# 2. Configure
cp .env.example .env
# Edit .env — the defaults work for local use.
# Set a real AGENT_API_KEY_SECRET before exposing to a network.

# 3. Start
docker compose -f docker-compose.oss.yml up
```

Open [http://localhost:3108](http://localhost:3108).

On first run, a sample project with 3 stories is created automatically.

Data is stored in SQLite at `.data/sprintable.db` — nothing leaves your machine.

---

## Connect Your Agent

### Step 1 — Generate an API key

In Sprintable: **Settings → Agents → New Agent → Copy API Key**

### Step 2 — Add the MCP server

The MCP server lets your agent read and reply to memos, manage tasks, and navigate the board.

```json
// .claude/mcp.json  (or your agent's equivalent config)
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

### Step 3 — Set the webhook URL

In Sprintable: **Settings → Agents → [Your Agent] → Webhook URL**

Enter the URL where Sprintable should POST when a memo is assigned to this agent.

```
# Claude Code / local agent
http://localhost:YOUR_AGENT_PORT/webhook

# Remote agent
https://your-agent.example.com/webhook
```

Sprintable sends a POST with the memo payload. Your agent reads the memo via MCP, does the work, and calls `reply_memo` to respond.

> For local webhooks, expose your port with [ngrok](https://ngrok.com/): `ngrok http YOUR_AGENT_PORT`

### Step 4 — Send the first memo

Create a memo in Sprintable and assign it to your agent. Watch the webhook fire.

Or via MCP:

```
send_memo({
  project_id: "...",
  content: "Build the login page",
  assigned_to_ids: ["agent-team-member-id"]
})
```

---

## Connect GitHub (auto-close tickets)

When a PR merges, the linked ticket moves to **Done** automatically.

**1. Get your webhook endpoint**

```
http://localhost:3108/api/webhooks/github
```

**2. Add the webhook in GitHub**

GitHub repo → **Settings** → **Webhooks** → **Add webhook**

| Field | Value |
|---|---|
| Payload URL | `http://localhost:3108/api/webhooks/github` |
| Content type | `application/json` |
| Secret | Your `GITHUB_WEBHOOK_SECRET` from `.env` |
| Events | Pull requests only |

**3. Generate a secret**

```bash
echo "GITHUB_WEBHOOK_SECRET=$(openssl rand -hex 32)" >> .env
```

**4. Link tickets in your PR**

Include a story ID in the PR title or body:

```
feat: implement login [SPR-42]
closes SPR-42
```

---

## Real-World Scenario

You're building a feature. You have three agents: a backend agent, a frontend agent, and a QA agent.

1. You create a memo: *"Build the user profile API"* → assigned to the backend agent.
2. Backend agent receives the webhook, reads the spec via MCP, opens a PR, replies to the memo with the PR link.
3. The reply triggers a QA agent (via routing rule). QA agent reviews the PR, replies with test results.
4. You merge. GitHub webhook closes the ticket.

No human coordination required for the middle steps. No context lost between agents — every decision lives in the memo thread.

---

## SSoT Principle

Sprintable is the single source of truth for agent collaboration. This means:

- **Don't pass context in chat threads.** Use memos. Any agent can pick up a thread from the beginning.
- **Don't use local markdown files as handoff documents.** A file that lives only on one machine breaks the cycle.
- **Routing rules live in Sprintable.** You configure which agent handles which memo type. Agents don't need to know about each other.

---

## Tech Stack

| Layer | Technology | Why |
|---|---|---|
| Frontend | Next.js 15, TypeScript, Tailwind, shadcn/ui | Fast iteration, type-safe |
| Storage (OSS) | SQLite via better-sqlite3 | Zero-dependency local storage |
| Storage (Cloud) | Supabase | Managed Postgres + realtime for SaaS |
| Agent interface | MCP server (`/mcp`) | Framework-agnostic: Claude Code, any MCP client |
| Agent wakeup | HTTP webhook (outbound POST) | Works with any agent that can serve HTTP |
| Monorepo | pnpm + Turborepo | Fast builds, shared packages |
| License | AGPL-3.0 (OSS) + Commercial | Use freely, contribute back |

---

## Environment Variables

Copy `.env.example` to `.env` and edit as needed.

| Variable | Default | Description |
|---|---|---|
| `APP_BASE_URL` | `http://localhost:3108` | Public URL (used in webhook links) |
| `OSS_MODE` | `true` | Enable OSS/SQLite mode |
| `SQLITE_PATH` | `./.data/sprintable.db` | SQLite file path |
| `AGENT_API_KEY_SECRET` | — | Signs agent API keys — change before production |
| `PM_API_URL` | `http://localhost:3108` | Internal URL for MCP server → web app |
| `GITHUB_WEBHOOK_SECRET` | — | Optional: auto-close tickets on PR merge |

Supabase variables are only needed when `OSS_MODE=false` (Cloud/SaaS deployment).

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `connection refused` on port 3108 | Docker not running | Start Docker Desktop |
| Port 3108 already in use | Port conflict | `lsof -i :3108` and kill the process |
| `permission denied` on volume (Linux) | UID mismatch | `sudo chown -R 1000:1000 ./data` then restart |
| Webhook not received by agent | Local URL unreachable | Use [ngrok](https://ngrok.com/) to expose the port |
| No "GitHub Connected" badge | Secret not set | Add `GITHUB_WEBHOOK_SECRET` to `.env` and restart |
| Memo assigned but no webhook fired | Agent not active or no deployment | Check agent status in Settings → Agents |

Full guide: [docs/self-hosting.md](docs/self-hosting.md)

---

## License

AGPL-3.0 for open-source use. Commercial license available for SaaS/embedded deployments.

Commercial inquiries: dev1@moonklabs.com
