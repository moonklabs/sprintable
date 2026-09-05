"""story #3360(발행 구조·서버, 선생님 확定 2026-09-03) — 자사 사이트 글 저장/조회.

**서버 chokepoint**(story 본문 §2): work item의 external_publish 게이트가 approved/
auto_passed가 아니면 발행 자체가 안 된다 — git 커밋이 승인 증거였던 자리를, 이 SitePost 행의
gate_id·created_at이 그대로 대신한다."""
from __future__ import annotations

import hashlib
import json
import re
import uuid
from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.core.config import settings
from app.models.gate import Gate, set_gate_status
from app.models.site_post import SitePost
from app.models.site_post_draft import SitePostDraft
from app.models.site_post_version import SitePostVersion
from app.models.team import TeamMember
from app.services import hosted_site_publish
from app.services.campaigns import CampaignNotFoundError, get_campaign  # noqa: F401 (재-export, 라우터가 import)
from app.services.content_rules import ContentRuleViolationError, get_org_content_rules, lint_content  # noqa: F401 (재-export)
from app.services.gate_seal import (
    GateReapprovalRequiredError as SitePostReapprovalRequiredError,
    GateSealMissingError as SitePostSealMissingError,
    compute_seal_hash,
)

_SLUG_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
_LANG_RE = re.compile(r"^[a-z]{2}(-[A-Z]{2})?$")

_APPROVED_STATUSES = ("approved", "auto_passed")


def _lint_site_post_fields(
    rules: dict | None, *, title: str, summary: str, body_md: str,
) -> list[dict]:
    """story #3482 — `lint_content` 자체는 무변(순수 함수, 결합 텍스트 한 덩이라는
    전제가 없다). 이 함수가 title·summary·body_md를 **각각** 별도로 lint해 위반의
    `field`를 호출부가 진짜 필드명으로 덮어쓴다 — #3471의 `f"{title}\\n{summary}\\n
    {body_md}"` 결합 방식은 위반 field가 항상 "text"로 와 site_post 화면(text 필드
    자체가 없다)이 「어느 필드 아래」를 못 정했다(미르코 3472 2부 범위 밖 처리).
    link_url은 site_post에 구조적으로 없다(UTM 축은 세 호출 다 no-op) — channel_post
    경로(link_url 있음)는 이 함수를 안 쓴다(무변)."""
    violations: list[dict] = []
    for field_name, text in (("title", title), ("summary", summary), ("body_md", body_md)):
        for v in lint_content(rules, text=text, link_url=None):
            violations.append({**v, "field": field_name})
    return violations


class InvalidSitePostInputError(ValueError):
    """slug/lang이 서버 형식 규칙을 어김(422)."""


class MediaNotSupportedPhase0Error(ValueError):
    """Phase 0엔 미디어 입력이 없다 — manifest가 비어 있지 않으면 422(story #3365 AC5)."""


class ExternalPublishGateNotApprovedError(Exception):
    """work item의 external_publish 게이트가 approved/auto_passed가 아님(403). gate_id·
    status를 담아 사유 문구에 그대로 노출한다(story 본문 §2 명시)."""

    def __init__(self, *, gate_id: uuid.UUID | None, status: str | None):
        self.gate_id = gate_id
        self.status = status
        detail = (
            f"external_publish 게이트가 승인되지 않았습니다(gate_id={gate_id}, status={status})"
            if gate_id is not None
            else "이 work item에 승인된 external_publish 게이트가 없습니다"
        )
        super().__init__(detail)


class SitePostApproverRoleMissingError(Exception):
    """story #3365(Phase0 S2, 페드루 PO 리뷰) — 조직에 기본 결재 역할(ParticipationRole.
    is_default)이 없으면 상신을 명시적으로 거부한다. 예전엔 `uuid.uuid4()`로 존재하지 않는
    role_id를 만들어 게이트를 생성했다(조용한 폴백 — green을 만드는 자리)."""

    def __init__(self, *, org_id: uuid.UUID):
        self.org_id = org_id
        super().__init__(
            f"조직에 기본 결재 역할이 설정되지 않았습니다(org_id={org_id}) — "
            "조직 설정에서 기본 역할을 지정한 뒤 다시 상신하세요"
        )


class SitePostDraftNotFoundError(Exception):
    def __init__(self, draft_id: uuid.UUID):
        self.draft_id = draft_id
        super().__init__(f"draft를 찾을 수 없습니다: {draft_id}")


class SitePostVersionNotFoundError(Exception):
    def __init__(self, version_id: uuid.UUID | None):
        self.version_id = version_id
        super().__init__(f"버전을 찾을 수 없습니다: {version_id}")


class SitePostConnectionNotFoundError(ValueError):
    """story e4fc29fa(조각③a, 페드루 PO 確定 2026-09-04) — connection_id가 이 org의
    channel_connections 행이 아니다(존재 안 함 또는 다른 org 소속) — org_id 조건이
    이미 두 경우를 같은 결과(None)로 합쳐 다룬다(이 도메인 전체 "존재 비노출" 관례,
    channel_posts.py::ChannelPostSourceContentItemNotFoundError와 동형)."""

    def __init__(self, *, connection_id: uuid.UUID):
        self.connection_id = connection_id
        super().__init__(f"연결을 찾을 수 없습니다: {connection_id}")


class SitePostDestinationKindMismatchError(ValueError):
    """story e4fc29fa(조각③a, 페드루 리뷰 B1, 2026-09-04) — connection_id가 가리키는
    채널이 blog kind가 아니다(예: Threads 같은 social 연결을 블로그 목적지로 지정).
    fail-closed — 초안 생성 시점에 막지 않으면 상신·봉인·승인까지 조용히 통과하고
    발행(아직 미배선)에서야 걸린다."""

    def __init__(self, *, connection_id: uuid.UUID, channel: str):
        self.connection_id = connection_id
        self.channel = channel
        super().__init__(
            f"connection_id={connection_id}(channel={channel!r})는 블로그 목적지가 아닙니다"
        )


class SitePostGateAlreadyHeldError(Exception):
    """story f6d14476(Phase0 결함, PO 결정 2026-09-03 20:12 KST ②) — external_publish
    게이트 슬롯은 work_item 단위(draft 단위가 아니다). 같은 work_item에 언어별 초안이
    둘 이상 있을 때, 이미 다른 초안이 그 게이트를 쥐고(pending/approved) 있으면 이
    초안의 상신을 명시 거부한다 — 조용히 되밟아 먼저 승인된 게이트를 pending으로
    되돌리는 사고(원 발견 맥락, #3739 리뷰)를 서버가 원천 차단한다. 어느 초안이
    쥐고 있는지(draft_id·lang·slug)를 실어 화면이 "다른 초안이 승인 절차 중" 문구+
    링크를 그릴 수 있게 한다(AC3)."""

    def __init__(self, *, holding_draft_id: uuid.UUID, holding_lang: str | None, holding_slug: str):
        self.holding_draft_id = holding_draft_id
        self.holding_lang = holding_lang
        self.holding_slug = holding_slug
        super().__init__(
            f"이 work item은 다른 초안이 이미 승인 절차 중입니다"
            f"(holding_draft_id={holding_draft_id}, lang={holding_lang}, slug={holding_slug})"
        )


class SitePostNotPublishedError(Exception):
    """story #3381(Phase0 후속·결함) — 이 draft의 work_item으로 현재 공개된(unpublished_at
    IS NULL) SitePost 행이 없다(애초에 발행된 적 없거나 이미 비공개됨) — 비공개할 대상 자체가
    없다는 뜻이라 409로 명시 거부한다."""

    def __init__(self, draft_id: uuid.UUID):
        self.draft_id = draft_id
        super().__init__(f"이 draft에 현재 공개된 글이 없습니다: {draft_id}")


def _validate_slug(slug: str) -> None:
    if not _SLUG_RE.match(slug):
        raise InvalidSitePostInputError(f"slug 형식이 올바르지 않습니다: {slug!r}")


def _validate_lang(lang: str) -> None:
    if not _LANG_RE.match(lang):
        raise InvalidSitePostInputError(f"lang 형식이 올바르지 않습니다: {lang!r}")


async def _resolve_approved_gate(
    db: AsyncSession, *, org_id: uuid.UUID, work_item_id: uuid.UUID, gate_id: uuid.UUID | None,
) -> Gate:
    """gate_id가 주어지면 그 게이트 자체를 검증(work_item/타입 일치 + 승인 상태). 없으면 이
    work item의 external_publish 게이트를 찾아 검증(가장 최근 것 — story #2150 재제출 리셋
    관례상 같은 (work_item, gate_type)엔 사실상 행 1개만 산다)."""
    if gate_id is not None:
        gate = (await db.execute(
            select(Gate).where(Gate.id == gate_id, Gate.org_id == org_id)
        )).scalar_one_or_none()
        if (
            gate is None
            or gate.work_item_id != work_item_id
            or gate.gate_type != "external_publish"
            or gate.status not in _APPROVED_STATUSES
        ):
            raise ExternalPublishGateNotApprovedError(
                gate_id=gate_id, status=gate.status if gate is not None else None,
            )
        return gate

    gate = (await db.execute(
        select(Gate)
        .where(
            Gate.org_id == org_id, Gate.work_item_id == work_item_id, Gate.gate_type == "external_publish",
        )
        .order_by(Gate.created_at.desc())
        .limit(1)
    )).scalar_one_or_none()
    if gate is None or gate.status not in _APPROVED_STATUSES:
        raise ExternalPublishGateNotApprovedError(
            gate_id=gate.id if gate is not None else None, status=gate.status if gate is not None else None,
        )
    return gate


async def publish_site_post(
    db: AsyncSession,
    *,
    org_id: uuid.UUID,
    work_item_id: uuid.UUID,
    gate_id: uuid.UUID | None,
    title: str,
    slug: str,
    lang: str,
    summary: str,
    tags: list,
    body_md: str,
    created_by_member_id: uuid.UUID,
) -> SitePost:
    _validate_slug(slug)
    _validate_lang(lang)
    gate = await _resolve_approved_gate(db, org_id=org_id, work_item_id=work_item_id, gate_id=gate_id)

    # story #3365(Phase0 S2) AC6 — 승인 뒤 본문이 바뀌었으면 공개하지 않는다. fail-closed
    # (페드루 PO 리뷰 2026-09-03 05:59Z) — 봉인 자체가 없는 승인 게이트(제출→봉인 경로를 안
    # 거친 구식/우회 게이트)는 "무엇이 승인됐는지 모른다"는 뜻이라 통과가 아니라 거부한다.
    # 뮤테이션 대상: 이 블록을 제거하면 승인 후 바뀐 본문이 그대로 공개돼 회귀 테스트가
    # 반드시 실패해야 한다.
    if gate.sealed_content_sha256 is None:
        raise SitePostSealMissingError(gate_id=gate.id)
    current_hash = compute_body_sha256(title=title, lang=lang, summary=summary, tags=tags, body_md=body_md)
    if current_hash != gate.sealed_content_sha256:
        raise SitePostReapprovalRequiredError(gate_id=gate.id)

    # story e4fc29fa(조각②, 페드루 PO 確定 2026-09-04) — hosted_site BlogDestinationAdapter로
    # 이관(로직 무변경, hosted_site_publish.py 참고). 이 함수 자체는 그대로 site_posts.py에
    # 남는다 — gate 조회·봉인 재검증은 hosted_site 전용이 아니라 이 도메인 공통 chokepoint.
    row = await hosted_site_publish.publish(
        db, org_id=org_id, work_item_id=work_item_id, gate_id=gate.id, title=title, slug=slug,
        lang=lang, summary=summary, tags=tags, body_md=body_md, created_by_member_id=created_by_member_id,
    )
    await db.commit()
    return row


async def get_published_site_post(db: AsyncSession, *, org_id: uuid.UUID, lang: str, slug: str) -> SitePost | None:
    return (await db.execute(
        select(SitePost).where(
            SitePost.org_id == org_id, SitePost.lang == lang, SitePost.slug == slug,
            SitePost.unpublished_at.is_(None),
        )
    )).scalar_one_or_none()


async def list_published_site_posts(db: AsyncSession, *, org_id: uuid.UUID, lang: str) -> list[SitePost]:
    stmt = (
        select(SitePost)
        .where(SitePost.org_id == org_id, SitePost.lang == lang, SitePost.unpublished_at.is_(None))
        .order_by(SitePost.published_at.desc())
    )
    return list((await db.execute(stmt)).scalars().all())


# ─── story #3365(Phase0 S1) — 초안·불변 버전 ────────────────────────────────────

async def is_agent_caller(db: AsyncSession, *, org_id: uuid.UUID, member_id: uuid.UUID) -> bool:
    """이 caller가 이 org의 agent TeamMember인지 — auth.py `_verify_org_membership`의 OrgMember∪
    TeamMember 재확인 축(story f84227b5, PR#3730)과 동형: 클레임(``api_key_id``)을 신뢰하지 않고
    DB의 실제 멤버 타입으로 판정한다(actor_type fail-closed — 클레임 위조·테스트 하네스의 클레임
    누락 둘 다에 안전)."""
    result = await db.execute(
        select(TeamMember.id).where(
            TeamMember.org_id == org_id, TeamMember.id == member_id, TeamMember.type == "agent",
            TeamMember.is_active.is_(True),
        ).limit(1)
    )
    return result.first() is not None


def compute_body_sha256(*, title: str, lang: str, summary: str, tags: list, body_md: str) -> str:
    """canonical payload hash — S2가 승인 대상 버전을 봉인할 때(gate.sealed_content_sha256)
    재사용할 같은 계산(페드루 PO 확定, 문서 62fc03ee §4-3: "content_sha256"이 이 값 그대로).
    story #3374 — 실 계산은 gate_seal.compute_seal_hash(공용)로 옮기고, 여기는 site_posts
    도메인의 payload dict 조립부(title/lang/summary/tags/body_md 서명)만 남는다."""
    return compute_seal_hash({"title": title, "lang": lang, "summary": summary, "tags": tags, "body_md": body_md})


# story #3365(Phase0 S2) — Phase 0엔 미디어가 없어(S1) manifest는 항상 빈 배열 → 이 해시는
# 상수. AC1이 "빈 media manifest hash"를 봉인 값으로 명시해서 지어내지 않고 실제로 계산해 둔다.
_EMPTY_MEDIA_MANIFEST_HASH = hashlib.sha256(json.dumps([], separators=(",", ":")).encode("utf-8")).hexdigest()
_SITE_POST_DESTINATION = "hosted_site"



# story #3437(페드루 PO 리뷰 B1, 2026-09-04) — campaign 소속은 휴먼 값이다(블루프린트
# §1 주체 모델: campaign 관리는 조직 마케터 휴먼 몫). campaign 개념을 모르는 호출자
# (예: 본문만 고치는 에이전트·구식 플러그인)가 이 파라미터를 아예 안 보내면, 그걸
# "campaign_id=None(해제 의도)"로 읽으면 안 된다 — 휴먼이 묶어 둔 소속이 무관한 편집
# 한 번에 조용히 풀린다. image_sha256 캐리포워드(channel_posts.py)와 동형 센티널로
# "생략(유지)"·"명시 null(해제)"·"값(변경)" 세 갈래를 구분한다.
_CAMPAIGN_ID_CARRY_FORWARD = object()
# story e4fc29fa(페드루 PO 確定 2026-09-04, 조각③a) — 3437의 campaign_id 캐리포워드
# (페드루 리뷰 B1)와 동형 센티널. connection_id도 draft-level 필드라 같은 함정
# (campaign 개념을 모르는 호출자가 이 키를 생략하면 목적지가 조용히 hosted_site로
# 되돌아간다)을 그대로 갖는다 — 이번엔 처음부터 캐리포워드로 짠다.
_CONNECTION_ID_CARRY_FORWARD = object()


async def create_site_post_draft_version(
    db: AsyncSession,
    *,
    org_id: uuid.UUID,
    work_item_id: uuid.UUID,
    slug: str,
    lang: str,
    title: str,
    summary: str,
    tags: list,
    body_md: str,
    media_manifest: list,
    author_member_id: uuid.UUID,
    author_kind: str,
    campaign_id: uuid.UUID | None = _CAMPAIGN_ID_CARRY_FORWARD,  # type: ignore[assignment]
    connection_id: uuid.UUID | None = _CONNECTION_ID_CARRY_FORWARD,  # type: ignore[assignment]
) -> tuple[SitePostVersion, list[dict]]:
    """초안을 (org, work_item, slug)로 upsert하고 새 불변 버전을 추가한다. 기존 버전은 절대
    덮어쓰지 않는다(AC3) — 에이전트 원안·휴먼 개정본이 별도 행으로 남는다(AC6). 공개 `SitePost`
    행은 여기서 절대 만들지 않는다(AC1) — 승인·발행은 별개 게이트·엔드포인트(S2·S3) 몫.

    story #3437(AC3, 페드루 PO 確定 2026-09-04·리뷰 B1) — `campaign_id` 생략(기본값)
    시 draft의 기존 campaign_id를 그대로 캐리포워드한다(신규 draft는 None). 라우터가
    요청 body에 `campaign_id` 키가 실제로 있었을 때만(pydantic `model_fields_set`)
    이 인자를 명시로 넘긴다 — 명시 null=해제, 값=변경. 존재하지 않거나 다른 org의
    campaign이면 CampaignNotFoundError(422).

    story e4fc29fa(조각③a, 페드루 PO 確定 2026-09-04) — `connection_id` 생략(기본값)
    시 draft의 기존 값을 그대로 캐리포워드한다(신규 draft는 None=hosted_site). None을
    명시하면 hosted_site로 되돌린다(해제). 존재하지 않거나 다른 org의 connection이면
    SitePostConnectionNotFoundError(422)."""
    _validate_slug(slug)
    _validate_lang(lang)
    if media_manifest:
        raise MediaNotSupportedPhase0Error("Phase 0은 미디어 입력을 지원하지 않습니다")
    explicit_campaign_id = campaign_id is not _CAMPAIGN_ID_CARRY_FORWARD
    if (
        explicit_campaign_id and campaign_id is not None
        and await get_campaign(db, org_id=org_id, campaign_id=campaign_id) is None
    ):
        raise CampaignNotFoundError(campaign_id=campaign_id)
    explicit_connection_id = connection_id is not _CONNECTION_ID_CARRY_FORWARD
    if explicit_connection_id and connection_id is not None:
        from app.models.channel_connection import ChannelConnection

        connection = (await db.execute(
            select(ChannelConnection).where(
                ChannelConnection.id == connection_id, ChannelConnection.org_id == org_id,
            )
        )).scalar_one_or_none()
        if connection is None:
            raise SitePostConnectionNotFoundError(connection_id=connection_id)
        # story e4fc29fa(조각③a, 페드루 리뷰 B1) — social(Threads) 연결을 블로그 목적지로
        # 넣으면 초안·상신·봉인은 조용히 통과하고 발행에서야(그것도 아직 미배선) 막힌다 —
        # 지금 이 자리에서 fail-closed. kind는 channel_adapters.py의 유일한 SSOT(연결 자체엔
        # kind 컬럼이 없다 — connection.channel로 레지스트리를 조회해야 안다).
        from app.services.channel_adapters import get_channel_adapter

        adapter = get_channel_adapter(connection.channel)
        if adapter is None or adapter.kind != "blog":
            raise SitePostDestinationKindMismatchError(
                connection_id=connection_id, channel=connection.channel,
            )

    draft = (await db.execute(
        select(SitePostDraft)
        .where(
            SitePostDraft.org_id == org_id, SitePostDraft.work_item_id == work_item_id,
            SitePostDraft.slug == slug,
        )
        .with_for_update()
    )).scalar_one_or_none()
    if draft is None:
        draft = SitePostDraft(
            id=uuid.uuid4(), org_id=org_id, work_item_id=work_item_id, slug=slug,
            campaign_id=(campaign_id if explicit_campaign_id else None),
            connection_id=(connection_id if explicit_connection_id else None),
        )
        db.add(draft)
        await db.flush()
        next_version = 1
    else:
        if explicit_campaign_id:
            draft.campaign_id = campaign_id
        if explicit_connection_id:
            draft.connection_id = connection_id
        next_version = (await db.execute(
            select(func.coalesce(func.max(SitePostVersion.version), 0)).where(
                SitePostVersion.draft_id == draft.id
            )
        )).scalar_one() + 1

    version = SitePostVersion(
        id=uuid.uuid4(), draft_id=draft.id, version=next_version,
        title=title, lang=lang, summary=summary, tags=tags, body_md=body_md,
        body_sha256=compute_body_sha256(title=title, lang=lang, summary=summary, tags=tags, body_md=body_md),
        author_member_id=author_member_id, author_kind=author_kind,
    )
    db.add(version)
    await db.flush()

    # story #3365(Phase0 S2) AC4·AC5, 페드루 PO 재정정(2026-09-03 06:06Z, 앞선 06:03Z 정정을
    # 유나군 코드 대조로 재철회) — 승인 뒤 봉인은 "무엇이 승인됐었나"의 유일한 기록이라 편집
    # 훅이 조용히 덮으면 안 된다(publish_site_post의 409 비교 기준점이 죽는다). 확定 규칙:
    #   · pending 中 편집  → 같은 트랜잭션에서 즉시 재봉인(결재자가 볼 것=승인할 것, 아직
    #     파괴할 승인 기록이 없다).
    #   · approved 뒤 편집 → pending 재오픈 + reapproval_required=True, **봉인은 옛 버전
    #     그대로 유지**(재봉인은 submit_site_post_draft의 명시 재호출만이 한다 — gates.py의
    #     approve 전이가 reapproval_required=True인 동안 409로 막혀 "옛 봉인을 승인하는" 막다른
    #     길 자체를 차단한다).
    await _reseal_gate_on_new_version(db, org_id=org_id, work_item_id=work_item_id, version=version, draft=draft)

    # story #3471(페드루 PO 確定 2026-09-05)·#3482(필드별, 2026-09-05 후속) —
    # channel_posts.py::create_channel_post_draft_version과 동형(비차단, draft에
    # 스냅샷 저장). site_post는 link_url 필드가 없어 UTM 필수 검사는 구조적으로
    # no-op(lint_content가 link_url=None이면 그 축을 건너뛴다) — banned_terms를
    # title·summary·body_md 각각에 적용한다(#3471의 결합 텍스트 한 덩이는 위반
    # field가 항상 "text"로 와 site_post 화면이 «어느 필드 아래»를 못 정했다 —
    # 미르코 3472 2부 범위 밖 처리, #3482 그라운딩).
    rule_row = await get_org_content_rules(db, org_id=org_id)
    violations = _lint_site_post_fields(
        rule_row.rules if rule_row else None, title=title, summary=summary, body_md=body_md,
    )
    draft.lint_result = {"rules_version": rule_row.version if rule_row else 0, "violations": violations}

    await db.commit()
    await db.refresh(version)
    return version, violations


async def _reseal_gate_on_new_version(
    db: AsyncSession, *, org_id: uuid.UUID, work_item_id: uuid.UUID, version: SitePostVersion,
    draft: SitePostDraft,
) -> None:
    gate = (await db.execute(
        select(Gate)
        .where(
            Gate.org_id == org_id, Gate.work_item_id == work_item_id, Gate.gate_type == "external_publish",
            Gate.status.in_(("pending", "approved")),
        )
        .with_for_update()
    )).scalar_one_or_none()
    if gate is None:
        return
    # story f6d14476(발견 즉시 수정, AC1과 동일한 corruption class) — 이 훅은
    # work_item_id만으로 게이트를 찾는다(draft 무관). 승인 대상이 아닌 다른 초안을
    # 편집(새 버전 생성)했을 뿐인데 여기서 그 게이트를 되돌리거나(approved→pending)
    # 조용히 재봉인하면(pending 유지) submit()을 거치지 않고도 동일한 파괴가 일어난다.
    # 판정은 submit()과 같은 함수로 한다(story #3404에서 gate_service.py::
    # resolve_gate_holder_draft_id로 추출 — channel_posts.py가 이 함수의 동형 훅에서도
    # 같은 결함 클래스를 갖고 있어 공유하게 됐다).
    from app.services.gate_service import resolve_gate_holder_draft_id

    if resolve_gate_holder_draft_id(gate, this_draft_id=version.draft_id) is not None:
        return
    if gate.status == "approved":
        # 승인된 뒤 편집 — pending으로 되돌리기만 한다. sealed_content_*는 절대 안 건드린다
        # (여기서 건드리면 "무엇이 승인됐었나" 기록이 사라진다 — 재봉인은 submit() 재호출 몫).
        set_gate_status(gate, "pending", now=datetime.now(timezone.utc))
        gate.requires_human = True
        gate.resolver_id = None
        gate.resolution_note = None
        gate.resolved_at = None
        gate.reapproval_required = True
        return
    # 아직 한 번도 승인된 적 없는 pending — 결재자가 볼 대상 자체가 그냥 최신본이면 되므로
    # 편집마다 즉시 재봉인(재상신 왕복 불요).
    gate.sealed_content_version = version.version
    gate.sealed_content_sha256 = version.body_sha256
    gate.sealed_content_body = version.body_md
    # story e4fc29fa(조각③a) — 목적지 축도 content 축과 동형으로 pending 中엔 매 편집마다
    # 최신 draft.connection_id로 계속 동기화한다(재상신 왕복 불요, content_version과 같은
    # 이유). approved 뒤 편집은 위 분기에서 이미 이 대입 자체에 도달 안 함(sealed_content_*
    # 와 동일하게 "무엇이 승인됐었나" 보존 — 재봉인은 submit() 재호출 몫).
    gate.sealed_destination_connection_id = draft.connection_id


async def get_site_post_draft(db: AsyncSession, *, org_id: uuid.UUID, draft_id: uuid.UUID) -> SitePostDraft | None:
    return (await db.execute(
        select(SitePostDraft).where(SitePostDraft.id == draft_id, SitePostDraft.org_id == org_id)
    )).scalar_one_or_none()


async def set_site_post_draft_campaign(
    db: AsyncSession, *, org_id: uuid.UUID, draft_id: uuid.UUID, campaign_id: uuid.UUID | None,
) -> SitePostDraft:
    """story #3437 후속(유나 #3805 정적 판정, 페드루 PO 確定 2026-09-04) — campaign
    「붙이기/해제」 전용 경로. `create_site_post_draft_version`을 재사용하면 본문
    무변인데도 새 버전이 이력에 끼고 `_reseal_gate_on_new_version`이 해시를 안 보고
    무조건 승인된 게이트를 pending·reapproval_required로 되돌린다 — campaign은 본문이
    아니라 draft 축이라 버전·게이트 어느 쪽도 건드릴 이유가 없다. 이 함수는 새 버전을
    만들지 않고 `site_post_drafts.campaign_id`만 갱신한다(게이트 무접촉)."""
    draft = await get_site_post_draft(db, org_id=org_id, draft_id=draft_id)
    if draft is None:
        raise SitePostDraftNotFoundError(draft_id)
    if campaign_id is not None and await get_campaign(db, org_id=org_id, campaign_id=campaign_id) is None:
        raise CampaignNotFoundError(campaign_id=campaign_id)
    draft.campaign_id = campaign_id
    await db.commit()
    await db.refresh(draft)
    return draft


async def list_site_post_draft_versions(db: AsyncSession, *, draft_id: uuid.UUID) -> list[SitePostVersion]:
    stmt = (
        select(SitePostVersion)
        .where(SitePostVersion.draft_id == draft_id)
        .order_by(SitePostVersion.version.asc())
    )
    return list((await db.execute(stmt)).scalars().all())


async def list_site_post_drafts(
    db: AsyncSession, *, org_id: uuid.UUID, limit: int = 50, offset: int = 0,
) -> list[tuple[SitePostDraft, SitePostVersion, SitePostVersion, Gate | None, SitePost | None]]:
    """story #3365 후속(S4 계약 갭, 페드루 PO 확定 2026-09-03) — 조직 스코프 초안 목록. S4
    화면이 열릴 때 draft_id를 미리 알 방법이 없어 만든 자리 — 항목마다 최신 버전(title·lang·
    version·author_kind)과 원안 버전(version 1, origin_author_kind — «에이전트가 쓰고 사람이
    고친 글» vs «사람이 쓴 글» 구별용, 페드루 PO 후속 2026-09-03 05:33Z)을 붙인다. "최신"은
    draft.updated_at이 아니라 최신 버전의 created_at으로 정렬한다 — draft 행 자체는 버전 추가
    시 갱신되지 않아(SSOT는 버전 쪽) 이 값이 실제 최근 활동을 반영한다.

    story #3384(Phase0 결함, 유나 원인 진단·페드루 PO 확定 2026-09-03) — 게이트·발행 파생
    입력을 이제 지어내지 않고 여기서 배치 조회해 붙인다(AC1 "FE가 행마다 게이트를 따로
    조회하는 N+1 금지"). 페이지 쿼리 1건 + 게이트 배치 1건 + site_posts 배치 1건, 총 3건
    고정(행 수 무관) — 상세 페이지(story #3386 GET .../publication)와 정확히 같은 조회 축
    (work_item_id→gate, (org_id,lang,slug)→site_posts)을 페이지 단위로 배치한 것뿐이다.

    반환: (draft, latest_version, origin_version, gate, site_post) 튜플 리스트 — gate·
    site_post는 없으면 None(그 draft가 아직 상신/발행 전이라는 뜻, 지어내지 않는다)."""
    latest_version_ids = (
        select(
            SitePostVersion.draft_id,
            func.max(SitePostVersion.version).label("max_version"),
        )
        .group_by(SitePostVersion.draft_id)
        .subquery()
    )
    origin_version_ids = (
        select(
            SitePostVersion.draft_id,
            func.min(SitePostVersion.version).label("min_version"),
        )
        .group_by(SitePostVersion.draft_id)
        .subquery()
    )
    latest = aliased(SitePostVersion)
    origin = aliased(SitePostVersion)
    stmt = (
        select(SitePostDraft, latest, origin)
        .join(latest_version_ids, latest_version_ids.c.draft_id == SitePostDraft.id)
        .join(
            latest,
            (latest.draft_id == latest_version_ids.c.draft_id)
            & (latest.version == latest_version_ids.c.max_version),
        )
        .join(origin_version_ids, origin_version_ids.c.draft_id == SitePostDraft.id)
        .join(
            origin,
            (origin.draft_id == origin_version_ids.c.draft_id)
            & (origin.version == origin_version_ids.c.min_version),
        )
        .where(SitePostDraft.org_id == org_id)
        .order_by(latest.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    page_rows = [(row[0], row[1], row[2]) for row in (await db.execute(stmt)).all()]
    if not page_rows:
        return []

    work_item_ids = [draft.work_item_id for draft, _, _ in page_rows]
    slugs = [draft.slug for draft, _, _ in page_rows]

    # 배치 ②: work_item당 external_publish 게이트 — story #3360 §2 관례상 사실상 1개뿐이지만
    # 재제출 리셋 등으로 여럿이면 최신(created_at desc)이 이긴다(dict 조립 순서로 구현).
    gates_by_work_item: dict[uuid.UUID, Gate] = {}
    gate_rows = (await db.execute(
        select(Gate)
        .where(Gate.org_id == org_id, Gate.work_item_id.in_(work_item_ids), Gate.gate_type == "external_publish")
        .order_by(Gate.created_at.desc())
    )).scalars().all()
    for g in gate_rows:
        gates_by_work_item.setdefault(g.work_item_id, g)

    # 배치 ③: 공개 site_posts — 유일키 (org_id, lang, slug)라 draft.slug + latest.lang으로
    # 되찾는다(story #3381/#3386과 동일 조회 축).
    posts_by_key: dict[tuple[str, str], SitePost] = {}
    post_rows = (await db.execute(
        select(SitePost).where(
            SitePost.org_id == org_id, SitePost.slug.in_(slugs), SitePost.unpublished_at.is_(None),
        )
    )).scalars().all()
    for p in post_rows:
        posts_by_key[(p.lang, p.slug)] = p

    return [
        (draft, latest_v, origin_v, gates_by_work_item.get(draft.work_item_id), posts_by_key.get((latest_v.lang, draft.slug)))
        for draft, latest_v, origin_v in page_rows
    ]


async def submit_site_post_draft(
    db: AsyncSession,
    *,
    org_id: uuid.UUID,
    draft_id: uuid.UUID,
    version_id: uuid.UUID | None,
    requester_member_id: uuid.UUID,
) -> tuple[Gate, uuid.UUID]:
    """story #3365(Phase0 S2) — 초안 버전을 external_publish 게이트에 상신. 대상 버전(생략 시
    최신)의 content_sha256·content_version·본문 스냅샷을 게이트에 봉인(sealed_content_*)한다.

    페드루 PO 정정(2026-09-03 06:03Z) — 봉인은 "승인된 뒤"에만 불변이다. pending/approved인
    한 `_reseal_gate_on_new_version`(버전 생성 훅)이 매 편집마다 이미 최신 버전으로 계속
    동기화해 두므로, 이 함수는 대부분 그 동기화된 상태를 그대로 반환하는 idempotent 조회다
    (아래 sha 동일성 분기). 값이 다를 때만(예: 명시적으로 과거 버전을 상신 요청) 여기서
    직접 재봉인한다 — 그것도 submit() 호출 자체가 그 재봉인의 명시적 트리거다.

    에이전트 키도 호출 가능(AC2) — external_publish는 `_ALWAYS_MANUAL_GATE_TYPES`라 create_gate가
    호출자 무관 항상 pending을 강제한다(gate_service.py 참고, 신규 코드 불요)."""
    draft = await get_site_post_draft(db, org_id=org_id, draft_id=draft_id)
    if draft is None:
        raise SitePostDraftNotFoundError(draft_id)

    versions = await list_site_post_draft_versions(db, draft_id=draft_id)
    if not versions:
        raise SitePostDraftNotFoundError(draft_id)
    target = versions[-1] if version_id is None else next((v for v in versions if v.id == version_id), None)
    if target is None:
        raise SitePostVersionNotFoundError(version_id)
    origin_author_member_id = versions[0].author_member_id

    # story #3471(페드루 PO 確定 2026-09-05)·#3482(필드별) — channel_posts.py::
    # submit_channel_post_draft와 동형 재검사(link_url 없어 UTM 축은 no-op), 필드별로
    # 갈라 상신 422 body의 violations[].field도 title/summary/body_md 중 하나로 온다.
    rule_row = await get_org_content_rules(db, org_id=org_id)
    submit_violations = _lint_site_post_fields(
        rule_row.rules if rule_row else None, title=target.title, summary=target.summary, body_md=target.body_md,
    )
    if submit_violations:
        raise ContentRuleViolationError(
            rules_version=rule_row.version if rule_row else 0, violations=submit_violations,
        )

    from app.services.gate_service import create_gate, find_gate_slot_with_pr_fallback, resolve_gate_holder_draft_id
    from app.services.workflow_line_config import _default_role_id

    existing = await find_gate_slot_with_pr_fallback(
        db, org_id=org_id, work_item_id=draft.work_item_id, work_item_type="story",
        gate_type="external_publish", pr_number=None, repo_full_name=None,
    )

    # story f6d14476(PO 결정②, AC1) — 게이트 슬롯은 work_item 단위라, 이미 다른 초안이 그
    # 게이트를 쥐고(pending/approved) 있으면 이 초안의 상신을 막는다. 판정 로직 자체는
    # story #3404에서 gate_service.py::resolve_gate_holder_draft_id로 뽑아 channel_
    # posts.py와 공유한다("모른다≠다르다"·자기 자신 재상신 허용 규칙 포함, 그 함수
    # docstring 참고) — 여기선 그 판정 결과로 이 도메인 전용 에러(lang/slug)만 짓는다.
    holding_draft_id = resolve_gate_holder_draft_id(existing, this_draft_id=draft.id)
    if holding_draft_id is not None:
        holder = await get_site_post_draft(db, org_id=org_id, draft_id=holding_draft_id)
        if holder is not None:
            holder_versions = await list_site_post_draft_versions(db, draft_id=holder.id)
            holder_lang = holder_versions[-1].lang if holder_versions else None
            raise SitePostGateAlreadyHeldError(
                holding_draft_id=holder.id, holding_lang=holder_lang, holding_slug=holder.slug,
            )

    if (
        existing is not None
        and existing.sealed_content_sha256 == target.body_sha256
        # story e4fc29fa(조각③a) — 목적지도 봉인 축이다(sealed_scheduled_at·sealed_media_
        # sha256과 동형, AC "판정 축 세분화"). content가 그대로여도 destination이 바뀌었으면
        # "이미 이 정확한 상태로 봉인돼 있다"가 아니다 — 재봉인(아래)을 타야 한다.
        and existing.sealed_destination_connection_id == draft.connection_id
        and existing.status in ("pending", "approved")
    ):
        return existing, target.id  # 이미 이 정확한 내용+목적지로 봉인돼 있다 — 재봉인하지 않는다(불변).

    neutral_facts = {
        # story e4fc29fa(조각③c) — 이전엔 이 값이 destination과 무관하게 항상 "hosted_site"
        # 상수였다(그라운딩에서 발견). 실제 목적지 채널을 실어야 ①승인 훅(gate_service.py::
        # _maybe_create_scheduled_publication_command)이 CHANNEL_ADAPTERS[destination].kind
        # 로 channel_post/site_post 게이트를 구분할 수 있고 ②사람이 보는 승인 화면이 실제
        # 목적지를 안다.
        "destination": await _resolve_destination_channel(db, org_id=org_id, draft=draft),
        "media_manifest_hash": _EMPTY_MEDIA_MANIFEST_HASH,
        "draft_author_member_id": str(origin_author_member_id),
        "requested_by_member_id": str(requester_member_id),
        # story f6d14476 — 이 게이트 슬롯을 "쥔" 초안 식별(위 차단 판정의 유일한 근거,
        # AC1). 재상신·재승인 요청도 매번 같은 값을 다시 써 넣는다(no-op이지만 명시).
        # story #3387(같은 값, 다른 소비처) — 이 게이트가 가리키는 글 관리 화면(apps/web
        # /content/{draft_id})을 에이전트 알림(_render_gate_verdict_message)이 참조로
        # 실을 수 있도록. 게이트 자체엔 draft_id 컬럼이 없어(그라운딩 완료) 기존
        # 필드들과 동형으로 neutral_facts에 얹는다 — 링크가 아니라 참조 정보다(PO
        # 2026-09-03 13:33Z, 에이전트에겐 실행 권유 아님).
        "draft_id": str(draft.id),
    }

    # 페드루 PO 리뷰(2026-09-03 05:59Z) — 기본 역할이 없으면 가짜 uuid로 게이트를 만드는
    # 조용한 폴백 대신 명시 실패한다(SITE_POST_APPROVER_ROLE_MISSING).
    role_id = await _default_role_id(db, org_id)
    if role_id is None:
        raise SitePostApproverRoleMissingError(org_id=org_id)
    gate = await create_gate(
        db, org_id, draft.work_item_id, "story", "external_publish",
        requester_member_id, role_id, neutral_facts=neutral_facts,
    )
    # create_gate()의 기존-pending/approved 멱등 반환 분기는 neutral_facts 인자를 무시한다
    # (신규 생성·rejected 재오픈 경로에서만 반영) — 위 sha 동일성 조기 return을 안 탔다는 건
    # 내용이 달라졌거나 신규라는 뜻이라, 여기서 명시적으로 (재)봉인하는 것이 바로 이번
    # submit() 호출이 의도한 행위다("조용한 갱신"이 아니다).
    gate.neutral_facts = neutral_facts
    if gate.status != "pending":
        set_gate_status(gate, "pending", now=datetime.now(timezone.utc))
        gate.requires_human = True
        gate.resolver_id = None
        gate.resolution_note = None
        gate.resolved_at = None
    gate.sealed_content_version = target.version
    gate.sealed_content_sha256 = target.body_sha256
    gate.sealed_content_body = target.body_md
    # story e4fc29fa(조각③a) — 목적지 봉인도 여기서 명시적으로 (재)봉인한다(위 sha+
    # destination 동일성 조기 return을 안 탔다는 건 둘 중 하나가 달라졌거나 신규라는 뜻).
    gate.sealed_destination_connection_id = draft.connection_id
    gate.reapproval_required = False
    await db.commit()
    await db.refresh(gate)
    return gate, target.id


# ─── story #3369(Phase0 S3) — 승인본만 서버가 공개, URL, platform 감사 ─────────────

async def _resolve_public_url(
    db: AsyncSession, *, org_id: uuid.UUID, lang: str, slug: str, backend_base_url: str,
) -> str:
    """사람용 URL 조립 — 조직 설정 `site` 커넥터의 org_config.site_base_url이 있으면
    그것 + `/{lang}/blog/{slug}`(PO 보정, doc 62fc03ee §4). 없으면(오늘은 어느 org도
    `site` 커넥터를 등록하지 않았다 — 실측 확認) 공개 API URL로 fallback한다(AC4: "설정이
    없으면 공개 API URL을 반환"). 새 env 상수를 만들지 않는다 — 공개 API가 이 백엔드
    자신이 서빙하는 라우트라 호출 시점의 `request.base_url`(backend_base_url)로 충분하다."""
    from app.services.connector_registry import get_org_connector

    connector = await get_org_connector(db, org_id=org_id, connector_key="site")
    site_base_url = None
    if connector is not None:
        raw = connector.org_config.get("site_base_url")
        if isinstance(raw, str) and raw.strip():
            site_base_url = raw.rstrip("/")

    if site_base_url is not None:
        return f"{site_base_url}/{lang}/blog/{slug}"

    from app.services.pageview_counter import get_or_create_active_key

    public_key = await get_or_create_active_key(db, org_id=org_id)
    return f"{backend_base_url.rstrip('/')}/api/v2/public/site-posts/{slug}?public_key={public_key}&lang={lang}"


async def publish_site_post_from_draft(
    db: AsyncSession,
    *,
    org_id: uuid.UUID,
    draft_id: uuid.UUID,
    published_by_member_id: uuid.UUID,
    backend_base_url: str,
) -> tuple[SitePost, str, uuid.UUID]:
    """story #3369(Phase0 S3) AC1~AC5 — draft의 최신 버전을, 그 버전을 봉인한
    external_publish 게이트가 실제로 `approved`일 때만 공개 projection에 반영한다.

    레거시 `publish_site_post`(POST /site-posts, 호출자가 본문 전체를 다시 보낸다)와
    달리 이 경로는 draft_id 하나로 최신 버전을 서버가 직접 읽는다(위조 불가). 게이트
    상태는 `approved` **정확히 일치**로만 인정한다(`auto_passed`도 거부 — 뮤테이션
    대상: 이 검사를 `_APPROVED_STATUSES` 세트로 완화하면 회귀 테스트가 반드시 실패해야
    한다. 레거시 경로가 auto_passed를 허용하는 것과 의도적으로 다르다 — Phase 0
    external_publish는 항상-수동 게이트라 auto_passed 분기가 원래 도달 불가능하지만
    (S1 doc 62fc03ee §3-1 각주), 이 새 endpoint 자신의 계약으로 한 번 더 못박는다).

    봉인 재검증(SitePostSealMissingError/SitePostReapprovalRequiredError)은 레거시
    publish_site_post와 이제 완전히 같은 규칙이다(페드루 PO 리뷰 2026-09-03 05:59Z로
    레거시도 fail-closed가 됐다 — 최초 구현 당시엔 레거시가 더 관대했으나 그 차이는
    리뷰로 없어졌다). gates.py의 approve 전이 가드(SITE_POST_RESUBMIT_REQUIRED, 페드루
    PO 06:06Z)가 이미 "옛 봉인을 승인"하는 경로 자체를 막아, approved인데 해시가 다른
    행은 정상 경로로 이중으로 도달 불가능하다 — 그래도 방어망으로 남긴다."""
    draft = await get_site_post_draft(db, org_id=org_id, draft_id=draft_id)
    if draft is None:
        raise SitePostDraftNotFoundError(draft_id)

    versions = await list_site_post_draft_versions(db, draft_id=draft_id)
    if not versions:
        raise SitePostDraftNotFoundError(draft_id)
    latest = versions[-1]

    from app.services.gate_service import find_gate_slot_with_pr_fallback

    gate = await find_gate_slot_with_pr_fallback(
        db, org_id=org_id, work_item_id=draft.work_item_id, work_item_type="story",
        gate_type="external_publish", pr_number=None, repo_full_name=None,
    )
    if gate is None or gate.status != "approved":
        raise ExternalPublishGateNotApprovedError(
            gate_id=gate.id if gate is not None else None,
            status=gate.status if gate is not None else None,
        )

    if gate.sealed_content_sha256 is None:
        raise SitePostSealMissingError(gate_id=gate.id)
    if gate.sealed_content_sha256 != latest.body_sha256:
        raise SitePostReapprovalRequiredError(gate_id=gate.id)

    post = await hosted_site_publish.publish(
        db, org_id=org_id, work_item_id=draft.work_item_id, gate_id=gate.id,
        title=latest.title, slug=draft.slug, lang=latest.lang, summary=latest.summary,
        tags=latest.tags, body_md=latest.body_md, created_by_member_id=published_by_member_id,
    )
    url = await _resolve_public_url(
        db, org_id=org_id, lang=latest.lang, slug=draft.slug, backend_base_url=backend_base_url,
    )

    # AC5 — 승인 actor(human)는 게이트 승인 시점에 이미 별도로 기록된다(gate_service.py 몫,
    # 이 함수가 새로 만들지 않는다). 여기서 기록하는 것은 "공개 projection 반영"이라는
    # platform의 기계적 실행 그 자체 — actor_type=platform·actor_id=None(사람이 아니라
    # 플랫폼이 한 일이라는 구분이 AC의 핵심), 누가 눌렀는지는 context에 보존한다.
    from app.services.activity_log import ActivityLogService

    await ActivityLogService(db).record(
        org_id=org_id, action="site_post_published", actor_type="platform", actor_id=None,
        entity_type="site_post", entity_id=post.id,
        context={
            "gate_id": str(gate.id), "version_id": str(latest.id), "url": url,
            "published_by_member_id": str(published_by_member_id),
        },
    )
    await db.commit()
    await db.refresh(post)
    return post, url, latest.id


async def _resolve_destination_channel(db: AsyncSession, *, org_id: uuid.UUID, draft: SitePostDraft) -> str:
    """story e4fc29fa(조각③c) — gate.neutral_facts["destination"]에 실을 값. connection_id
    가 None이면 `_SITE_POST_DESTINATION`("hosted_site") 그대로, 있으면 그 connection의
    실제 channel 문자열(예: "wordpress"). 승인 훅(gate_service.py)이 이 값으로
    `CHANNEL_ADAPTERS[destination].kind`를 조회해 channel_post/site_post 게이트를
    구분한다 — connection이 그 사이 지워졌으면(이례적) hosted_site로 안전하게 폴백
    (fail-closed로 훅이 스킵되는 쪽이 존재하지 않는 채널명을 싣는 것보다 낫다)."""
    if draft.connection_id is None:
        return _SITE_POST_DESTINATION
    from app.models.channel_connection import ChannelConnection

    connection = (await db.execute(
        select(ChannelConnection.channel).where(
            ChannelConnection.id == draft.connection_id, ChannelConnection.org_id == org_id,
        )
    )).scalar_one_or_none()
    return connection if connection is not None else _SITE_POST_DESTINATION


async def _get_active_blog_connection(db: AsyncSession, *, org_id: uuid.UUID, connection_id: uuid.UUID):
    """`channel_posts.py::_get_active_connection`과 동형(로직 복제, 순환 import 회피 —
    channel_posts.py가 이미 이 파일을 모듈 최상단에서 import해서 그 반대 방향은 못
    연다)."""
    from app.models.channel_connection import ChannelConnection
    from app.services.channel_posts import ChannelConnectionNotActiveError

    conn = (await db.execute(
        select(ChannelConnection).where(
            ChannelConnection.id == connection_id, ChannelConnection.org_id == org_id,
        )
    )).scalar_one_or_none()
    if conn is None or conn.status != "active":
        raise ChannelConnectionNotActiveError(connection_id=connection_id)
    return conn


def _blog_destination_exception_classes() -> tuple[tuple[type[Exception], ...], tuple[type[Exception], ...]]:
    """story e4fc29fa(조각④) — wordpress_publish.py·webhook_publish.py 각자 자기
    공개 예외 타입을 갖는다(호출자 계약 유지, 모듈 재사용 원칙) — 오케스트레이션
    계층은 둘 다 잡아야 하므로 여기서 한 곳에 모은다(새 모듈이 추가되면 여기 한 줄만
    늘면 된다)."""
    from app.services.webhook_publish import WebhookPublishError, WebhookTargetURLInsecureError
    from app.services.wordpress_publish import WordPressPublishError, WordPressSiteURLInsecureError

    return (
        (WordPressSiteURLInsecureError, WebhookTargetURLInsecureError),
        (WordPressPublishError, WebhookPublishError),
    )


_BLOG_DESTINATION_INSECURE_ERRORS, _BLOG_DESTINATION_PUBLISH_ERRORS = _blog_destination_exception_classes()


def _blog_publish_error_code(exc: Exception) -> str:
    """story e4fc29fa(조각④) — 401/403은 "일시적 provider 오류"가 아니라 자격 자체가
    틀렸다는 뜻(wordpress Application Password·webhook 공유 비밀 오설정). 뮤테이션
    대상: 이 분기를 지우면 401도 CHANNEL_PUBLISH_PROVIDER_ERROR(transient)로 떨어져
    고쳐지지 않는 자격으로 무한 백오프 재시도만 반복한다(webhook 라이브 테스트가
    실제로 이 경로를 잡았다)."""
    if getattr(exc, "status_code", None) in (401, 403):
        return "CHANNEL_PUBLISH_AUTH_REJECTED"
    return "CHANNEL_PUBLISH_PROVIDER_ERROR"


async def _call_blog_module_publish(
    module, client, *, channel: str, connection, app_password: str, title: str, body_md: str,
    summary: str, tags: list, slug: str, external_id: str | None,
) -> tuple[str, str | None]:
    """story e4fc29fa(조각④) — wordpress/webhook 모듈은 이름(publish)은 같아도
    파라미터 모양이 다르다(BlogDestinationModule Protocol 明示 — 목적지마다 자격
    형태가 다르다). 이 함수가 channel별 kwargs 조립을 한 곳에 모아, 오케스트레이션
    본문(publish_site_post_external_command)은 채널을 몰라도 되게 한다."""
    if channel == "wordpress":
        return await module.publish(
            client, site_url=connection.account_id, username=connection.account_label or "",
            app_password=app_password, title=title, body_md=body_md, summary=summary, slug=slug,
            external_id=external_id,
        )
    if channel == "webhook":
        return await module.publish(
            client, target_url=connection.account_id, secret=app_password, title=title, body_md=body_md,
            summary=summary, tags=tags, slug=slug, external_id=external_id,
        )
    raise SitePostExternalPublishError(
        error_code="SITE_POST_DRAFT_NOT_FOUND", message=f"알 수 없는 blog 채널: {channel!r}",
    )


async def _call_blog_module_unpublish(module, client, *, channel: str, connection, app_password: str, external_id: str) -> None:
    if channel == "wordpress":
        await module.unpublish(
            client, site_url=connection.account_id, username=connection.account_label or "",
            app_password=app_password, external_id=external_id,
        )
        return
    if channel == "webhook":
        await module.unpublish(client, target_url=connection.account_id, secret=app_password, external_id=external_id)
        return
    raise SitePostExternalPublishError(
        error_code="SITE_POST_DRAFT_NOT_FOUND", message=f"알 수 없는 blog 채널: {channel!r}",
    )


class SitePostExternalPublishError(Exception):
    """story e4fc29fa(조각③c) — 외부 목적지(WordPress 등) 발행/회수 실패. error_code로
    워커가 failure_kind(connection/needs_check/transient)를 분류한다(publication_
    command.py::classify_failure_kind — channel_posts.py와 같은 매핑표를 공유하므로
    새 표를 안 만들고 기존 error_code 문자열을 그대로 재사용한다)."""

    def __init__(self, *, error_code: str, message: str):
        self.error_code = error_code
        super().__init__(message)


async def request_site_post_external_publish(
    db: AsyncSession, *, org_id: uuid.UUID, draft_id: uuid.UUID, requested_by_member_id: uuid.UUID,
) -> "PublicationCommand":
    """story e4fc29fa(조각③c) — draft.connection_id가 non-null(외부 목적지)일 때의 발행
    요청. `publish_site_post_from_draft`와 같은 3중 재검증(게이트 approved·봉인 일치)을
    거치되, 내부 저장 대신 publication_command를 upsert만 하고 반환한다 — 실제 외부
    HTTP는 워커(`process_due_publication_commands`)가 한다. site_post는 scheduled_at
    개념이 없어(그라운딩 확認) 이 요청은 항상 `scheduled_at=None`으로 커맨드를 만든다
    — channel_posts의 "즉시" 분기와 달리 이 경로 자체는 동기 완결이 아니다(PO 確定 —
    응답은 command_id+status="pending", 실제 결과는 워커가 채운다)."""
    draft = await get_site_post_draft(db, org_id=org_id, draft_id=draft_id)
    if draft is None:
        raise SitePostDraftNotFoundError(draft_id)

    versions = await list_site_post_draft_versions(db, draft_id=draft_id)
    if not versions:
        raise SitePostDraftNotFoundError(draft_id)
    latest = versions[-1]

    from app.services.gate_service import find_gate_slot_with_pr_fallback

    gate = await find_gate_slot_with_pr_fallback(
        db, org_id=org_id, work_item_id=draft.work_item_id, work_item_type="story",
        gate_type="external_publish", pr_number=None, repo_full_name=None,
    )
    if gate is None or gate.status != "approved":
        raise ExternalPublishGateNotApprovedError(
            gate_id=gate.id if gate is not None else None,
            status=gate.status if gate is not None else None,
        )
    if gate.sealed_content_sha256 is None:
        raise SitePostSealMissingError(gate_id=gate.id)
    if gate.sealed_content_sha256 != latest.body_sha256:
        raise SitePostReapprovalRequiredError(gate_id=gate.id)

    from app.services.publication_command import create_or_get_publication_command

    command, _ = await create_or_get_publication_command(
        db, org_id=org_id, gate_id=gate.id, destination=draft.connection_id,
        approved_version=latest.id, requested_by_member_id=requested_by_member_id,
        scheduled_at=None, content_kind="site_post",
    )
    await db.commit()
    return command


async def request_site_post_external_unpublish(
    db: AsyncSession, *, org_id: uuid.UUID, draft_id: uuid.UUID, requested_by_member_id: uuid.UUID,
) -> "PublicationCommand":
    """story e4fc29fa(조각③c) — 외부 목적지 회수 요청. 지금 살아 있는(status="published")
    `channel_publications` 행을 되짚어 그 (gate_id, version_id)로 operation="unpublish"
    커맨드를 upsert한다 — publish와 같은 멱등키 구조(gate_id+version_id는 그대로,
    operation만 다르니 별도 행).

    카디르·PO 실물 확認(2026-09-04, PR#3797 블로커) — 같은 WordPress connection에
    글이 둘(draft A·B)이면 connection_id만으로 좁힌 조회가 "가장 최근 published"를
    A/B 구분 없이 집어, A 회수 요청이 더 최근 발행된 B를 회수해 버렸다. `version_id`를
    이 draft 자신의 `site_post_versions`로 좁혀 계보를 벗어난 행을 원천 배제한다."""
    draft = await get_site_post_draft(db, org_id=org_id, draft_id=draft_id)
    if draft is None or draft.connection_id is None:
        raise SitePostDraftNotFoundError(draft_id)

    from app.models.channel_publication import ChannelPublication
    from app.models.site_post_version import SitePostVersion

    own_version_ids = select(SitePostVersion.id).where(SitePostVersion.draft_id == draft_id)
    published = (await db.execute(
        select(ChannelPublication)
        .where(
            ChannelPublication.org_id == org_id,
            ChannelPublication.connection_id == draft.connection_id,
            ChannelPublication.status == "published",
            ChannelPublication.version_id.in_(own_version_ids),
        )
        .order_by(ChannelPublication.created_at.desc())
        .limit(1)
    )).scalar_one_or_none()
    if published is None:
        raise SitePostNotPublishedError(draft_id)

    from app.services.publication_command import create_or_get_publication_command

    command, _ = await create_or_get_publication_command(
        db, org_id=org_id, gate_id=published.gate_id, destination=draft.connection_id,
        approved_version=published.version_id, requested_by_member_id=requested_by_member_id,
        scheduled_at=None, content_kind="site_post", operation="unpublish",
    )
    await db.commit()
    return command


async def publish_site_post_external_command(db: AsyncSession, command: "PublicationCommand"):
    """워커(`publication_command.py::_process_one_command`)의 site_post 분기 —
    `command.approved_version`(SitePostVersion.id)→draft→connection을 되짚어
    `blog_destinations` 디스패치로 실 HTTP를 친다. 성공 결과는 `channel_publications`에
    기록(정본 §3 "재사용" — hosted_site는 이 테이블을 안 쓰는 것과 별개, 이 함수는
    connection_id가 있는 draft 전용). 재발행(같은 connection의 기존 external_id가
    있으면 그 글을 갱신)해 WordPress에 중복 글이 안 쌓인다."""
    from app.models.channel_publication import ChannelPublication
    from app.models.site_post_version import SitePostVersion
    from app.services.blog_destinations import get_blog_destination_module
    from app.services.channel_connection import decrypt_for_use
    from app.services.channel_posts import ChannelConnectionNotActiveError

    version = (await db.execute(
        select(SitePostVersion).where(SitePostVersion.id == command.approved_version)
    )).scalar_one_or_none()
    if version is None:
        raise SitePostExternalPublishError(
            error_code="SITE_POST_DRAFT_NOT_FOUND", message=f"버전을 찾을 수 없습니다: {command.approved_version}",
        )

    draft = await get_site_post_draft(db, org_id=command.org_id, draft_id=version.draft_id)
    if draft is None or draft.connection_id is None:
        raise SitePostExternalPublishError(
            error_code="SITE_POST_DRAFT_NOT_FOUND", message=f"draft를 찾을 수 없습니다: {version.draft_id}",
        )

    try:
        connection = await _get_active_blog_connection(db, org_id=command.org_id, connection_id=draft.connection_id)
    except ChannelConnectionNotActiveError as exc:
        raise SitePostExternalPublishError(error_code="CHANNEL_CONNECTION_NOT_ACTIVE", message=str(exc)) from exc

    app_password = decrypt_for_use(connection)
    if app_password is None:
        raise SitePostExternalPublishError(
            error_code="CHANNEL_CONNECTION_NOT_ACTIVE", message=f"연결에 자격이 없습니다: {connection.id}",
        )

    module = get_blog_destination_module(connection_id=connection.id, channel=connection.channel)

    # 카디르·PO 실물 확認(2026-09-04, PR#3797 블로커) — connection_id만으로 좁힌 조회가
    # 같은 connection의 다른 draft(B) 첫 발행 시 다른 draft(A)의 external_id를
    # "prior"로 집어 WordPress update 경로를 태워 A를 B 내용으로 덮어썼다(데이터 오염).
    # version_id를 이 draft 자신의 site_post_versions로 좁혀 계보 밖 행을 배제한다.
    own_version_ids = select(SitePostVersion.id).where(SitePostVersion.draft_id == draft.id)
    existing_pub = (await db.execute(
        select(ChannelPublication)
        .where(
            ChannelPublication.connection_id == connection.id,
            ChannelPublication.external_id.isnot(None),
            ChannelPublication.version_id.in_(own_version_ids),
        )
        .order_by(ChannelPublication.created_at.desc())
        .limit(1)
    )).scalar_one_or_none()
    prior_external_id = existing_pub.external_id if existing_pub is not None else None

    import httpx

    try:
        async with httpx.AsyncClient() as client:
            external_id, permalink = await _call_blog_module_publish(
                module, client, channel=connection.channel, connection=connection, app_password=app_password,
                title=version.title, body_md=version.body_md, summary=version.summary, tags=version.tags,
                slug=draft.slug, external_id=prior_external_id,
            )
    except _BLOG_DESTINATION_INSECURE_ERRORS as exc:
        raise SitePostExternalPublishError(error_code="SITE_POST_DESTINATION_INSECURE", message=str(exc)) from exc
    except _BLOG_DESTINATION_PUBLISH_ERRORS as exc:
        raise SitePostExternalPublishError(error_code=_blog_publish_error_code(exc), message=str(exc)) from exc

    # story #3395/#3757 동형 SAVEPOINT 관용구(동시 처리 방어) — (gate_id, version_id) UNIQUE 재사용.
    from sqlalchemy.exc import IntegrityError

    now = datetime.now(timezone.utc)
    row = (await db.execute(
        select(ChannelPublication).where(
            ChannelPublication.gate_id == command.gate_id, ChannelPublication.version_id == version.id,
        )
    )).scalar_one_or_none()
    if row is None:
        row = ChannelPublication(
            id=uuid.uuid4(), org_id=command.org_id, gate_id=command.gate_id, version_id=version.id,
            connection_id=connection.id, channel=connection.channel, status="published",
            external_id=external_id, permalink=permalink, published_at=now,
        )
        try:
            async with db.begin_nested():
                db.add(row)
                await db.flush()
        except IntegrityError as exc:
            _orig = getattr(exc, "orig", None)
            constraint = getattr(_orig, "constraint_name", None) or getattr(
                getattr(_orig, "__cause__", None), "constraint_name", None,
            )
            if constraint != "uq_channel_publications_gate_version":
                raise
            row = (await db.execute(
                select(ChannelPublication).where(
                    ChannelPublication.gate_id == command.gate_id, ChannelPublication.version_id == version.id,
                )
            )).scalar_one()
            row.status, row.external_id, row.permalink, row.published_at = "published", external_id, permalink, now
    else:
        row.status, row.external_id, row.permalink, row.published_at = "published", external_id, permalink, now
    return row


async def unpublish_site_post_external_command(db: AsyncSession, command: "PublicationCommand"):
    """워커의 site_post unpublish 분기 — `command.gate_id`+`approved_version`으로 원
    `channel_publications` 행(external_id 보유)을 되짚어 `wordpress_publish.unpublish()`
    를 친다(status=draft 전환, 비파괴). 성공 시 그 행 status="unpublished"(channel_
    publications 기존 3값 container_created|published|failed에 이 조각이 4번째 값을
    보탠다 — CHECK 제약 없는 Text 컬럼이라 마이그 불요)."""
    from app.models.channel_publication import ChannelPublication
    from app.services.blog_destinations import get_blog_destination_module
    from app.services.channel_connection import decrypt_for_use
    from app.services.channel_posts import ChannelConnectionNotActiveError

    row = (await db.execute(
        select(ChannelPublication).where(
            ChannelPublication.gate_id == command.gate_id, ChannelPublication.version_id == command.approved_version,
        )
    )).scalar_one_or_none()
    if row is None or row.external_id is None:
        raise SitePostExternalPublishError(error_code="SITE_POST_NOT_PUBLISHED", message="회수할 발행 기록이 없습니다")

    try:
        connection = await _get_active_blog_connection(db, org_id=command.org_id, connection_id=row.connection_id)
    except ChannelConnectionNotActiveError as exc:
        raise SitePostExternalPublishError(error_code="CHANNEL_CONNECTION_NOT_ACTIVE", message=str(exc)) from exc

    app_password = decrypt_for_use(connection)
    if app_password is None:
        raise SitePostExternalPublishError(
            error_code="CHANNEL_CONNECTION_NOT_ACTIVE", message=f"연결에 자격이 없습니다: {connection.id}",
        )

    module = get_blog_destination_module(connection_id=connection.id, channel=connection.channel)

    import httpx

    try:
        async with httpx.AsyncClient() as client:
            await _call_blog_module_unpublish(
                module, client, channel=connection.channel, connection=connection,
                app_password=app_password, external_id=row.external_id,
            )
    except _BLOG_DESTINATION_INSECURE_ERRORS as exc:
        raise SitePostExternalPublishError(error_code="SITE_POST_DESTINATION_INSECURE", message=str(exc)) from exc
    except _BLOG_DESTINATION_PUBLISH_ERRORS as exc:
        raise SitePostExternalPublishError(error_code=_blog_publish_error_code(exc), message=str(exc)) from exc

    row.status = "unpublished"
    return row


class SitePostPublicationInfo:
    """story #3386(Phase0 결함, 유나 원인 진단·페드루 PO 확定 2026-09-03) — 상세 화면 S8
    (발행됨·URL·행위자) 계약. 필드명은 목록 계약(story 0b72a300)과 한 벌: `published_at`
    하나로 발행 여부가 서고 별도 boolean은 두지 않는다."""

    __slots__ = ("published_at", "url", "published_by_member_id", "published_body_sha256")

    def __init__(
        self, *, published_at: datetime | None, url: str | None,
        published_by_member_id: uuid.UUID | None, published_body_sha256: str | None,
    ):
        self.published_at = published_at
        self.url = url
        self.published_by_member_id = published_by_member_id
        self.published_body_sha256 = published_body_sha256


_EMPTY_PUBLICATION_INFO = SitePostPublicationInfo(
    published_at=None, url=None, published_by_member_id=None, published_body_sha256=None,
)


def _resolve_public_site_display_url(*, lang: str, slug: str) -> str | None:
    """story 194acb63(배포 11 실측) — S8 상세 화면 전용 URL 해소. `_resolve_public_url`
    (발행 액션 자체가 조립하는 URL, org별 site 커넥터 우선 + 백엔드 API 폴백)과 의도적으로
    분리한다 — 그 함수의 폴백(API 주소+public_key)이 바로 이 결함의 원인이라, 표시 전용
    경로는 그 폴백을 아예 밟지 않는다. `settings.public_site_base_url`(deploy SSOT)
    하나만 본다 — 미설정이면 None(화면은 「—」, 지어내지 않는다)."""
    if not settings.public_site_base_url:
        return None
    return f"{settings.public_site_base_url.rstrip('/')}/{lang}/blog/{slug}"


async def get_site_post_publication_info(
    db: AsyncSession, *, org_id: uuid.UUID, draft_id: uuid.UUID,
) -> SitePostPublicationInfo:
    """이 draft의 현재 공개 상태를 상세 화면이 그대로 그릴 수 있는 형태로 반환한다.
    발행된 적이 없으면(또는 이미 unpublish됐으면) 전부 None — 404가 아니라 200(draft 자체가
    없는 경우만 SitePostDraftNotFoundError, §AC6 "파생 입력이 없으면 단정하지 않는다"의
    서버측 대응 — FE가 "모른다"와 "발행 안 됐다"를 구별하려면 이 둘이 서로 다른 신호여야
    한다: draft 자체가 없다=404, 발행 안 됐다=200+null 전부).

    조회 축은 unpublish_site_post()(story #3381)와 동일 — draft.slug + 최신 버전 lang이
    _upsert_site_post_row가 실제 쓰는 유일키 (org_id, lang, slug) 그대로다(다국어 행 혼선
    방지, 페드루 PO 코드리뷰 2026-09-03 11:02Z 그 자리).

    `published_body_sha256`은 목록/상세 어느 계약표에도 없던 신규 필드(디디 판단, AC2
    "재발행" 버튼 활성화 조건을 풀려면 "지금 라이브인 본문"과 "지금 승인된(sealed) 본문"이
    다른지 비교할 축이 하나 더 필요하다 — gate_status/reapproval_required만으로는 "막
    발행했다"와 "재승인 후 아직 재발행 안 눌렀다"를 구별 못 한다, 두 경우 다 approved+
    hasPublishedSitePost=true로 동일하게 보인다).

    story 194acb63(배포 11 실측) — url은 `backend_base_url`을 더 받지 않는다(그 파라미터
    자체가 결함의 재료였다 — 백엔드 자기 주소로 URL을 조립하는 경로를 아예 없앤다)."""
    draft = await get_site_post_draft(db, org_id=org_id, draft_id=draft_id)
    if draft is None:
        raise SitePostDraftNotFoundError(draft_id)

    versions = await list_site_post_draft_versions(db, draft_id=draft_id)
    if not versions:
        return _EMPTY_PUBLICATION_INFO
    latest_lang = versions[-1].lang

    post = (await db.execute(
        select(SitePost).where(
            SitePost.org_id == org_id, SitePost.lang == latest_lang, SitePost.slug == draft.slug,
            SitePost.unpublished_at.is_(None),
        )
    )).scalar_one_or_none()
    if post is None:
        return _EMPTY_PUBLICATION_INFO

    url = _resolve_public_site_display_url(lang=post.lang, slug=post.slug)
    published_body_sha256 = compute_body_sha256(
        title=post.title, lang=post.lang, summary=post.summary, tags=post.tags, body_md=post.body_md,
    )
    return SitePostPublicationInfo(
        published_at=post.published_at, url=url,
        published_by_member_id=post.created_by_member_id, published_body_sha256=published_body_sha256,
    )


# ─── story #3381(Phase0 후속·결함) — 발행 취소(비공개) ─────────────────────────────

async def unpublish_site_post(
    db: AsyncSession, *, org_id: uuid.UUID, draft_id: uuid.UUID, unpublished_by_member_id: uuid.UUID,
) -> SitePost:
    """공개 SitePost 행을 비공개로(상태 전환 — 행 삭제 아님, AC 명시). `source_story_id`가
    게이트는 건드리지 않는다(PO 결정) — 승인 자체는 여전히 유효(sealed_content_sha256도
    그대로)라 재발행(같은 publish_site_post_from_draft 재호출)이 내용 불변이면 그 승인을
    그대로 재사용한다(_upsert_site_post_row의 upsert가 unpublished_at을 다시 NULL로 되돌림
    — 신규 코드 불요, 기존 publish 경로가 이미 이 역할을 한다).

    페드루 PO 코드리뷰(2026-09-03 11:02Z) — 원래 `source_story_id == work_item_id`만으로
    조회했더니 같은 work_item에 두 언어(예: ko·en, 서로 다른 slug의 별도 draft)가 각각
    발행돼 있으면 두 행이 걸려 `MultipleResultsFound`(500)였다. 공개 행의 실제 유일키는
    `(org_id, lang, slug)`(_upsert_site_post_row가 쓰는 그 축 그대로) — draft의 slug는
    고정이고 lang은 최신 버전 것을 쓴다(발행 시점에 실제로 이 축으로 upsert됐으므로 draft
    하나 = 행 하나가 정확히 선다)."""
    draft = await get_site_post_draft(db, org_id=org_id, draft_id=draft_id)
    if draft is None:
        raise SitePostDraftNotFoundError(draft_id)

    versions = await list_site_post_draft_versions(db, draft_id=draft_id)
    if not versions:
        raise SitePostNotPublishedError(draft_id)
    latest_lang = versions[-1].lang

    post = (await db.execute(
        select(SitePost).where(
            SitePost.org_id == org_id, SitePost.lang == latest_lang, SitePost.slug == draft.slug,
            SitePost.unpublished_at.is_(None),
        )
    )).scalar_one_or_none()
    if post is None:
        raise SitePostNotPublishedError(draft_id)

    # story e4fc29fa(조각②) — hosted_site BlogDestinationAdapter.unpublish로 이관
    # (로직 무변경 — 필드 대입 한 줄 그대로).
    await hosted_site_publish.unpublish(post=post)

    from app.services.activity_log import ActivityLogService

    await ActivityLogService(db).record(
        org_id=org_id, action="site_post_unpublished", actor_type="platform", actor_id=None,
        entity_type="site_post", entity_id=post.id,
        context={
            "gate_id": str(post.gate_id), "unpublished_by_member_id": str(unpublished_by_member_id),
        },
    )
    await db.commit()
    await db.refresh(post)
    return post
