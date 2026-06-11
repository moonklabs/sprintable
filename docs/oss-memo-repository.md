# OSS memo repository — self-host integrity (story 7a57e7b1)

## Summary

In a **pure OSS build**, `MemoService` has **no memo repository**. `apps/web/src/services/memo.ts`
historically defined the repository as an empty `as any` class:

```ts
const ApiMemoRepository = class { constructor(_db: any) {} } as any;
```

The real implementation is provided only by the **SaaS overlay** (a separate build that shadows
this module), so prod is unaffected. But every OSS runtime path that calls an unconditional
`this.repo.<method>()` crashed with a cryptic `this.repo.X is not a function`.

Story/Epic do not have this problem because their repositories are real (`SupabaseXRepository`
backed by `fastapiCall`). Memo is the only entity with an empty stub.

## ① Stub inventory (`apps/web/src`)

| File:line | Stub | Shadows | Methods |
|---|---|---|---|
| `services/memo.ts` (top) | `ApiMemoRepository` | real repo in SaaS overlay | none (empty) → now explicit fail-fast |

No other empty `as any` repository/client stubs were found under `apps/web/src` (admin client,
storage clients, etc. are real or already guarded).

## ② Crash points

`MemoService` calls `this.repo.<method>` for: `getById` (×7), `getReplies` (×2), `list`,
`create`, `addReply` (×1 each), `resolve` (×2).

**Unconditional (crash in OSS):**

| Method | Notes |
|---|---|
| `list` | direct `this.repo.list(...)` |
| `getById` | direct |
| `addReply` | `repo.getById` + `repo.addReply` |
| `resolve` | `repo.getById` + `repo.resolve` |
| `create` | `fromDb()` passes neither `projectRepo` nor `teamMemberRepo`, so the OSS fallback branch is skipped and it falls through to `repo.create` |

**Guarded (safe in OSS):** `enrichMemo`, `linkDoc`, `markRead` (early-return / throw on `!this.db`),
`getByIdWithDetails` (`repo.getById` inside try/catch with fallback), `dispatchOssReplyWebhooks`
(returns when `!teamMemberRepo`).

**OSS runtime consumers that reach a crash point (11):**

- `slack-outbound-dispatcher` / `discord-outbound-dispatcher` / `teams-outbound-dispatcher` — `recordFailure → addReply`
- `agent-execution-loop` — HITL `addReply`, finalize `addReply` + `resolve`, forward `create`, HITL request `create`
- `agent-builtin-tools` — `resolve_memo → resolve`, `reply_memo`/`add_memo_reply → addReply`
- `bridge-inbound` — `processInboundMessage → create`

## ③ Prescription (this story)

**Graceful guard (shipped).** The empty stub is replaced with an explicit `OssMemoRepositoryStub`
whose methods fail fast with an actionable error, plus a one-time startup `console.warn`. Behaviour
is unchanged (the empty class already threw on every call) — the failure is now legible instead of
`is not a function`, and operators get a clear pointer.

This satisfies the story AC: pure-OSS memo paths fail with an explicit guard + documentation rather
than a cryptic crash, and the SaaS overlay (real repo) is unaffected.

## Durable fix (follow-up, not this story)

Provide a **real OSS memo repository** so self-host memo paths work, mirroring Story/Epic:

- Option A — **FastAPI-backed** `ApiMemoRepository` (like `SupabaseStoryRepository.fastapiCall`),
  delegating memo CRUD to the Python backend. Consistent with the post-OSS-split architecture.
- Option B — **db-client-backed** repository using the supabase-style client already used for reads.

Either removes the 11 crash points and makes agent memo replies, HITL, forwarding, and the
message bridges fully functional in OSS. Recommended: Option A (architecture-consistent).
