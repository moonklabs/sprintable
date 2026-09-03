"""story #3374(Phase1·마케팅운영, 페드루 PO 확定 2026-09-03) — 채널(Threads 등) 포스트
초안·버전·상신 봉인. `site_posts.py`(story #3365)의 초안/버전/상신 구조를 그대로 미러하되
페이로드는 채널 전용(단일 text·link_url·대상 channel/connection)이다.

봉인 판정(해시 계산·「봉인 없음」·「재승인 필요」)은 `app/services/gate_seal.py`의 공용
헬퍼 3종을 재사용한다(site_posts.py와 공유, 새로 만들지 않는다) — 에러코드 문자열도
`SITE_POST_SEAL_MISSING`/`SITE_POST_REAPPROVAL_REQUIRED`를 site_posts와 그대로 공유한다
(PO 결정, 2026-09-03 09:02Z — 이 스토리는 두 채널 전용 에러코드를 제안했으나 철회됨).

`_reseal_gate_on_new_version`(편집 훅)은 site_posts.py 것과 별개로 여기서 자체 작성한다
(게이트 봉인 필드에 site의 `body_md` 대신 이 도메인의 `text`를 싣는다는 것 외엔 site
버전과 동형 — story 본문이 "3종 밖"이라 명시한 부분).

**이 스토리 범위**: 초안 생성/수정·상신(=게이트 pending 생성+봉인)까지. 승인은 gates.py의
기존 범용 transition 엔드포인트(신규 코드 0), 실제 발행(Threads API 호출)은 다음 스토리
[서버 Threads 발행 실행](entity:story:f8f7cb0f-6271-48bd-8a4d-a329b16b9167) 몫이다."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.models.channel_connection import ChannelConnection
from app.models.channel_post_draft import ChannelPostDraft
from app.models.channel_post_version import ChannelPostVersion
from app.models.gate import Gate, set_gate_status
from app.services.channel_adapters import get_channel_adapter
from app.services.gate_seal import (
    GateReapprovalRequiredError as ChannelPostReapprovalRequiredError,  # noqa: F401 (재-export, 라우터가 import)
    GateSealMissingError as ChannelPostSealMissingError,  # noqa: F401 (재-export, 라우터가 import)
    compute_seal_hash,
)
from app.services.site_posts import is_agent_caller  # noqa: F401 (재-export 편의 — 채널 라우터도 재사용)

_EXTERNAL_PUBLISH_GATE_TYPE = "external_publish"


class ChannelConnectionNotActiveError(ValueError):
    """AC6 — connection_id가 이 org의 channel_connections 행이 아니거나 status≠active."""

    def __init__(self, *, connection_id: uuid.UUID):
        self.connection_id = connection_id
        super().__init__(f"연결을 찾을 수 없거나 비활성 상태입니다: {connection_id}")


class ChannelTextTooLongError(ValueError):
    """AC2 — text가 어댑터 선언 max_text_length를 넘음. 한도·현재 길이를 응답에 실어야
    하므로(담롱 요구) 둘 다 속성으로 보존한다."""

    def __init__(self, *, max_length: int, current_length: int):
        self.max_length = max_length
        self.current_length = current_length
        super().__init__(f"본문이 한도를 넘었습니다(한도 {max_length}자, 현재 {current_length}자)")


class ChannelPostApproverRoleMissingError(Exception):
    """site_posts.py::SitePostApproverRoleMissingError와 동형(조직 기본 결재 역할 없음) —
    이 에러는 PO가 사이트/채널 공유로 확定한 두 코드(SEAL_MISSING/REAPPROVAL_REQUIRED) 밖의
    edge case라 채널 전용 코드(CHANNEL_POST_APPROVER_ROLE_MISSING)로 낸다(공유 결정 대상이
    아니었음 — story 본문 AC 목록에 없는 방어적 사전조건)."""

    def __init__(self, *, org_id: uuid.UUID):
        self.org_id = org_id
        super().__init__(
            f"조직에 기본 결재 역할이 설정되지 않았습니다(org_id={org_id}) — "
            "조직 설정에서 기본 역할을 지정한 뒤 다시 상신하세요"
        )


class ChannelPostDraftNotFoundError(Exception):
    def __init__(self, draft_id: uuid.UUID):
        self.draft_id = draft_id
        super().__init__(f"draft를 찾을 수 없습니다: {draft_id}")


class ChannelPostVersionNotFoundError(Exception):
    def __init__(self, version_id: uuid.UUID | None):
        self.version_id = version_id
        super().__init__(f"버전을 찾을 수 없습니다: {version_id}")


def compute_channel_post_hash(*, text: str, link_url: str | None) -> str:
    """gate_seal.compute_seal_hash 위 얇은 payload 조립부(site_posts.compute_body_sha256과
    동형 역할) — channel은 draft 고정값(배달 경로)이라 해시에 안 섞는다(모델 docstring 참고)."""
    return compute_seal_hash({"text": text, "link_url": link_url})


async def _get_active_connection(
    db: AsyncSession, *, org_id: uuid.UUID, connection_id: uuid.UUID,
) -> ChannelConnection:
    conn = (await db.execute(
        select(ChannelConnection).where(
            ChannelConnection.id == connection_id, ChannelConnection.org_id == org_id,
        )
    )).scalar_one_or_none()
    if conn is None or conn.status != "active":
        raise ChannelConnectionNotActiveError(connection_id=connection_id)
    return conn


def _validate_text_length(*, channel: str, text: str) -> None:
    adapter = get_channel_adapter(channel)
    if adapter is None or adapter.max_text_length <= 0:
        return
    if len(text) > adapter.max_text_length:
        raise ChannelTextTooLongError(max_length=adapter.max_text_length, current_length=len(text))


async def create_channel_post_draft_version(
    db: AsyncSession,
    *,
    org_id: uuid.UUID,
    work_item_id: uuid.UUID,
    connection_id: uuid.UUID,
    text: str,
    link_url: str | None,
    author_member_id: uuid.UUID,
    author_kind: str,
) -> ChannelPostVersion:
    """초안을 (org, work_item, connection_id)로 upsert하고 새 불변 버전을 추가한다 —
    site_posts.create_site_post_draft_version과 1:1 대응(AC1)."""
    connection = await _get_active_connection(db, org_id=org_id, connection_id=connection_id)
    _validate_text_length(channel=connection.channel, text=text)

    draft = (await db.execute(
        select(ChannelPostDraft)
        .where(
            ChannelPostDraft.org_id == org_id, ChannelPostDraft.work_item_id == work_item_id,
            ChannelPostDraft.connection_id == connection_id,
        )
        .with_for_update()
    )).scalar_one_or_none()
    if draft is None:
        draft = ChannelPostDraft(
            id=uuid.uuid4(), org_id=org_id, work_item_id=work_item_id,
            channel=connection.channel, connection_id=connection_id,
        )
        db.add(draft)
        await db.flush()
        next_version = 1
    else:
        next_version = (await db.execute(
            select(func.coalesce(func.max(ChannelPostVersion.version), 0)).where(
                ChannelPostVersion.draft_id == draft.id
            )
        )).scalar_one() + 1

    version = ChannelPostVersion(
        id=uuid.uuid4(), draft_id=draft.id, version=next_version,
        text=text, link_url=link_url,
        body_sha256=compute_channel_post_hash(text=text, link_url=link_url),
        author_member_id=author_member_id, author_kind=author_kind,
    )
    db.add(version)
    await db.flush()

    await _reseal_gate_on_new_version(db, org_id=org_id, work_item_id=work_item_id, version=version)

    await db.commit()
    await db.refresh(version)
    return version


async def _reseal_gate_on_new_version(
    db: AsyncSession, *, org_id: uuid.UUID, work_item_id: uuid.UUID, version: ChannelPostVersion,
) -> None:
    """site_posts.py::_reseal_gate_on_new_version과 동형 규칙(§3-1-2), 봉인 본문만 이
    도메인의 `text`를 쓴다: pending 中 편집 → 즉시 재봉인, approved 뒤 편집 → pending
    재오픈+reapproval_required=True(옛 봉인은 그대로 보존)."""
    gate = (await db.execute(
        select(Gate)
        .where(
            Gate.org_id == org_id, Gate.work_item_id == work_item_id,
            Gate.gate_type == _EXTERNAL_PUBLISH_GATE_TYPE, Gate.status.in_(("pending", "approved")),
        )
        .with_for_update()
    )).scalar_one_or_none()
    if gate is None:
        return
    if gate.status == "approved":
        set_gate_status(gate, "pending", now=datetime.now(timezone.utc))
        gate.requires_human = True
        gate.resolver_id = None
        gate.resolution_note = None
        gate.resolved_at = None
        gate.reapproval_required = True
        return
    gate.sealed_content_version = version.version
    gate.sealed_content_sha256 = version.body_sha256
    gate.sealed_content_body = version.text


async def get_channel_post_draft(
    db: AsyncSession, *, org_id: uuid.UUID, draft_id: uuid.UUID,
) -> ChannelPostDraft | None:
    return (await db.execute(
        select(ChannelPostDraft).where(ChannelPostDraft.id == draft_id, ChannelPostDraft.org_id == org_id)
    )).scalar_one_or_none()


async def list_channel_post_draft_versions(
    db: AsyncSession, *, draft_id: uuid.UUID,
) -> list[ChannelPostVersion]:
    stmt = (
        select(ChannelPostVersion)
        .where(ChannelPostVersion.draft_id == draft_id)
        .order_by(ChannelPostVersion.version.asc())
    )
    return list((await db.execute(stmt)).scalars().all())


async def list_channel_post_drafts(
    db: AsyncSession, *, org_id: uuid.UUID, limit: int = 50, offset: int = 0,
) -> list[tuple[ChannelPostDraft, ChannelPostVersion, ChannelPostVersion]]:
    """site_posts.list_site_post_drafts와 동형(latest+origin 버전 조인, "최신"은 최신
    버전의 created_at 기준) — API 경로 제안 §③ "site S4 후속과 동형"."""
    latest_version_ids = (
        select(
            ChannelPostVersion.draft_id,
            func.max(ChannelPostVersion.version).label("max_version"),
        )
        .group_by(ChannelPostVersion.draft_id)
        .subquery()
    )
    origin_version_ids = (
        select(
            ChannelPostVersion.draft_id,
            func.min(ChannelPostVersion.version).label("min_version"),
        )
        .group_by(ChannelPostVersion.draft_id)
        .subquery()
    )
    latest = aliased(ChannelPostVersion)
    origin = aliased(ChannelPostVersion)
    stmt = (
        select(ChannelPostDraft, latest, origin)
        .join(latest_version_ids, latest_version_ids.c.draft_id == ChannelPostDraft.id)
        .join(
            latest,
            (latest.draft_id == latest_version_ids.c.draft_id)
            & (latest.version == latest_version_ids.c.max_version),
        )
        .join(origin_version_ids, origin_version_ids.c.draft_id == ChannelPostDraft.id)
        .join(
            origin,
            (origin.draft_id == origin_version_ids.c.draft_id)
            & (origin.version == origin_version_ids.c.min_version),
        )
        .where(ChannelPostDraft.org_id == org_id)
        .order_by(latest.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    return [(row[0], row[1], row[2]) for row in (await db.execute(stmt)).all()]


async def submit_channel_post_draft(
    db: AsyncSession,
    *,
    org_id: uuid.UUID,
    draft_id: uuid.UUID,
    version_id: uuid.UUID | None,
    requester_member_id: uuid.UUID,
) -> tuple[Gate, uuid.UUID]:
    """초안 버전을 external_publish 게이트에 상신 — site_posts.submit_site_post_draft와
    1:1 대응(AC3). **에이전트도 호출 가능**(AC1, 2026-09-03 dev 실측 정정 — site S2와 동일
    실동작: submit은 게이트 생성까지만, 승인·발행이 human-only다. 이 함수 자체엔 actor_type
    가드가 없다 — 신규 코드 불요)."""
    draft = await get_channel_post_draft(db, org_id=org_id, draft_id=draft_id)
    if draft is None:
        raise ChannelPostDraftNotFoundError(draft_id)

    # AC6 — 상신 시점에도 connection이 여전히 active인지 재검증(생성 시점 이후 revoke될 수
    # 있다).
    await _get_active_connection(db, org_id=org_id, connection_id=draft.connection_id)

    versions = await list_channel_post_draft_versions(db, draft_id=draft_id)
    if not versions:
        raise ChannelPostDraftNotFoundError(draft_id)
    target = versions[-1] if version_id is None else next((v for v in versions if v.id == version_id), None)
    if target is None:
        raise ChannelPostVersionNotFoundError(version_id)
    origin_author_member_id = versions[0].author_member_id

    from app.services.gate_service import create_gate, find_gate_slot_with_pr_fallback
    from app.services.workflow_line_config import _default_role_id

    existing = await find_gate_slot_with_pr_fallback(
        db, org_id=org_id, work_item_id=draft.work_item_id, work_item_type="story",
        gate_type=_EXTERNAL_PUBLISH_GATE_TYPE, pr_number=None, repo_full_name=None,
    )
    if (
        existing is not None
        and existing.sealed_content_sha256 == target.body_sha256
        and existing.status in ("pending", "approved")
    ):
        return existing, target.id

    neutral_facts = {
        "destination": draft.channel,
        "draft_author_member_id": str(origin_author_member_id),
        "requested_by_member_id": str(requester_member_id),
    }

    role_id = await _default_role_id(db, org_id)
    if role_id is None:
        raise ChannelPostApproverRoleMissingError(org_id=org_id)
    gate = await create_gate(
        db, org_id, draft.work_item_id, "story", _EXTERNAL_PUBLISH_GATE_TYPE,
        requester_member_id, role_id, neutral_facts=neutral_facts,
    )
    gate.neutral_facts = neutral_facts
    if gate.status != "pending":
        set_gate_status(gate, "pending", now=datetime.now(timezone.utc))
        gate.requires_human = True
        gate.resolver_id = None
        gate.resolution_note = None
        gate.resolved_at = None
    gate.sealed_content_version = target.version
    gate.sealed_content_sha256 = target.body_sha256
    gate.sealed_content_body = target.text
    gate.reapproval_required = False
    await db.commit()
    await db.refresh(gate)
    return gate, target.id
