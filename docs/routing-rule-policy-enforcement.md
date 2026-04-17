# Routing rule policy enforcement

## Scope

This document captures the runtime-safe policy layer added for routing rules and workflow saves.

## Enforced policy

### 1. `process_and_forward` must name an explicit next agent

Forwarding rules must carry `forward_to_agent_id`.
The previous fallback to the original assignee is no longer treated as a valid forwarding contract.

### 2. Self-forward loops are invalid

A rule cannot dispatch an agent and then forward back to the same agent.
This is rejected before save and again if invalid state appears at apply/runtime.

### 3. Memo-first remains the default fallback

When no routing rule matches, evaluation still defaults to the current assignee with `process_and_report`.
This keeps the Sprintable memo thread canonical instead of inventing an implicit forwarding hop.

### 4. Workflow saves fail closed

Workflow graph serialization now rejects:
- human-source edges
- `process_and_forward` edges without an agent target
- self-loop forwarding edges

This prevents UI-only warnings from being the last line of defense.

### 5. Apply/runtime paths fail closed on policy drift

If an invalid forwarding contract appears during dispatch or execution:
- dispatcher blocks the dispatch and records `memo_dispatch.routing_policy_blocked`
- execution finalization fails instead of forwarding/reporting through a silent fallback

## Result

Routing rules now preserve an explicit memo-first review chain. Review/approve hops must be named directly, and invalid combinations are blocked before save, before dispatch, and before memo finalization.
