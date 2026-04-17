# Tool ACL enforcement

## Operator-managed ACL units

The runtime now enforces tool access from three operator-readable sources:

1. **Deployment project scope**
   - Source: `agent_deployments.config.scope_mode` + `project_ids`
   - Effect: if the current project is outside the deployment scope, the runtime exposes no tools and denies every tool call before execution.

2. **Persona tool allowlist**
   - Source: `agent_personas.config.tool_allowlist`
   - Effect: only allowlisted builtin tools and project-approved MCP tools enter the runtime registry.

3. **Project-approved MCP tool mapping**
   - Source: approved MCP connections and each connection's `allowed_tools`
   - Effect: an external tool must still be approved and mapped at the project level even if the persona allowlist includes it.

## Pre-execution deny reasons

The runtime writes `agent_tool.acl_denied` audit events with one of these stable reason codes:

- `project_not_allowlisted`
- `agent_scope_mismatch`
- `tool_not_allowlisted`
- `project_tool_not_registered`

Each deny event includes the effective ACL boundary (`project_id`, `allowed_project_ids`, `agent_id`, explicit tool names) so operators can trace why a tool was blocked.

## Operator-facing audit trail

The run detail API now returns a `tool_audit_trail` feed sourced from `agent_audit_logs` for the current run.

- Allowed builtin execution is recorded as `agent_tool.executed`
- Allowed external execution is recorded as `agent_tool.external_executed`
- External execution failures are recorded as `agent_tool.external_failed`
- ACL denials are recorded as `agent_tool.acl_denied`

Each record includes run/session identifiers, tool name, tool source, outcome, and an operator-readable summary.

## Audience split for denial UX

ACL denial payloads now separate messages by audience:

- `user_reason`: short explanation safe to surface back to the agent/user flow
- `operator_reason`: deeper configuration/runtime reason for operators
- `next_action`: concrete remediation guidance

This keeps the in-run denial message actionable without hiding the fuller operator diagnosis.

## Execution-path guarantee

Tool ACL is evaluated inside `AgentToolExecutionEngine.execute(...)` before builtin or external tool execution. Prompt exposure and runtime execution now share the same effective registry boundary.
