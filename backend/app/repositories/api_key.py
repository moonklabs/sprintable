from __future__ import annotations

import hashlib
import secrets
import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy import update as sa_update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.api_key import ApiKey


def _generate_key() -> tuple[str, str, str]:
    raw = secrets.token_hex(32)
    prefix = f"sk_live_{raw[:8]}"
    plaintext = f"sk_live_{raw}"
    key_hash = hashlib.sha256(plaintext.encode()).hexdigest()
    return plaintext, prefix, key_hash


class ApiKeyRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def list_by_member(self, team_member_id: uuid.UUID) -> list[ApiKey]:
        result = await self.session.execute(
            select(ApiKey)
            .where(ApiKey.team_member_id == team_member_id)
            .order_by(ApiKey.created_at.desc())
        )
        return list(result.scalars().all())

    async def get(self, api_key_id: uuid.UUID) -> ApiKey | None:
        result = await self.session.execute(
            select(ApiKey).where(ApiKey.id == api_key_id)
        )
        return result.scalar_one_or_none()

    async def sync_active_scope(self, team_member_id: uuid.UUID, scope: list[str]) -> list[uuid.UUID]:
        """story #2941 — `PATCH /agent_personas`가 표시용 tool_allowlist만 바꾸고 실제 집행값
        `ApiKey.scope`(매 요청 `_check_api_key_scope`로 검증)를 재동기화 안 하던 갭 봉합.
        `rotate()`와 달리 새 키를 발급하지 않는다 — 스코프 축소가 기존에 발급된 키에 **즉시**
        반영되는 게 보안 취지(호출자가 새 plaintext를 다시 받아야 하는 건 이 작업의 목적이
        아니다). 활성(revoked_at IS NULL) 키가 없으면(persona만 만들고 아직 recruit/키 발급이
        없는 경우) no-op — 빈 리스트 반환, 에러 아님.

        ⚠️카디르 HIGH 재발견(2026-08-22): "활성 키는 항상 최대 1개"는 recruit
        (`_rotate_or_create_key`) 경로에서만 참인 불변식이다 — 일반 발급 엔드포인트
        `POST /agents/{agent_id}/api-keys`(`api_keys.py::create_agent_api_key`)는 기존 활성
        키 존재 여부를 확인하지 않고 무조건 `repo.create()`로 신규 발급하므로, 한 agent가
        합법적으로 활성 키를 2개 이상 가질 수 있다. UPDATE 문 자체는 WHERE 절에 매칭되는
        모든 행을 원자적으로 갱신하므로 다중 키에도 원래 안전했지만, 예전 구현은 결과 확인용
        후속 SELECT에 `scalar_one_or_none()`을 써 다중 키 케이스에서 `MultipleResultsFound`로
        크래시했다 — 트랜잭션 전체 롤백으로 이어져 **권한 축소가 가장 필요한 다중 키 상황에서
        정확히 실패**하는 최악의 결과였다. 처방: 후속 SELECT 자체를 없애고 UPDATE의
        `RETURNING`으로 갱신된 모든 행의 id를 그대로 받는다 — 단일/다중 키 모두 동일 코드
        경로로 안전."""
        result = await self.session.execute(
            sa_update(ApiKey)
            .where(ApiKey.team_member_id == team_member_id, ApiKey.revoked_at.is_(None))
            .values(scope=scope)
            .returning(ApiKey.id)
        )
        return list(result.scalars().all())

    async def create(
        self,
        team_member_id: uuid.UUID,
        scope: list[str] | None = None,
        *,
        expires_at: datetime | None,
    ) -> tuple[ApiKey, str]:
        """story #2838(PO AC 정정 2026-08-20) — expires_at은 **기본값 없는 필수 kwarg**. 최초
        sentinel(_UNSET) 안은 이 repo가 인자를 안 받은 호출부에 옛 90일 기본값을 여전히
        내려줘 그 자체가 "침묵 90일" 경로로 남았다(diff 밖 grep — team_members.py/org_agent.py/
        recruit_service.py 셋 다 인자 미전달, 실사고의 유력 발급 경로 그 자체). 필수화해 repo
        층이 침묵을 구조로 거부 — 모든 호출부가 명시(값 있으면 그 시각, None이면 명시적
        무만료)해야 컴파일조차 안 된다."""
        plaintext, prefix, key_hash = _generate_key()
        key = ApiKey(
            team_member_id=team_member_id,
            member_id=team_member_id,  # AC3-1 dual-write: agent member.id = team_member.id (1:1)
            key_prefix=prefix,
            key_hash=key_hash,
            scope=scope,
            expires_at=expires_at,
        )
        self.session.add(key)
        await self.session.flush()
        await self.session.refresh(key)
        return key, plaintext

    async def revoke(self, api_key_id: uuid.UUID) -> ApiKey | None:
        key = await self.get(api_key_id)
        if key is None:
            return None
        key.revoked_at = datetime.now(timezone.utc)
        await self.session.flush()
        await self.session.refresh(key)
        return key

    async def rotate(
        self, api_key_id: uuid.UUID, scope: list[str] | None = None
    ) -> tuple[ApiKey, str] | None:
        """이전 키 revoke + 신규 발급. ``scope`` 미지정 시 이전 scope 그대로 승계(기존 동작 보존) —
        E-RECRUIT S3(story ff2996d0)가 역할변경 시 scope 를 새 role_template 파생값으로 교체하려고
        명시 override 를 추가했다(sentinel: None=승계 vs []=빈 scope 의도적 지정 구분).

        까심 QA HIGH(S3 RC) 방어: revoke를 compare-and-swap(``UPDATE ... WHERE revoked_at IS NULL``)
        으로 실행한다 — 동시 두 rotate 호출이 같은 키를 둘 다 "성공"으로 revoke+재발급해 active 키가
        2개 남는 레이스를 막는다. Postgres의 UPDATE 자체가 대상 행을 잠그므로 두번째 호출은 첫번째
        커밋 후 재평가돼 ``revoked_at IS NULL`` 이 거짓 → rowcount 0 → None(이미 다른 호출이 회전함).
        """
        old = await self.get(api_key_id)
        if old is None:
            return None

        result = await self.session.execute(
            sa_update(ApiKey)
            .where(ApiKey.id == api_key_id, ApiKey.revoked_at.is_(None))
            .values(revoked_at=datetime.now(timezone.utc))
        )
        if result.rowcount == 0:
            return None  # 레이스 패배 — 다른 호출이 이미 이 키를 회전시킴

        new_key, plaintext = await self.create(
            team_member_id=old.team_member_id,
            scope=scope if scope is not None else old.scope,
            # story #2838 AC② — 원 키의 만료 정책 그대로 승계(무만료→무만료·만료 키→같은 만료
            # 시각). 회전이 수명을 침묵으로 늘리거나 줄이지 않는다(#2838이 고치는 병의 재발
            # 지점이었다 — 이전엔 항상 expires_at=None을 여기서 create()에 넘겨 90일이 매
            # rotate마다 재각인됐다). 연장이 필요하면 그건 명시 파라미터의 몫으로 남긴다.
            expires_at=old.expires_at,
        )
        return new_key, plaintext
