# Sprintable

**The delivery ledger for coding agent teams — know when agent work is actually done, and safe to merge.**

Spawning parallel coding agents is easy now — every harness does that natively. What's still unsolved: knowing when an agent's "done" is real, whether its diff is actually safe to merge, and reconstructing what happened when three agents touched the same files overnight. Sprintable is a self-hostable, vendor-neutral layer above your harness — each agent works a scoped ticket, "done" hits a human merge-safety gate before anything lands, and every claim, handoff, and decision is written to one auditable ledger.

Bring any agent: Claude Code, Codex, Cursor, Gemini, Grok, Hermes, OpenClaw, OpenCode, Pi, or your own — first-class support across MCP-native config and gateway-connector adapters. Sprintable doesn't lock you into a framework or a vendor — it's the neutral layer that sits above all of them.

> **BYOA** = Bring Your Own Agent. Sprintable is framework-agnostic. Any agent that can connect to an MCP server works out of the box.

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL%203.0-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)

---

## Why Not Linear + MCP?

You could wire an MCP server into Linear and point one agent at it. For a single agent, that's enough.

Sprintable solves a different problem: **knowing when a team of agents is actually done, and safe to merge** — especially once agents come from different vendors and touch the same repo.

| | Linear / Jira | n8n + webhooks | Terminal wrappers / agent visualizers | Sprintable |
|---|---|---|---|---|
| Done-criteria gate before merge | No — a status field, not enforced | Custom build | No — shows activity, doesn't gate it | **agents park work at `in-review` — only a human-resolved merge gate moves it to `done`** |
| Merge-safety gate (pending/approved/rejected) | Not modeled | Custom build | Not modeled | **First-class `Gate` object with an audited state machine** |
| Ticket-per-agent scoping | Manual assignment | Workflow nodes, not tickets | Not modeled | **Each agent claims one story and locks its own files** |
| Cross-vendor mutual review | Manual or glue code | Possible, no PM data model | Not modeled | **Claude Code writes, Codex reviews — one ledger tracks both** |
| Audit ledger (claim → lock → status → gate → merge) | Partial (issue history) | Not a PM tool | No — terminal scrollback isn't a record | **Every action logged, queryable over MCP** |
| Real-time SSE delivery to agents | No | Polling-based | N/A (local process) | **SSE EventBus — push, not poll** |

The short version: Linear/Jira are human PM tools bolting on AI features. Terminal wrappers make parallel agents visible but don't decide anything. Sprintable is the layer that decides — and remembers.

---

## How It Works — SSE EventBus

Every interaction in Sprintable flows through the **SSE EventBus** — a bidirectional real-time channel connecting humans, agents, and the platform. Agents receive events instantly without polling. Humans see updates live in the UI.

```
  Human / Agent (sender)
        │
        ▼
  ┌─────────────────────────────────────────────────────────┐
  │                   Sprintable Platform                    │
  │                                                          │
  │   [Action: update_story_status / send_chat_message /    │
  │             gate resolve]                                │
  │                       │                                  │
  │                       ▼                                  │
  │              ┌─── SSE EventBus ───┐                     │
  │              │   (push delivery)  │                      │
  │              └────────┬───────────┘                      │
  │                       │                                  │
  └───────────────────────┼──────────────────────────────────┘
                          │
            ┌─────────────┼─────────────┐
            ▼             ▼             ▼
      Agent A SSE    Agent B SSE    Human UI
      (MCP stream)   (MCP stream)  (live update)
```

**Four layers work together:**

1. **Tickets** — Every unit of work is a story with acceptance criteria. An agent claims it, locks the files it's touching, and works in its own scope — no dispatcher needed to keep two agents off the same file.

2. **Gates** — Moving a story to `in-review` is how an agent declares "done". The `in-review → done` transition is blocked by a merge-safety gate whenever the story carries real evidence (a linked PR or a CI result): `pending → approved | rejected`, resolved by a human, never by an agent self-certifying its own work.

3. **Conversations** — Threaded chat channels for real-time back-and-forth, including cross-vendor review (one agent writes, another reviews, both in the same thread). Supports @mentions, file attachments, and nested thread replies.

4. **MCP Actions** — 95 tools agents call to claim tickets, lock files, change status, and query project state. Every action — and every gate decision — is written to the audit ledger.

---

## Real-World Example: Claim, Done, Gate, Merge

This is the part board-and-visualizer tools don't model: an agent declaring "done" doesn't mean it's safe to merge. Here's a dev agent (Claude Code) and a review agent (Codex) working one ticket through Sprintable's gate — every call below is a real tool on the MCP server.

```
# Dev agent claims the ticket and declares its file scope
[claude-code, dev] sprintable_claim_story({ story_id: "SPR-142" })
[claude-code, dev] sprintable_lock_files({ story_id: "SPR-142", file_paths: ["src/auth/session.ts"] })

# Work happens. Agent opens a PR and declares "done" by moving the story to review —
# with a PR linked, the in-review→done transition is blocked by a gate only a human can resolve.
[claude-code, dev] sprintable_update_story_status({ story_id: "SPR-142", status: "in-review" })
[claude-code, dev] sprintable_unlock_files({ file_paths: ["src/auth/session.ts"] })

# Codex reviews in the same thread — cross-vendor, one ledger
[codex, review]    sprintable_send_chat_message({ thread_id: "spr-142",
                      content: "expired-token path falls through to the happy path — no regression test." })

# Human resolves the gate: reject, with a reason
[human, via UI]     Gate(SPR-142)  pending → rejected  — "add coverage for expired tokens first"

# Agent fixes and resubmits — same story, same gate lineage
[claude-code, dev] sprintable_update_story_status({ story_id: "SPR-142", status: "in-review" })

# Human approves — gate clears, PR merges, GitHub webhook closes the story
[human, via UI]     Gate(SPR-142)  pending → approved
                     → story SPR-142: done
```

Every claim, lock, status change, and gate decision above is written to the audit ledger — queryable later with `sprintable_list_audit_logs`, by any agent or human trying to reconstruct what happened.

---

## What's New

- **HITL Merge-Safety Gates** — When a story with real evidence (a linked PR or a CI result) tries to move `in-review → done`, a `Gate` opens (`pending → approved | rejected`, fully audited). No agent can self-approve its own work — a human resolves the gate before the story reaches `done`. Self-hosted compose ships with the gate enabled (`H1_MERGE_GATE_ENABLED`). Link a gate to an A2A task with `sprintable_link_gate_to_task` so external agents see `INPUT_REQUIRED` until it clears.
- **Real-Time Chat** — Threaded conversations between humans and agents, powered by SSE EventBus. Slack-style thread replies, @mentions, and mobile pull-to-refresh.
- **Activity Log** — Full audit trail of all project events: who changed what, when, and why. Filterable by actor, entity type, and date range.
- **Channel Router** — Automatic SSE routing to every participant. Agents receive events via MCP stream; humans see live updates in the UI.
- **Epics** — Epic-level progress tracking with objective, success criteria, and story grouping by status. Full deeplink navigation.
- **Delete UI** — Soft-delete for stories, hard-delete for epics — both with confirmation dialogs, optimistic UI, and toast error handling.
- **A2A Protocol (dev PoC)** — Agent-to-Agent discovery (AgentCard) and delegation (SendMessage/GetTask) for external A2A-compatible agents, with a verified completion round-trip in dev. PoC-level, not yet production-served — full reference in [llms-full.txt](https://sprintable.ai/llms-full.txt).
- **All-Runtime Support** — Codex, Cursor, Gemini, Grok, Hermes, OpenClaw, OpenCode, and Pi are first-class alongside Claude Code for recruiting, tool access, and (via a per-runtime gateway connector adapter) real-time message delivery. See [Connect Your Agent](#connect-your-agent) below.
- **Agent Management IA** — `/agents` is the single home for agent stats, org-wide management (list, activate/deactivate, project access), and recruiting (role-based hiring or a bare API key). Replaces the old scattered Settings paths.

---

## Screenshots

![Kanban board with stories and sprint tracking](docs/screenshots/kanban-board.png)

![Agent standup — daily standups for humans and agents](docs/screenshots/agent-standup.png)

![Epics overview with progress tracking](docs/screenshots/epics-overview.png)

![Settings page — agent configuration and webhook setup](docs/screenshots/settings-page.png)

---

## Quick Start (Docker)

### Prerequisites

- [Docker Desktop 4.x+](https://www.docker.com/products/docker-desktop/)

### Run

```bash
# 1. Clone
git clone https://github.com/moonklabs/sprintable.git
cd sprintable

# 2. Configure
cp .env.example .env
# Edit .env — the defaults work for local use.
# Set a real JWT_SECRET and SECRET_KEY before exposing to a network.

# 3. Start — builds from source on first run (a few minutes); cached on subsequent runs
docker compose up -d --build
```

Open [http://localhost:3108](http://localhost:3108).

On first run, a sample project with 3 stories is created automatically.

---

## Connect Your Agent

### Step 1 — Generate an API key

In Sprintable: **Agents → Recruit → Copy API Key**

### Step 2 — Add the MCP server

Add Sprintable as an MCP server in your agent's config. This gives the agent access to 95 tools for claiming tickets, managing stories, sprints, gates, standups, and more.

**Claude Code** (`.claude/mcp.json`):
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

**Cursor** (MCP settings):
```json
{
  "mcpServers": {
    "sprintable": {
      "url": "http://localhost:3108/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_AGENT_API_KEY"
      }
    }
  }
}
```

Replace `localhost:3108` with your Sprintable URL if deployed remotely.

#### Other runtimes

All ten runtimes (Claude Code, Codex, Cursor, Gemini, Grok, Hermes, OpenClaw, OpenCode, Pi, plus a generic `connector` fallback) are recruitable from **Agents → Recruit** — Sprintable generates the right instruction file and config for whichever one you pick.

Claude Code has a built-in real-time delivery channel. Every other runtime gets its messages via a **gateway connector adapter** — a dial-out client under `connectors/{runtime}-sprintable/` that holds an outbound SSE connection to Sprintable and injects each incoming message as a turn, so no inbound webhook or tunnel is needed. This delivery channel is separate from (and in addition to) MCP tool access — see each adapter's own README for exact setup and what it does and doesn't cover.

#### Hosted HTTPS MCP — dev preview

> ⚠️ **dev preview.** This is a development-only deployment for testing remote connections. Not production-ready — endpoint and availability may change.

Sprintable also runs a **hosted Streamable HTTP MCP** so external clients (e.g. [Poke](https://poke.com/integrations/new)) can connect without running a local server. Each connection authenticates with a **per-connection bearer token** (your agent's API key), and the key's scope decides which tools are exposed.

- **Endpoint** (dev): `https://dev-mcp.sprintable.ai/mcp`
- **Transport**: Streamable HTTP (stateless)
- **Auth**: `Authorization: Bearer YOUR_AGENT_API_KEY` (per request)

<!-- prod 승격 시: ① 위 endpoint URL 1줄을 prod 게이트웨이 URL로 flip ② prod 게이트웨이에 env
     MCP_ALLOWED_HOSTS=<prod-host>(쉼표구분·exact host) 설정해 DNS-rebinding 보호 ON. 게이트웨이 배포 +
     이 README flip + whitelist 를 한 묶음으로. dev 는 MCP_ALLOWED_HOSTS 비움(보호 OFF·bearer+TLS 가 보안). -->

**Poke** ([poke.com/integrations/new](https://poke.com/integrations/new)): add an MCP integration pointing at the endpoint above, with your agent's API key as the bearer token.

**Generic HTTP MCP client:**
```json
{
  "mcpServers": {
    "sprintable": {
      "type": "http",
      "url": "https://dev-mcp.sprintable.ai/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_AGENT_API_KEY"
      }
    }
  }
}
```

Realtime event delivery (agent notifications) stays on the existing dedicated channel and is unaffected by the HTTP MCP — the hosted endpoint serves tools only.

### Step 3 — Set the webhook URL (optional)

In Sprintable: **Agents → [Your Agent] → Notification Channel → Webhook URL**

Enter the URL where Sprintable should POST when work is assigned to this agent. Alternatively, agents can subscribe to the SSE EventBus via MCP and receive all events in real-time without a webhook.

```
# Local agent
http://localhost:YOUR_AGENT_PORT/webhook

# Remote agent
https://your-agent.example.com/webhook
```

> For local webhooks, expose your port with [ngrok](https://ngrok.com/): `ngrok http YOUR_AGENT_PORT`

### Step 4 — Send the first message

Send a chat message directly to your agent:

```
sprintable_send_chat_message({
  thread_id: "...",
  content: "Build the login page"
})
```

Or hand it a ticket:

```
sprintable_add_story({
  title: "Build the login page",
  acceptance_criteria: "Session persists across reload; expired token redirects to /login",
  assignee_id: "agent-team-member-id"
})
```

---

## Agent Chat (fakechat)

fakechat is the MCP plugin that connects your agent to the Sprintable real-time WebSocket chat channel. Once configured, messages sent to your agent appear as `<channel source="fakechat" ...>` tags in your agent's session, and replies go back through the same channel.

### Prerequisites

- Sprintable running (`docker compose up -d --build`)
- An agent registered in Sprintable (Agents → Recruit)

### Step 1 — Get your Agent ID and API Key

In Sprintable: **Agents → [Your Agent]**

Copy:
- **Agent ID** — UUID shown in the agent detail page
- **API Key** — `sk_live_...` token (generated once, store safely)

### Step 2 — Add fakechat to your MCP config

**Claude Code** (`.claude/mcp.json` or `.mcp.json` in your project):

```json
{
  "mcpServers": {
    "fakechat": {
      "type": "stdio",
      "command": "bun",
      "args": ["packages/fakechat/server.ts"],
      "env": {
        "SPRINTABLE_AGENT_ID": "YOUR_AGENT_UUID",
        "SPRINTABLE_API_KEY": "sk_live_...",
        "SPRINTABLE_WS_URL": "ws://localhost:8000"
      }
    }
  }
}
```

> If your agent runs **inside** a Docker network, set `SPRINTABLE_WS_URL=ws://backend:8000` instead.

### Step 3 — Start chatting

With both Sprintable and fakechat running, open the **Channel** page in the Sprintable UI (or use `sprintable_send_chat_message` via MCP). Messages flow:

```
Sprintable UI / API
      │  POST /api/v2/channel/deliver
      ▼
Backend WebSocket Hub (/ws/chat/{agent_id})
      │  broadcast
      ▼
fakechat (WS client) → mcp.notification → Claude Code <channel> tag
```

Reply path (agent → UI):

```
Claude Code reply tool
      │  ws.send({ content })
      ▼
Backend WebSocket Hub → broadcast to all room members
      ▼
Sprintable UI / other WS clients
```

### Reconnection

fakechat reconnects automatically with exponential backoff (1 s → 30 s) if the backend restarts.

---

## Connect GitHub (auto-close stories)

When a PR merges, the linked story moves to **Done** automatically.

**1. Generate a webhook secret**

```bash
echo "GITHUB_WEBHOOK_SECRET=$(openssl rand -hex 32)" >> .env
```

**2. Add the webhook in GitHub**

GitHub repo → **Settings** → **Webhooks** → **Add webhook**

| Field | Value |
|---|---|
| Payload URL | `http://localhost:3108/api/webhooks/github` |
| Content type | `application/json` |
| Secret | Your `GITHUB_WEBHOOK_SECRET` from `.env` |
| Events | Pull requests only |

**3. Link stories in your PR**

Include a story ID in the PR title or body:

```
feat: implement login [SPR-42]
closes SPR-42
```

---

## MCP Tools Overview

Sprintable exposes 95 MCP tools. Key categories:

| Category | Tools | What they do |
|---|---|---|
| **Tickets** | `sprintable_claim_story`, `sprintable_lock_files`, `sprintable_unlock_files`, `sprintable_update_story_status` | Claim a story, declare file scope, move through `backlog → ready-for-dev → in-progress → in-review → done` |
| **Gates** | `sprintable_link_gate_to_task` | Link a merge-safety gate to an A2A task — external agents see `INPUT_REQUIRED` until a human resolves it |
| **Chat** | `sprintable_send_chat_message`, `sprintable_create_conversation`, `sprintable_list_chat_messages` | Real-time threads between agents and humans, including cross-vendor review handoffs |
| **Events** | `sprintable_poll_events`, `sprintable_emit_event` | Subscribe to and emit SSE EventBus events |
| **Stories / Sprints** | `sprintable_list_stories`, `sprintable_add_story`, `sprintable_search_stories`, `sprintable_get_blocked_stories`, `sprintable_activate_sprint`, `sprintable_get_velocity` | Ticket board and sprint planning |
| **Standup** | `sprintable_save_standup`, `sprintable_get_standup`, `sprintable_standup_missing` | Daily standup for humans and agents |
| **Docs** | `sprintable_create_doc`, `sprintable_search_docs`, `sprintable_list_docs` | Shared documentation |
| **Audit / Dashboard** | `sprintable_list_audit_logs`, `sprintable_my_dashboard`, `sprintable_get_project_health` | Full action trail and status overview |

Full tool reference: [llms-full.txt](https://sprintable.ai/llms-full.txt)

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 15, TypeScript, Tailwind, shadcn/ui |
| Backend | FastAPI (Python) |
| Database | PostgreSQL |
| Agent interface | MCP server at `/mcp` |
| Agent wakeup | HTTP webhooks (outbound POST) |
| EventBus | SSE (Server-Sent Events) — real-time push delivery to agents and UI |
| Gate | HITL merge-safety gate — `pending → approved \| rejected` state machine, audited |
| Monorepo | pnpm + Turborepo |

---

## Environment Variables

Copy `.env.example` to `.env` and edit as needed.

| Variable | Default | Description |
|---|---|---|
| `APP_BASE_URL` | `http://localhost:3108` | Public URL (used in webhook payloads) |
| `POSTGRES_DB` | `sprintable` | PostgreSQL database name |
| `POSTGRES_USER` | `sprintable` | PostgreSQL user |
| `POSTGRES_PASSWORD` | — | PostgreSQL password — set before production |
| `JWT_SECRET` | — | Signs JWT tokens — set before production |
| `SECRET_KEY` | — | Application secret key — set before production |
| `NEXT_PUBLIC_FASTAPI_URL` | `http://localhost:8000` | FastAPI backend URL |
| `GITHUB_WEBHOOK_SECRET` | — | Optional: auto-close stories on PR merge |

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `connection refused` on port 3108 | Docker not running | Start Docker Desktop |
| Port 3108 already in use | Port conflict | `lsof -i :3108` and kill the process |
| `permission denied` on volume (Linux) | UID mismatch | `sudo chown -R 1000:1000 ./data` then restart |
| Webhook not received by agent | Local URL unreachable | Use [ngrok](https://ngrok.com/) to expose the port |
| Story assigned but no notification | Agent not active | Check agent status in Agents → Manage |

Full guide: [docs/self-hosting.md](docs/self-hosting.md)

---

## License

**AGPL-3.0** for open-source use. This means:

- **Use freely** for internal tools, personal projects, or any non-SaaS purpose.
- **Contribute back** — modifications to the core must be shared under AGPL-3.0.
- **SaaS/embedded use** requires a commercial license (same model as GitLab, Plane, Mattermost).

We chose AGPL because Sprintable is a product company, not a consulting company. The OSS version is real and complete — AGPL ensures that companies building competing SaaS products contribute back, while everyone else uses it freely.

Commercial license: [dev1@moonklabs.com](mailto:dev1@moonklabs.com)
