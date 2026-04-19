# Sprintable

Tickets close automatically when PRs merge. Self-host in one command. Local LLM support.

## Getting Started

### Prerequisites

- [Docker Desktop 4.x+](https://www.docker.com/products/docker-desktop/)
- A GitHub repository (for webhook integration)

### Install in 1 minute

```bash
# 1. Clone the repo
git clone https://github.com/moonklabs/sprintable.git
cd sprintable

# 2. Set up environment
cp .env.example .env
# Open .env and set NEXTAUTH_SECRET:
# NEXTAUTH_SECRET=$(openssl rand -base64 32)

# 3. Start
docker compose -f docker-compose.oss.yml up
```

→ Open http://localhost:3000

<!-- screenshot: kanban board with "Hello Sprintable" sample project -->
![Sprintable Board](docs/screenshots/board-sample.png)

On first run, a sample project ("Hello Sprintable") with 3 sample stories is created automatically.

---

## Connect GitHub Webhook (5 steps)

When a PR merges, the linked ticket moves to "Done" automatically.

**Step 1 — Get your webhook URL**

```
http://localhost:3000/api/webhooks/github
```

For a remote server: `https://your-domain.com/api/webhooks/github`

> For local development, expose your port with [ngrok](https://ngrok.com/):
> ```bash
> ngrok http 3000
> ```

**Step 2 — Open your GitHub repo settings**

GitHub repo → **Settings** → **Webhooks** → **Add webhook**

**Step 3 — Configure the webhook**

| Field | Value |
|---|---|
| Payload URL | `http://localhost:3000/api/webhooks/github` |
| Content type | `application/json` |
| Secret | Your `GITHUB_WEBHOOK_SECRET` from `.env` |
| Events | **Let me select individual events** → check **Pull requests** |

**Step 4 — Set the secret**

Copy `GITHUB_WEBHOOK_SECRET` from your `.env` and paste it into the GitHub webhook secret field.

```bash
# If it's not in .env yet, generate one:
echo "GITHUB_WEBHOOK_SECRET=$(openssl rand -hex 32)" >> .env
```

**Step 5 — Verify the connection**

After saving, GitHub sends a ping. If the **"GitHub Connected ✓"** badge appears in the top-right of the board, you're done.

---

## Verify

```bash
# Check the webhook endpoint is alive (no signature → 400 is correct)
curl -X POST http://localhost:3000/api/webhooks/github \
  -H "Content-Type: application/json" \
  -d '{}' \
  -w "\nHTTP %{http_code}\n"
# Expected: HTTP 400 (server is running)
```

Include a ticket ID in your PR title or body to auto-close it:
- `feat: implement login [SPR-42]`
- `closes SPR-42`
- `fixes #SPR-42`

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `connection refused` | Docker not running or port conflict | Start Docker Desktop; check `lsof -i :3000` and kill any conflicting process |
| `localhost:3000` not responding | Mac Docker Desktop bridge network issue | Restart Docker Desktop; or run `docker compose -f docker-compose.oss.yml down && up` |
| `permission denied` on volume | UID mismatch (Linux) | Run `sudo chown -R 1000:1000 ./data` then restart |
| Webhook not firing | Local URL unreachable from GitHub | Use [ngrok](https://ngrok.com/) or deploy to an external server |
| No "GitHub Connected" badge | `GITHUB_WEBHOOK_SECRET` not set | Add `GITHUB_WEBHOOK_SECRET` to `.env` and restart |

Full troubleshooting: [docs/self-hosting.md](docs/self-hosting.md)

---

## Advanced (after first successful run)

<details>
<summary>Claude Code / Cursor MCP integration (AI copilot)</summary>

```json
// .claude/mcp-settings.json or Cursor settings
{
  "mcpServers": {
    "sprintable": {
      "url": "http://localhost:3000/mcp",
      "apiKey": "your-agent-api-key"
    }
  }
}
```

</details>

<details>
<summary>BYOA — Bring Your Own AI key</summary>

Add your preferred LLM key to `.env`:

```bash
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
# Or local Ollama
OPENAI_BASE_URL=http://localhost:11434/v1
OPENAI_API_KEY=ollama
```

</details>

<details>
<summary>Tech stack</summary>

- Next.js 15, TypeScript, Tailwind CSS, shadcn/ui
- SQLite (OSS) / Supabase (Cloud)
- pnpm monorepo

</details>

<details>
<summary>License</summary>

AGPL-3.0 (OSS) + Commercial License.
Commercial use inquiries: dev1@moonklabs.com

</details>
