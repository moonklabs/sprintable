"""E-DECISION-GATE S1 (8fe3667b): Workflow line schema — expand migration.

Decision Gate(org-configurable 결재/핸드오프 라인)의 기반 스키마. 신규 테이블만 추가하는
순수 expand 마이그레이션이며 기존 Gate / Event / Story.status 머신은 일절 건드리지 않는다.
라인 엔진은 default-off로 S3/S18에서 도입되므로 본 스토리는 스키마만 깐다(런타임 무영향).

스펙 출처: 스토리 8fe3667b AC(= build-guide §1.2 전체 스키마 + §3 S1 done AC).

설계 노트:
- enum류(status·delivery_status·step_type·event_type 등)는 모두 ``text`` 컬럼 + 애플리케이션
  레벨 validator로 표현한다. DB CHECK / native enum 을 쓰지 않는다 → 새 enum 값 추가 시
  baseline schema.sql CHECK 갱신 누락(CI SQLite blindspot) 위험을 원천 차단하고, S2~ 에서
  값 확장이 마이그 없이 가능하다.
- idempotent: 모든 create_table / create_index 를 inspector 가드로 감싼다. alembic 자체가
  revision 추적으로 재실행을 막지만, 부분 적용/수동 재시도(migrate-dev) 안전을 위해.
- expand-contract(P1-5): 신규 테이블은 비어 있으므로 인덱스 생성이 기존 행을 잠그지 않는다.
  따라서 본 마이그는 CREATE INDEX CONCURRENTLY 가 불필요하다(빈 테이블=즉시). 운영상 큰
  partial unique 가 문제되는 시점은 S19 backfill 이 이 테이블들을 채운 "이후" 인덱스를 다시
  만들 때이며, 그때는 CONCURRENTLY(트랜잭션 밖) 로 친다 — 본 파일은 fresh-DB 경로라 일반
  CREATE INDEX 로 둔다.

리뷰 확인 요청(AC가 명시하지 않아 코히어런스로 결정한 지점):
- ``entity_type`` 을 모든 테이블에서 NOT NULL 로 둔다(AC는 definitions 에만 NN 명시). steps/
  step_runs/versions 의 unique 제약에 entity_type 이 포함되는데, nullable 이면 NULL-distinct 로
  unique 의도가 깨지므로 NN 으로 통일했다.
- definitions / step_runs 의 partial unique 는 project_id·from_status 가 nullable 이라 Postgres
  의 NULL-distinct 규칙상 "org-default(project_id NULL)" 또는 "from_status NULL" 행은 중복이
  허용된다. AC 문구 그대로 구현했고, org-default 단일성을 강제하려면 COALESCE 표현식 인덱스가
  필요하다 — 의도 확인 필요(S2 config 거버넌스에서 정리 가능).
- table 8 ``workflow_delivery_outbox`` 는 AC done ①의 "(+8 optional)" 에 따라 additive 로 함께
  생성한다(빈 테이블·무해·S7 핸드오프 relay 재마이그 회피). 실제 사용은 S7 에서
  dispatch_entity_to_assignee(commit=False) 가능 여부로 결정.

Revision ID: 0126
Revises: 0125
"""
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB, UUID

from alembic import op

revision = "0126"
down_revision = "0125"
branch_labels = None
depends_on = None


def _has_table(bind, name: str) -> bool:
    return sa.inspect(bind).has_table(name)


def _has_index(bind, table: str, index: str) -> bool:
    insp = sa.inspect(bind)
    if not insp.has_table(table):
        return False
    return any(ix["name"] == index for ix in insp.get_indexes(table))


def _uuid_pk() -> sa.Column:
    return sa.Column(
        "id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")
    )


def _timestamps() -> list[sa.Column]:
    return [
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    ]


def _create_index(bind, name: str, table: str, cols, *, unique: bool = False, where: str | None = None) -> None:
    if _has_index(bind, table, name):
        return
    kwargs: dict = {"unique": unique}
    if where is not None:
        kwargs["postgresql_where"] = sa.text(where)
    op.create_index(name, table, cols, **kwargs)


def upgrade() -> None:
    bind = op.get_bind()

    # ── 1) workflow_line_definitions ────────────────────────────────────────
    if not _has_table(bind, "workflow_line_definitions"):
        op.create_table(
            "workflow_line_definitions",
            _uuid_pk(),
            sa.Column("org_id", UUID(as_uuid=True), nullable=False),
            sa.Column("project_id", UUID(as_uuid=True), nullable=True),
            sa.Column("entity_type", sa.Text(), nullable=False),
            sa.Column("name", sa.Text(), nullable=False),
            sa.Column("version", sa.Integer(), server_default=sa.text("1"), nullable=False),
            sa.Column("is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
            sa.Column("source", sa.Text(), server_default=sa.text("'org_config'"), nullable=False),
            sa.Column("created_by_member_id", UUID(as_uuid=True), nullable=True),
            sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("retired_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("config_hash", sa.Text(), nullable=True),
            *_timestamps(),
        )
    _create_index(
        bind, "uq_wf_line_def_active", "workflow_line_definitions",
        ["org_id", "project_id", "entity_type"], unique=True, where="is_active",
    )
    _create_index(
        bind, "ix_wf_line_def_org_entity_active", "workflow_line_definitions",
        ["org_id", "entity_type", "is_active"],
    )
    _create_index(bind, "ix_wf_line_def_project", "workflow_line_definitions", ["project_id"])

    # ── 2) workflow_line_definition_versions [P0-4 거버넌스] ─────────────────
    if not _has_table(bind, "workflow_line_definition_versions"):
        op.create_table(
            "workflow_line_definition_versions",
            _uuid_pk(),
            sa.Column("line_definition_id", UUID(as_uuid=True), nullable=True),
            sa.Column("org_id", UUID(as_uuid=True), nullable=False),
            sa.Column("project_id", UUID(as_uuid=True), nullable=True),
            sa.Column("entity_type", sa.Text(), nullable=False),
            sa.Column("version", sa.Integer(), nullable=False),
            sa.Column("status", sa.Text(), server_default=sa.text("'draft'"), nullable=False),
            sa.Column("config", JSONB(), server_default=sa.text("'{}'::jsonb"), nullable=False),
            sa.Column("config_hash", sa.Text(), nullable=False),
            sa.Column("lint_status", sa.Text(), server_default=sa.text("'not_run'"), nullable=False),
            sa.Column("lint_errors", JSONB(), server_default=sa.text("'[]'::jsonb"), nullable=False),
            sa.Column("created_by_member_id", UUID(as_uuid=True), nullable=False),
            sa.Column("reviewed_by_member_id", UUID(as_uuid=True), nullable=True),
            sa.Column("review_gate_id", UUID(as_uuid=True), nullable=True),
            sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
            *_timestamps(),
        )
    _create_index(
        bind, "uq_wf_line_def_ver", "workflow_line_definition_versions",
        ["org_id", "project_id", "entity_type", "version"], unique=True,
    )
    _create_index(bind, "ix_wf_line_def_ver_project", "workflow_line_definition_versions", ["project_id"])
    _create_index(bind, "ix_wf_line_def_ver_def", "workflow_line_definition_versions", ["line_definition_id"])

    # ── 3) workflow_line_steps ──────────────────────────────────────────────
    if not _has_table(bind, "workflow_line_steps"):
        op.create_table(
            "workflow_line_steps",
            _uuid_pk(),
            sa.Column("line_definition_id", UUID(as_uuid=True), nullable=False),
            sa.Column("org_id", UUID(as_uuid=True), nullable=False),
            sa.Column("entity_type", sa.Text(), nullable=False),
            sa.Column("from_status", sa.Text(), nullable=True),
            sa.Column("to_status", sa.Text(), nullable=False),
            sa.Column("step_order", sa.Integer(), nullable=False),
            sa.Column("step_key", sa.Text(), nullable=False),
            sa.Column("step_type", sa.Text(), nullable=False),
            sa.Column("assignee_policy", JSONB(), server_default=sa.text("'{}'::jsonb"), nullable=False),
            sa.Column("on_approve", JSONB(), server_default=sa.text("'{}'::jsonb"), nullable=False),
            sa.Column("on_reject", JSONB(), server_default=sa.text("'{}'::jsonb"), nullable=False),
            sa.Column("gate_type", sa.Text(), nullable=True),
            sa.Column("routing_rules", JSONB(), server_default=sa.text("'[]'::jsonb"), nullable=False),
            sa.Column("sla_policy", JSONB(), server_default=sa.text("'{}'::jsonb"), nullable=False),
            sa.Column("approval_policy", JSONB(), server_default=sa.text("'{}'::jsonb"), nullable=False),
            sa.Column("recall_policy", JSONB(), server_default=sa.text("'{}'::jsonb"), nullable=False),
            sa.Column("metadata", JSONB(), nullable=True),
            *_timestamps(),
        )
    _create_index(
        bind, "uq_wf_line_step", "workflow_line_steps",
        ["line_definition_id", "entity_type", "from_status", "to_status"], unique=True,
    )
    _create_index(bind, "ix_wf_line_step_org", "workflow_line_steps", ["org_id"])

    # ── 4) workflow_line_step_runs [전이 1건 route/audit/delivery] ───────────
    if not _has_table(bind, "workflow_line_step_runs"):
        op.create_table(
            "workflow_line_step_runs",
            _uuid_pk(),
            sa.Column("org_id", UUID(as_uuid=True), nullable=False),
            sa.Column("project_id", UUID(as_uuid=True), nullable=False),
            sa.Column("line_definition_id", UUID(as_uuid=True), nullable=True),
            sa.Column("line_step_id", UUID(as_uuid=True), nullable=True),
            sa.Column("entity_type", sa.Text(), nullable=False),
            sa.Column("entity_id", UUID(as_uuid=True), nullable=False),
            sa.Column("from_status", sa.Text(), nullable=True),
            sa.Column("to_status", sa.Text(), nullable=False),
            sa.Column("status", sa.Text(), server_default=sa.text("'pending'"), nullable=False),
            sa.Column("mode", sa.Text(), nullable=True),
            sa.Column("effective_step_type", sa.Text(), nullable=True),
            sa.Column("effective_gate_type", sa.Text(), nullable=True),
            sa.Column("routing_decision", sa.Text(), nullable=True),
            sa.Column("routing_reason", sa.Text(), nullable=True),
            sa.Column("routing_context", JSONB(), nullable=True),
            sa.Column("trust_snapshot", JSONB(), nullable=True),
            sa.Column("risk_snapshot", JSONB(), nullable=True),
            sa.Column("resolved_member_id", UUID(as_uuid=True), nullable=True),
            sa.Column("resolved_member_type", sa.Text(), nullable=True),
            sa.Column("gate_id", UUID(as_uuid=True), nullable=True),
            sa.Column("h1_gate_id", UUID(as_uuid=True), nullable=True),
            sa.Column("event_id", UUID(as_uuid=True), nullable=True),
            sa.Column("recipient_seq", sa.BigInteger(), nullable=True),
            sa.Column("delivery_status", sa.Text(), server_default=sa.text("'not_required'"), nullable=False),
            sa.Column("delivery_error", sa.Text(), nullable=True),
            sa.Column("approval_group_id", UUID(as_uuid=True), nullable=True),
            sa.Column("quorum_policy", JSONB(), nullable=True),
            sa.Column("sla_due_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("next_reminder_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("reminder_count", sa.Integer(), server_default=sa.text("0"), nullable=False),
            sa.Column("escalated_to_member_id", UUID(as_uuid=True), nullable=True),
            sa.Column("failure_class", sa.Text(), nullable=True),
            sa.Column("failure_message", sa.Text(), nullable=True),
            sa.Column("degraded_to_plain", sa.Boolean(), server_default=sa.text("false"), nullable=False),
            sa.Column("correlation_id", UUID(as_uuid=True), nullable=False),
            sa.Column("transition_id", sa.Text(), nullable=False),
            sa.Column("attempt", sa.Integer(), server_default=sa.text("1"), nullable=False),
            sa.Column("started_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
            sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("withdrawn_by_member_id", UUID(as_uuid=True), nullable=True),
            sa.Column("withdrawn_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("withdraw_reason", sa.Text(), nullable=True),
            *_timestamps(),
        )
    # 활성 1전이 1행 보장(중복 in-flight 방지). status가 terminal이면 제외.
    _create_index(
        bind, "uq_wf_step_run_active", "workflow_line_step_runs",
        ["org_id", "entity_type", "entity_id", "from_status", "to_status", "attempt"], unique=True,
        where="status NOT IN ('applied','rejected','failed','engine_failed','withdrawn','timed_out','cancelled','grandfathered')",
    )
    # 이중 pending gate 방지(P0-2 duplicate_pending_gate_count=0).
    _create_index(
        bind, "uq_wf_step_run_pending_gate", "workflow_line_step_runs",
        ["org_id", "entity_type", "entity_id", "from_status", "to_status", "effective_gate_type"], unique=True,
        where="status IN ('waiting_gate','waiting_parallel','reminded','escalated','held')",
    )
    _create_index(
        bind, "ix_wf_step_run_org_proj_status", "workflow_line_step_runs",
        ["org_id", "project_id", "status", sa.text("started_at DESC")],
    )
    _create_index(
        bind, "ix_wf_step_run_org_entity", "workflow_line_step_runs",
        ["org_id", "entity_type", "entity_id", sa.text("started_at DESC")],
    )
    _create_index(bind, "ix_wf_step_run_project", "workflow_line_step_runs", ["project_id"])
    _create_index(bind, "ix_wf_step_run_def", "workflow_line_step_runs", ["line_definition_id"])
    _create_index(bind, "ix_wf_step_run_step", "workflow_line_step_runs", ["line_step_id"])
    _create_index(bind, "ix_wf_step_run_gate", "workflow_line_step_runs", ["gate_id"])
    _create_index(bind, "ix_wf_step_run_h1_gate", "workflow_line_step_runs", ["h1_gate_id"])
    _create_index(bind, "ix_wf_step_run_event", "workflow_line_step_runs", ["event_id"])
    _create_index(bind, "ix_wf_step_run_approval_group", "workflow_line_step_runs", ["approval_group_id"])

    # ── 5) workflow_step_approvals [parallel/quorum/consult/deputy] ──────────
    if not _has_table(bind, "workflow_step_approvals"):
        op.create_table(
            "workflow_step_approvals",
            _uuid_pk(),
            sa.Column("org_id", UUID(as_uuid=True), nullable=False),
            sa.Column("project_id", UUID(as_uuid=True), nullable=False),
            sa.Column("step_run_id", UUID(as_uuid=True), nullable=False),
            sa.Column("gate_id", UUID(as_uuid=True), nullable=True),
            sa.Column("approval_group_id", UUID(as_uuid=True), nullable=False),
            sa.Column("approver_member_id", UUID(as_uuid=True), nullable=False),
            sa.Column("approver_member_type", sa.Text(), nullable=False),
            sa.Column("original_approver_member_id", UUID(as_uuid=True), nullable=True),
            sa.Column("requested_by_member_id", UUID(as_uuid=True), nullable=True),
            sa.Column("implementation_member_id", UUID(as_uuid=True), nullable=True),
            sa.Column("role_key", sa.Text(), nullable=True),
            sa.Column("kind", sa.Text(), server_default=sa.text("'approver'"), nullable=False),
            sa.Column("blocking", sa.Boolean(), server_default=sa.text("true"), nullable=False),
            sa.Column("status", sa.Text(), server_default=sa.text("'pending'"), nullable=False),
            sa.Column("decision_note", sa.Text(), nullable=True),
            sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("held_until", sa.DateTime(timezone=True), nullable=True),
            sa.Column("reassigned_from_member_id", UUID(as_uuid=True), nullable=True),
            *_timestamps(),
        )
    _create_index(
        bind, "uq_wf_step_approval", "workflow_step_approvals",
        ["step_run_id", "approver_member_id", "kind"], unique=True,
    )
    _create_index(
        bind, "ix_wf_step_approval_org_approver", "workflow_step_approvals",
        ["org_id", "approver_member_id", "status", sa.text("created_at DESC")],
    )
    _create_index(bind, "ix_wf_step_approval_project", "workflow_step_approvals", ["project_id"])
    _create_index(bind, "ix_wf_step_approval_gate", "workflow_step_approvals", ["gate_id"])
    _create_index(bind, "ix_wf_step_approval_group", "workflow_step_approvals", ["approval_group_id"])

    # ── 6) workflow_step_run_events [append-only audit] ─────────────────────
    if not _has_table(bind, "workflow_step_run_events"):
        op.create_table(
            "workflow_step_run_events",
            _uuid_pk(),
            sa.Column("org_id", UUID(as_uuid=True), nullable=False),
            sa.Column("project_id", UUID(as_uuid=True), nullable=False),
            sa.Column("step_run_id", UUID(as_uuid=True), nullable=False),
            sa.Column("event_type", sa.Text(), nullable=False),
            sa.Column("actor_member_id", UUID(as_uuid=True), nullable=True),
            sa.Column("target_member_id", UUID(as_uuid=True), nullable=True),
            sa.Column("payload", JSONB(), nullable=True),
            sa.Column("correlation_id", UUID(as_uuid=True), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        )
    _create_index(
        bind, "ix_wf_step_run_event_org_run", "workflow_step_run_events",
        ["org_id", "step_run_id", sa.text("created_at ASC")],
    )
    _create_index(bind, "ix_wf_step_run_event_run", "workflow_step_run_events", ["step_run_id"])
    _create_index(bind, "ix_wf_step_run_event_project", "workflow_step_run_events", ["project_id"])

    # ── 7) workflow_role_assignments [route candidate] ──────────────────────
    if not _has_table(bind, "workflow_role_assignments"):
        op.create_table(
            "workflow_role_assignments",
            _uuid_pk(),
            sa.Column("org_id", UUID(as_uuid=True), nullable=False),
            sa.Column("project_id", UUID(as_uuid=True), nullable=True),
            sa.Column("role_key", sa.Text(), nullable=False),
            sa.Column("member_id", UUID(as_uuid=True), nullable=False),
            sa.Column("member_type", sa.Text(), nullable=False),
            sa.Column("priority", sa.Integer(), server_default=sa.text("100"), nullable=False),
            sa.Column("is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
            sa.Column("deputy_member_id", UUID(as_uuid=True), nullable=True),
            sa.Column("deputy_member_type", sa.Text(), nullable=True),
            sa.Column("availability_status", sa.Text(), server_default=sa.text("'available'"), nullable=False),
            sa.Column("effective_from", sa.DateTime(timezone=True), nullable=True),
            sa.Column("effective_to", sa.DateTime(timezone=True), nullable=True),
            sa.Column("delegation_policy", JSONB(), nullable=True),
            sa.Column("metadata", JSONB(), nullable=True),
            *_timestamps(),
        )
    _create_index(
        bind, "ix_wf_role_assign_lookup", "workflow_role_assignments",
        ["org_id", "project_id", "role_key", "is_active", "priority"],
    )
    _create_index(
        bind, "uq_wf_role_assign_member", "workflow_role_assignments",
        ["org_id", "project_id", "role_key", "member_id"], unique=True,
    )
    _create_index(bind, "ix_wf_role_assign_project", "workflow_role_assignments", ["project_id"])

    # ── 8) workflow_delivery_outbox [P1-2 · optional · S7 사용 결정] ─────────
    if not _has_table(bind, "workflow_delivery_outbox"):
        op.create_table(
            "workflow_delivery_outbox",
            _uuid_pk(),
            sa.Column("org_id", UUID(as_uuid=True), nullable=False),
            sa.Column("project_id", UUID(as_uuid=True), nullable=False),
            sa.Column("step_run_id", UUID(as_uuid=True), nullable=False),
            sa.Column("event_id", UUID(as_uuid=True), nullable=False),
            sa.Column("recipient_id", UUID(as_uuid=True), nullable=False),
            sa.Column("recipient_type", sa.Text(), nullable=False),
            sa.Column("recipient_seq", sa.BigInteger(), nullable=True),
            sa.Column("status", sa.Text(), server_default=sa.text("'pending'"), nullable=False),
            sa.Column("wake_after", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
            sa.Column("attempt_count", sa.Integer(), server_default=sa.text("0"), nullable=False),
            sa.Column("last_error", sa.Text(), nullable=True),
            *_timestamps(),
        )
    # outbox worker poll: pending 중 wake_after 도래분.
    _create_index(
        bind, "ix_wf_delivery_outbox_poll", "workflow_delivery_outbox",
        ["status", "wake_after"],
    )
    _create_index(bind, "ix_wf_delivery_outbox_step_run", "workflow_delivery_outbox", ["step_run_id"])
    _create_index(bind, "ix_wf_delivery_outbox_event", "workflow_delivery_outbox", ["event_id"])
    _create_index(bind, "ix_wf_delivery_outbox_org", "workflow_delivery_outbox", ["org_id"])


def downgrade() -> None:
    bind = op.get_bind()
    # 생성 역순으로 drop(테이블 drop 시 소속 인덱스 동반 제거).
    for table in (
        "workflow_delivery_outbox",
        "workflow_role_assignments",
        "workflow_step_run_events",
        "workflow_step_approvals",
        "workflow_line_step_runs",
        "workflow_line_steps",
        "workflow_line_definition_versions",
        "workflow_line_definitions",
    ):
        if _has_table(bind, table):
            op.drop_table(table)
