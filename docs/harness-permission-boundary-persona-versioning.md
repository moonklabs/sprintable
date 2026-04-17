# Harness permission boundary & persona versioning

## Scope

This contract normalizes three operator-facing surfaces for managed personas:

1. Harness permission boundary
2. Persona version publish / rollback metadata
3. Operator-visible change history

## Harness permission boundary

The effective harness boundary is resolved from three layers and exposed as `permission_boundary` on persona responses.

1. `persona.tool_allowlist`
2. project-approved MCP tools / servers
3. runtime tool registry enforcement

`permission_boundary` shape:

```ts
{
  schema_version: 1;
  mode: 'allowlist';
  allowed_tool_names: string[];
  builtin_tool_names: string[];
  external_tool_names: string[];
  mcp_server_names: string[];
  enforcement_layers: [
    'persona.tool_allowlist',
    'project.approved_mcp_tools',
    'runtime.tool_registry',
  ];
}
```

This keeps the contract anchored to the current runtime instead of inventing a second permission system.

## Persona version metadata

Persona rows remain the canonical editable record, but version publish metadata is now stored under `agent_personas.config.version_metadata`.

```ts
{
  schema_version: 1;
  lineage_id: string;
  version_number: number;
  published_at: string | null;
  change_summary: string | null;
  rollback_target_version_number: number | null;
  rollback_source: 'agent_audit_logs';
}
```

Rules:

- create starts at `version_number = 1`
- each publish/update increments `version_number`
- `rollback_target_version_number` points to the immediately previous published version
- rollback evidence lives in audit-log snapshots, not a separate speculative table

## Operator trace surface

Persona create / publish / delete events are written to `agent_audit_logs` with:

- `persona_id`
- `lineage_id`
- `version_metadata`
- `permission_boundary`
- `snapshot`
- `previous_snapshot` when applicable

Persona APIs expose a `change_history` preview derived from those audit records so operators can see the current publish lineage and rollback target in the UI.
