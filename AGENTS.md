# AGENTS.md — repo-internal conventions for Sprintable's own agents

This file documents conventions used by **this repository's own agent contributors**. It is an internal convenience, **not** a requirement for customers using Sprintable. (Customer-facing contribution notes live in [`CONTRIBUTING.md`](CONTRIBUTING.md).)

## Linking PRs to story gates

Approval gates record the real CI/merge outcome of a story instead of self-report. A live GitHub webhook ([`verdict_capture.py`](backend/app/routers/verdict_capture.py)) parses a story id from PR/CI events and feeds the verdict into that story's gate; when no id resolves, the verdict is skipped and the gate stays `CI unknown (self-report only)`.

The id resolves through [`pr_story_link.py`](backend/app/services/pr_story_link.py), highest priority first: an explicit link (`POST /api/v2/integrations/github/links`, stored in `pull_request_story_link`) outranks every tag, confident auto-match (exact title-slug against a single candidate) outranks SID tags, and partial-token suggestions never close anything. SID tags carry the full 36-character story UUID — a `sid-<uuid>` (or `sid/<uuid>`) segment in the branch name or `[SID:<uuid>]` in the PR body — while short-number tags (`[SID:2288]`, `fix(#2288)`) resolve only inside one org with exactly one match and otherwise skip rather than guess.

When an agent opens a story-backed PR in this repo, link it explicitly in-app and tag both carriers. Put a `sid-<full-story-uuid>` segment in the branch name, e.g. `feat/sid-14744174-35d3-452c-9594-386fc2c3b0ef-gate-ci-linking` — CI events carry only `head_branch`, so the branch is the only carrier for the CI verdict. Put `[SID:<full-story-uuid>]` in the PR body — the PR template has a placeholder; this covers the merge verdict and shows the link to reviewers.

Resolve the full UUID from the story in Sprintable, never the short 8-char id. Tagging stays optional — untagged PRs are skipped gracefully. A non-blocking advisory check ([`sid-link-check.yml`](.github/workflows/sid-link-check.yml)) warns when a PR has neither carrier and never blocks merge.

## Checking whether a PR's CI is actually green

When confirming PR status programmatically, count anything whose `bucket` isn't `pass` as blocking: `gh pr checks <PR> --json name,bucket,link | jq -r '.[] | select(.bucket!="pass" and .bucket!="skipping")'`.

Filtering on `FAILURE` alone misses `CANCELLED`/`TIMED_OUT`/`ACTION_REQUIRED`, which still block the branch-protection merge gate while reading as an empty failures list. `skipping` stays excluded — it marks conditionally-skipped jobs, not blocked ones.

## Live-QA temporary story cards

Live verification sometimes needs a throwaway card to click through or observe SSE against without touching a product story. `DELETE /api/v2/stories/{id}` is human-only by design (agent API keys get 403), so an agent that creates a throwaway card cannot clean it up itself; unmarked cards accumulate on the board and inflate remaining-work counts.

**When creating one:**
- Prefix the title with `[TEMP-QA]`.
- Mark it `is_excluded: true` (`sprintable_update_story` or the equivalent API field) in the same turn, not as a follow-up. The [board/backlog UI](apps/web/src/components/kanban/kanban-board.tsx) hides `is_excluded` cards from every column unconditionally, and `command_center`/analytics exclude them too.

**When cleaning up:**
- You cannot delete the card yourself. Don't leave the request implicit in a chat message that scrolls away — batch pending `[TEMP-QA]` deletions into one bulk-delete request to the PO per branch of work, and search the `[TEMP-QA]` prefix, including any legacy unambiguous markers still on the board, to compile the list.
- Do not request agent delete-permission as a workaround: the human-only block guards against an agent deleting someone else's work, and throwaway-card convenience is not worth trading that away.

## Attaching visual evidence to a Sprintable artifact

`sprintable_create_artifact` takes only `nodes[]` and has no image field, so never embed a screenshot as base64 `<img src="data:...">` inside an `html_blob` node — a ~45KB PNG costs ~60K tokens in the tool call. Use `sprintable_import_image_artifact` instead, a one-shot upload-plus-artifact-create call that works with an agent API key and no browser session.

There is no upload-only flow that returns a URL for a later `sprintable_create_artifact` call: the only agent-reachable endpoint is `POST /api/v2/visual-artifacts/import-image` ([`visual_artifacts.py`](backend/app/routers/visual_artifacts.py)), JSON base64-in and full artifact-out in one call.

- If the file is local to the agent's filesystem, pass `image_path` so the server reads the bytes byte-exact.
- If the agent has Bash/HTTP access and wants to skip the MCP round-trip for a large image, curl the endpoint directly instead of the MCP tool:
  ```
  curl -X POST $SPRINTABLE_API_URL/api/v2/visual-artifacts/import-image \
    -H "Authorization: Bearer $AGENT_API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"title\": \"screenshot\", \"content_type\": \"image/png\", \
         \"image_base64\": \"$(base64 -i screenshot.png | tr -d '\n')\"}"
  ```
  This one call returns a complete artifact (same shape as `get_artifact`) — do **not** also call `sprintable_create_artifact` afterward, there's nothing left to do.
- Reserve `image_base64` (either via the MCP tool or curl above) for small images: the base64 string is re-typed as text and a single wrong character silently corrupts the stored image, so prefer a local file whenever the agent has filesystem access.
