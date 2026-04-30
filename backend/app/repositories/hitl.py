from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.hitl import HitlPolicy, HitlRequest
from app.schemas.hitl import (
    HitlApprovalRule,
    HitlHighRiskActionItem,
    HitlPolicySnapshot,
    HitlRequestResponse,
    HitlTimeoutClass,
)

_HIGH_RISK_CATALOG: list[HitlHighRiskActionItem] = [
    HitlHighRiskActionItem(
        key="destructive_change",
        severity="critical",
        default_request_type="approval",
        default_timeout_class="fast",
        prompt_label="Destructive memo/story resolution, deletion, or irreversible state change",
    ),
    HitlHighRiskActionItem(
        key="external_side_effect",
        severity="high",
        default_request_type="approval",
        default_timeout_class="standard",
        prompt_label="Outbound write to external systems, public channels, or third-party tools",
    ),
    HitlHighRiskActionItem(
        key="credential_or_billing_change",
        severity="critical",
        default_request_type="approval",
        default_timeout_class="fast",
        prompt_label="Credential rotation, billing-impacting action, or managed-cost override",
    ),
]

_DEFAULT_APPROVAL_RULES: list[HitlApprovalRule] = [
    HitlApprovalRule(key="manual_hitl_request", request_type="approval", timeout_class="standard"),
    HitlApprovalRule(key="billing_cap_exceeded", request_type="approval", timeout_class="fast"),
]

_DEFAULT_TIMEOUT_CLASSES: list[HitlTimeoutClass] = [
    HitlTimeoutClass(key="fast", duration_minutes=240, reminder_minutes_before=60, escalation_mode="timeout_memo_and_escalate"),
    HitlTimeoutClass(key="standard", duration_minutes=1440, reminder_minutes_before=60, escalation_mode="timeout_memo"),
    HitlTimeoutClass(key="extended", duration_minutes=4320, reminder_minutes_before=240, escalation_mode="timeout_memo_and_escalate"),
]


def _merge_by_key(defaults: list, overrides: list) -> list:
    override_map = {item.key: item for item in overrides}
    return [override_map.get(d.key, d) for d in defaults]


def _build_prompt_summary(approval_rules: list[HitlApprovalRule], timeout_classes: list[HitlTimeoutClass]) -> str:
    timeout_map = {tc.key: tc for tc in timeout_classes}
    high_risk_lines = "\n".join(
        f"- {item.prompt_label} -> {item.default_request_type}/{item.default_timeout_class}"
        for item in _HIGH_RISK_CATALOG
    )
    approval_lines = "\n".join(
        f"- {rule.key} -> {rule.request_type}, timeout={rule.timeout_class}"
        + (f" ({timeout_map[rule.timeout_class].duration_minutes}m, remind {timeout_map[rule.timeout_class].reminder_minutes_before}m before, {timeout_map[rule.timeout_class].escalation_mode})" if rule.timeout_class in timeout_map else "")
        for rule in approval_rules
    )
    return "\n".join([
        "HITL policy",
        "High-risk action catalog:",
        high_risk_lines or "- (none)",
        "Approval-needed events:",
        approval_lines or "- (none)",
    ])


def _build_snapshot(config: dict | None) -> HitlPolicySnapshot:
    raw = config or {}
    raw_rules = raw.get("approval_rules", [])
    raw_timeouts = raw.get("timeout_classes", [])

    try:
        loaded_rules = [HitlApprovalRule(**r) for r in raw_rules if isinstance(r, dict)]
        loaded_timeouts = [HitlTimeoutClass(**t) for t in raw_timeouts if isinstance(t, dict)]
    except Exception:
        loaded_rules, loaded_timeouts = [], []

    approval_rules = _merge_by_key(_DEFAULT_APPROVAL_RULES, loaded_rules)
    timeout_classes = _merge_by_key(_DEFAULT_TIMEOUT_CLASSES, loaded_timeouts)

    return HitlPolicySnapshot(
        schema_version=1,
        high_risk_actions=_HIGH_RISK_CATALOG,
        approval_rules=approval_rules,
        timeout_classes=timeout_classes,
        prompt_summary=_build_prompt_summary(approval_rules, timeout_classes),
    )


class HitlRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get_policy(self, org_id: uuid.UUID, project_id: uuid.UUID) -> HitlPolicySnapshot:
        result = await self.session.execute(
            select(HitlPolicy.config).where(
                HitlPolicy.org_id == org_id,
                HitlPolicy.project_id == project_id,
            )
        )
        row = result.scalar_one_or_none()
        return _build_snapshot(row)

    async def save_policy(
        self,
        org_id: uuid.UUID,
        project_id: uuid.UUID,
        actor_id: uuid.UUID,
        approval_rules: list[HitlApprovalRule],
        timeout_classes: list[HitlTimeoutClass],
    ) -> HitlPolicySnapshot:
        merged_rules = _merge_by_key(_DEFAULT_APPROVAL_RULES, approval_rules)
        merged_timeouts = _merge_by_key(_DEFAULT_TIMEOUT_CLASSES, timeout_classes)
        config = {
            "schema_version": 1,
            "approval_rules": [r.model_dump() for r in merged_rules],
            "timeout_classes": [t.model_dump() for t in merged_timeouts],
        }
        now = datetime.now(timezone.utc)

        existing = await self.session.execute(
            select(HitlPolicy).where(HitlPolicy.project_id == project_id)
        )
        row = existing.scalar_one_or_none()

        if row is None:
            self.session.add(HitlPolicy(
                org_id=org_id,
                project_id=project_id,
                config=config,
                created_by=actor_id,
                updated_by=actor_id,
                created_at=now,
                updated_at=now,
            ))
        else:
            await self.session.execute(
                update(HitlPolicy)
                .where(HitlPolicy.project_id == project_id)
                .values(config=config, updated_by=actor_id, updated_at=now)
            )
        await self.session.commit()

        return _build_snapshot(config)

    async def list_requests(
        self,
        org_id: uuid.UUID,
        project_id: uuid.UUID,
        status: str | None = None,
    ) -> list[HitlRequestResponse]:
        stmt = select(HitlRequest).where(
            HitlRequest.org_id == org_id,
            HitlRequest.project_id == project_id,
        )
        if status:
            stmt = stmt.where(HitlRequest.status == status)
        stmt = stmt.order_by(HitlRequest.created_at.desc())

        result = await self.session.execute(stmt)
        rows = result.scalars().all()

        return [
            HitlRequestResponse(
                id=r.id,
                org_id=r.org_id,
                project_id=r.project_id,
                agent_id=r.agent_id,
                deployment_id=r.deployment_id,
                session_id=r.session_id,
                run_id=r.run_id,
                request_type=r.request_type,
                title=r.title,
                prompt=r.prompt,
                requested_for=r.requested_for,
                status=r.status,
                response_text=r.response_text,
                responded_by=r.responded_by,
                responded_at=r.responded_at,
                expires_at=r.expires_at,
                hitl_metadata=r.hitl_metadata or {},
                created_at=r.created_at,
                updated_at=r.updated_at,
                agent_name=r.hitl_metadata.get("agent_name") if r.hitl_metadata else None,
                requested_for_name=r.hitl_metadata.get("requested_for_name") if r.hitl_metadata else None,
                source_memo_id=r.hitl_metadata.get("source_memo_id") if r.hitl_metadata else None,
                hitl_memo_id=r.hitl_metadata.get("hitl_memo_id") if r.hitl_metadata else None,
            )
            for r in rows
        ]

    async def resolve_request(
        self,
        request_id: uuid.UUID,
        org_id: uuid.UUID,
        actor_id: uuid.UUID,
        status: str,
        response_text: str | None,
    ) -> HitlRequest | None:
        result = await self.session.execute(
            select(HitlRequest).where(
                HitlRequest.id == request_id,
                HitlRequest.org_id == org_id,
            )
        )
        row = result.scalar_one_or_none()
        if row is None:
            return None
        if row.status != "pending":
            return None

        now = datetime.now(timezone.utc)
        await self.session.execute(
            update(HitlRequest)
            .where(HitlRequest.id == request_id)
            .values(
                status=status,
                response_text=response_text,
                responded_by=actor_id,
                responded_at=now,
                updated_at=now,
            )
        )
        await self.session.commit()
        await self.session.refresh(row)
        return row
