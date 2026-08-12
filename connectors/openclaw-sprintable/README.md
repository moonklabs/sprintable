# openclaw-sprintable

Sprintable Gateway channel plugin for [OpenClaw](https://github.com/openclaw/openclaw) — real-time team chat via SSE dial-out. No inbound webhook, domain, or tunnel required.

## Install

```bash
openclaw plugins install npm:openclaw-sprintable
```

Or via [ClawHub](https://clawhub.dev) (the primary discovery surface for OpenClaw plugins):

```bash
openclaw plugins install clawhub:openclaw-sprintable
```

**Restart the gateway after install** — plugin installation alone does not start serving:

```bash
openclaw daemon restart   # or: openclaw restart, depending on your setup
```

Verify the plugin is actually loaded and running (install success ≠ serving):

```bash
openclaw plugins inspect sprintable --runtime
```

## Configure

Set credentials in `~/.openclaw/openclaw.json`:

```json
{
  "channels": {
    "sprintable": {
      "enabled": true,
      "apiKey": "sk_live_...",
      "apiUrl": "https://app.sprintable.ai"
    }
  }
}
```

Or via environment variables (`SPRINTABLE_API_KEY` / `AGENT_API_KEY`, `SPRINTABLE_API_URL`) — config takes precedence over env when both are set.

## How it works

```
GET /api/v2/agent/stream (SSE)
  → runSprintableSSE (vendored SDK)
  → onMessage()
  → runtime.channel.inbound.buildContext(...)
  → runtime.channel.inbound.dispatchReply(...)
  → deliver: POST /api/v2/conversations/{id}/messages
  → ack: POST /api/v2/agent/events/ack
```

- Started via `gateway.startAccount` — OpenClaw's documented seam for channels that
  dial out to fetch messages rather than receive an inbound webhook (native ChannelPlugin,
  gateway-daemon-resident, same category as WhatsApp/Telegram).
- `gateway.stopAccount` tears the SSE loop down on channel stop/restart — wired through both
  OpenClaw's own `ctx.abortSignal` and an explicit per-account `AbortController`, matching the
  actual-not-just-declared dispose contract this session's #2578/S7 QA required for the sibling
  OpenCode connector's SDK.
- SSE consumption, dedup, ack, backoff, and attachment handling live in the vendored
  `sprintable-sse.ts` (SDK original: `connectors/sdk/sprintable-sse.ts` — published packages
  can't resolve a monorepo-relative `../sdk/...` import, so a copy ships in this package;
  keep it synced with the canonical SDK when it changes — see [`project_vendored_sdk_sync_debt`]
  for the tracked follow-up to end this vendoring pattern via an SDK-as-npm-package extraction).
- **Concurrent-stream limit per key (tier-aware — free defaults to 3).** The same
  `AGENT_API_KEY`/`SPRINTABLE_API_KEY` can only hold that many simultaneous `/agent/stream`
  connections (abuse/fair-use). If a connection dies ungracefully (`kill -9`, OOM — anything
  that skips `gateway.stopAccount`'s cleanup), its slot is reclaimed automatically after at
  most 90s (`SSE_HEARTBEAT_TIMEOUT`×3, tolerating 2 missed heartbeat ticks) — a **bounded
  self-heal, not a permanent lockout**. A 429 past the limit carries a `Retry-After` reflecting
  the actual time until that scope's soonest slot frees up (story #2582), so retrying after
  that value succeeds without guessing.

## Packaging notes

- **Pure JS ship, no postinstall build.** `openclaw plugins install` runs
  `npm install --ignore-scripts` — this package ships pre-built `dist/*.js` + `.d.ts`
  (via `tsup`), not raw TypeScript. `openclaw.extensions`/`openclaw.setupEntry` point at the
  TS sources (for bundled/dev loads); `openclaw.runtimeExtensions`/`openclaw.runtimeSetupEntry`
  point at the built JS (what installed packages actually load).
- **`openclaw.compat.pluginApi`** is pinned to the exact version this package was built and
  ground-truthed against (`>=2026.7.1`) — a stale/looser floor is what lets a compat gate
  silently install an old, incompatible version instead of failing closed.
- Setup entry (`setup-entry.ts`) exports the plugin object only — no listeners, clients, or
  transport runtimes start from it, per OpenClaw's setup-entry contract.
