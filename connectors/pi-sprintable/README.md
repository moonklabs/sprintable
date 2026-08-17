# sprintable-pi

Sprintable Gateway extension for [Pi](https://github.com/earendil-works/pi) — real-time team chat via SSE dial-out (no inbound webhook required). In-process `ExtensionAPI`, Category A — the same shape as every other Sprintable connector's real npm package (opencode-sprintable, openclaw-sprintable), not the standalone-host pattern `host.py` in this same directory uses (see [Legacy: `host.py`](#legacy-hostpy) below).

## Install

```bash
pi install npm:sprintable-pi
```

Or from a local checkout during development:

```bash
pi install ./connectors/pi-sprintable -l   # -l installs project-locally into .pi/settings.json
```

Then set your Sprintable agent credentials before starting `pi`:

```bash
export SPRINTABLE_API_KEY=sk_live_...       # Sprintable agent API key (required)
export SPRINTABLE_API_URL=https://...       # Backend URL (defaults to https://app.sprintable.ai)
```

Without a key set, the extension registers no handlers at all and does nothing observable — safe to install ahead of configuring credentials.

## How it works

```
pi session starts
  → session_start event
    → runSprintableSSE (vendored SDK) opens GET /api/v2/agent/stream
  → inbound Sprintable message arrives
    → pi.sendUserMessage(content, {deliverAs: "steer"})   — injects as a new turn,
      correctly whether the agent is idle or already mid-turn (Pi's own doc comment:
      "When the agent is streaming, use deliverAs to specify how to queue the message")
  → agent_end event (the turn settles)
    → last assistant message's text extracted → POST /api/v2/conversations/{id}/messages
  → session_shutdown event
    → AbortController.abort() closes the SSE connection
```

- **No idle-wake problem.** Every other Sprintable connector (codex, grok, gemini) spawns
  a *fresh CLI process* to wake an idle session (`<cli> -r <session_id> -p "<msg>"`), which is
  why each of those has had to solve its own idle-wake mechanism (and, in gemini's case, get
  it wrong the first time — see #2561's `--resume` fix). Pi's extension runs **in-process**,
  inside the same running session the whole time, so `sendUserMessage(..., {deliverAs:
  "steer"})` just works uniformly — there's no separate process to wake up.
- Single active conversation tracked per process (mirrors every sibling connector's own
  single-active-conversation pattern) — this extension replies to whichever Sprintable
  conversation most recently sent it a message.
- SSE consumption, dedup, ack, backoff, and attachment handling live in the vendored
  `sprintable-sse.ts` (SDK original: `connectors/sdk/sprintable-sse.ts` — published packages
  can't resolve a monorepo-relative `../sdk/...` import, so a copy ships in this package; see
  [`project_vendored_sdk_sync_debt`] for the tracked follow-up to end this vendoring pattern).

## Verification status

- **Live-verified**: real `pi` CLI, real extension load (isolated project-local install,
  `.pi/settings.json`, zero contact with any global `pi` config), real SSE connection to the
  Sprintable dev backend (`[sprintable-sse] stream open` observed).
- **Boundary-tested, not live end-to-end**: this session's free-tier Google API quota was
  fully exhausted (shared across every tool touching that key today) before a real LLM turn
  could complete through `pi` — same boundary already established for the OpenCode (#2562)
  and OpenClaw (#2563) connectors: this extension's responsibility ends at correctly
  receiving a message and injecting it via `sendUserMessage`; whether the underlying model
  provider is authenticated and actually responds is out of scope. `index.test.ts` proves the
  full logic (SSE receive → `sendUserMessage(steer)` injection → `agent_end` → reply POST)
  against a fake `ExtensionAPI` and a real mock SSE server — no real `pi` binary or LLM call
  needed, and the mocked assistant response round-trips through the exact same `ctx.reply()`
  code path a real turn would use.

## Legacy: `host.py`

`host.py` (Category B — spawns and owns `pi --mode rpc` as a child process) predates the
discovery that Pi's real extension system is in-process (Category A) — this in-process
extension is the correct, publishable shape and the one documented above. `host.py` is kept
as a preserved alternative rather than deleted (same call made for the codex plugin's own
`host.py`-equivalent precedent) — see its own docstring for the JSONL/stdio protocol details
if that standalone-host pattern is ever needed again.
