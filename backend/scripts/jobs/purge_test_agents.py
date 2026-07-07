"""선생님 지시(2026-07-07): dev DB 테스트 에이전트 하드딜리트 — FK-safe 설계.

대상: ``members`` 중 ``type='agent'`` AND ``id NOT IN`` :data:`KEEP_MEMBER_IDS`(keep-8, SSOT).
0075 이후 ``members`` 가 앵커 SSOT — ``team_members`` 는 뷰(``0088_team_members_projection_view``)
라 실 삭제 대상은 ``members.id`` (``team_members.id`` 와 1:1 동치, ``team_members_legacy`` 는 0088
이후 신규 row 0건 · 어차피 아무 FK도 안 그쪽을 가리키지 않음 — 실측: schema.sql 에 grep, 아래 참조).

FK 그래프(``backend/alembic/baseline/schema.sql`` 직접 grep 으로 실측 — 모델 주석 아님. 모델의
``agent_api_keys.team_member_id`` FK 선언은 stale-drift, 실 DB 제약 0건 확認):

- **CASCADE**(``members`` 삭제 시 자동): ``member_identity_aliases.member_id``,
  ``agent_project_profiles.member_id``, ``project_access.member_id``.
- **SET NULL**(자동): ``agent_api_keys.member_id``, ``project_access.inherited_from_member_id``,
  ``members.owner_member_id``(self-ref).
- **FK 없음**(``ON DELETE FOREIGN KEY`` 로 ``members(id)``/``agent_*`` 를 가리키는 제약 0건, grep
  실측) — 두 갈래로 나눠 앱레벨 처리:
  - NOT NULL·agent 소유 컨텐츠(그 행 자체가 그 에이전트에 관한 것) → :data:`DELETE_SPECS` 로 행 삭제.
  - nullable·다른 엔티티 위의 포인터(story/doc 등 본체는 보존해야) → :data:`NULLIFY_SPECS` 로
    컬럼만 NULL.

까심 QA RC(재-QA 1회차·2026-07-07): 초판이 model 존재 테이블 위주라 **ORM 모델 없는 supabase/Node
소유 테이블**(memo_*/inbox_items/messaging_bridge_*/mcp_connection_requests 등)을 놓쳤다 —
schema.sql 전체를 정규식으로 exhaustive sweep해 재검증, 25개 컬럼 추가. 이 스윕 중 `invitations`
drift 발견(0104가 DROP했는데 schema.sql엔 남아있음) → 테이블 존재 가드(`to_regclass`) 추가.

PO direction-2 감사(재-QA 2회차·2026-07-07): **schema.sql 자체가 구조적으로 stale** —
`invitations` 1건이 아니라 0150(loop_artifacts)·0151(embeddings)·0158(a2a_tasks) 이후 신규
테이블을 통째로 누락(마지막 재생성 2026-06-21 이후에도 갱신 안 됨). "schema.sql grep"이라는
접근 자체가 이제 신뢰 불가 판정 — **정적 파일을 소스로 삼는 한 이 drift는 계속 재발한다.**

**근본 fix**: schema.sql/모델 대신 :func:`_audit_completeness` 가 **이 세션이 실제로 붙은 live DB**
의 ``information_schema`` 를 매 실행마다 조회해 member/agent-axis 로 보이는(이름 패턴 매치) 전
uuid 컬럼을 뽑고, 각각을 (a) `members` FK CASCADE/SET NULL(자동 처리) (b) 다른 테이블 FK(무관)
(c) `DELETE_SPECS`/`NULLIFY_SPECS` 기재분 (d) **위 어디에도 안 걸리는 미커버 컬럼** 으로 분류한다.
(d)가 1건이라도 있으면 dry-run/execute 둘 다 진행 전에 **fail-loud**(무엇을 놓쳤는지 정확히
출력하고 종료) — 정적 스냅샷이 미래에 또 stale해져도(신규 마이그레이션 추가 등) 이 스크립트
자신이 매 실행마다 스스로 재검증하므로 구조적으로 재발이 막힌다. `_table_exists` 가드(테이블
자체의 생존 드리프트)와 이 감사(컬럼 커버리지 드리프트)가 양방향을 다 잡는다.

선생님 스코프 확認(2026-07-07): dev 내 타 org 테스트 에이전트는 놔두고 뭉클랩(54bac162-...)만 대상.
``--org-id`` 로 SELECT 자체를 스코프하면 DELETE_SPECS/NULLIFY_SPECS/members 삭제 전부 target_ids
경유라 자동으로 그 org 로 한정된다.

::

    cd backend
    DATABASE_URL=... python -m scripts.jobs.purge_test_agents                                    # dry-run(기본) — 전체 org
    DATABASE_URL=... python -m scripts.jobs.purge_test_agents --org-id 54bac162-...                # dry-run, org 스코프
    DATABASE_URL=... python -m scripts.jobs.purge_test_agents --org-id 54bac162-... --execute       # 실행(단일 트랜잭션)

dry-run 출력을 눈으로 검수(비가역) 후에만 --execute. 대상 0건이면 --execute 도 no-op.
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
import uuid

from sqlalchemy import bindparam, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import async_session_factory


class _TargetsChangedError(Exception):
    """dry-run 목록과 실행 직전 재조회 결과가 다름(TOCTOU) — 트랜잭션을 롤백시키기 위한 raise."""

# keep-8 SSOT(오르테가 kickoff 2026-07-07·conv 4a6395bd) — 이 목록 제외 전 agent 하드딜리트 대상.
KEEP_MEMBER_IDS: list[uuid.UUID] = [
    uuid.UUID("05f52181-ea2a-42be-b9a8-9a418b72feb1"),  # 오르테가
    uuid.UUID("9cac9d96-5474-45f7-941e-787407597b52"),  # 은와추쿠/디디
    uuid.UUID("685f3f72-c85c-4a32-898f-3d3320ba39ad"),  # 까심
    uuid.UUID("a24a7ac6-3c4b-4634-8f26-4eb5f3f2d4ee"),  # 미르코
    uuid.UUID("111f1cca-73c7-4fbb-9aed-3cbae19da286"),  # 유나
    uuid.UUID("bff7ea7a-df96-411b-92e7-52791d220d62"),  # 산티아고
    uuid.UUID("61a60fbc-1d3f-497c-9a57-40efc2076ef1"),  # 담롱
    uuid.UUID("7e0e7cc1-c2b8-4669-bfaa-3b13903fd670"),  # 댄 어윈
]

def _select_targets_sql(scoped: bool) -> str:
    org_clause = " AND org_id = :org_id" if scoped else ""
    return (
        "SELECT id, org_id, name, created_at FROM members "
        f"WHERE type = 'agent' AND id NOT IN :keep_ids{org_clause} ORDER BY created_at"
    )

# (table, [column(s) — OR-matched against target ids]) — FK 없음·NOT NULL·그 행 자체가 그 에이전트에
# 관한 컨텐츠라 앱레벨로 행을 삭제(실 FK CASCADE 가 있었다면 했을 일을 대신함).
DELETE_SPECS: list[tuple[str, list[str]]] = [
    ("agent_api_keys", ["member_id", "team_member_id"]),  # team_member_id: 모델 FK 선언은 stale, 실 FK 0
    ("agent_audit_logs", ["agent_id"]),
    ("agent_deployments", ["agent_id"]),
    ("agent_endpoints", ["team_member_id"]),
    ("agent_event_cursors", ["agent_id"]),
    ("agent_event_seqs", ["recipient_id"]),
    ("agent_gateway_sessions", ["agent_id"]),
    ("agent_hitl_requests", ["agent_id", "requested_for"]),
    ("agent_long_term_memories", ["agent_id"]),
    ("agent_message_allowlist", ["agent_member_id", "allowed_id"]),
    ("agent_personas", ["agent_id"]),
    ("agent_routing_rules", ["agent_id"]),
    ("agent_runs", ["agent_id"]),
    ("agent_session_memories", ["agent_id"]),
    ("agent_sessions", ["agent_id"]),
    ("events", ["sender_id", "recipient_id"]),
    ("notification_preferences", ["member_id"]),
    ("standup_entries", ["author_id"]),
    ("standup_feedback", ["feedback_by_id"]),
    ("conversation_participants", ["member_id"]),
    ("retro_votes", ["voter_id"]),
    ("webhook_configs", ["member_id"]),
    ("reward_ledger", ["member_id"]),
    ("participation", ["member_id"]),
    ("file_locks", ["member_id"]),
    ("member_gate_override", ["member_id"]),
    ("story_comments", ["created_by"]),
    ("story_activities", ["created_by"]),
    # 까심 RC 재-QA 추가분(2026-07-07) — schema.sql 전체 스윕, ORM 모델 없는 supabase/Node 소유 테이블 포함.
    ("story_assignees", ["member_id"]),
    ("notification_settings", ["member_id"]),
    ("inbox_items", ["assignee_member_id"]),
    ("memo_assignees", ["member_id"]),
    ("memo_reads", ["team_member_id"]),
    ("memo_replies", ["created_by"]),
    ("memos", ["created_by"]),
    ("messaging_bridge_users", ["team_member_id"]),
    ("permission_audit_logs", ["actor_id"]),
    ("mcp_connection_requests", ["requested_by"]),
    # invitations: schema.sql 이 여전히 이 테이블을 포함하나 0104_drop_invitations_table 이 이미
    # DROP(2026-06-08)·재생성 없음 — disposable pg 로 실측 확認(to_regclass=NULL). 테이블 존재
    # 가드가 이 항목을 무해하게 skip 한다(스키마 drift에도 안전).
    ("invitations", ["invited_by"]),
    # PO direction-2 감사 발견(2026-07-07): schema.sql baseline이 0150(loop_artifacts)·0151
    # (embeddings)·0158(a2a_tasks) 이후 신규 테이블을 통째로 누락 — schema.sql 은 stale-drift가
    # invitations 1건이 아니라 구조적. 이 이후 목록은 disposable pg 를 실제 head(0162)까지
    # `alembic upgrade heads` 돌린 뒤 information_schema 로 직접 뽑은 결과(_audit_completeness
    # 와 동일 로직 — 로컬에서 선-검증). schema.sql 은 더 이상 신뢰하지 않는다.
    ("hypotheses", ["owner_member_id"]),
    ("l2_trigger_firings", ["target_agent_id"]),
    ("workflow_line_definition_versions", ["created_by_member_id"]),
    ("workflow_step_approvals", ["approver_member_id"]),
    ("workflow_role_assignments", ["member_id"]),
    ("workflow_delivery_outbox", ["recipient_id"]),
    ("loop_artifacts", ["created_by_member_id"]),
    ("loop_runs", ["created_by_member_id"]),
    ("a2a_tasks", ["member_id"]),
]

# (table, [column(s)]) — FK 없음·nullable·다른 엔티티(story/doc/conversation 등) 위의 포인터라
# 본체 행은 보존하고 컬럼만 NULL(assignee_id 류 — RESTRICT/CASCADE 아닌 앱레벨 SET NULL 동형).
NULLIFY_SPECS: list[tuple[str, list[str]]] = [
    ("stories", ["assignee_id"]),
    ("epics", ["assignee_id"]),
    ("tasks", ["assignee_id"]),
    ("docs", ["created_by", "assignee_id"]),
    ("doc_comments", ["created_by"]),
    ("doc_revisions", ["created_by"]),
    ("conversations", ["created_by", "resolved_by"]),
    ("conversation_messages", ["sender_id"]),
    ("retro_sessions", ["created_by"]),
    ("retro_items", ["author_id"]),
    ("retro_actions", ["assignee_id"]),
    ("reward_ledger", ["granted_by"]),  # member_id 매칭 행은 위 DELETE_SPECS 에서 이미 제거됨
    ("meetings", ["created_by"]),
    ("policy_documents", ["created_by"]),
    ("agent_hitl_policies", ["created_by", "updated_by"]),
    ("agent_hitl_requests", ["responded_by"]),  # agent_id/requested_for 매칭 행은 위에서 이미 제거됨
    ("workflow_events", ["actor_id"]),
    ("gate", ["resolver_id"]),
    # 까심 RC 재-QA 추가분(2026-07-07) — schema.sql 전체 스윕, ORM 모델 없는 supabase/Node 소유 테이블 포함.
    ("activity_logs", ["actor_id"]),
    ("agent_audit_logs", ["created_by"]),
    ("agent_deployments", ["created_by"]),
    ("agent_personas", ["created_by"]),
    ("agent_routing_rules", ["created_by"]),
    ("agent_sessions", ["created_by"]),
    ("inbox_items", ["from_agent_id", "resolved_by"]),
    ("memo_assignees", ["assigned_by"]),
    ("memo_doc_links", ["created_by"]),
    ("memos", ["resolved_by"]),
    ("messaging_bridge_org_auths", ["created_by"]),
    ("mockup_pages", ["created_by"]),
    ("workflow_execution_logs", ["target_agent_id"]),
    ("workflow_versions", ["created_by"]),
    # PO direction-2 감사 발견(2026-07-07) — 위 DELETE_SPECS 주석 참조(schema.sql 구조적 stale).
    ("doc_share_tokens", ["created_by"]),
    ("hypotheses", ["created_by_member_id", "confirmed_by_member_id", "drafted_by_member_id"]),
    ("activity_events", ["actor_id"]),
    ("hitl_gate_config", ["created_by"]),
    ("hitl_gate_audit", ["actor_id"]),
    ("workflow_line_definitions", ["created_by_member_id"]),
    ("workflow_line_definition_versions", ["reviewed_by_member_id"]),
    ("workflow_line_step_runs", ["resolved_member_id", "escalated_to_member_id", "withdrawn_by_member_id"]),
    ("workflow_step_approvals", [
        "original_approver_member_id", "requested_by_member_id",
        "implementation_member_id", "reassigned_from_member_id",
    ]),
    ("workflow_step_run_events", ["actor_member_id", "target_member_id"]),
    ("workflow_role_assignments", ["deputy_member_id"]),
    ("pull_request_story_link", ["created_by"]),
    ("onboarding_events", ["agent_id"]),
    ("asset_folders", ["created_by"]),
    ("assets", ["created_by"]),
    ("asset_links", ["created_by"]),
    ("embeddings", ["created_by_member_id"]),
]

_DELETE_MEMBERS_SQL = "DELETE FROM members WHERE id IN :ids"


def _or_where(columns: list[str]) -> str:
    # asyncpg 는 파이썬 list 를 Postgres ARRAY 로 자동 캐스팅 안 함(= ANY(:ids) 는 별도 array-typed
    # bind 필요 — 트랩). expanding bindparam(IN (:ids_1, :ids_2, ...) 으로 전개)이 포터블·검증됨.
    return " OR ".join(f"{c} IN :ids" for c in columns)


def _expanding(stmt_sql: str, *names: str):
    return text(stmt_sql).bindparams(*(bindparam(n, expanding=True) for n in names))


async def _select_targets(session: AsyncSession, org_id: uuid.UUID | None) -> list[dict]:
    stmt = _expanding(_select_targets_sql(scoped=org_id is not None), "keep_ids")
    params: dict = {"keep_ids": KEEP_MEMBER_IDS}
    if org_id is not None:
        params["org_id"] = org_id
    rows = (await session.execute(stmt, params)).mappings().all()
    return [dict(r) for r in rows]


# information_schema 컬럼명 매치 패턴 — DELETE_SPECS/NULLIFY_SPECS 에 실제 있는 컬럼명들에서 역산.
# 새 이름 관례(예: "*_actor" 같은 접두 없는 형태)가 생기면 이 패턴도 갱신 필요 — 그 경우도
# _audit_completeness 자체는 "패턴에 안 걸리면 조용히 통과"이므로 이름 패턴 밖의 완전히 새로운
# 컬럼명 관례는 이 가드의 한계(테이블 존재 누락과 달리 컬럼명 형태 누락은 휴리스틱 한계 내에서만 방어).
_MEMBER_AXIS_COLUMN_PATTERN = (
    r"(member_id|agent_id|created_by|updated_by|assignee_id|author_id|actor_id|"
    r"resolved_by|assigned_by|requested_by|requested_for|invited_by|granted_by|voter_id|"
    r"feedback_by|sender_id|recipient_id|_agent_id|team_member_id|agent_member_id|"
    r"allowed_id|owner_member_id|inherited_from|responded_by|resolver_id|org_member_id|"
    r"from_agent_id|target_agent_id)"
)

_AUDIT_LIVE_COLUMNS_SQL = f"""
SELECT c.table_name, c.column_name, c.is_nullable
FROM information_schema.columns c
WHERE c.table_schema = 'public' AND c.data_type = 'uuid'
  AND c.table_name != 'team_members'  -- 뷰(0088) — DELETE/UPDATE 대상 아님, members 가 실체
  AND c.column_name ~* '{_MEMBER_AXIS_COLUMN_PATTERN}'
"""

_AUDIT_FK_SQL = """
SELECT tc.table_name, kcu.column_name, ccu.table_name AS ref_table, rc.delete_rule
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
JOIN information_schema.referential_constraints rc ON rc.constraint_name = tc.constraint_name
WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
"""


async def _audit_completeness(session: AsyncSession) -> list[str]:
    """schema.sql 이 아니라 **이 세션이 실제로 붙은 live DB** 의 카탈로그로 커버리지를 재검증.

    PO direction-2 감사(2026-07-07): schema.sql 이 구조적으로 stale(신규 마이그레이션 누락)이라
    정적 파일을 소스로 삼는 스윕은 언제든 다시 놓칠 수 있다 — 이 함수가 매 실행마다 실 DB 를
    직접 물어 (a) members FK CASCADE/SET NULL(자동) (b) 다른 테이블 FK(무관) (c) DELETE_SPECS/
    NULLIFY_SPECS 기재분 어디에도 안 걸리는 컬럼을 찾아 문자열 목록으로 반환한다(빈 리스트=완전).
    """
    covered = {(t, c) for t, cols in DELETE_SPECS for c in cols} | {
        (t, c) for t, cols in NULLIFY_SPECS for c in cols
    }
    cols = (await session.execute(text(_AUDIT_LIVE_COLUMNS_SQL))).all()
    fk_rows = (await session.execute(text(_AUDIT_FK_SQL))).all()
    fk_map = {(r[0], r[1]): (r[2], r[3]) for r in fk_rows}

    gaps: list[str] = []
    for table, col, nullable in cols:
        fk = fk_map.get((table, col))
        if fk is not None:
            ref_table, delete_rule = fk
            if ref_table == "members" and delete_rule in ("CASCADE", "SET NULL"):
                continue  # 자동 처리
            if ref_table == "members":
                gaps.append(f"{table}.{col}: members FK 있으나 delete_rule={delete_rule}(CASCADE/SET NULL 아님 — 별도 처리 필요)")
                continue
            continue  # 다른 테이블 FK — members 축 아님, 무관
        if (table, col) in covered:
            continue
        gaps.append(f"{table}.{col} (nullable={nullable}) — DELETE_SPECS/NULLIFY_SPECS 미기재·FK 없음")
    return gaps


async def _table_exists(session: AsyncSession, table: str) -> bool:
    # schema.sql(체크인된 정적 참조)이 실제 마이그레이션 head와 어긋날 수 있음이 이번 재-QA로
    # 실측 확認됨(invitations — 0104가 이미 DROP했는데 schema.sql엔 남아있었음). 정적 분석을
    # 신뢰하지 않고 이 세션이 실제로 붙은 DB에 직접 물어 어느 환경/시점이든 안전하게 만든다.
    result = await session.execute(text("SELECT to_regclass(:t) IS NOT NULL"), {"t": f"public.{table}"})
    return bool(result.scalar_one())


async def _run_execute(session: AsyncSession, target_ids: list[uuid.UUID]) -> None:
    for table, columns in DELETE_SPECS:
        if not await _table_exists(session, table):
            print(f"  SKIP {table}: 테이블 없음(스키마 drift·무해)")
            continue
        stmt = _expanding(f"DELETE FROM {table} WHERE {_or_where(columns)}", "ids")  # noqa: S608 — 컬럼명 고정 리터럴(상수 목록), id 값만 바인딩
        result = await session.execute(stmt, {"ids": target_ids})
        if result.rowcount:
            print(f"  DELETE {table}: {result.rowcount}건")

    for table, columns in NULLIFY_SPECS:
        if not await _table_exists(session, table):
            print(f"  SKIP {table}: 테이블 없음(스키마 drift·무해)")
            continue
        set_clause = ", ".join(f"{c} = NULL" for c in columns)
        stmt = _expanding(f"UPDATE {table} SET {set_clause} WHERE {_or_where(columns)}", "ids")  # noqa: S608
        result = await session.execute(stmt, {"ids": target_ids})
        if result.rowcount:
            print(f"  NULLIFY {table}: {result.rowcount}건")

    result = await session.execute(_expanding(_DELETE_MEMBERS_SQL, "ids"), {"ids": target_ids})
    print(f"  DELETE members: {result.rowcount}건 (CASCADE/SET NULL 자동: member_identity_aliases·"
          f"agent_project_profiles·project_access·agent_api_keys.member_id·members.owner_member_id)")


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--execute", action="store_true", help="실제 삭제 실행(기본은 dry-run/SELECT만)")
    parser.add_argument(
        "--org-id", type=uuid.UUID, default=None,
        help="지정 시 이 org로만 스코프(선생님 지시 2026-07-07: dev 내 타 org는 놔둠). 기본=전체 org.",
    )
    args = parser.parse_args()
    org_id: uuid.UUID | None = args.org_id

    if not os.environ.get("DATABASE_URL"):
        print("[FAIL] DATABASE_URL 필요", file=sys.stderr)
        return 2

    # 완전성 자가감사 — dry-run 조차 진행 전에 먼저. schema.sql 이 아니라 이 세션이 실제로 붙은
    # live DB 를 물어서, 정적 스냅샷이 미래에 또 stale 해져도 구조적으로 재발을 막는다.
    async with async_session_factory() as audit_session:
        gaps = await _audit_completeness(audit_session)
    if gaps:
        print(f"[FAIL] 완전성 감사 실패 — DELETE_SPECS/NULLIFY_SPECS 미커버 {len(gaps)}건(fail-loud, 진행 안 함):", file=sys.stderr)
        for g in gaps:
            print(f"  {g}", file=sys.stderr)
        return 2
    print("[OK] 완전성 감사 통과 — live DB member-axis 컬럼 전부 CASCADE/SET NULL/DELETE_SPECS/NULLIFY_SPECS 커버됨")

    # SELECT 전용 세션(읽기만·트랜잭션 상태를 실행 세션과 분리) — 눈으로 검수하는 dry-run 대상 확정.
    async with async_session_factory() as ro_session:
        targets = await _select_targets(ro_session, org_id)

    print(f"=== 삭제 대상(agent·keep-8 제외{f'·org={org_id}' if org_id else ''}) {len(targets)}건 ===")
    for t in targets:
        print(f"  {t['id']}  org={t['org_id']}  name={t['name']!r}  created_at={t['created_at']}")

    if not targets:
        print("[OK] 대상 0건 — 할 일 없음")
        return 0

    target_ids = [t["id"] for t in targets]
    # 방어: keep-8 이 대상에 절대 섞이면 안 됨(쿼리 자체가 제외하지만 이중 확인).
    overlap = set(target_ids) & set(KEEP_MEMBER_IDS)
    if overlap:
        print(f"[FAIL] keep-8 이 대상에 섞임(있어선 안 됨): {overlap}", file=sys.stderr)
        return 2

    if not args.execute:
        print("\n[DRY-RUN] 위 목록을 눈으로 검수 후 --execute 로 실행하는. 삭제된 것 없음.")
        return 0

    # 실행 전용 새 세션 — dry-run SELECT 이후 재확인(TOCTOU 가드) + 단일 트랜잭션.
    print(f"\n[EXECUTE] {len(target_ids)}건 하드딜리트 트랜잭션 시작")
    try:
        async with async_session_factory() as exec_session, exec_session.begin():
            revalidated = await _select_targets(exec_session, org_id)
            revalidated_ids = {t["id"] for t in revalidated}
            if revalidated_ids != set(target_ids):
                raise _TargetsChangedError(revalidated_ids ^ set(target_ids))
            await _run_execute(exec_session, target_ids)
    except _TargetsChangedError as exc:
        # raise 로 인해 위 async with 가 롤백하고 빠져나옴(commit 아님) — 안전.
        print(f"[FAIL] 실행 직전 재조회 결과가 dry-run 목록과 다름(동시 변경 감지, diff={exc}) — 재실행하는", file=sys.stderr)
        return 2
    print("[DONE] 커밋 완료")

    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
