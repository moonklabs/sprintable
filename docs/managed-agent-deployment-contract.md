# Managed agent registry and deployment contract

## Registry baseline

Managed agents are registered in `team_members` with:

- `type = 'agent'`
- `is_active` as the registry lifecycle flag (`true` = registered/active, `false` = inactive)
- `agent_config` validated as:
  - `schema_version: 1`
  - `registration_kind: 'managed'`
  - `default_runtime: 'webhook' | 'openclaw'`

This keeps the registry contract small and explicit while leaving identity fields (`name`, `role`, `webhook_url`) in the existing `team_members` columns.

## Deployment create contract

`POST /api/v1/agent-deployments` accepts:

- `agent_id`
- `name`
- `runtime` (`webhook` or `openclaw`)
- `model`
- `version`
- `persona_id`
- `config`
  - `schema_version: 1`
  - `llm_mode: 'managed' | 'byom'`
  - `provider`
  - `scope_mode: 'org' | 'projects'`
  - `project_ids: string[]`
- `overwrite_routing_rules`

Notes:

- BYOM deployments reuse encrypted project AI credentials. Inline deployment secrets are not part of the persisted contract.
- BYOM deployments are only valid when `config.provider` matches the current project's stored AI credential provider. Provider mismatch must be rejected server-side, and the deploy wizard should keep the BYOM provider aligned with project AI settings.
- The runtime now resolves provider, billing mode, persona, deployment id, and allowed project scope from the deployment row instead of silently falling back to project defaults.

## Deployment state contract

`agent_deployments.status` is the shared lifecycle source of truth:

- `DEPLOYING`
- `ACTIVE`
- `SUSPENDED`
- `TERMINATED`
- `DEPLOY_FAILED`

`PATCH /api/v1/agent-deployments/[id]` supports:

- `ACTIVE`
- `SUSPENDED`
- `DEPLOY_FAILED` with optional persisted failure payload

## Persisted deployment failure evidence

When a deployment enters `DEPLOY_FAILED`, the row must retain:

- `failure_code`
- `failure_message`
- `failure_detail` (structured evidence JSON)
- `failed_at`

This allows the UI, admin flows, and runtime recovery paths to inspect the same failure record without depending on transient logs or webhook payloads.
