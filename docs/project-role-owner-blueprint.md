# First-class project role / owner model — blueprint

Status: Draft for review. Epic `44434ce9` (E-MEMBER-POLICY). Foundation for HITL gating (`hitl-gating-policy-v1` §2/§7/§8) — gating permission sits on top of this.
Scope: backend (FastAPI) + migration. Migration merges atomically with a `sprintable-migrate-dev` run (see §8).

## 1. Goal

HITL gating needs a **project owner** who can set per-project gating levels. Today Sprintable has no first-class project role/owner — per the policy decision ("할 거면 제대로") we build it properly rather than proxy it through `can_manage_members`.

AC (from the story):
1. A project owner can be designated.
2. `ProjectAccess.role` becomes a proper enum (`owner` | `admin` | `member`).
3. `can_manage_members` is backfilled into the role mapping.
4. A `project_auth` role helper exists.
5. Existing authorization does not regress.

## 2. Current state (audited)

| Aspect | Reality today | File |
|---|---|---|
| `ProjectAccess.role` | `Text`, default `'member'`, **no CHECK** (free-text) | `models/project_access.py` |
| Is project role enforced for authz? | **No.** Read for the team_members view + agent role-rank only. Resource access never gates on it. | `services/member_resolver.py`, `routers/team_members.py:161` |
| Owner/admin checks | **org-level only** — `org_members.role IN ('owner','admin')`. `_require_owner_or_admin` ignores project role. | `services/project_auth.py`, `routers/project_access.py:44` |
| `can_manage_members` | boolean on `project_access`; enforced **only** at agent member-create (`team_members.py:157`) | |
| Project owner field | **none.** `projects` has no owner. `members.owner_member_id` is the *agent creator*, not a project owner. | `models/project.py`, `models/member.py:41` |
| team_members view `role`/`can_manage_members` | both sourced from `project_access` (all member types) | `0110` view |
| Org→project role | `_effective_role` = **max(org_rank, project_rank)** — so a project `owner` who is an org `member` already surfaces as `owner` in JWT claims (not swallowed). | `routers/auth.py:501` |
| Latest migration | `0121` → next is **0122**, linear `down_revision` chain. CHECK-constraint pattern exists (`members.type IN (...)`). | `alembic/versions/` |

**Summary:** project role data already flows end-to-end (column → view → JWT claim via max-rank), but **nothing authorizes on it** and there is **no owner concept or value constraint**. The gap is: (a) constrain the values, (b) define/assign owners, (c) make authz consult project role, (d) keep org owner/admin working.

## 3. Target model — role on `ProjectAccess` as the single SSOT

**Decision: project role lives on `project_access.role` (enum), and "project owner" = a `project_access` row with `role='owner'`. We do NOT add a `projects.owner_member_id` column.**

Rationale:
- A separate `projects.owner_member_id` would create a **second source of truth** for "who owns the project" alongside `project_access.role`, inviting the dual-SSOT / one-sided-transition traps we have repeatedly hit (members vs team_members, grant vs view). One SSOT.
- `project_access.role` is *already* projected through the team_members view and the JWT effective-role for all member types — building on it means no new read paths.
- Multi-owner is naturally supported (multiple `role='owner'` grants) and per-member, matching how grants already work.
- Trade-off: "the project owner" (singular) becomes a query (`role='owner'` rows) rather than a column. For v1 that is fine; if a *primary* owner is ever needed, add it later as a nullable pointer without moving the SSOT.

Role set (per AC): `owner` > `admin` > `member`. (Org keeps its own `manager` rank; project enum is the three the policy names. `manager` project rows, if any exist, backfill down to `member` — see §4.)

Effective project role for a user = `max_rank(project_access.role, org_members.role-if-owner/admin)`. This preserves the existing org-inheritance (org owner/admin act as owner/admin in every project — 무회귀) while letting an org member be elevated to `owner`/`admin` on a specific project.

## 4. Migration (0122) — prod-safe ordering

Shared dev/prod Cloud SQL: a "dev" migrate hits prod DB too, so the schema change must be **prod-code-compatible before it applies** (see §8). Ordering inside 0122:

1. **Audit + backfill values first (before any constraint).**
   - Normalize `project_access.role` to the enum set: anything not in (`owner`,`admin`,`member`) → `member` (report counts). Audit query must run first to confirm what exists (expected: almost all `member`).
   - `can_manage_members = true` AND `role NOT IN ('owner','admin')` → set `role = 'admin'` (idempotent; never downgrade an existing `owner`). This is AC#3 — the boolean's intent ("can manage members") maps to `admin`.
2. **Assign initial project owners (backfill).** Proposed rule (open question §9): for each project, grant `role='owner'` to the org's owner(s)' project_access rows; if an org owner has no `project_access` row for a project, they still act as owner via org-inheritance (§3), so no row is forced. → net effect: org owners are project owners by inheritance; explicit per-project owners are set going forward via the new endpoint (§7 / S3).
3. **Add the CHECK constraint** `project_access.role IN ('owner','admin','member')` — added `NOT VALID` then `VALIDATE` (two-step, lock-light) after the backfill guarantees conformance.

No column is dropped. `can_manage_members` is **kept** (no-regression) and becomes *derived* (admin/owner ⇒ can manage) — its one enforcement site is migrated to the role helper in a later story, not in this migration.

Pre-merge gate: grep that **no code writes a non-enum value** to `project_access.role` before the CHECK lands (else prod writes 500). Audited writers: `agent_anchor_sync` (`role=team_member.role`), `create_project_access`. Confirm both only ever produce the enum set.

## 5. `project_auth` role helpers (AC#4)

New, in `services/project_auth.py`:
- `get_project_role(session, user_or_member_id, project_id, org_id) -> 'owner'|'admin'|'member'|None` — resolves the **effective** project role = max of the member's `project_access.role` and their org owner/admin floor. `None` if no access.
- `has_project_role(session, user_id, project_id, org_id, *, min_role) -> bool` — rank gate (`owner>admin>member`).
- FastAPI dependency `require_project_role(min_role)` and a convenience `require_project_owner` — mirrors the existing `_require_owner_or_admin` but project-scoped, **additively** (org owner/admin still pass via the floor).

`_ROLE_RANK` is centralized (today duplicated in `auth.py` and `team_members.py`) into one constant the helpers import.

## 6. No-regression strategy (AC#5)

- `has_project_access` unchanged (already includes grant + org owner/admin). 
- `_require_owner_or_admin` (manages project_access grants) stays valid for org owner/admin; **additively** also accepts project `owner`/`admin` for that project (so a project owner can manage their own project's members). Org-only callers keep working.
- `can_manage_members` enforcement (`team_members.py:157`) keeps working as-is in this epic; a follow-up story switches it to `has_project_role(min_role='admin')` once the data is proven.
- The team_members view and `_effective_role` already read `project_access.role`; the only change they see is that values are now constrained — behavior identical for existing `member`/`admin` rows.
- Parity: existing auth/security regression suites (`test_ss4_security_regression`, `test_s_mbr_03`, member-ssot) must stay green; add tests for project-owner elevation + org-owner inheritance.

## 7. API surface

- `PUT /api/v2/projects/{project_id}/access/{member_id}/role` (or extend the existing `POST .../access`) — set a member's project role (`owner`/`admin`/`member`). Guard: project owner or org owner/admin. This is AC#1 ("designate a project owner").
- Reads: project role already surfaces in `GET /api/v2/members` / team-members responses (`role` field). Add `role` to the project_access response if missing.

## 8. Migration discipline (hard rules)

- **Atomic merge + migrate**: do not merge the schema PR without running `sprintable-migrate-dev` immediately after (Cloud Build does NOT auto-run Alembic). `[[no_merge_without_migration]]`.
- **Shared dev/prod DB**: 0122 applies to prod DB on the "dev" migrate. It is **additive + value-backfill + CHECK** — no prod code reads a constrained-away value, and prod writes only enum values (verified §4). Prod Sprintable (`1d3bfded`) behavior unchanged (no project owners assigned there until the product surfaces it).
- Infra actions (running the migrate job, any gcloud) are the PO/infra lane — I prepare and request, per [[feedback_infra_is_po_lane]].

## 9. Open questions for the PO

1. **Initial owner backfill rule** (§4 step 2): rely on org-owner *inheritance* (no forced rows) — OK? Or explicitly stamp a `role='owner'` project_access row per project for each org owner (more rows, explicit)? Recommendation: inheritance, stamp on demand.
2. **`manager` rank**: project enum = `owner/admin/member` only (drop `manager` at project level)? Org keeps `manager`. Confirm.
3. **Who may designate a project owner** (§7): project owner + org owner/admin? Or org owner/admin only for the first owner? 
4. **`can_manage_members` end-state**: keep as derived-and-ignored, or schedule removal once role gating lands (follow-up)?

## 10. Phased delivery (proposed stories)

1. **S1 — schema foundation (migration 0122)**: value backfill + `can_manage_members→admin` mapping + role CHECK. Pre-merge writer audit. *(migration story — merge+migrate atomic)*
2. **S2 — `project_auth` role helpers** + centralized `_ROLE_RANK`. Pure additive, tests for elevation/inheritance.
3. **S3 — designate project role endpoint** (AC#1) + response `role` exposure. Guarded by helper.
4. **S4 — wire `_require_owner_or_admin` to accept project owner/admin** (additive) and migrate `can_manage_members` enforcement to the role helper.

S1 is the only migration-bearing slice; S2–S4 are code-only and independently QA-able. HITL gate-config stories (S-GATE-1+) build on S2/S3.
