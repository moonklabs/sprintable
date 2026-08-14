# fakechat

**Local SSE bridge test harness** — not a product/deployment artifact. `package.json`'s own description says this plainly: "Fake chat MCP plugin — localhost UI for SSE bridge testing".

story #2653 (2026-08-14) reclassified this package after grounding for `[플러그인·사본] packages/fakechat ↔ sprintable-agent-plugins 이중 사본 표류` found it wasn't a competing production implementation drifting behind the real one — it was always a test tool that docs (`docs/runtime-channel-map.md`, `apps/web/src/services/recruit.ts`) had mis-described as "the" Claude Code channel distribution path. That's fixed now: the onboarding kit points Claude Code users at the real distribution (`claude plugin marketplace add moonklabs/sprintable-agent-plugins` → `claude plugin install sprintable@moonklabs`, published from [`moonklabs/sprintable-agent-plugins`](https://github.com/moonklabs/sprintable-agent-plugins)'s `plugins/sprintable`), not this package.

## What this is for

`server.ts` is a real, working MCP stdio shim that dials out to the Sprintable Agent Gateway SSE stream (`GET /api/v2/agent/stream`) and injects inbound messages as `notifications/claude/channel` — same protocol the real plugin speaks. Use it to smoke-test the SSE bridge itself (backend changes to the gateway stream, envelope shape, ack semantics) without needing a full plugin marketplace install:

```
bun run server.ts   # or: bun start
bun smoke.ts         # or: bun run smoke
```

## What this is not

- Not kept in sync feature-for-feature with `plugins/sprintable/server.ts` (the real plugin) — it lags on purpose (`chat_id` explicit reply targeting, HITL `approval_prompt`, attachment support, credential file resolution, envelope rendering, audit logging are all real-plugin-only, per the #2653 grounding doc). Don't point users or automation at this package expecting plugin-parity behavior.
- Not referenced by any launcher, deploy pipeline, or onboarding copy anymore (#2653) — if you find a new reference treating this as a distribution path, that's the bug #2653 fixed, reintroduced; point it at the real plugin instead.
