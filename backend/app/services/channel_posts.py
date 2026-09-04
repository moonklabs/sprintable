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

초안 생성/수정·상신(=게이트 pending 생성+봉인)까지는 story #3374 몫. 승인은 gates.py의
기존 범용 transition 엔드포인트(신규 코드 0).

story #f8f7cb0f(Phase1·마케팅운영, 페드루 PO 확定 2026-09-03) — 실제 발행(Threads API
2-호출) 오케스트레이션(`publish_channel_post_draft`)을 이어 붙인다. site_posts.py가
발행까지 한 파일에 담는 것과 동형 관례(draft→submit→publish 한 도메인 서비스 파일)."""
from __future__ import annotations

import asyncio
import unicodedata
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.models.channel_connection import ChannelConnection
from app.models.channel_post_draft import ChannelPostDraft
from app.models.channel_post_version import ChannelPostVersion
from app.models.channel_publication import ChannelPublication
from app.models.gate import Gate, set_gate_status
from app.services.channel_adapters import get_channel_adapter
from app.services.channel_connection import decrypt_for_use
from app.services.gate_seal import (
    GateReapprovalRequiredError as ChannelPostReapprovalRequiredError,  # noqa: F401 (재-export, 라우터가 import)
    GateSealMissingError as ChannelPostSealMissingError,  # noqa: F401 (재-export, 라우터가 import)
    compute_seal_hash,
)
from app.services.site_posts import (  # noqa: F401 (재-export 편의 — 채널 라우터도 재사용)
    ExternalPublishGateNotApprovedError,
    is_agent_caller,
)
from app.services.utm import attach_utm, resolve_utm_campaign

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


class ChannelTokenExpiredError(Exception):
    """story #f8f7cb0f — provider가 401/403(인증 실패)로 응답 — 토큰이 만료/철회됐다는
    뜻. `apply_refresh_failure`와 동형으로 connection.status를 expired로 내려 재인증을
    유도한다(호출부가 처리)."""

    def __init__(self, *, connection_id: uuid.UUID, provider_message: str):
        self.connection_id = connection_id
        self.provider_message = provider_message
        super().__init__(f"연결 토큰이 만료됐습니다(connection_id={connection_id}) — 재인증이 필요합니다")


class ChannelRateLimitedError(Exception):
    """story #f8f7cb0f — 발행 직전 재조회한 한도 잔량이 0. `reset_at`은
    `now + quota_duration`으로 근사(Meta가 명시적 reset 타임스탬프를 안 줌, threads_
    publish.py 참고) — 화면이 "N시 이후 가능" 문구·예약 기본값으로 쓴다(AC)."""

    def __init__(self, *, reset_at: datetime):
        self.reset_at = reset_at
        super().__init__(f"발행 한도를 초과했습니다 — {reset_at.isoformat()} 이후 재시도하세요")


class ChannelPublishProviderError(Exception):
    """story #f8f7cb0f — 위 목록(승인/봉인/연결/토큰/한도) 어디에도 안 걸리는 Threads API
    실패(컨테이너 생성·publish 호출 자체가 2xx 아님). provider 원문은 `last_error`에,
    안정 코드 하나는 응답에 — "막혔다"와 "막는 장치를 쟀다"를 기계가 구별해야 한다는
    담롱 요구(그라운딩 §③) 그대로."""

    def __init__(self, *, provider_code: str, provider_message: str):
        self.provider_code = provider_code
        self.provider_message = provider_message
        super().__init__(f"발행 provider 호출 실패({provider_code}): {provider_message}")


# story #3395 — 동시 요청 경합에서 진 쪽이 이긴 쪽의 완료를 기다리는 최대 시간
# (attempts × interval ≈ 3초). "발행 버튼 더블클릭" 수준의 드문 경합이고 남은 작업이
# Threads 호출 최대 2건뿐이라 3초면 정상 케이스 대부분을 덮는다 — 그보다 오래 걸리면
# ChannelPublishInProgressError로 정직하게 알리고, 재시도는 그때 남아있는 container_
# created 행으로 기존 부분성공 재시도 경로를 그대로 탄다(새 폴링을 또 하지 않는다).
_CONCURRENT_PUBLISH_POLL_ATTEMPTS = 10
_CONCURRENT_PUBLISH_POLL_INTERVAL_SEC = 0.3


class ChannelPublishInProgressError(Exception):
    """story #3395 — 같은 (gate_id, version_id)로 동시 요청 2건이 들어와 진 쪽이 이긴
    쪽의 완료를 짧게 기다렸는데도(POLL_ATTEMPTS×POLL_INTERVAL_SEC) 이긴 쪽이 아직
    끝내지 못했다. 진 쪽이 여기서 이어 발행을 시도하면 이긴 쪽이 처리 중인 컨테이너를
    이중 publish할 위험이 있어(AC2), 대신 "다른 요청이 처리 중"임을 그대로 알린다 —
    거짓 200(아직 안 끝난 걸 끝난 것처럼)도, 무단 500도 아닌 정직한 응답."""

    def __init__(self, *, gate_id: uuid.UUID):
        self.gate_id = gate_id
        super().__init__(f"같은 발행이 다른 요청에서 처리 중입니다(gate_id={gate_id}) — 잠시 후 다시 시도하세요")


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


class ChannelPostGateAlreadyHeldError(Exception):
    """story #3404(Phase1 결함, site_posts.py::SitePostGateAlreadyHeldError·story f6d14476
    미러) — external_publish 게이트 슬롯은 work_item 단위(draft 단위가 아니다). 같은
    work_item에 채널 포스트 초안이 둘 이상(예: 서로 다른 connection_id) 있을 때, 이미 다른
    초안이 그 게이트를 쥐고(pending/approved) 있으면 이 초안의 상신을 명시 거부한다 —
    조용히 되밟아 먼저 승인된 게이트를 pending으로 되돌리는 사고를 서버가 원천 차단한다.
    어느 초안이 쥐고 있는지(draft_id·channel·connection_id)를 실어 화면이 "다른 초안이
    승인 절차 중" 문구+링크를 그릴 수 있게 한다."""

    def __init__(self, *, holding_draft_id: uuid.UUID, holding_channel: str, holding_connection_id: uuid.UUID):
        self.holding_draft_id = holding_draft_id
        self.holding_channel = holding_channel
        self.holding_connection_id = holding_connection_id
        super().__init__(
            f"이 work item은 다른 초안이 이미 승인 절차 중입니다"
            f"(holding_draft_id={holding_draft_id}, channel={holding_channel}, "
            f"connection_id={holding_connection_id})"
        )


def compute_channel_post_hash(*, text: str, link_url: str | None) -> str:
    """gate_seal.compute_seal_hash 위 얇은 payload 조립부(site_posts.compute_body_sha256과
    동형 역할) — channel은 draft 고정값(배달 경로)이라 해시에 안 섞는다(모델 docstring 참고)."""
    return compute_seal_hash({"text": text, "link_url": link_url})


def build_tagged_link(*, channel: str, link_url: str, draft_id: uuid.UUID) -> str | None:
    """story #3394(S2c BE 선행) AC5·`publish_channel_post_draft` 공용 — UTM 태그된 최종
    링크 조립. **미리보기(편집·버전이력 응답)와 실제 발행이 반드시 같은 값을 내야 한다** —
    로직을 두 곳에 따로 두면 "미리보기가 거짓말"하는 자리가 생긴다(그래서 publish_channel_
    post_draft도 이 함수로 옮겼다, 신규 로직 아님). 어댑터가 없는 채널이면 None(지어내지
    않는다 — 발행 자체도 이 경우 별도 가드로 막힌다)."""
    adapter = get_channel_adapter(channel)
    if adapter is None:
        return None
    campaign = resolve_utm_campaign(link_url, fallback_draft_id=draft_id)
    return attach_utm(link_url, source=adapter.utm_source, medium=adapter.utm_medium, campaign=campaign)


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


def text_char_count(text: str) -> int:
    """story #3411 — 「글자 수」의 유일한 정의. Python `len(str)`은 코드포인트 수(=JS
    `[...text].length`와 같은 값) — surrogate pair가 되는 BMP 밖 문자(😀 등)를 이중으로
    안 센다. `_validate_text_length`(422 검증)와 `ChannelPostDraftListItem.text_length`
    (목록/단건 응답)가 이 함수 하나를 공유해야 한다 — 각자 세면 같은 문장에 다른 값이
    나올 수 있다(유나 design §3-1①)."""
    return len(text)


_ZWJ = "\u200d"  # ZERO WIDTH JOINER
_VARIATION_SELECTORS = {"\ufe0e", "\ufe0f"}  # VS15(text) / VS16(emoji)
_HANGUL_JUNGSEONG_JONGSEONG_START = 0x1160
_HANGUL_JUNGSEONG_JONGSEONG_END = 0x11FF
TEXT_PREVIEW_MAX_LENGTH = 80


def _continues_prior_grapheme_cluster(ch: str, prev: str) -> bool:
    """story #3411 — ch가 prev와 하나의 grapheme cluster를 이루는 확장자인지. 완전한
    UAX#29 세그멘테이션이 아니라 유나 design이 명시한 3축만 처리한다(선언, 범위 밖):
    결합 문자(unicodedata combining class≠0)·variation selector(U+FE0E/FE0F)·ZWJ(U+200D)
    직후·한글 결합 자모(중성/종성, U+1160~U+11FF). 이 3축 밖의 결합(예: 국가 국기 이모지의
    regional indicator 쌍)은 여전히 쪼개질 수 있다."""
    if unicodedata.combining(ch) != 0:
        return True
    if ch in _VARIATION_SELECTORS:
        return True
    if prev == _ZWJ:
        return True
    cp = ord(ch)
    if _HANGUL_JUNGSEONG_JONGSEONG_START <= cp <= _HANGUL_JUNGSEONG_JONGSEONG_END:
        return True
    return False


def build_text_preview(text: str, *, max_length: int = TEXT_PREVIEW_MAX_LENGTH) -> str:
    """앞 max_length 코드포인트(text_char_count와 동일 셈법)로 자르되, 그 경계가
    grapheme cluster 중간이면 클러스터가 끝날 때까지 포함한다(쪼개지 않는다) — 유나
    design §3-1②. max_length 자체(80)는 서버 상수 — FE가 다시 자를지는 FE 몫."""
    if text_char_count(text) <= max_length:
        return text
    cut = max_length
    while cut < len(text) and _continues_prior_grapheme_cluster(text[cut], text[cut - 1]):
        cut += 1
    return text[:cut]


def _validate_text_length(*, channel: str, text: str) -> None:
    adapter = get_channel_adapter(channel)
    if adapter is None or adapter.max_text_length <= 0:
        return
    current_length = text_char_count(text)
    if current_length > adapter.max_text_length:
        raise ChannelTextTooLongError(max_length=adapter.max_text_length, current_length=current_length)


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
) -> tuple[ChannelPostVersion, str]:
    """초안을 (org, work_item, connection_id)로 upsert하고 새 불변 버전을 추가한다 —
    site_posts.create_site_post_draft_version과 1:1 대응(AC1).

    story #3394 — 반환을 `(version, channel)` 튜플로 넓혔다(회귀 0, 유일한 호출부인
    라우터가 곧바로 unpack하도록 같이 바꾼다) — 라우터가 `tagged_link_preview`(AC5)를
    조립하려면 이 draft의 channel을 알아야 하는데, 여기서 이미 조회한 `connection.channel`을
    그대로 돌려주는 편이 라우터가 별도 쿼리로 다시 찾는 것보다 싸다."""
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
    return version, connection.channel


async def _reseal_gate_on_new_version(
    db: AsyncSession, *, org_id: uuid.UUID, work_item_id: uuid.UUID, version: ChannelPostVersion,
) -> None:
    """site_posts.py::_reseal_gate_on_new_version과 동형 규칙(§3-1-2), 봉인 본문만 이
    도메인의 `text`를 쓴다: pending 中 편집 → 즉시 재봉인, approved 뒤 편집 → pending
    재오픈+reapproval_required=True(옛 봉인은 그대로 보존).

    story #3404(디디 코드 확認 2026-09-03·페드루 PO 지시 2026-09-04) — 이 훅은
    work_item_id만으로 게이트를 찾는다(draft 무관). 승인 대상이 아닌 다른 초안을
    편집(새 버전 생성 — 새 draft 최초 생성 포함, 그 자체가 버전 1 생성)했을 뿐인데
    여기서 그 게이트를 되돌리거나(approved→pending) 조용히 재봉인하면 submit()의
    가드(resolve_gate_holder_draft_id)를 거치지 않고도 동일한 파괴가 일어난다 —
    site_posts.py가 f6d14476에서 이미 막은 것과 정확히 같은 결함 클래스가 이 파일에
    그대로 남아 있었다(직접 재현 확認). submit()과 같은 판정 함수를 그대로 쓴다."""
    from app.services.gate_service import resolve_gate_holder_draft_id

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
    if resolve_gate_holder_draft_id(gate, this_draft_id=version.draft_id) is not None:
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
    draft_id: uuid.UUID | None = None,
) -> list[
    tuple[
        ChannelPostDraft, ChannelPostVersion, ChannelPostVersion,
        Gate | None, ChannelPublication | None, ChannelPublication | None, str | None,
    ]
]:
    """site_posts.list_site_post_drafts와 동형(latest+origin 버전 조인, "최신"은 최신
    버전의 created_at 기준) — API 경로 제안 §③ "site S4 후속과 동형".

    story #3403 — `draft_id`를 주면 페이지 쿼리에 단건 필터가 추가될 뿐, 그 아래 배치
    ②~⑤(gate·publication·버전해시 조회)는 손대지 않는다 — 이미 work_item_id/gate_id
    키로 동작해 draft 수와 무관하다. 단건 조회(`GET .../drafts/{draft_id}`)가 이 함수를
    그대로 재사용하는 이유 — 두 번째 쿼리 경로를 새로 짜면 목록과 단건이 다른 값을
    낼 드리프트 표면이 생긴다.

    story #3394(S2c BE 선행, 페드루 PO 확定 2026-09-04) — 상태 파생·발행 상태 필드를 여기서
    배치 조회해 붙인다(site_posts.list_site_post_drafts의 #3384 확장과 동형 패턴, N+1 금지 —
    페이지 쿼리 1건 + gate 배치 1건 + publication 배치 2건 + version 해시 배치 1건, 총 5건
    고정, draft 수 무관).

    **조인 축이 둘로 갈린다**(PO 지시, site와 의미가 다른 자리) — 한 축으로 뭉치면 "발행
    뒤 편집·재승인"이 목록에서 발행 이력째 사라진다:
    - `latest_version_publication`(6번째 원소) — **최신 버전**의 publication 행(gate_id +
      최신 version_id로 조인). `publication_status`·`error_code`의 출처 — T9 "이어서 발행"은
      최신 버전에 대한 부분 성공만 뜻한다.
    - `published_publication`(5번째 원소) — 이 게이트의 **가장 최근 `status='published'`**
      publication(버전 무관, published_at 최대). `published_at`·`permalink`·`external_id`의
      출처 — "지금 Threads에 살아 있는 것"은 최신 버전이 아직 재발행 전이어도 남아야 한다.
    - `published_body_sha256`(7번째 원소, str) — `published_publication`의 `version_id`로
      `channel_post_versions.body_sha256`을 조인한 값(그 publication이 없으면 None) —
      channel_publications 자체엔 본문 해시 컬럼이 없다.

    반환: (draft, latest_version, origin_version, gate, published_publication,
    latest_version_publication, published_body_sha256) — gate·publication 계열은 없으면
    None(지어내지 않는다, "모른다≠다르다")."""
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
    if draft_id is not None:
        stmt = stmt.where(ChannelPostDraft.id == draft_id)
    page_rows = [(row[0], row[1], row[2]) for row in (await db.execute(stmt)).all()]
    if not page_rows:
        return []

    work_item_ids = [draft.work_item_id for draft, _, _ in page_rows]

    # 배치 ②: work_item당 external_publish 게이트(site_posts.list_site_post_drafts와 동형 —
    # 사실상 1개뿐이지만 여럿이면 최신 created_at이 이긴다).
    gates_by_work_item: dict[uuid.UUID, Gate] = {}
    gate_rows = (await db.execute(
        select(Gate)
        .where(Gate.org_id == org_id, Gate.work_item_id.in_(work_item_ids), Gate.gate_type == "external_publish")
        .order_by(Gate.created_at.desc())
    )).scalars().all()
    for g in gate_rows:
        gates_by_work_item.setdefault(g.work_item_id, g)

    gate_ids = [g.id for g in gates_by_work_item.values()]
    latest_version_id_by_gate = {
        gates_by_work_item[draft.work_item_id].id: latest_v.id
        for draft, latest_v, _ in page_rows
        if draft.work_item_id in gates_by_work_item
    }

    latest_version_pub_by_gate: dict[uuid.UUID, ChannelPublication] = {}
    published_pub_by_gate: dict[uuid.UUID, ChannelPublication] = {}
    published_version_ids: set[uuid.UUID] = set()
    if gate_ids:
        # 배치 ③: 최신 버전의 publication 행(publication_status·error_code 축).
        pub_rows = (await db.execute(
            select(ChannelPublication).where(ChannelPublication.gate_id.in_(gate_ids))
        )).scalars().all()
        for p in pub_rows:
            if latest_version_id_by_gate.get(p.gate_id) == p.version_id:
                latest_version_pub_by_gate[p.gate_id] = p

        # 배치 ④: 가장 최근 published 상태(published_at·permalink·external_id 축) —
        # published_at desc로 이미 정렬돼 오므로 setdefault로 최신만 남는다.
        published_rows = (await db.execute(
            select(ChannelPublication)
            .where(ChannelPublication.gate_id.in_(gate_ids), ChannelPublication.status == "published")
            .order_by(ChannelPublication.published_at.desc())
        )).scalars().all()
        for p in published_rows:
            published_pub_by_gate.setdefault(p.gate_id, p)
            published_version_ids.add(p.version_id)

    # 배치 ⑤: published_publication이 가리키는 버전의 본문 해시(published_body_sha256).
    body_sha256_by_version_id: dict[uuid.UUID, str] = {}
    if published_version_ids:
        version_rows = (await db.execute(
            select(ChannelPostVersion.id, ChannelPostVersion.body_sha256).where(
                ChannelPostVersion.id.in_(published_version_ids)
            )
        )).all()
        body_sha256_by_version_id = {row[0]: row[1] for row in version_rows}

    result = []
    for draft, latest_v, origin_v in page_rows:
        gate = gates_by_work_item.get(draft.work_item_id)
        published_pub = published_pub_by_gate.get(gate.id) if gate else None
        latest_pub = latest_version_pub_by_gate.get(gate.id) if gate else None
        published_body_sha256 = (
            body_sha256_by_version_id.get(published_pub.version_id) if published_pub else None
        )
        result.append((draft, latest_v, origin_v, gate, published_pub, latest_pub, published_body_sha256))
    return result


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

    from app.services.gate_service import create_gate, find_gate_slot_with_pr_fallback, resolve_gate_holder_draft_id
    from app.services.workflow_line_config import _default_role_id

    existing = await find_gate_slot_with_pr_fallback(
        db, org_id=org_id, work_item_id=draft.work_item_id, work_item_type="story",
        gate_type=_EXTERNAL_PUBLISH_GATE_TYPE, pr_number=None, repo_full_name=None,
    )

    # story #3404(site_posts.py f6d14476 미러, 판정 로직은 gate_service.py::
    # resolve_gate_holder_draft_id로 공유) — 게이트 슬롯은 work_item 단위라, 이미 다른
    # 초안이 그 게이트를 쥐고(pending/approved) 있으면 이 초안의 상신을 막는다.
    holding_draft_id = resolve_gate_holder_draft_id(existing, this_draft_id=draft.id)
    if holding_draft_id is not None:
        holder = await get_channel_post_draft(db, org_id=org_id, draft_id=holding_draft_id)
        if holder is not None:
            raise ChannelPostGateAlreadyHeldError(
                holding_draft_id=holder.id, holding_channel=holder.channel,
                holding_connection_id=holder.connection_id,
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
        # story #3404 — 이 게이트 슬롯을 "쥔" 초안 식별(위 차단 판정의 유일한 근거).
        # 재상신·재승인 요청도 매번 같은 값을 다시 써 넣는다(no-op이지만 명시).
        "draft_id": str(draft.id),
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


# ─── story #f8f7cb0f(Phase1·마케팅운영) — 서버 Threads 발행 실행 ───────────────────────
# UTM 조립(link_url이 있으면 본문 끝에 태그된 링크를 덧붙인다)은 publish_channel_post_
# draft() 안에서 draft.channel(어댑터 조회 축)을 안 상태로 직접 한다 — 원본 latest.text/
# latest.link_url은 절대 바꾸지 않는다(봉인 해시가 이미 그 원본 쌍으로 계산돼 있다, #3374).
# UTM은 발행 시점에만 조립되는 배달 계층 부가물이지 승인 대상 내용이 아니다.


def _classify_threads_error(
    exc: "ThreadsPublishError", *, connection_id: uuid.UUID,
) -> tuple[str, Exception]:
    """provider 실패를 안정 코드+예외로 분류. 401/403은 토큰 만료(재인증 유도), 그 외는
    미분류 provider 오류(502) — 담롱 요구 "«막혔다»와 «막는 장치를 쟀다»는 다르다"
    그대로(그라운딩 §③)."""
    if exc.status_code in (401, 403):
        return "CHANNEL_TOKEN_EXPIRED", ChannelTokenExpiredError(
            connection_id=connection_id, provider_message=exc.message,
        )
    return "CHANNEL_PUBLISH_PROVIDER_ERROR", ChannelPublishProviderError(
        provider_code=exc.code, provider_message=exc.message,
    )


async def publish_channel_post_draft(
    db: AsyncSession, *, org_id: uuid.UUID, draft_id: uuid.UUID, published_by_member_id: uuid.UUID,
) -> ChannelPublication:
    """AC1~AC4 — 승인·봉인 재검증 뒤 연결 토큰으로 Threads 2-호출 발행. 멱등
    (UNIQUE(gate_id, version_id)) — 같은 (gate, version) 재요청은 Threads에 새 POST 없이
    기존 완료 행을 그대로 반환. 부분 성공(컨테이너 생성 후 publish 실패)은
    container_created로 남고 재시도는 그 컨테이너로 publish만 다시 — 컨테이너 생성
    자체가 실패해도 새 행을 만들지 않고 같은 (gate_id, version_id) 행을 그 자리에서
    갱신한다(PO 결정②).

    human-only 가드(CHANNEL_POST_PUBLISH_HUMAN_ONLY)는 라우터 책임(site_posts.py
    발행 엔드포인트와 동형 관례 — 서비스 함수 자체엔 actor_type 가드가 없다)."""
    draft = await get_channel_post_draft(db, org_id=org_id, draft_id=draft_id)
    if draft is None:
        raise ChannelPostDraftNotFoundError(draft_id)

    from app.services.gate_service import find_gate_slot_with_pr_fallback

    gate = await find_gate_slot_with_pr_fallback(
        db, org_id=org_id, work_item_id=draft.work_item_id, work_item_type="story",
        gate_type=_EXTERNAL_PUBLISH_GATE_TYPE, pr_number=None, repo_full_name=None,
    )
    if gate is None or gate.status != "approved":
        raise ExternalPublishGateNotApprovedError(
            gate_id=gate.id if gate is not None else None,
            status=gate.status if gate is not None else None,
        )

    versions = await list_channel_post_draft_versions(db, draft_id=draft_id)
    if not versions:
        raise ChannelPostDraftNotFoundError(draft_id)
    latest = versions[-1]

    # 발행 직전 재검증②(봉인) — site_posts.publish_site_post_from_draft와 동형 규율.
    if gate.sealed_content_sha256 is None:
        raise ChannelPostSealMissingError(gate_id=gate.id)
    if gate.sealed_content_sha256 != latest.body_sha256:
        raise ChannelPostReapprovalRequiredError(gate_id=gate.id)

    # 멱등 — 이미 완료된 발행이면 새 POST 없이 그대로 반환(뮤테이션 대상: 이 UNIQUE
    # 조회를 제거하면 같은 버전 재요청이 Threads에 두 번 POST된다).
    existing = (await db.execute(
        select(ChannelPublication).where(
            ChannelPublication.gate_id == gate.id, ChannelPublication.version_id == latest.id,
        )
    )).scalar_one_or_none()
    if existing is not None and existing.status == "published":
        return existing

    # 발행 직전 재검증③(연결 활성) — 초안 생성/상신과 같은 헬퍼.
    connection = await _get_active_connection(db, org_id=org_id, connection_id=draft.connection_id)
    access_token = decrypt_for_use(connection)
    if access_token is None:
        raise ChannelConnectionNotActiveError(connection_id=connection.id)

    import httpx
    from app.services.channel_connection import apply_refresh_failure
    from app.services.threads_publish import (
        ThreadsPublishError,
        create_container,
        get_permalink,
        get_publishing_limit,
        publish_container,
    )

    tagged_link = (
        build_tagged_link(channel=draft.channel, link_url=latest.link_url, draft_id=draft.id)
        if latest.link_url else None
    )
    text_to_post = f"{latest.text}\n\n{tagged_link}" if tagged_link else latest.text

    # 페드루 PO 확定(2026-09-03) — draft 저장 시점(create_channel_post_draft_version)의
    # 길이 검사는 `text`만 잰다. 발행 시점엔 UTM 태그된 링크가 덧붙어 실제 전송 문자열
    # (`text_to_post`)이 더 길다 — 승인된 본문 혼자는 한도 밑이어도 링크 부착 후 넘을 수
    # 있다(blocking, 그라운딩 §③에서 「재검사 확定 필요」로 남겼던 자리). 여기서 합성된
    # 실제 전송 문자열을 재검사해 Threads 호출(한도 조회 포함) 0건으로 fail-closed —
    # 기존 ChannelTextTooLongError를 그대로 재사용한다(max·current 둘 다 실림).
    _validate_text_length(channel=draft.channel, text=text_to_post)

    try:
        async with httpx.AsyncClient(timeout=20) as client:
            try:
                quota_usage, quota_total, quota_duration = await get_publishing_limit(
                    client, access_token=access_token, threads_user_id=connection.account_id,
                )
            except ThreadsPublishError as exc:
                _, mapped_exc = _classify_threads_error(exc, connection_id=connection.id)
                raise mapped_exc from exc
            if quota_usage >= quota_total:
                raise ChannelRateLimitedError(
                    reset_at=datetime.now(timezone.utc) + timedelta(seconds=quota_duration),
                )

            row = existing
            if row is None:
                row = ChannelPublication(
                    id=uuid.uuid4(), org_id=org_id, gate_id=gate.id, version_id=latest.id,
                    connection_id=connection.id, channel=draft.channel, status="container_created",
                )
                # story #3395(디디 코드 리뷰 발견, PR#3752) — 같은 (gate_id, version_id)로
                # 진짜 동시 요청 2건이 들어오면 둘 다 위 existing 조회에서 None을 본 뒤 각자
                # INSERT를 시도한다. 먼저 커밋되는 쪽은 성공, 진 쪽은 uq_channel_publications_
                # gate_version 위반으로 IntegrityError → 잡히지 않으면 500. SAVEPOINT(begin_
                # nested)로 감싸면 위반 시 이 INSERT만 롤백되고 바깥 트랜잭션(gate/draft 등
                # 이미 읽은 상태)은 오염되지 않는다(participation_helpers.py::
                # ensure_default_participation_role과 동형 관용구).
                from sqlalchemy.exc import IntegrityError
                try:
                    async with db.begin_nested():
                        db.add(row)
                        await db.flush()
                except IntegrityError as exc:
                    # approval_delivery.py QA 4R/5R 교훈 — constraint 이름을 확인하지 않고
                    # "IntegrityError면 무조건 경합"으로 삼키면 진짜 다른 원인(예: 미래에
                    # FK가 추가된다면 그 위반)까지 조용히 오판할 수 있다. 이 테이블엔 FK가
                    # 없어(그라운딩 §9) 지금은 이 uq 하나뿐이지만, 방어적으로 이름을 짚는다.
                    _orig = getattr(exc, "orig", None)
                    constraint = getattr(_orig, "constraint_name", None) or getattr(
                        getattr(_orig, "__cause__", None), "constraint_name", None,
                    )
                    if constraint != "uq_channel_publications_gate_version":
                        raise
                    # 진 쪽 — Threads 실 호출은 이긴 쪽에게 맡긴다(이 자리에서 이어 부르면
                    # 이긴 쪽이 아직 처리 중인 컨테이너를 이중으로 publish할 위험이 있다).
                    # 라우터(publish_channel_post_draft_endpoint)는 이 함수가 "완결된"
                    # 행(published_at 등)을 돌려준다고 가정한다 — 그래서 그 자리에서 바로
                    # 반환하지 않고, 이긴 쪽이 끝낼 때까지 짧게 폴링한다(실측: 폴링 없이
                    # 바로 반환하면 아직 container_created인 행의 published_at=None을
                    # 라우터가 그대로 .isoformat() 해 500이 재발했다 — 이 폴링이 그 재발을
                    # 막는 부분이다).
                    row = (await db.execute(
                        select(ChannelPublication).where(
                            ChannelPublication.gate_id == gate.id, ChannelPublication.version_id == latest.id,
                        )
                    )).scalar_one()
                    # ⚠️실측 함정 — 이 row는 이제 세션 identity map에 들어가 있다. 이후
                    # 같은 select()를 반복해도 SQLAlchemy가 "이미 아는 행"이라 판단해
                    # DB에서 새로 읽은 컬럼값으로 덮어쓰지 않고 캐시된 파이썬 객체를 그대로
                    # 돌려준다(row.status가 영원히 최초 값에 멈춰 폴링이 매번 타임아웃
                    # 나던 것이 이 함정이었다) — `db.refresh(row)`로 명시적으로 다시
                    # 읽어야 이긴 쪽 세션이 커밋한 값이 보인다.
                    for _ in range(_CONCURRENT_PUBLISH_POLL_ATTEMPTS):
                        if row.status in ("published", "failed"):
                            break
                        await db.refresh(row)
                        if row.status in ("published", "failed"):
                            break
                        await asyncio.sleep(_CONCURRENT_PUBLISH_POLL_INTERVAL_SEC)
                    if row.status == "published":
                        return row
                    if row.status == "failed":
                        # 이긴 쪽이 이미 실패로 끝냈다 — 그 실패를 이 요청도 같은 모양으로
                        # 알린다(성공한 것처럼 200을 돌려주면 거짓이다). row에는 원본
                        # ThreadsPublishError 객체가 없어(안정 코드+메시지만 저장) 완전히
                        # 같은 예외를 재현할 순 없지만, 라우터의 기존 두 핸들러(토큰 만료·
                        # provider 오류)로 그대로 매핑되는 동종 예외를 다시 만든다.
                        if row.error_code == "CHANNEL_TOKEN_EXPIRED":
                            raise ChannelTokenExpiredError(
                                connection_id=connection.id, provider_message=row.last_error or "",
                            )
                        raise ChannelPublishProviderError(
                            provider_code=row.error_code or "UNKNOWN", provider_message=row.last_error or "",
                        )
                    # 폴링 시간 안에 끝나지 않았다 — 아직 진행 중이라는 뜻(이긴 쪽 프로세스가
                    # 죽어 영영 안 끝날 수도 있으나, 그 복구는 이 스토리 스코프 밖이다:
                    # 재시도가 그때는 existing.status=="container_created"인 채로 다시 이
                    # 함수에 들어와 그 컨테이너로 publish만 이어간다 — 기존 부분성공 재시도
                    # 경로 그대로).
                    raise ChannelPublishInProgressError(gate_id=gate.id)
                    return row

            if row.external_container_id is None:
                try:
                    container_id = await create_container(
                        client, access_token=access_token, threads_user_id=connection.account_id,
                        text=text_to_post,
                    )
                except ThreadsPublishError as exc:
                    error_code, mapped_exc = _classify_threads_error(exc, connection_id=connection.id)
                    row.status = "failed"
                    row.error_code = error_code
                    row.last_error = exc.message
                    await db.commit()
                    if error_code == "CHANNEL_TOKEN_EXPIRED":
                        await apply_refresh_failure(db, connection=connection, error_message=exc.message)
                    raise mapped_exc from exc
                row.external_container_id = container_id
                row.status = "container_created"
                row.error_code = None
                row.last_error = None
                await db.commit()

            try:
                media_id = await publish_container(
                    client, access_token=access_token, threads_user_id=connection.account_id,
                    creation_id=row.external_container_id,
                )
            except ThreadsPublishError as exc:
                error_code, mapped_exc = _classify_threads_error(exc, connection_id=connection.id)
                row.status = "failed"
                row.error_code = error_code
                row.last_error = exc.message
                await db.commit()
                if error_code == "CHANNEL_TOKEN_EXPIRED":
                    await apply_refresh_failure(db, connection=connection, error_message=exc.message)
                raise mapped_exc from exc

            row.external_id = media_id
            row.status = "published"
            row.published_at = datetime.now(timezone.utc)
            row.error_code = None
            row.last_error = None

            try:
                permalink = await get_permalink(client, access_token=access_token, media_id=media_id)
            except ThreadsPublishError:
                # 발행 자체는 성공(media_id 확보) — permalink 조회 실패는 비치명(threads_
                # publish.py::get_permalink 독스트링 참고, None 허용).
                permalink = None
            row.permalink = permalink
    finally:
        del access_token  # ⛔즉시 소비 후 폐기 — channel_connections.py 관례와 동일.

    await db.commit()
    await db.refresh(row)

    from app.services.activity_log import ActivityLogService

    await ActivityLogService(db).record(
        org_id=org_id, action="channel_post_published", actor_type="platform", actor_id=None,
        entity_type="channel_publication", entity_id=row.id,
        context={
            "gate_id": str(gate.id), "version_id": str(latest.id),
            "permalink": row.permalink, "external_id": row.external_id,
            "published_by_member_id": str(published_by_member_id),
        },
    )
    await db.commit()
    return row
