"""로드테스트용 테스트 신원 N개 시더 — org(pro) + verified user + project + org-level agent + api_key.

각 «신원» 1개 = (organizations plan='pro') + (users email_verified) + owner org_members +
휴먼 앵커(members) + project + org-level agent(members+profile+grant) + api_key(sk_live_*).
raw INSERT 를 team_members(뷰·0088)에 하지 않고 앱의 실 서비스 경로만 태운다:

- Organization(name, slug, plan='pro')  ·  app/models/organization.py
- User(email, hashed_password=hash_password(...), is_active, email_verified)  ·  app/models/user.py + app/core/security.py
- OrgMember(org_id, user_id, role='owner')  ·  app/models/project.py
- ensure_human_member(session, org_member_id)  ·  app/services/agent_anchor_sync.py  (휴먼 members 앵커)
- ProjectRepository(session, org_id).create(name=, description=None, slug=)  ·  app/repositories/project.py (→ base.py)
- create_org_level_agent(session, org_id=, created_by=, name=, project_ids=[project.id]) → (member, api_key)  ·  app/services/org_agent.py

성공한 신원의 자격을 로그에서 회수 가능하게 마커 사이에 «한 줄» JSON 으로 찍는다:
    LOADTEST_CREDS_JSON_START
    [{"api_key": "sk_live_...", "org_id": "...", "project_id": "..."}, ...]
    LOADTEST_CREDS_JSON_END

신원 하나가 실패하면 그 번호를 로그로 남기고 «계속»(전체 중단 안 함) — 각 신원은 자기 트랜잭션이라
실패분은 통째로 롤백되어 부분 신원이 남지 않는다. 마지막에 성공/전체 개수를 찍는다.

재실행 안전(UNIQUE 충돌 방지): 시작 시 랜덤 run-id(hex 8자)를 뽑아 slug/email/name 전부에 접두한다 —
고정 접두는 재실행 時 organizations.slug(전역 UNIQUE)/users.email(전역 UNIQUE)에서 충돌한다.

실행(이미지 내부 /app 기준):
    python -m scripts.jobs.seed_loadtest_identities            # N=20(기본)
    python -m scripts.jobs.seed_loadtest_identities 50         # argv 우선
    SEED_N=50 python -m scripts.jobs.seed_loadtest_identities  # 없으면 env SEED_N

DB 접속: DATABASE_URL(없으면 ALEMBIC_URL 폴백 — scripts/jobs/_db_env.py). 이 폴백은 app.core.database
import «前»에 돌아야 한다(engine 이 import 시점 settings.database_url 로 1회 생성됨) — 아래 import 순서 준수.
"""
from __future__ import annotations

import asyncio
import json
import os
import secrets
import sys
import uuid

from scripts.jobs._db_env import resolve_database_url

# ⚠️ app.* import «前»에 DATABASE_URL 을 확정한다 — app.core.database.engine 은 그 모듈 import
#    시점에 settings.database_url 로 단 한 번 생성된다(_db_env.py 도크스트링). 늦으면 반영 안 됨.
_db_url_summary = resolve_database_url()

from app.core.database import async_session_factory  # noqa: E402
from app.core.security import hash_password  # noqa: E402
from app.models.organization import Organization  # noqa: E402
from app.models.project import OrgMember  # noqa: E402
from app.models.user import User  # noqa: E402
from app.repositories.project import ProjectRepository  # noqa: E402
from app.services.agent_anchor_sync import ensure_human_member  # noqa: E402
from app.services.org_agent import create_org_level_agent  # noqa: E402


def _resolve_n() -> int:
    """N 결정: argv[1] 우선, 없으면 env SEED_N, 없으면 20."""
    if len(sys.argv) > 1 and sys.argv[1].strip():
        return int(sys.argv[1])
    env = os.environ.get("SEED_N")
    if env and env.strip():
        return int(env)
    return 20


async def _seed_one(run_id: str, i: int) -> dict[str, str]:
    """신원 1개를 자기 트랜잭션에서 생성하고 {api_key, org_id, project_id} 반환.

    성공 시 커밋(session.begin 블록 종료 = commit), 예외 시 통째 롤백(부분 신원 0). 반환값은
    커밋 «前»에 확정한다(expire_on_commit=False 라 커밋 후에도 접근 가능하나, 방어적으로 미리 캡처).
    """
    async with async_session_factory() as session:
        async with session.begin():
            org = Organization(
                name=f"LoadTest {run_id} Org {i}",
                slug=f"loadtest-{run_id}-{i}",
                plan="pro",
            )
            session.add(org)
            await session.flush()  # org.id 확정(members/project org_id FK 선행)

            user = User(
                email=f"loadtest+{run_id}-{i}@loadtest.local",
                hashed_password=hash_password(secrets.token_urlsafe(16)),
                is_active=True,
                email_verified=True,
            )
            session.add(user)
            await session.flush()  # user.id 확정

            om = OrgMember(org_id=org.id, user_id=user.id, role="owner")
            session.add(om)
            await session.flush()  # om.id 확정

            # 휴먼 앵커(members, id=om.id) 멱등 보장 — org-level agent 의 owner_member_id 해소 선행.
            await ensure_human_member(session, om.id)

            project = await ProjectRepository(session, org.id).create(
                name=f"LoadTest {run_id} Project {i}",
                description=None,
                slug=f"loadtest-proj-{run_id}-{i}",
            )

            # org-level agent 1개 + project grant fan-out + api_key 1개. created_by=user.id
            # (org_agent 가 org_members.user_id 로 owner_member 를 찾는다).
            _member, api_key_plaintext = await create_org_level_agent(
                session,
                org_id=org.id,
                created_by=user.id,
                name=f"loadtest-agent-{run_id}-{i}",
                project_ids=[project.id],
            )

            # 커밋 前 캡처(방어적).
            return {
                "api_key": api_key_plaintext or "",
                "org_id": str(org.id),
                "project_id": str(project.id),
            }


async def main() -> int:
    if _db_url_summary is None:
        print("[FAIL] DATABASE_URL·ALEMBIC_URL 둘 다 미설정", file=sys.stderr)
        return 2
    print(f"[db] {_db_url_summary}", file=sys.stderr)

    n = _resolve_n()
    run_id = secrets.token_hex(4)  # 8 hex chars — 재실행 UNIQUE 접두(고정 접두 금지)
    print(f"[seed] run_id={run_id} n={n}", file=sys.stderr)

    creds: list[dict[str, str]] = []
    for i in range(n):
        try:
            row = await _seed_one(run_id, i)
        except Exception as exc:  # noqa: BLE001 — 한 신원 실패가 나머지를 막지 않게 격리
            print(f"[FAIL] identity {i} 실패 — {type(exc).__name__}: {exc}", file=sys.stderr)
            continue
        creds.append(row)
        print(f"[ok] identity {i}: org={row['org_id']} project={row['project_id']}", file=sys.stderr)

    # 자격 회수용 — 마커 사이 «한 줄» JSON(부분 성공이어도 항상 찍어 파싱 가능하게).
    print("LOADTEST_CREDS_JSON_START")
    print(json.dumps(creds))
    print("LOADTEST_CREDS_JSON_END")

    print(f"[done] {len(creds)}/{n} identities created", file=sys.stderr)
    return 0 if len(creds) == n else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
