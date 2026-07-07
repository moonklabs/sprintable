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

::

    cd backend
    DATABASE_URL=... python -m scripts.jobs.purge_test_agents               # dry-run(기본) — SELECT만
    DATABASE_URL=... python -m scripts.jobs.purge_test_agents --execute     # 실행(단일 트랜잭션)

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

_SELECT_TARGETS_SQL = """
SELECT id, org_id, name, created_at
FROM members
WHERE type = 'agent' AND id NOT IN :keep_ids
ORDER BY created_at
"""

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
]

_DELETE_MEMBERS_SQL = "DELETE FROM members WHERE id IN :ids"


def _or_where(columns: list[str]) -> str:
    # asyncpg 는 파이썬 list 를 Postgres ARRAY 로 자동 캐스팅 안 함(= ANY(:ids) 는 별도 array-typed
    # bind 필요 — 트랩). expanding bindparam(IN (:ids_1, :ids_2, ...) 으로 전개)이 포터블·검증됨.
    return " OR ".join(f"{c} IN :ids" for c in columns)


def _expanding(stmt_sql: str, *names: str):
    return text(stmt_sql).bindparams(*(bindparam(n, expanding=True) for n in names))


async def _select_targets(session: AsyncSession) -> list[dict]:
    stmt = _expanding(_SELECT_TARGETS_SQL, "keep_ids")
    rows = (await session.execute(stmt, {"keep_ids": KEEP_MEMBER_IDS})).mappings().all()
    return [dict(r) for r in rows]


async def _run_execute(session: AsyncSession, target_ids: list[uuid.UUID]) -> None:
    for table, columns in DELETE_SPECS:
        stmt = _expanding(f"DELETE FROM {table} WHERE {_or_where(columns)}", "ids")  # noqa: S608 — 컬럼명 고정 리터럴(상수 목록), id 값만 바인딩
        result = await session.execute(stmt, {"ids": target_ids})
        if result.rowcount:
            print(f"  DELETE {table}: {result.rowcount}건")

    for table, columns in NULLIFY_SPECS:
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
    args = parser.parse_args()

    if not os.environ.get("DATABASE_URL"):
        print("[FAIL] DATABASE_URL 필요", file=sys.stderr)
        return 2

    # SELECT 전용 세션(읽기만·트랜잭션 상태를 실행 세션과 분리) — 눈으로 검수하는 dry-run 대상 확정.
    async with async_session_factory() as ro_session:
        targets = await _select_targets(ro_session)

    print(f"=== 삭제 대상(agent·keep-8 제외) {len(targets)}건 ===")
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
            revalidated = await _select_targets(exec_session)
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
