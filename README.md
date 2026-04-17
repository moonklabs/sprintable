# 🚀 Sprintable

**AI-powered sprint management for modern development teams.**

Sprintable combines agile project management with AI agents to automate standups, code reviews, meeting notes, and sprint operations — all in one platform.

<p align="center">
  <img src="docs/screenshots/kanban.svg" width="250" alt="Kanban Board" />
  <img src="docs/screenshots/meetings.svg" width="250" alt="Meeting Notes" />
  <img src="docs/screenshots/pricing.svg" width="250" alt="Pricing" />
</p>

## ✨ Features

- **📋 Kanban Board** — Stories, epics, sprints with drag-and-drop
- **🤖 AI Agents** — Automated standups, code reviews, meeting summaries
- **🎙 Meeting Notes** — Browser recording, STT transcription, AI structuring
- **📝 Memos** — Team communication with @mentions and threading
- **📊 Analytics** — Velocity tracking, burndown charts, team workload
- **🎨 Mockup Editor** — Drag-and-drop UI prototyping
- **📄 Docs** — Markdown documentation with version history
- **🏆 Rewards** — Gamified team recognition
- **🔌 MCP Server** — AI agent integration via Model Context Protocol

## 🤖 Bring Your Own Agent (BYOA)

Sprintable is designed to work with any AI coding agent. Connect Claude Code, Codex, Windsurf, Cursor, or any MCP-compatible agent with three values:

| Value | Where to find it |
|-------|-----------------|
| **MCP URL** | `http://localhost:3000/api/mcp` (or your deployed URL) |
| **API Key** | Generate in Settings → Agents |
| **Webhook URL** | `http://localhost:3000/api/webhooks/agent-runtime` |

Once connected, your agent can read and write stories, memos, standups, and docs directly through the MCP tools.

## 🛠 Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | Next.js 15, React 19, Tailwind CSS, next-intl |
| **Backend (OSS)** | Next.js API Routes, SQLite (Node built-in `node:sqlite`) |
| **Backend (SaaS)** | Next.js API Routes, Supabase (Postgres + Auth + Storage) |
| **AI** | OpenAI GPT-4o-mini, Anthropic Claude, Whisper STT |
| **MCP** | @modelcontextprotocol/sdk |
| **Monorepo** | pnpm workspaces, Turborepo |

## 📦 Project Structure

```
sprintable/
├── apps/web/              # Next.js frontend + API routes
├── packages/
│   ├── core-storage/      # Storage interfaces (repository contracts)
│   ├── storage-sqlite/    # SQLite adapter (OSS default)
│   ├── db/                # Supabase migrations + types (SaaS)
│   ├── mcp-server/        # MCP tool server (stdio/SSE)
│   └── shared/            # Shared schemas + utilities
└── docs/                  # Documentation
```

## 🚀 Quick Start

### Prerequisites

**OSS path** (default — no external database needed):
- Node.js >=22.5.0 (required for built-in `node:sqlite`)
- pnpm 9+

**SaaS path** (Supabase-backed):
- Node.js >=22.5.0
- pnpm 9+
- Supabase project (local or cloud)

### Installation

```bash
# Clone
git clone https://github.com/moonklabs/sprintable.git
cd sprintable

# Install dependencies
pnpm install

# Copy environment variables (OSS defaults work out of the box)
cp .env.example apps/web/.env.local

# Start development server
pnpm dev
```

Visit `http://localhost:3000` — in OSS mode, data is stored in SQLite and no external database is required.

For a detailed walkthrough, see [docs/quickstart-oss.md](docs/quickstart-oss.md).

### MCP Server

```
Agent (Claude Code / Codex / Cursor)
  │  stdio / SSE
  ▼
MCP Server  ──(pm-api HTTP)──▶  Sprintable Web App
                                      │
                                      ▼ webhook
                                  Discord / Slack
```

```bash
# stdio mode (for Claude Desktop, Codex, etc.)
PM_API_URL=http://localhost:3000 \
pnpm --filter @sprintable/mcp-server start

# SSE mode (for web clients)
PM_API_URL=http://localhost:3000 \
MCP_MODE=sse MCP_PORT=3100 \
pnpm --filter @sprintable/mcp-server start
```

## 🧪 Development

```bash
pnpm lint          # ESLint
pnpm type-check    # TypeScript
pnpm test          # Vitest
pnpm build         # Production build
```

## 📖 Documentation

- [OSS Quick Start](docs/quickstart-oss.md)
- [Self-Hosting Guide](docs/self-hosting.md)
- [Contributing Guide](CONTRIBUTING.md)
- [Security Policy](SECURITY.md)
- [License](LICENSE)

## 📄 License

**AGPL-3.0** — See [LICENSE](LICENSE) for details.

For commercial licensing (SaaS hosting, white-label, closed-source modifications), contact [license@moonklabs.com](mailto:license@moonklabs.com).

## 🤝 Contributing

We welcome contributions! Please read our [Contributing Guide](CONTRIBUTING.md) before submitting a PR.

---

Built with ❤️ by [Moonklabs](https://moonklabs.com)
