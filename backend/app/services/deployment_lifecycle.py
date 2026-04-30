"""Agent deployment lifecycle service — S41 FastAPI port."""
from __future__ import annotations

import hashlib
import hmac
import json
import time
import uuid
from datetime import datetime, timezone
from typing import Any

import httpx
from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agent_deployment import AgentAuditLog, AgentDeployment, AgentPersona
from app.models.agent_run import AgentRun
from app.models.team import TeamMember
from app.models.webhook_config import WebhookConfig
from app.schemas.agent_deployment import (
    AgentDeploymentResponse,
    DeploymentCardResponse,
    DeploymentFailureInput,
    DeploymentFailureSignal,
    DeploymentMutationResponse,
    DeploymentPreflightResponse,
)

ACTIVE_STATUSES = ("DEPLOYING", "ACTIVE", "SUSPENDED")
TRANSITIONS: dict[str, list[str]] = {
    "DEPLOYING": ["ACTIVE", "SUSPENDED", "DEPLOY_FAILED", "TERMINATED"],
    "ACTIVE": ["SUSPENDED", "DEPLOY_FAILED", "TERMINATED"],
    "SUSPENDED": ["ACTIVE", "DEPLOY_FAILED", "TERMINATED"],
    "DEPLOY_FAILED": ["DEPLOYING", "TERMINATED"],
    "TERMINATED": [],
}


class DeploymentLifecycleError(Exception):
    def __init__(self, code: str, status: int, message: str, details: dict | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.status = status
        self.details = details or {}


# ---------------------------------------------------------------------------
# Webhook dispatch
# ---------------------------------------------------------------------------

def _build_signature_headers(secret: str | None, body: str) -> dict[str, str]:
    if not secret:
        return {}
    ts = str(int(time.time() * 1000))
    sig = hmac.new(secret.encode(), f"{ts}.{body}".encode(), hashlib.sha256).hexdigest()
    return {
        "X-Sprintable-Signature": f"sha256={sig}",
        "X-Sprintable-Timestamp": ts,
    }


async def _fire_webhooks(session: AsyncSession, org_id: uuid.UUID, event: str, data: dict[str, Any]) -> None:
    result = await session.execute(
        select(WebhookConfig.url, WebhookConfig.secret, WebhookConfig.events)
        .where(WebhookConfig.org_id == org_id, WebhookConfig.is_active.is_(True))
    )
    configs = result.all()
    if not configs:
        return

    payload_obj = {"event": event, "data": data}
    body = json.dumps(payload_obj)

    async with httpx.AsyncClient(timeout=10.0) as client:
        for row in configs:
            url, secret, events = row
            if events and event not in events:
                continue
            headers = {"Content-Type": "application/json", **_build_signature_headers(secret, body)}
            try:
                await client.post(url, content=body, headers=headers)
            except Exception:
                pass


# ---------------------------------------------------------------------------
# Routing template helpers
# ---------------------------------------------------------------------------

def _resolve_persona_role(slug: str | None, base_slug: str | None) -> str:
    val = (base_slug or slug or "").strip().lower()
    if val == "product-owner":
        return "product-owner"
    if val == "developer":
        return "developer"
    if val == "qa":
        return "qa"
    return "unknown"


def _build_routing_template(agents: list[dict], existing_rule_count: int) -> dict[str, Any]:
    seen: set[str] = set()
    deduped = []
    for a in agents:
        if a["agentId"] not in seen:
            seen.add(a["agentId"])
            deduped.append(a)

    po = next((a for a in deduped if a["role"] == "product-owner"), None)
    dev = next((a for a in deduped if a["role"] == "developer"), None)
    qa = next((a for a in deduped if a["role"] == "qa"), None)

    if len(deduped) <= 1 and dev:
        return {"templateId": "solo-dev", "rules": [], "requiresOverwriteConfirmation": False, "existingRuleCount": existing_rule_count}

    if not po or not dev:
        return {"templateId": "none", "rules": [], "requiresOverwriteConfirmation": False, "existingRuleCount": existing_rule_count}

    template_id = "po-dev-qa" if qa else "po-dev"
    roles = ["product-owner", "developer", "qa"] if qa else ["product-owner", "developer"]
    meta: dict[str, Any] = {"auto_generated": True, "template_id": template_id, "generated_from_roles": roles}
    rules = [
        {"agent_id": str(po["agentId"]), "persona_id": po.get("personaId"), "deployment_id": po.get("deploymentId"), "name": f"{po['agentName']} auto route requirement/user_story", "priority": 10, "match_type": "event", "conditions": {"memo_type": ["requirement", "user_story"]}, "action": {"auto_reply_mode": "process_and_report", "forward_to_agent_id": None}, "target_runtime": "openclaw", "target_model": None, "is_enabled": True, "metadata": meta},
        {"agent_id": str(dev["agentId"]), "persona_id": dev.get("personaId"), "deployment_id": dev.get("deploymentId"), "name": f"{dev['agentName']} auto route task/dev_task", "priority": 20, "match_type": "event", "conditions": {"memo_type": ["task", "dev_task"]}, "action": {"auto_reply_mode": "process_and_report", "forward_to_agent_id": None}, "target_runtime": "openclaw", "target_model": None, "is_enabled": True, "metadata": meta},
    ]
    if qa:
        rules.append({"agent_id": str(qa["agentId"]), "persona_id": qa.get("personaId"), "deployment_id": qa.get("deploymentId"), "name": f"{qa['agentName']} auto route review", "priority": 30, "match_type": "event", "conditions": {"memo_type": ["review"]}, "action": {"auto_reply_mode": "process_and_report", "forward_to_agent_id": None}, "target_runtime": "openclaw", "target_model": None, "is_enabled": True, "metadata": meta})

    return {"templateId": template_id, "rules": rules, "requiresOverwriteConfirmation": existing_rule_count > 0, "existingRuleCount": existing_rule_count}


async def _replace_routing_rules(session: AsyncSession, org_id: uuid.UUID, project_id: uuid.UUID, actor_id: uuid.UUID, rules: list[dict]) -> None:
    await session.execute(
        text("SELECT replace_agent_routing_rules(:org_id, :project_id, :actor_id, CAST(:rules AS jsonb))"),
        {
            "org_id": str(org_id),
            "project_id": str(project_id),
            "actor_id": str(actor_id),
            "rules": json.dumps(rules),
        },
    )


# ---------------------------------------------------------------------------
# Main service
# ---------------------------------------------------------------------------

class DeploymentLifecycleService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def _get_agent(self, org_id: uuid.UUID, project_id: uuid.UUID, agent_id: uuid.UUID) -> TeamMember:
        r = await self.session.execute(
            select(TeamMember).where(
                TeamMember.id == agent_id,
                TeamMember.org_id == org_id,
                TeamMember.project_id == project_id,
                TeamMember.type == "agent",
            )
        )
        agent = r.scalar_one_or_none()
        if not agent:
            raise DeploymentLifecycleError("AGENT_NOT_FOUND", 404, "Agent not found in current project")
        return agent

    async def _get_deployment(self, org_id: uuid.UUID, project_id: uuid.UUID, deployment_id: uuid.UUID) -> AgentDeployment:
        r = await self.session.execute(
            select(AgentDeployment).where(
                AgentDeployment.id == deployment_id,
                AgentDeployment.org_id == org_id,
                AgentDeployment.project_id == project_id,
                AgentDeployment.deleted_at.is_(None),
            )
        )
        dep = r.scalar_one_or_none()
        if not dep:
            raise DeploymentLifecycleError("DEPLOYMENT_NOT_FOUND", 404, "Deployment not found in current project")
        return dep

    async def _get_persona(self, org_id: uuid.UUID, project_id: uuid.UUID, agent_id: uuid.UUID, persona_id: uuid.UUID) -> AgentPersona:
        r = await self.session.execute(
            select(AgentPersona).where(
                AgentPersona.id == persona_id,
                AgentPersona.org_id == org_id,
                AgentPersona.deleted_at.is_(None),
            )
        )
        persona = r.scalar_one_or_none()
        if not persona:
            raise DeploymentLifecycleError("PERSONA_NOT_FOUND", 404, "Persona not found in the current organization")
        if persona.is_builtin and (persona.project_id != project_id or persona.agent_id != agent_id):
            raise DeploymentLifecycleError("PERSONA_NOT_FOUND", 404, "Persona not found for this agent in the current project")
        return persona

    async def _assert_no_duplicate_live(self, org_id: uuid.UUID, project_id: uuid.UUID, agent_id: uuid.UUID, exclude_id: uuid.UUID | None = None) -> None:
        q = select(AgentDeployment.id).where(
            AgentDeployment.org_id == org_id,
            AgentDeployment.project_id == project_id,
            AgentDeployment.agent_id == agent_id,
            AgentDeployment.deleted_at.is_(None),
            AgentDeployment.status.in_(ACTIVE_STATUSES),
        )
        if exclude_id:
            q = q.where(AgentDeployment.id != exclude_id)
        r = await self.session.execute(q)
        if r.scalar_one_or_none():
            raise DeploymentLifecycleError("DUPLICATE_AGENT_DEPLOYMENT", 409, "A live deployment already exists for this agent in the current project")

    async def _count_routing_rules(self, org_id: uuid.UUID, project_id: uuid.UUID) -> int:
        r = await self.session.execute(
            text("SELECT COUNT(*) FROM agent_routing_rules WHERE org_id = :org_id AND project_id = :project_id AND deleted_at IS NULL"),
            {"org_id": str(org_id), "project_id": str(project_id)},
        )
        return r.scalar_one() or 0

    async def _list_live_deployments(self, org_id: uuid.UUID, project_id: uuid.UUID) -> list[AgentDeployment]:
        r = await self.session.execute(
            select(AgentDeployment).where(
                AgentDeployment.org_id == org_id,
                AgentDeployment.project_id == project_id,
                AgentDeployment.deleted_at.is_(None),
                AgentDeployment.status.in_(ACTIVE_STATUSES),
            )
        )
        return list(r.scalars().all())

    async def _preview_routing_template(self, org_id: uuid.UUID, project_id: uuid.UUID, pending_agent: dict) -> dict[str, Any]:
        live = await self._list_live_deployments(org_id, project_id)
        rule_count = await self._count_routing_rules(org_id, project_id)

        agent_ids = {d.agent_id for d in live}
        persona_ids = {d.persona_id for d in live if d.persona_id}
        if pending_agent.get("personaId"):
            persona_ids.add(uuid.UUID(str(pending_agent["personaId"])))

        agent_name_by_id: dict[uuid.UUID, str] = {}
        if agent_ids:
            r = await self.session.execute(
                select(TeamMember.id, TeamMember.name).where(TeamMember.id.in_(agent_ids))
            )
            agent_name_by_id = {row.id: row.name for row in r.all()}

        persona_by_id: dict[uuid.UUID, AgentPersona] = {}
        if persona_ids:
            r2 = await self.session.execute(
                select(AgentPersona).where(AgentPersona.id.in_(persona_ids), AgentPersona.deleted_at.is_(None))
            )
            persona_by_id = {p.id: p for p in r2.scalars().all()}

        def _get_base_persona_id(persona: AgentPersona | None) -> uuid.UUID | None:
            if not persona or not isinstance(persona.config, dict):
                return None
            bpid = persona.config.get("base_persona_id")
            if isinstance(bpid, str) and bpid.strip():
                try:
                    return uuid.UUID(bpid)
                except ValueError:
                    return None
            return None

        base_persona_ids = {_get_base_persona_id(p) for p in persona_by_id.values() if _get_base_persona_id(p)}
        base_persona_by_id: dict[uuid.UUID, AgentPersona] = {}
        if base_persona_ids:
            r3 = await self.session.execute(
                select(AgentPersona).where(AgentPersona.id.in_(base_persona_ids), AgentPersona.deleted_at.is_(None))
            )
            base_persona_by_id = {p.id: p for p in r3.scalars().all()}

        def _resolve_role(dep_persona_id: uuid.UUID | None) -> str:
            persona = persona_by_id.get(dep_persona_id) if dep_persona_id else None
            base_pid = _get_base_persona_id(persona)
            base_persona = base_persona_by_id.get(base_pid) if base_pid else None
            return _resolve_persona_role(
                persona.slug if persona else None,
                base_persona.slug if base_persona else None,
            )

        agents = [
            {
                "agentId": str(d.agent_id),
                "agentName": agent_name_by_id.get(d.agent_id, str(d.agent_id)),
                "role": _resolve_role(d.persona_id),
                "personaId": str(d.persona_id) if d.persona_id else None,
                "deploymentId": str(d.id),
            }
            for d in live
        ]
        agents.append(pending_agent)

        return _build_routing_template(agents, rule_count)

    async def _log_audit(self, org_id: uuid.UUID, project_id: uuid.UUID, agent_id: uuid.UUID, event_type: str, severity: str, payload: dict) -> None:
        log = AgentAuditLog(
            org_id=org_id,
            project_id=project_id,
            agent_id=agent_id,
            event_type=event_type,
            severity=severity,
            summary=event_type,
            payload=payload,
        )
        self.session.add(log)
        await self.session.flush()

    async def _hold_queued_runs(self, deployment_id: uuid.UUID) -> int:
        r = await self.session.execute(
            update(AgentRun)
            .where(AgentRun.deployment_id == deployment_id, AgentRun.status == "queued")
            .values(status="held", result_summary="Queued run held while deployment is suspended")
            .returning(AgentRun.id)
        )
        return len(r.all())

    async def _resume_held_runs(self, deployment_id: uuid.UUID) -> int:
        r = await self.session.execute(
            update(AgentRun)
            .where(AgentRun.deployment_id == deployment_id, AgentRun.status == "held")
            .values(status="queued", result_summary="Queued run resumed after deployment activation")
            .returning(AgentRun.id)
        )
        return len(r.all())

    async def _fail_queued_runs(self, deployment_id: uuid.UUID, error_code: str, message: str) -> int:
        now = datetime.now(timezone.utc)
        r = await self.session.execute(
            update(AgentRun)
            .where(AgentRun.deployment_id == deployment_id, AgentRun.status.in_(["queued", "held"]))
            .values(status="failed", last_error_code=error_code, result_summary=message, finished_at=now)
            .returning(AgentRun.id)
        )
        return len(r.all())

    async def run_deployment_preflight(
        self,
        org_id: uuid.UUID,
        project_id: uuid.UUID,
        agent_id: uuid.UUID,
        name: str,
        runtime: str | None,
        model: str | None,
        version: str | None,
        persona_id: uuid.UUID | None,
        config: dict | None,
        overwrite_routing_rules: bool | None,
        actor_id: uuid.UUID,
    ) -> DeploymentPreflightResponse:
        checked_at = datetime.now(timezone.utc).isoformat()
        blocking_reasons: list[str] = []
        warnings: list[str] = []
        routing_preview: dict[str, Any] = {"templateId": "none", "rules": [], "requiresOverwriteConfirmation": False, "existingRuleCount": 0}

        try:
            agent = await self._get_agent(org_id, project_id, agent_id)
            if not agent.is_active:
                blocking_reasons.append("Cannot deploy to an inactive agent")

            persona = None
            if persona_id:
                try:
                    persona = await self._get_persona(org_id, project_id, agent_id, persona_id)
                except DeploymentLifecycleError as e:
                    blocking_reasons.append(str(e))

            persona_slug = persona.slug if persona else None
            persona_role = _resolve_persona_role(persona_slug, None)

            routing_preview = await self._preview_routing_template(org_id, project_id, {
                "agentId": str(agent_id),
                "agentName": agent.name,
                "role": persona_role,
                "personaId": str(persona_id) if persona_id else None,
                "deploymentId": None,
            })

            if routing_preview["rules"] and routing_preview["requiresOverwriteConfirmation"] and not overwrite_routing_rules:
                blocking_reasons.append("Existing routing rules require explicit overwrite confirmation before applying an automatic template")

            try:
                await self._assert_no_duplicate_live(org_id, project_id, agent_id)
            except DeploymentLifecycleError as e:
                blocking_reasons.append(str(e))

        except DeploymentLifecycleError as e:
            blocking_reasons.append(str(e))

        return DeploymentPreflightResponse(
            ok=len(blocking_reasons) == 0,
            checked_at=checked_at,
            blocking_reasons=blocking_reasons,
            warnings=warnings,
            routing_template_id=routing_preview.get("templateId", "none"),
            routing_rule_count=len(routing_preview.get("rules", [])),
            existing_routing_rule_count=routing_preview.get("existingRuleCount", 0),
            requires_routing_overwrite_confirmation=routing_preview.get("requiresOverwriteConfirmation", False),
            mcp_validation_errors=[],
        )

    async def create_deployment(
        self,
        org_id: uuid.UUID,
        project_id: uuid.UUID,
        agent_id: uuid.UUID,
        actor_id: uuid.UUID,
        name: str,
        runtime: str | None = None,
        model: str | None = None,
        version: str | None = None,
        persona_id: uuid.UUID | None = None,
        config: dict | None = None,
        overwrite_routing_rules: bool | None = None,
    ) -> DeploymentMutationResponse:
        preflight = await self.run_deployment_preflight(
            org_id=org_id, project_id=project_id, agent_id=agent_id,
            name=name, runtime=runtime, model=model, version=version,
            persona_id=persona_id, config=config,
            overwrite_routing_rules=overwrite_routing_rules, actor_id=actor_id,
        )
        if not preflight.ok:
            raise DeploymentLifecycleError(
                "DEPLOYMENT_PREFLIGHT_FAILED", 409,
                "Resolve preflight issues before deploying",
                {"preflight": preflight.model_dump()},
            )

        agent = await self._get_agent(org_id, project_id, agent_id)
        if not agent.is_active:
            raise DeploymentLifecycleError("AGENT_INACTIVE", 409, "Cannot deploy to an inactive agent")

        deployment_config = config or {
            "schema_version": 1,
            "llm_mode": "managed",
            "provider": "openai",
            "scope_mode": "projects",
            "project_ids": [str(project_id)],
            "verification": {"status": "pending", "required_checkpoints": ["dashboard_active", "routing_reviewed", "mcp_reviewed"]},
        }

        dep = AgentDeployment(
            org_id=org_id,
            project_id=project_id,
            agent_id=agent_id,
            persona_id=persona_id,
            name=name,
            runtime=runtime or "webhook",
            model=model,
            version=version,
            status="DEPLOYING",
            config=deployment_config,
            created_by=actor_id,
            failure_code=None,
            failure_message=None,
            failure_detail=None,
            failed_at=None,
        )
        self.session.add(dep)
        await self.session.flush()
        await self.session.refresh(dep)

        try:
            persona = await self._get_persona(org_id, project_id, agent_id, persona_id) if persona_id else None
            persona_slug = persona.slug if persona else None
            persona_role = _resolve_persona_role(persona_slug, None)

            routing_preview = await self._preview_routing_template(org_id, project_id, {
                "agentId": str(agent_id),
                "agentName": agent.name,
                "role": persona_role,
                "personaId": str(persona_id) if persona_id else None,
                "deploymentId": str(dep.id),
            })

            if routing_preview["rules"]:
                await _replace_routing_rules(self.session, org_id, project_id, actor_id, routing_preview["rules"])

            await self._log_audit(org_id, project_id, agent_id, "agent_deployment.initializing", "info", {
                "deployment_id": str(dep.id),
                "actor_id": str(actor_id),
                "runtime": dep.runtime,
                "model": dep.model,
            })

            await _fire_webhooks(self.session, org_id, "agent_deployment.initializing", {
                "deployment_id": str(dep.id),
                "org_id": str(org_id),
                "project_id": str(project_id),
                "agent_id": str(agent_id),
                "actor_id": str(actor_id),
                "status": dep.status,
                "runtime": dep.runtime,
                "model": dep.model,
                "version": dep.version,
            })

            return await self.transition_deployment(org_id, project_id, actor_id, dep.id, "ACTIVE", None)

        except Exception as e:
            code = e.code.lower() if isinstance(e, DeploymentLifecycleError) else "deployment_activation_failed"
            msg = str(e) if isinstance(e, DeploymentLifecycleError) else "Managed deployment activation failed"
            return await self.transition_deployment(
                org_id, project_id, actor_id, dep.id, "DEPLOY_FAILED",
                DeploymentFailureInput(code=code, message=msg, detail={"error": str(e)}),
            )

    async def transition_deployment(
        self,
        org_id: uuid.UUID,
        project_id: uuid.UUID,
        actor_id: uuid.UUID,
        deployment_id: uuid.UUID,
        status: str,
        failure: DeploymentFailureInput | None,
    ) -> DeploymentMutationResponse:
        dep = await self._get_deployment(org_id, project_id, deployment_id)
        previous_status = dep.status

        if status not in TRANSITIONS.get(previous_status, []):
            raise DeploymentLifecycleError(
                "INVALID_DEPLOYMENT_TRANSITION", 409,
                f"Cannot transition deployment from {previous_status} to {status}",
            )

        if status in ACTIVE_STATUSES:
            await self._assert_no_duplicate_live(org_id, project_id, dep.agent_id, dep.id)

        now = datetime.now(timezone.utc)
        queue_held = 0
        queue_resumed = 0
        queue_failed = 0

        if status == "SUSPENDED":
            queue_held = await self._hold_queued_runs(dep.id)

        if status == "ACTIVE" and previous_status == "SUSPENDED":
            queue_resumed = await self._resume_held_runs(dep.id)

        if status == "DEPLOY_FAILED":
            queue_failed = await self._fail_queued_runs(dep.id, "deployment_failed", "Queued run cancelled because deployment failed")

        patch: dict[str, Any] = {"status": status, "updated_at": now}
        if status == "ACTIVE":
            patch["last_deployed_at"] = now
            patch["failure_code"] = None
            patch["failure_message"] = None
            patch["failure_detail"] = None
            patch["failed_at"] = None
        if status == "SUSPENDED":
            patch["failure_code"] = None
            patch["failure_message"] = None
            patch["failure_detail"] = None
            patch["failed_at"] = None
        if status == "DEPLOY_FAILED":
            f = failure or DeploymentFailureInput(code="deployment_failed", message="Deployment failed")
            patch["failure_code"] = f.code
            patch["failure_message"] = f.message
            patch["failure_detail"] = f.detail or {}
            patch["failed_at"] = now

        await self.session.execute(
            update(AgentDeployment).where(AgentDeployment.id == dep.id).values(**patch)
        )
        await self.session.flush()
        await self.session.refresh(dep)

        event_map = {
            "ACTIVE": "agent_deployment.resumed" if previous_status == "SUSPENDED" else "agent_deployment.activated",
            "SUSPENDED": "agent_deployment.suspended",
            "DEPLOY_FAILED": "agent_deployment.deploy_failed",
            "TERMINATED": "agent_deployment.terminated",
        }
        event = event_map.get(status, "agent_deployment.updated")
        severity = "error" if status == "DEPLOY_FAILED" else "warn" if status == "TERMINATED" else "info"

        await self._log_audit(org_id, project_id, dep.agent_id, event, severity, {
            "deployment_id": str(dep.id),
            "actor_id": str(actor_id),
            "from_status": previous_status,
            "to_status": status,
            "queue_held_count": queue_held,
            "queue_resumed_count": queue_resumed,
            "queue_failed_count": queue_failed,
            "failure_code": failure.code if failure else None,
            "failure_message": failure.message if failure else None,
        })

        await _fire_webhooks(self.session, org_id, event, {
            "deployment_id": str(dep.id),
            "org_id": str(org_id),
            "project_id": str(project_id),
            "agent_id": str(dep.agent_id),
            "actor_id": str(actor_id),
            "from_status": previous_status,
            "status": status,
            "queue_held_count": queue_held,
            "queue_resumed_count": queue_resumed,
            "queue_failed_count": queue_failed,
        })

        return DeploymentMutationResponse(
            deployment=AgentDeploymentResponse.model_validate(dep),
            queue_held_count=queue_held,
            queue_resumed_count=queue_resumed,
            queue_failed_count=queue_failed,
        )

    async def terminate_deployment(
        self,
        org_id: uuid.UUID,
        project_id: uuid.UUID,
        actor_id: uuid.UUID,
        deployment_id: uuid.UUID,
    ) -> DeploymentMutationResponse:
        dep = await self._get_deployment(org_id, project_id, deployment_id)
        previous_status = dep.status

        if "TERMINATED" not in TRANSITIONS.get(previous_status, []):
            raise DeploymentLifecycleError(
                "INVALID_DEPLOYMENT_TRANSITION", 409,
                f"Cannot transition deployment from {previous_status} to TERMINATED",
            )

        now = datetime.now(timezone.utc)
        queue_failed = await self._fail_queued_runs(dep.id, "deployment_terminated", "Queued run cancelled because deployment was terminated")

        await self.session.execute(
            update(AgentDeployment).where(AgentDeployment.id == dep.id).values(
                status="TERMINATED", deleted_at=now, updated_at=now
            )
        )
        await self.session.flush()
        await self.session.refresh(dep)

        await self._log_audit(org_id, project_id, dep.agent_id, "agent_deployment.terminated", "warn", {
            "deployment_id": str(dep.id),
            "actor_id": str(actor_id),
            "from_status": previous_status,
            "to_status": "TERMINATED",
            "queue_failed_count": queue_failed,
        })

        await _fire_webhooks(self.session, org_id, "agent_deployment.terminated", {
            "deployment_id": str(dep.id),
            "org_id": str(org_id),
            "project_id": str(project_id),
            "agent_id": str(dep.agent_id),
            "actor_id": str(actor_id),
            "from_status": previous_status,
            "status": "TERMINATED",
            "queue_failed_count": queue_failed,
        })

        return DeploymentMutationResponse(
            deployment=AgentDeploymentResponse.model_validate(dep),
            queue_held_count=0,
            queue_resumed_count=0,
            queue_failed_count=queue_failed,
        )

    async def complete_verification(
        self,
        org_id: uuid.UUID,
        project_id: uuid.UUID,
        actor_id: uuid.UUID,
        deployment_id: uuid.UUID,
    ) -> AgentDeploymentResponse:
        dep = await self._get_deployment(org_id, project_id, deployment_id)
        if dep.status != "ACTIVE":
            raise DeploymentLifecycleError(
                "DEPLOYMENT_VERIFICATION_REQUIRES_ACTIVE_STATUS", 409,
                "Deployment must be active before verification can be completed",
            )

        config = dep.config or {}
        now = datetime.now(timezone.utc).isoformat()
        verification = {
            "status": "completed",
            "required_checkpoints": ["dashboard_active", "routing_reviewed", "mcp_reviewed"],
            "completed_at": now,
            "completed_by": str(actor_id),
        }
        next_config = {**config, "verification": verification}

        await self.session.execute(
            update(AgentDeployment).where(AgentDeployment.id == dep.id).values(
                config=next_config, updated_at=datetime.now(timezone.utc)
            )
        )
        await self.session.flush()
        await self.session.refresh(dep)

        await self._log_audit(org_id, project_id, dep.agent_id, "agent_deployment.verification_completed", "info", {
            "deployment_id": str(dep.id),
            "actor_id": str(actor_id),
            "verification_status": "completed",
            "verification_completed_at": now,
            "verification_completed_by": str(actor_id),
        })

        await _fire_webhooks(self.session, org_id, "agent_deployment.verification_completed", {
            "deployment_id": str(dep.id),
            "org_id": str(org_id),
            "project_id": str(project_id),
            "agent_id": str(dep.agent_id),
            "actor_id": str(actor_id),
            "verification_status": "completed",
            "verification_completed_at": now,
        })

        return AgentDeploymentResponse.model_validate(dep)

    async def build_cards(self, org_id: uuid.UUID, project_id: uuid.UUID, requested_for_member_id: str | None = None) -> list[DeploymentCardResponse]:
        r = await self.session.execute(
            select(AgentDeployment).where(
                AgentDeployment.org_id == org_id,
                AgentDeployment.project_id == project_id,
                AgentDeployment.deleted_at.is_(None),
                AgentDeployment.status.in_(["DEPLOYING", "ACTIVE", "SUSPENDED", "DEPLOY_FAILED"]),
            ).order_by(AgentDeployment.updated_at.desc())
        )
        deployments = list(r.scalars().all())
        if not deployments:
            return []

        dep_ids = [d.id for d in deployments]
        agent_ids = list({d.agent_id for d in deployments})
        persona_ids = list({d.persona_id for d in deployments if d.persona_id})

        agent_name_by_id: dict[uuid.UUID, str] = {}
        if agent_ids:
            ar = await self.session.execute(select(TeamMember.id, TeamMember.name).where(TeamMember.id.in_(agent_ids)))
            agent_name_by_id = {row.id: row.name for row in ar.all()}

        persona_name_by_id: dict[uuid.UUID, str] = {}
        if persona_ids:
            pr = await self.session.execute(
                select(AgentPersona.id, AgentPersona.name).where(AgentPersona.id.in_(persona_ids), AgentPersona.deleted_at.is_(None))
            )
            persona_name_by_id = {row.id: row.name for row in pr.all()}

        from datetime import date
        today_start = datetime.combine(date.today(), datetime.min.time()).replace(tzinfo=timezone.utc)

        runs_today_r = await self.session.execute(
            select(AgentRun.deployment_id, AgentRun.input_tokens, AgentRun.output_tokens)
            .where(AgentRun.deployment_id.in_(dep_ids), AgentRun.created_at >= today_start)
        )
        exec_count: dict[uuid.UUID, int] = {}
        tokens: dict[uuid.UUID, int] = {}
        for row in runs_today_r.all():
            dep_id = row.deployment_id
            exec_count[dep_id] = exec_count.get(dep_id, 0) + 1
            tokens[dep_id] = tokens.get(dep_id, 0) + (row.input_tokens or 0) + (row.output_tokens or 0)

        latest_runs_r = await self.session.execute(
            select(AgentRun.deployment_id, AgentRun.finished_at, AgentRun.started_at, AgentRun.created_at)
            .where(AgentRun.deployment_id.in_(dep_ids))
            .order_by(AgentRun.created_at.desc())
        )
        last_run_by_dep: dict[uuid.UUID, str | None] = {}
        for row in latest_runs_r.all():
            if row.deployment_id not in last_run_by_dep:
                last_run_by_dep[row.deployment_id] = (
                    row.finished_at.isoformat() if row.finished_at
                    else row.started_at.isoformat() if row.started_at
                    else row.created_at.isoformat()
                )

        latest_success_r = await self.session.execute(
            select(AgentRun.deployment_id, AgentRun.finished_at, AgentRun.started_at, AgentRun.created_at)
            .where(AgentRun.deployment_id.in_(dep_ids), AgentRun.status == "completed")
            .order_by(AgentRun.created_at.desc())
        )
        latest_success_by_dep: dict[uuid.UUID, str | None] = {}
        for row in latest_success_r.all():
            if row.deployment_id not in latest_success_by_dep:
                latest_success_by_dep[row.deployment_id] = (
                    row.finished_at.isoformat() if row.finished_at
                    else row.started_at.isoformat() if row.started_at
                    else row.created_at.isoformat()
                )

        latest_failed_r = await self.session.execute(
            select(
                AgentRun.id, AgentRun.deployment_id, AgentRun.memo_id,
                AgentRun.result_summary, AgentRun.last_error_code,
                AgentRun.failure_disposition, AgentRun.next_retry_at,
                AgentRun.retry_count, AgentRun.max_retries,
                AgentRun.finished_at, AgentRun.started_at, AgentRun.created_at,
            )
            .where(AgentRun.deployment_id.in_(dep_ids), AgentRun.status == "failed")
            .order_by(AgentRun.created_at.desc())
        )
        latest_failed_by_dep: dict[uuid.UUID, DeploymentFailureSignal] = {}
        for row in latest_failed_r.all():
            dep_id = row.deployment_id
            if dep_id not in latest_failed_by_dep:
                failed_at = (
                    row.finished_at.isoformat() if row.finished_at
                    else row.started_at.isoformat() if row.started_at
                    else row.created_at.isoformat()
                )
                can_retry = bool(
                    row.failure_disposition == "retryable"
                    and row.next_retry_at
                    and row.retry_count is not None
                    and row.max_retries is not None
                    and row.retry_count < row.max_retries
                )
                latest_failed_by_dep[dep_id] = DeploymentFailureSignal(
                    run_id=str(row.id),
                    memo_id=str(row.memo_id) if row.memo_id else None,
                    failed_at=failed_at,
                    error_message=None,
                    last_error_code=row.last_error_code,
                    result_summary=row.result_summary,
                    failure_disposition=row.failure_disposition,
                    next_retry_at=row.next_retry_at.isoformat() if row.next_retry_at else None,
                    can_manual_retry=can_retry,
                )

        return [
            DeploymentCardResponse(
                id=str(d.id),
                name=d.name,
                status=d.status,
                model=d.model,
                runtime=d.runtime,
                agent_name=agent_name_by_id.get(d.agent_id, "Agent"),
                persona_name=persona_name_by_id.get(d.persona_id) if d.persona_id else None,
                updated_at=d.updated_at.isoformat(),
                last_run_at=last_run_by_dep.get(d.id),
                latest_successful_run_at=latest_success_by_dep.get(d.id),
                executions_today=exec_count.get(d.id, 0),
                tokens_today=tokens.get(d.id, 0),
                pending_hitl_count=0,
                next_hitl_deadline_at=None,
                latest_failed_run=latest_failed_by_dep.get(d.id),
            )
            for d in deployments
        ]
