# Workflow Templates

Workflow templates let you auto-generate routing rules from pre-defined chain patterns. Instead of manually wiring `AgentRoutingRule` rows, pick a template, map roles to agents, and the system creates the full rule set.

## Concepts

### Chain Patterns

Every template is built from three primitive patterns:

| Pattern | Meaning |
|---------|---------|
| `assign` | Kick off — route the task to a role |
| `submit` | Role signals work is done (e.g., PR submitted) |
| `review` | Another role reviews/approves |

Templates chain these patterns into N-step pipelines.

### System Templates

Four templates ship out of the box:

| Slug | Chain Length | Use Case |
|------|-------------|----------|
| `solo` | 1 | Single assignee, no review |
| `two-step` | 2 | Maker → Reviewer (code review, approvals) |
| `three-step` | 3 | Executor → Reviewer → Final Approver (PO-Dev-QA) |
| `kanban` | 0 | Status-change notifications, role-agnostic |

### role_ref Convention

Steps are identified by `step_1`, `step_2`, `step_3`. When a template is applied, each `step_X` placeholder is replaced with the actual agent and role you supply.

```
rules_template:
  - role_ref: "step_1"        → agent_id: <Dev agent>
    conditions:
      event_params:
        reply_author_role: ["step_1"]  → ["developer"]
    action:
      side_effects:
        - assign_to_role: "step_1"    → "developer"
```

Three substitution paths are resolved automatically:

1. `role_ref` → `agent_id` (top-level rule assignment)
2. `conditions.event_params.*: ["step_X"]` → actual role string
3. `action.side_effects[].assign_to_role: "step_X"` → actual role string
4. `name: "{step_X} …"` → agent name

## API

### List templates

```
GET /api/v2/workflow-templates
```

Returns `WorkflowTemplateListItem[]` (slug, name, description, chain_length, presets, is_system).

### Get template detail

```
GET /api/v2/workflow-templates/{slug}
```

Returns full `WorkflowTemplateResponse` including `steps`, `presets`, `rules_template`.

### Apply template

```
POST /api/v2/workflow-templates/{slug}/apply
```

Request body:

```json
{
  "project_id": "uuid",
  "role_mapping": {
    "step_1": "agent-uuid-1",
    "step_2": "agent-uuid-2"
  },
  "custom_labels": {
    "step_1": "Frontend Dev"
  },
  "overwrite_existing": false
}
```

- `role_mapping` is required for every `role_ref` that appears in `steps`.
- `overwrite_existing: true` deletes existing rules tagged with `from_workflow_template: true` before inserting new ones.
- All agent UUIDs must belong to the calling org (422 otherwise).

Response:

```json
{
  "ok": true,
  "rules_created": 4,
  "rules_deleted": 0
}
```

## Presets

Each template ships named presets that map `step_X` keys to human-readable label strings. Presets are cosmetic — they do **not** auto-select agents. Use them as UX hints in the role-mapping dialog.

```json
"presets": {
  "po-dev-qa": { "step_1": "Developer", "step_2": "Product Owner", "step_3": "QA" }
}
```

## Adding a Custom Template

### Option A — Database INSERT

```sql
INSERT INTO workflow_templates (id, slug, name, description, chain_length, steps, presets, rules_template, is_system, is_enabled)
VALUES (
  gen_random_uuid(),
  'my-template',
  'My Template',
  'Description here',
  2,
  '[{"pattern":"assign","role_ref":"step_1"},{"pattern":"review","role_ref":"step_2"}]',
  '{"my-preset":{"step_1":"Writer","step_2":"Editor"}}',
  '[{"role_ref":"step_1","name":"{step_1} kickoff","priority":10,"match_type":"event","conditions":{"memo_type":["task"],"trigger_type_slugs":["kickoff"]},"action":{"auto_reply_mode":"process_and_report","side_effects":[]}}]',
  false,
  true
);
```

Set `is_system = false` so users can delete it.

### Option B — Alembic Migration

Add a new entry to `SEED_TEMPLATES` in `backend/alembic/versions/0016_add_workflow_templates.py` and run:

```bash
cd backend && alembic upgrade head
```

### Template Schema Reference

| Field | Type | Description |
|-------|------|-------------|
| `slug` | string | Unique identifier (URL-safe) |
| `name` | string | Display name |
| `description` | text | Short description |
| `chain_length` | int | Number of review hops (0 = kanban) |
| `steps` | JSONB array | `[{pattern, role_ref, default_label?}]` |
| `presets` | JSONB object | Named label mappings |
| `rules_template` | JSONB array | Rule prototypes with `role_ref` placeholders |
| `is_system` | bool | `true` = not deletable by users |
| `is_enabled` | bool | `false` = hidden from API |

### rules_template entry schema

```json
{
  "role_ref": "step_1",
  "name": "{step_1} kickoff",
  "priority": 10,
  "match_type": "event",
  "conditions": {
    "memo_type": ["task"],
    "trigger_type_slugs": ["kickoff"],
    "event_params": {
      "reply_author_role": ["step_1"]
    }
  },
  "action": {
    "auto_reply_mode": "process_and_report",
    "side_effects": [
      { "type": "auto_assign", "assign_to_role": "step_1" },
      { "type": "update_status", "target_status": "in-review" }
    ]
  }
}
```

Supported `side_effects` types: `auto_assign`, `update_status`.

## resolve_rules_template

`backend/app/repositories/workflow_template.py` exports `resolve_rules_template(rules_template, role_map)`.

`role_map` shape:

```python
{
  "step_1": {
    "agent_id": "uuid-string",
    "agent_name": "Dev",
    "role": "developer",          # TeamMember.role value
    "persona_id": None,
    "deployment_id": None,
    "target_runtime": "openclaw",
    "target_model": None,
  }
}
```

The function returns a deep copy — original `rules_template` is not mutated.
