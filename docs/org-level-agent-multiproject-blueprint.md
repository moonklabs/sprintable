# Organization-level agents with multi-project access — blueprint

Status: Draft for review (prod story `d2338cc1` / kickoff `1c947ff5`).
Scope: backend (FastAPI). Frontend wiring is a follow-up handed to the FE lane.

## 1. Goal

Today an agent is created bound to exactly one project, and its single API key is treated as project-scoped. The request is:

- Create an agent at the **organization** level.
- One agent (one `members` row, one API key) can **access and participate in multiple projects** in the org.
- With that single API key the agent can: list the projects it is allowed into, and route per-project tickets / memos / events correctly.

Concrete driver: a "뭉크리 Chief of Staff" agent that operates across every project in the org.

## 2. Foundation that already exists

Most of the data layer was already built by the E-MEMBER-SSOT line (`0075`), the view cutover (`0088` → `0106` → `0110`), and `feat(access): agent multi-project access via grants` (PR #1376, `18073a52`). The access model is **grant-as-SSOT**: an agent belongs to a project iff a `project_access` row grants it.

| Capability | Where | Status |
|---|---|---|
| `project_access.member_id` points at an agent member | `models/project_access.py` | ✅ (0075) |
| `has_project_access` agent branch (member_id grant) | `services/project_auth.py:52-64` | ✅ (18073a52) |
| `accessible_project_ids_in_org` agent branch | `services/project_auth.py:225-235` | ✅ |
| `GET /api/v2/projects` returns all granted projects for an agent | `routers/projects.py:23-39` | ✅ |
| `team_members` view surfaces grant-only agents (no profile) | `0110` UNION branch 3 | ✅ |
| `POST /api/v2/projects/{id}/access` accepts agent `member_id` | `routers/project_access.py:93-122` | ✅ |
| **API key has no `project_id` column** (key is identity-scoped, not project-scoped) | `models/api_key.py` | ✅ |

Implication: the key insight — **one API key per agent, project access decided by grants at request time** — is already the committed direction (0110 "A안: grant이 SSOT, 뷰는 surface만"). We do not introduce a new scoping mechanism; we finish wiring the existing one.

## 3. Target model

```
organizations
  └── members (type='agent', id = canonical agent identity)   ← created ONCE at org level
        ├── api_keys (1 active key, member_id = agent id, NO project binding)
        └── project_access (N rows, one per granted project)  ← multi-project membership
              └── role/color/can_manage_members are PER project
        └── agent_project_profiles (0..N rows, per-project runtime: presence, fakechat_port)
```

- **Identity**: one `members` row. Not duplicated per project (no profile proliferation — keeps `members.id` = API-key subject stable).
- **Membership**: `project_access` grants. Adding a project = one grant row. Removing = revoke.
- **Per-project role**: carried on `project_access.role` (already there). This is the seam the upcoming HITL gating / role-owner model (`44434ce9`) plugs into — an org-level agent can be `member` in project A and `manager` in project B without new identity rows.
- **Runtime presence**: `agent_project_profiles` is optional per project. Branch 3 of the view already emits a grant-only agent with NULL runtime columns, so an agent is *discoverable and assignable* in a project even before a profile exists.

## 4. Gaps to close (the delta)

### G1 — Auth pins the API key to a single project (critical)
`dependencies/auth.py:_resolve_api_key` derives `app_metadata.project_id` from the **first** `agent_project_profiles` row (`ORDER BY created_at LIMIT 1`). For a multi-project agent this single pin is misleading and breaks any code that trusts `claims.project_id`.

Direction: for agents, **stop pinning a single project**. Populate `app_metadata.project_ids` (array of granted project ids) and leave `project_id` unset (or null). Project-scoped endpoints already resolve and authorize per request via `get_project_scoped_org_id` → `has_project_access`, which honors the agent grant branch. `require_project_access` (`auth.py:372`) already reads the plural `project_ids` claim and passes legacy tokens through — so this is additive and back-compatible.

Note `member_ssot_apikey_cut` flag gates the anchor path; the change lands behind/with it. Legacy single-project agents keep working (one grant → one-element `project_ids`).

### G2 — Dispatch fan-out drops non-first-project events (correctness)
`services/notification_dispatch.py:185-196` dedupes recipients by `member_id` because the `team_members` view returns one row per (agent, project). For a multi-project agent this picks **one project's** Event and silently drops the rest.

Direction: the multi-recipient notification fan-out must scope to the **triggering** project rather than dedupe to an arbitrary first project. Dedupe by `(member_id, project_id)` for the project in context, or pass the source project_id through and filter the view rows to it. (The *direct* dispatch path — `services/agent_dispatch.dispatch_entity_to_assignee` — already uses the entity's own `project_id`, so single-entity dispatch to a multi-project agent is already correct; the gap is only the multi-recipient `dispatch_notification` fan-out.)

### G3 — No org-level create / grant ergonomics
Agent creation (`POST /api/v2/team-members`) still requires a single `project_id` and `agent_anchor_sync` writes exactly one grant + one profile.

Direction: add an org-level create contract that accepts a project set:
- `scope_mode: 'org' | 'projects'`
- `project_ids: string[]` (ignored/empty when `scope_mode='org'` → grant to all current org projects)

This mirrors the already-documented `agent_deployments.config.scope_mode` (see `docs/managed-agent-deployment-contract.md`) so the managed-deploy layer and the core grant layer speak the same vocabulary. Implementation = create the single `members`/api_key once, then write N `project_access` grants (one per resolved project).

### G4 — Profile not created on later grants
Granting an agent into a new project creates a `project_access` row but no `agent_project_profiles` row. Branch 3 covers discovery/assignment with NULL runtime, but presence (`agent_status`, `fakechat_port`, `last_seen_at`) and per-project `agent_config` are absent.

Direction: on grant, best-effort create a default `agent_project_profiles` row (idempotent, `on_conflict_do_nothing`) so per-project runtime is consistent. Keep it additive — absence must remain non-fatal (Branch 3 stays the safety net).

### G5 — "List my projects" for an agent
Largely solved (`GET /api/v2/projects` + `accessible_project_ids_in_org`). Confirm the agent path returns the full granted set and add an explicit, documented contract for "projects this key may act in" if the FE needs a dedicated shape.

## 5. API surface (proposed)

- `POST /api/v2/agents` (org-scoped create) — body `{ name, role, agent_config?, scope_mode, project_ids[] }` → creates one agent identity + one API key + N grants (+ best-effort profiles). Returns the agent and the plaintext key once.
- `POST /api/v2/projects/{project_id}/access` (exists) — grant/extend an existing agent into one more project (`member_id`).
- `DELETE /api/v2/projects/{project_id}/access/{member_id}` — revoke from a project (confirm exists / add).
- `GET /api/v2/projects` (exists) — the agent lists its accessible projects.
- `GET /api/v2/agents/{id}` — show an org agent and its granted projects + per-project role.

All project-scoped reads/writes continue to flow through `get_project_scoped_org_id` (X-Project-Id / path) → `has_project_access`. No per-endpoint changes needed for authorization.

## 6. Data model / migrations

No new identity tables — the anchor model already supports this. Anticipated migration work is limited to:
- Optional: a partial index supporting `project_access(member_id) WHERE permission='granted'` if grant lookups need it (measure first).
- No schema change is required to *store* multi-project membership — it is already N `project_access` rows.

Per the dev/prod shared-DB rule, any migration must be prod-code-compatible before merge, and runs via the `sprintable-migrate-dev` job (not auto-applied by Cloud Build).

## 7. Auth & security model

- The API key authorizes an **identity**, not a project. Every project-scoped action is authorized at request time by `has_project_access` against live grants — so revoking a grant takes effect immediately (no key reissue).
- Cross-project isolation is preserved: an agent can only act in projects it has a `granted` row for; `get_verified_org_id` keeps it inside its org.
- Tool ACL / scope (`api_keys.scope`) remains orthogonal and per-key.

## 8. Phased delivery (proposed stories)

1. **S1 — Auth de-pin (G1)**: emit `project_ids` for agents, stop single `project_id` pin; regression-test legacy single-project agents. *(low risk, unblocks everything)*
2. **S2 — Dispatch fan-out per-project (G2)**: fix `dispatch_notification` dedupe to be project-correct; test a 2-project agent receives both projects' events. *(correctness)*
3. **S3 — Org-level create (G3)**: `POST /api/v2/agents` with `scope_mode`/`project_ids`; reuse `agent_anchor_sync` to fan out grants.
4. **S4 — Grant ergonomics + profile-on-grant (G4)** and revoke endpoint.
5. **S5 — List/show contracts (G5)** + FE handoff.

S1 and S2 are independently shippable and each guarded by tests; S3–S5 build the ergonomics on top.

## 9. Open questions for the PO

1. `scope_mode='org'` semantics: grant to **all current** projects only, or auto-grant **future** projects too? (The latter needs a hook on project-create.)
2. Default per-project role for an org-level agent — `member` everywhere, or settable per grant at create time?
3. Should an org-level agent be hidden from / shown in each project's member roster by default? (View already surfaces it once granted.)
4. Billing/quotas: is an org-level agent counted once, or per granted project?

## 10. Relationship to HITL gating / role-owner model (`44434ce9`)

The per-project `project_access.role` and the `members.owner_member_id` (agent's creator) are the exact fields the HITL gating / role-owner work will lean on. An org-level agent therefore wants **per-project** role resolution (already available) rather than a single global role — designing S1–S3 around `project_access.role` keeps this blueprint forward-compatible with that line and avoids a second identity refactor.
