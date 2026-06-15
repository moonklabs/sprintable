# Sprintable Adapter for Hermes Agent

Dial-out gateway adapter that connects a **Hermes Agent** runtime to a Sprintable
project: it holds a long-lived OUTBOUND SSE connection to the Sprintable Agent
Gateway, injects each delivered message into the running Hermes session as a new
turn, posts the agent's reply back, and acks consumed events. No inbound domain,
webhook, or tunnel is required (works behind NAT).

```
GET /api/v2/agent/stream (SSE, long-lived dial-out)
  → _on_event() → handle_message()        # inject as a Hermes turn
  → send() → POST /api/v2/conversations/{id}/messages   # reply
  → _send_ack(seq) → POST /api/v2/agent/events/ack       # advance cursor
```

---

## ⚠️ The gateway adapter is NOT the MCP server

A Hermes agent talks to Sprintable through **two independent channels**. Getting
one working does not mean the other is:

| | Gateway adapter (this plugin) | MCP server (`sprintable` tools) |
|---|---|---|
| Purpose | **Receives** messages, **replies** | Calls PM API tools (create story, send chat, …) |
| Transport | Outbound SSE `GET /api/v2/agent/stream` | MCP stdio / tool calls |
| Auth env | `AGENT_API_KEY` (`sk_live_…`) | `PM_API_KEY`, `PM_API_URL`, `PM_PROJECT_ID` |
| "It works" signal | `stream open` in `gateway.log` + a real reply round-trip | `ping` returns ok |

> **A successful MCP `ping` does NOT mean the agent is connected to the gateway.**
> MCP ping only proves the PM API tools are reachable. If this plugin is not
> loaded and dialed out, the agent will never *receive* a single conversation
> message — it can only push. Verify the gateway side with the checklist below,
> not with an MCP ping.

---

## Requirements

- **Hermes Agent ≥ v0.13.0** — needs the plugin platform registry with the
  `env_enablement_fn` / `cron_deliver_env_var` hooks and `home_channel`
  promotion (introduced in v0.13.0, #21306/#21331). On older builds the plugin
  still injects/replies, but env-only auto-enable, `/sethome` and cron delivery
  won't surface — see [Vendoring fallback](#vendoring-fallback-pre-v0130).
- `httpx` (already a Hermes dependency).
- An agent **API key** (`sk_live_…`) issued by your operator. See the public
  onboarding guide (`apps/web/public/onboarding-guide.txt`, Step 1) for how a
  human operator registers the agent and mints the key — an agent cannot mint
  its own.

---

## Install (full path — do every step)

The plugin folder is **self-contained**: the inject allow-list is vendored into
`adapter.py`, so copying this one folder is enough (no sibling `connectors/sdk`
needed). The earlier "symlink the folder" instruction used to break here because
the adapter imported `sprintable_sse` from `../sdk`, which is absent in a
single-folder install — that is fixed; the folder now loads standalone.

```bash
# 1. Get the adapter onto the machine (full repo checkout OR copy this folder)
git pull origin develop

# 2. Deploy the plugin into the Hermes plugin dir.
#    Copy is the safest for a fresh box; symlink is fine from a full checkout.
cp -r connectors/hermes-sprintable ~/.hermes/plugins/sprintable
#   or, from a full repo checkout:
# ln -sf "$(pwd)/connectors/hermes-sprintable" ~/.hermes/plugins/sprintable

# 3. Enable by the plugin.yaml `name:` — NOT the folder name.
#    The folder is "sprintable"; the plugin name is "sprintable-platform".
hermes plugins enable sprintable-platform

# 4. Configure env (see the env table below).
export AGENT_API_KEY=sk_live_...                       # required
export SPRINTABLE_API_URL=https://app.sprintable.ai    # dev backend if unset

# 5. Restart the gateway so the plugin loads and dials out.
hermes gateway restart

# 6. Confirm the gateway side is actually live (do NOT rely on an MCP ping).
tail -f ~/.hermes/gateway.log    # watch for the lines in the checklist below
```

> Direct (non-Hermes) integration only: if instead of this plugin you build on
> the shared SDK, also copy `connectors/sdk/`. The Hermes plugin does **not**
> need it.

### Enable target gotcha

`hermes plugins enable <X>` takes the **`name:` from `plugin.yaml`**
(`sprintable-platform`), not the install folder name (`sprintable`). Enabling
`sprintable` (the folder) is a silent no-op.

---

## Environment variables — keep the three groups separate

Mixing these three is the most common onboarding failure. They are NOT
interchangeable.

### Group 1 — dev gateway adapter (this plugin)

| Var | Req | Meaning |
|-----|-----|---------|
| `AGENT_API_KEY` | ✅ | Agent API key (Bearer), `sk_live_…` |
| `SPRINTABLE_API_URL` | — | Backend base URL (default: dev backend) |
| `SPRINTABLE_ALLOWED_USERS` | — | Comma-sep member IDs allowed to trigger. **Unset = all** |
| `SPRINTABLE_ALLOW_ALL_USERS` | — | `1` = explicit allow-all (same as unset) |
| `SPRINTABLE_HOME_CHANNEL` | — | Default conversation_id for cron/notify. Usually set via `/sethome` |
| `SPRINTABLE_HOME_CHANNEL_THREAD_ID` | — | Thread id for the home channel |

### Group 2 — prod gateway adapter (separate `hermes-sprintable-prod` plugin)

Install `connectors/hermes-sprintable-prod` **in addition** to run dev and prod
side by side. It is keyed entirely on `SPRINTABLE_PROD_*`
(`SPRINTABLE_PROD_AGENT_API_KEY`, `SPRINTABLE_PROD_API_URL`,
`SPRINTABLE_PROD_HOME_CHANNEL[_THREAD_ID]`) so credentials, home channel and
cron delivery never cross with dev. See
[`../hermes-sprintable-prod/README.md`](../hermes-sprintable-prod/README.md).

### Group 3 — MCP server (PM API tools — a different channel)

`PM_API_URL`, `PM_API_KEY`, `PM_PROJECT_ID`. These configure the `sprintable`
MCP tools, **not** this adapter. Setting them does nothing for message delivery;
setting `AGENT_API_KEY` does nothing for the MCP tools.

---

## Verification checklist (this is the real "connected" test)

Watch `~/.hermes/gateway.log` after `hermes gateway restart`. A healthy onboard
shows every line, in order:

```
[sprintable] Connected — dial-out to https://.../api/v2/agent/stream
[sprintable] stream open
[sprintable] inbound seq=N conv=<id>: <message text>     # after you send a test message
[sprintable] ack seq=N
```

1. **dial-out** line appears → plugin loaded + API key accepted.
2. **stream open** → the SSE connection is live (this, not MCP ping, is "connected").
3. Send a message into a conversation the agent belongs to → **inbound seq=N** appears.
4. The agent replies → exactly **one** message posts back to the conversation.
5. **ack seq=N** appears → cursor advanced.
6. Restart the gateway → on reconnect there is **no re-injection** of already-acked
   messages (no backfill flood). If old messages re-inject, ack is not landing.

If you see `dial-out` but never `stream open`, the API key/URL is wrong. If you
see neither, the plugin did not load — re-check step 3 (enabled by `name:`, not
folder) and the import (`grep -i sprintable ~/.hermes/gateway.log` for a
traceback).

---

## Behaviour notes

- **Session model**: a Sprintable conversation is mapped to a shared Hermes
  *thread* (`chat_type="thread"`, `thread_id == conversation_id`), so all
  participants share one conversation-scoped session instead of Hermes' default
  per-sender group split.
- **Inject allow-list**: only "recommended" event types are injected as work
  turns (`dispatched`, `story_assigned`, `conversation.message_created`,
  `conversation:mention`, `kickoff`, `review_request`, `qa_request`,
  `deploy_request`, `handoff`). FYI events (status changes, etc.) are dropped
  even if they carry text. The canonical list lives in
  `connectors/sdk/sprintable_sse.py` and is vendored here; a contract test
  (`connectors/sdk/test_inject_allowlist.py`) guards the two against drift.
- **Dedup / ack / reconnect**: `event_id` dedup (300s TTL), contiguous ack
  (`seq <= last_acked` is a no-op), `Last-Event-ID` reconnect cursor,
  exponential backoff.
- **One inbound channel only**: if an external webhook (e.g. Discord) is already
  delivering the same conversation, don't also dial out — keep exactly one
  active to avoid double delivery.

---

## Vendoring fallback (pre-v0.13.0)

If you must run an older Hermes that lacks `env_enablement_fn` /
`cron_deliver_env_var` / `home_channel` promotion, the adapter still loads and
injects/replies, but you lose env-only auto-enable, `/sethome` persistence and
`deliver=sprintable` cron routing. Either upgrade to ≥ v0.13.0 (recommended), or
register the platform manually in your gateway bootstrap and set the home
channel directly in `config.yaml`. The inject allow-list is already vendored, so
there is never a `sprintable_sse` import to satisfy.

---

## Files

| File | Role |
|------|------|
| `plugin.yaml` | Hermes plugin metadata (`name: sprintable-platform`) |
| `__init__.py` | Plugin entry point (`register`) |
| `adapter.py` | `SprintableAdapter` — self-contained (allow-list vendored) |
