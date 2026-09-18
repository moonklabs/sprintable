# AGENTS.md — repo-internal conventions for Sprintable's own agents

This file documents conventions used by **this repository's own agent contributors**.
It is an internal convenience, **not** a requirement for customers using Sprintable.
(Customer-facing contribution notes live in [`CONTRIBUTING.md`](CONTRIBUTING.md).)

## Linking PRs to story gates (gate CI evidence)

Sprintable's approval gates record the **real** CI/merge outcome of a story instead of
self-report. A live GitHub webhook (`app/routers/verdict_capture.py`) parses a story id
from PR/CI events and feeds the verdict into that story's gate via
`capture_pr_ci_verdict` → `resolve_gate_from_verdict`. If no story id is found, the
verdict is skipped and the gate stays `CI unknown (self-report only)`.

The id is matched by `_SID_RE` in `app/services/verdict_capture.py` as a **fallback
chain** — any one of these, when present, links the gate:

1. **Explicit link** (planned, convention-free — product surface; tracked separately).
2. **Branch name** — a `sid-<full-uuid>` / `sid/<full-uuid>` segment.
3. **PR body** — a `[SID:<full-uuid>]` tag.

None is mandatory; untagged PRs are handled gracefully (skipped).

### Convention for our agents (fast internal unblock)

When an agent opens a story-backed PR in this repo, tag it so its gate gets real CI
evidence:

- **Branch** — include a `sid-<full-story-uuid>` segment, e.g.
  `feat/sid-14744174-35d3-452c-9594-386fc2c3b0ef-gate-ci-linking`.
  This is the **primary carrier for CI evidence**: CI webhook events (`workflow_run`,
  `check_suite`, `status`) carry only `head_branch` — not the PR title/body — so the
  branch is the only reliable carrier for the *CI* verdict.
- **PR body** — include `[SID:<full-story-uuid>]` (the PR template has a placeholder).
  This covers the *merge* verdict and shows the link to reviewers.

Notes:
- Use the **full 36-character story UUID**, not the short 8-char id — `_SID_RE` requires
  the full UUID. Resolve it from the story in Sprintable.
- A non-blocking advisory check (`.github/workflows/sid-link-check.yml`) emits a warning
  when a PR has neither carrier. It never blocks merge.

## Checking whether a PR's CI is actually green (story #2285)

When confirming PR status programmatically, count anything whose `bucket` isn't `pass`
as blocking: `gh pr checks <PR> --json name,bucket,link | jq -r '.[] | select(.bucket!="pass" and .bucket!="skipping")'`.
Filtering on `conclusion == "FAILURE"` alone misses `CANCELLED`/`TIMED_OUT`/`ACTION_REQUIRED` —
those read as an empty "failures" list even though the check is not passing (PR #2570,
2026-07-28: a `Backend pytest` run hit its 25-minute ceiling and was cancelled, and a
`FAILURE`-only filter reported zero failures). GitHub's branch-protection merge gate
already treats non-`SUCCESS` conclusions as blocking regardless of this tooling gap — the
risk here is a human/agent being told "clear to merge" by a script when the actual gate
is still red. `skipping` is excluded — it's a conditionally-skipped job (e.g. "Main
Alembic preflight" when its precondition doesn't apply), not a blocked one.

## Live-QA temporary story cards (story #2187)

Live verification sometimes needs a real story to click through/observe SSE against,
without touching an actual product story. `DELETE /api/v2/stories/{id}` is human-only
(agent API keys get 403) by design — an agent that creates a throwaway card **cannot
clean it up itself**. Without a convention, these accumulate on the board forever and
inflate "how much is left" counts (exactly the class of defect this story reports).

**When creating one:**
- Prefix the title with `[TEMP-QA]` (or an equally unambiguous marker — existing
  examples use `[TEST-PROBE·삭제예정]` / `[삭제 대상 — ...]`, `[TEMP-QA]` is preferred
  going forward for grep-ability).
- Immediately mark it `is_excluded: true` (`sprintable_update_story` or the equivalent
  API field) — do this in the same turn you create the card, not as a follow-up. The
  board/backlog UI (`kanban-board.tsx`, story #2187) filters `is_excluded` cards out of
  every column unconditionally, so this is what actually keeps the card from inflating
  visible counts; `command_center`/analytics already excluded it before this story.

**When cleaning up:**
- You cannot delete it yourself. Don't leave the request implicit in a chat message that
  will scroll away — batch pending `[TEMP-QA]` deletions and ask the PO for a bulk
  delete once per branch of work (not per-card), e.g. at the end of a live-verification
  session. `gh`/Sprintable search for the `[TEMP-QA]` prefix to compile the list.
- Do not request agent delete-permission as a workaround (rejected direction — see story
  #2187 AC4: the human-only block is an intentional safeguard against an agent deleting
  someone else's work, and throwaway-card convenience isn't worth trading that away).

## Attaching visual evidence (screenshots/images) to a Sprintable artifact (story #2707, path corrected story #3767)

`sprintable_create_artifact` only takes `nodes[]` (html/tree structure) — there's no
`image` field. Don't embed a screenshot as base64 `<img src="data:...">` inside an
`html_blob` node; a ~45KB PNG becomes ~60K tokens in the tool call. Use
`sprintable_import_image_artifact` instead — a one-shot upload+artifact-create tool made
exactly for this (agent API key, no browser session needed).

There is **no** separate "upload-only, get a URL back, then call
sprintable_create_artifact" flow — no such bare-upload endpoint exists on the backend
for agents (story #3767: an earlier version of this doc pointed at a non-`v2`,
multipart form of this same path — that variant doesn't exist for agents; the only
backend endpoint reachable with an agent API key is
`/api/v2/visual-artifacts/import-image`, and it's JSON base64-in, **full artifact**-out
in one call, not a bare URL).

- If the file is local to the agent's filesystem: call `sprintable_import_image_artifact`
  with `image_path` — the server reads the bytes directly (no re-typing, byte-exact).
- If the agent has Bash/HTTP access and wants to skip the MCP round-trip for a large
  image, curl the same endpoint directly instead of the MCP tool:
  ```
  curl -X POST $SPRINTABLE_API_URL/api/v2/visual-artifacts/import-image \
    -H "Authorization: Bearer $AGENT_API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"title\": \"screenshot\", \"content_type\": \"image/png\", \
         \"image_base64\": \"$(base64 -i screenshot.png | tr -d '\n')\"}"
  ```
  This one call returns a complete artifact (same shape as `get_artifact`) — do **not**
  also call `sprintable_create_artifact` afterward, there's nothing left to do.
- Only use `image_base64` (either via the MCP tool or curl above) for small images —
  the base64 string is typed/re-typed as text, and a single wrong character silently
  corrupts the stored image (real incident, story #3753). Prefer `image_path`/a local
  file whenever the agent has filesystem access.
