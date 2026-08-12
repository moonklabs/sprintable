# Session injection envelope — schema (story #2583)

Every connector injects inbound Sprintable events as a new agent turn. This
document is the schema for what that injection must carry — the standard
this repo's connectors are held to, and the contract `formatEnvelopeText()`
(Python: `sprintable_sse.py`, TS: `sprintable-sse.ts`) implements for the
text-only delivery mode below.

## Background

Story #2583 (customer-zero incident, 2026-08-12): an agent misaddressed a
human as a different agent because the injected message carried no sender
identity — the agent could only infer "who's talking" from the previous
turn's sender, and inferred wrong. Investigation (doc
`2583-injection-envelope-recon-20260812`) found the SDK's own parser already
extracts sender correctly in every connector — the defect was every
connector's "build the text/call the host API" step silently dropping it
after that point, plus a structurally identical defect for attachments
(#2568/#2578: presence itself never reached the model).

## Required fields

| Field | Type | Meaning | If unavailable |
|---|---|---|---|
| `event_kind` | string | The event's type (`conversation.message_created`, `story_assigned`, `dispatched`, ...) | literal `"unknown"` — never guessed |
| `sender.name` | string | Display name of who sent this | falls back to `sender.id`, never a blank/omitted field |
| `sender.type` | string | `"human"` or `"agent"` (or whatever the platform's sender-type vocabulary is) | literal `"unknown"` — **never inferred from name or defaulted to `"agent"`** |
| `sender.id` | string | Stable identifier for the sender | `"sprintable"` sentinel if genuinely absent (matches existing SDK fallback) |
| `conversation_id` | string | Which conversation this belongs to | literal `"unknown"` |
| `ts` | string (ISO 8601) | When the event was created | literal `"unknown"` |
| body | string | The message content, with any attachment manifest already merged in (see below) | — |
| attachments manifest | string block | Presence, name, and recovery method (`GET /api/v2/assets/{id}/text`) for each attachment | omitted entirely if there are none — never a fabricated "no attachments" line |

**No-fabrication rule (AC1):** a missing value is rendered as the literal
string `"unknown"` (for the header fields) — never silently omitted, never
guessed from context (e.g. never assume `sender.type = "agent"` because the
name looks like an agent's). An agent reading `"unknown"` knows to say so if
asked, rather than confidently asserting a fabricated identity — this is the
exact failure mode #2583 exists to close.

## Two delivery modes

Connectors split into two groups, discovered during the #2583 recon:

### 1. Text-only injection host APIs

Claude Code channel plugin, Codex/Grok/Gemini Stop-hook `reason` strings,
OpenCode `session.prompt()` `parts[].text`, Pi `sendUserMessage(content)` —
the host API accepts exactly one string. These connectors **must** call
`format_envelope_text(ctx)` / `formatEnvelopeText(ctx)` to build that string
— hand-rolling `ctx.content` alone (the #2583 defect) is the thing this
schema exists to prevent.

Rendered shape (pinned in `test_envelope_format.py` /
`envelope-format.test.ts` — these two must never drift apart, see the
language-boundary comment in each file):

```
[{event_kind}] {sender.name} ({sender.type}) · conv={conversation_id} · ts={ts}
{body}
```

### 2. Structured-native sender APIs

Hermes (`handle_message(..., user_id=, user_name=)`, rendered by the
hermes-agent framework itself as `[sender_name] body`) and OpenClaw
(`rt.inbound.buildContext({..., sender: {id, name}})`) already accept sender
as a first-class parameter on the host's own injection call. These
connectors don't need `formatEnvelopeText()` — the standard for them is
simply: **populate the native field, don't drop it.** Both were confirmed
already doing this correctly as of the #2583 recon.

## Attachments manifest

Already centralized in the SDK (`render_attachment_notice()` /
`renderAttachmentNotice()`, story #2568/#2578) and merged into `ctx.content`
at parse time — `format_envelope_text()` doesn't need to handle attachments
separately, they're already part of the body it renders.

## Sync discipline

`format_envelope_text()` (Python) and `formatEnvelopeText()` (TS) must
render byte-identically for the same input — that's what lets every
connector, regardless of language, produce a consistent envelope. Each
implementation pins the other's exact expected output for a shared sample
input (the #2589 language-boundary pattern) so an edit to one side's
rendering rule breaks that side's own test immediately, rather than drifting
silently (the #2311 vendored-copy-drift class this whole SDK already has to
guard against for the parser itself).

### Cross-repo port list — where to look if the render rule ever changes

This SDK (`connectors/sdk/sprintable_sse.py` / `sprintable-sse.ts`, this
repo) is the canonical implementation. Every other copy below is a **hand
port or a manually-synced vendored copy** — none of them import this file
directly (either a different repo entirely, or a standalone npm/pip package
that can't have a `../sdk` relative import survive publishing). There is no
automated cross-repo guard tying them together; this list *is* the guard.
Changing the render shape (field order, separators, the `"unknown"`
fallback string) means updating **all** of these, not just this file:

| Location | Repo | Kind |
|---|---|---|
| `connectors/sdk/sprintable_sse.py` / `sprintable-sse.ts` | `moonklabs/sprintable` | canonical |
| `connectors/opencode-sprintable/sprintable-sse.ts` | `moonklabs/sprintable` | vendored copy (npm-publish standalone) |
| `connectors/pi-sprintable/sprintable-sse.ts` | `moonklabs/sprintable` | vendored copy (npm-publish standalone) |
| `plugins/sprintable/envelope.ts` | `moonklabs/sprintable-agent-plugins` | hand port (Claude Code channel plugin — no SDK dependency at all) |
| `plugins/sprintable-codex/scripts/envelope.py` | `moonklabs/sprintable-agent-plugins` | hand port |
| `plugins/sprintable-grok/scripts/envelope.py` | `moonklabs/sprintable-agent-plugins` | hand port, itself a manually-synced copy of the codex one (same repo, per-folder packaging boundary — see that file's own comment) |
| `scripts/envelope.py` | `moonklabs/sprintable-gemini` | hand port |

Hermes and OpenClaw are **not** in this list — they use their host runtime's
native structured sender API instead of this text-render contract (see
"Structured-native sender APIs" above), so a render-shape change here
doesn't touch them.
