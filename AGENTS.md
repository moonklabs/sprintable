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
