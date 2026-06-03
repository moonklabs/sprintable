"""grant-only 휴먼 "스토리 배정" 200 라이브 검증 (E-MEMBER-SSOT AC3-2).

스토리 배정 write 경로는 stories.assignee_id(FK 완화 0078) + participation.member_id(FK 완화 0079)
**2개 컬럼**을 건드린다(update_story → _upsert_assignee_participation). 따라서 grant-only 스토리배정
200은 0078·0079가 **둘 다** dev 적용된 뒤에만 통과한다. 0078만 적용된 상태에선 participation INSERT에서
여전히 FK violation 500.

이 스크립트는: 임시 grant-only 휴먼(User+OrgMember[member]+project_access[granted], team_member 없음)과
임시 스토리를 만들고, 그 휴먼 JWT로 dev 백엔드 PATCH /api/v2/stories/{id}에 assignee_id=org_member.id를
보내 **200**을 확인한 뒤, participation 행 생성까지 검증하고 전부 정리(cleanup)한다.

전제(환경변수):
  BACKEND_URL   예) https://sprintable-backend-dev-57iommnikq-du.a.run.app
  DATABASE_URL  백엔드와 동일 (postgresql+asyncpg://...  cloud-sql-proxy 경유 가능)
  JWT_SECRET    dev와 동일 secret (Secret Manager JWT_SECRET) — create_access_token 서명용
  ORG_ID        대상 조직 (실 dev org)
  PROJECT_ID    대상 프로젝트 (해당 org 소속)

실행:
  cd backend && DATABASE_URL=... JWT_SECRET=... BACKEND_URL=... ORG_ID=... PROJECT_ID=... \
      python -m scripts.verify_grant_only_story_assign

⚠️ 0079 migrate-dev 적용 후 실행할 것. (0078만 적용 시 의도적으로 500이 나며 FAIL로 표시된다.)
"""
from __future__ import annotations

import asyncio
import os
import sys
import uuid

import httpx
from sqlalchemy import text

from app.core.database import async_session_factory
from app.core.security import create_access_token
from app.models.pm import Story
from app.models.project import OrgMember
from app.models.project_access import ProjectAccess
from app.models.user import User


def _env(name: str) -> str:
    v = os.environ.get(name)
    if not v:
        print(f"[FAIL] 환경변수 {name} 필요", file=sys.stderr)
        sys.exit(2)
    return v


async def main() -> int:
    backend = _env("BACKEND_URL").rstrip("/")
    org_id = uuid.UUID(_env("ORG_ID"))
    project_id = uuid.UUID(_env("PROJECT_ID"))
    _env("DATABASE_URL")  # async_session_factory가 settings.database_url로 이미 바인딩
    _env("JWT_SECRET")

    suffix = uuid.uuid4().hex[:10]
    email = f"grant-only-verify-{suffix}@example.invalid"

    user_id = om_id = story_id = None
    try:
        # ── 1. 임시 grant-only 휴먼 + 스토리 (team_member 없음) ──────────────────
        async with async_session_factory() as s:
            u = User(email=email, hashed_password="x" * 32, email_verified=True)
            s.add(u)
            await s.flush()
            om = OrgMember(org_id=org_id, user_id=u.id, role="member")  # owner/admin 아님 = 순수 grant 의존
            s.add(om)
            await s.flush()
            pa = ProjectAccess(
                project_id=project_id,
                org_member_id=om.id,
                permission="granted",
                member_id=om.id,
                role="member",
                access_source="direct",
            )
            s.add(pa)
            story = Story(org_id=org_id, project_id=project_id, title=f"grant-only assign verify {suffix}")
            s.add(story)
            await s.flush()
            user_id, om_id, story_id = u.id, om.id, story.id

            # 안전망: team_member가 없어야 진짜 grant-only
            tm = await s.execute(
                text("SELECT 1 FROM team_members WHERE org_id=:o AND user_id=:u LIMIT 1"),
                {"o": org_id, "u": user_id},
            )
            assert tm.scalar_one_or_none() is None, "임시 휴먼에 team_member가 존재 — grant-only 아님"
            await s.commit()

        print(f"[setup] user={user_id} org_member={om_id} story={story_id} (grant-only, no team_member)")

        # ── 2. 그 휴먼 JWT로 스토리 배정 PATCH → 200 기대 ────────────────────────
        token = create_access_token(
            str(user_id),
            email=email,
            app_metadata={
                "org_id": str(org_id),
                "project_id": str(project_id),
                "project_ids": [str(project_id)],
                "role": "member",
            },
        )
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.patch(
                f"{backend}/api/v2/stories/{story_id}",
                json={"assignee_id": str(om_id)},
                headers={"Authorization": f"Bearer {token}"},
            )
        print(f"[assign] PATCH /api/v2/stories/{story_id} assignee_id={om_id} → {resp.status_code}")
        if resp.status_code != 200:
            print(f"[FAIL] 기대 200, 실제 {resp.status_code}: {resp.text[:400]}")
            return 1

        # ── 3. participation 공동-write까지 확인 (member_id = org_member.id) ──────
        async with async_session_factory() as s:
            assignee = await s.execute(text("SELECT assignee_id FROM stories WHERE id=:i"), {"i": story_id})
            part = await s.execute(
                text("SELECT 1 FROM participation WHERE story_id=:s AND member_id=:m LIMIT 1"),
                {"s": story_id, "m": om_id},
            )
            assignee_ok = assignee.scalar_one_or_none() == om_id
            part_ok = part.scalar_one_or_none() is not None
        print(f"[verify] stories.assignee_id==org_member.id: {assignee_ok} / participation 행 생성: {part_ok}")
        if not (assignee_ok and part_ok):
            print("[FAIL] 배정/참가 행 확인 실패")
            return 1

        print("[PASS] grant-only 휴먼 스토리 배정 200 + participation 공동-write 정상 (0078+0079 적용 확인)")
        return 0
    finally:
        # ── cleanup (생성 역순) ─────────────────────────────────────────────────
        async with async_session_factory() as s:
            if story_id is not None:
                await s.execute(text("DELETE FROM participation WHERE story_id=:s"), {"s": story_id})
                await s.execute(text("DELETE FROM stories WHERE id=:i"), {"i": story_id})
            if om_id is not None:
                await s.execute(text("DELETE FROM project_access WHERE org_member_id=:m"), {"m": om_id})
                await s.execute(text("DELETE FROM org_members WHERE id=:m"), {"m": om_id})
            if user_id is not None:
                await s.execute(text("DELETE FROM users WHERE id=:u"), {"u": user_id})
            await s.commit()
        print("[cleanup] 임시 데이터 정리 완료")


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
