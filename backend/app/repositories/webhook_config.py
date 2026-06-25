from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.webhook_config import WebhookConfig


class WebhookConfigRepository:
    def __init__(self, session: AsyncSession, org_id: uuid.UUID) -> None:
        self.session = session
        self.org_id = org_id

    async def list(
        self, member_id: uuid.UUID, project_id: uuid.UUID | None = None
    ) -> list[WebhookConfig]:
        # IDOR(산티아고): webhook-config 는 **멤버 소유** 리소스 — org_id 만으론 same-org 타 멤버 config
        # (URL 포함)가 응답에 실린다(5c1258e2 토대 갭). caller member-scope 강제. admin 전체조회는 별도.
        q = select(WebhookConfig).where(
            WebhookConfig.org_id == self.org_id,
            WebhookConfig.member_id == member_id,
        )
        if project_id is not None:
            q = q.where(WebhookConfig.project_id == project_id)
        q = q.order_by(WebhookConfig.created_at.desc())
        result = await self.session.execute(q)
        return list(result.scalars().all())

    async def get(self, id: uuid.UUID) -> WebhookConfig | None:
        """org-scope 조회 — **내부용**(upsert 직후 자기 행 재조회). 외부 노출 경로는 get_owned 사용."""
        result = await self.session.execute(
            select(WebhookConfig).where(WebhookConfig.id == id, WebhookConfig.org_id == self.org_id)
        )
        return result.scalar_one_or_none()

    async def get_owned(self, id: uuid.UUID, member_id: uuid.UUID) -> WebhookConfig | None:
        """소유 검증 조회 — id + org + **member**. same-org 타 멤버 config_id 를 알아도 None(IDOR 차단).
        get/delete/test-send 등 외부 노출 경로의 표준 조회."""
        result = await self.session.execute(
            select(WebhookConfig).where(
                WebhookConfig.id == id,
                WebhookConfig.org_id == self.org_id,
                WebhookConfig.member_id == member_id,
            )
        )
        return result.scalar_one_or_none()

    async def get_by_project(self, project_id: uuid.UUID) -> list[WebhookConfig]:
        result = await self.session.execute(
            select(WebhookConfig).where(
                WebhookConfig.project_id == project_id,
                WebhookConfig.is_active.is_(True),
            )
        )
        return list(result.scalars().all())

    async def upsert(
        self,
        member_id: uuid.UUID,
        url: str,
        project_id: uuid.UUID | None = None,
        events: list[str] | None = None,
        is_active: bool = True,
        secret: str | None = None,
    ) -> WebhookConfig:
        """webhook_config upsert — conflict-key 기반.

        스키마에는 멤버 1행을 강제하는 부분 unique 인덱스 2개가 있다:
          - idx_webhook_configs_unique:  UNIQUE(org_id, member_id, project_id) WHERE project_id IS NOT NULL
          - idx_webhook_configs_default: UNIQUE(org_id, member_id)             WHERE project_id IS NULL
        즉 (org, member, project) 또는 (org, member, project=NULL) 당 webhook 1행만 허용한다.
        과거 url 기준 조회는 같은 멤버가 다른 url로 재등록하면 None→plain INSERT→부분 unique 위반→500.
        따라서 위 두 부분 인덱스를 conflict 타깃으로 on_conflict_do_update를 수행한다(중복키 0, url/설정 갱신).
        """
        # 충돌(update) 시 갱신할 컬럼. 기존 url-조회 update 경로 의미 보존:
        #   - url / is_active 는 항상 갱신
        #   - events 는 명시(non-None) 일 때만 갱신(None → 기존 값 유지)
        #   - secret 는 명시(non-None) 일 때만 갱신(None → 기존 값 유지)
        set_values: dict = {
            "url": url,
            "is_active": is_active,
        }
        if events is not None:
            set_values["events"] = events
        if secret is not None:
            set_values["secret"] = secret or None

        if project_id is not None:
            # idx_webhook_configs_unique (org_id, member_id, project_id) WHERE project_id IS NOT NULL
            index_elements = ["org_id", "member_id", "project_id"]
            index_where = WebhookConfig.project_id.isnot(None)
        else:
            # idx_webhook_configs_default (org_id, member_id) WHERE project_id IS NULL
            index_elements = ["org_id", "member_id"]
            index_where = WebhookConfig.project_id.is_(None)

        stmt = (
            pg_insert(WebhookConfig)
            .values(
                org_id=self.org_id,
                member_id=member_id,
                url=url,
                project_id=project_id,
                events=events or [],
                is_active=is_active,
                secret=secret or None,
                channel="generic",
            )
            .on_conflict_do_update(
                index_elements=index_elements,
                index_where=index_where,
                set_=set_values,
            )
            .returning(WebhookConfig.id)
        )
        result = await self.session.execute(stmt)
        config_id = result.scalar_one()
        await self.session.flush()

        config = await self.get(config_id)
        assert config is not None  # noqa: S101 — 방금 upsert한 행, 동일 org 스코프
        await self.session.refresh(config)
        return config

    async def delete(self, id: uuid.UUID, member_id: uuid.UUID) -> bool:
        # IDOR: 소유 검증(get_owned) — 타 멤버 config_id 로 삭제 차단.
        config = await self.get_owned(id, member_id)
        if config is None:
            return False
        await self.session.delete(config)
        return True
