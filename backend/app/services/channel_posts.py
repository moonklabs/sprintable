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
from app.models.channel_post_image import ChannelPostImage
from app.models.channel_post_version import ChannelPostVersion
from app.models.channel_publication import ChannelPublication
from app.models.gate import Gate, set_gate_status
from app.models.publication_command import PublicationCommand
from app.models.site_post_draft import SitePostDraft
from app.models.site_post_version import SitePostVersion
from app.services.channel_adapters import get_channel_adapter
from app.services.channel_connection import decrypt_for_use
from app.services.content_rules import ContentRuleViolationError, get_org_content_rules, lint_content
from app.services.gate_seal import (
    GateReapprovalRequiredError as ChannelPostReapprovalRequiredError,  # noqa: F401 (재-export, 라우터가 import)
    GateSealMissingError as ChannelPostSealMissingError,  # noqa: F401 (재-export, 라우터가 import)
    compute_seal_hash,
)
from app.services.site_posts import (  # noqa: F401 (재-export 편의 — 채널 라우터도 재사용)
    ExternalPublishGateNotApprovedError,
    get_site_post_draft,
    is_agent_caller,
)
from app.services.utm import attach_utm, resolve_utm_campaign

_EXTERNAL_PUBLISH_GATE_TYPE = "external_publish"

# story 620beefc — create_channel_post_draft_version()의 image_sha256 파라미터 기본값
# 센티널. text/link_url은 편집 때마다 클라이언트가 매번 다시 보내야 하는 필드지만(그대로
# 재사용 안 함), 이미지는 별도 엔드포인트(channel_post_images.py)로만 첨부/교체된다 —
# 일반 텍스트 편집 호출은 이 파라미터를 아예 모르므로, "생략"과 "명시적으로 없앰(None)"을
# 구별해야 조용히 이미지가 떨어지는 사고를 막는다. 생략=직전 버전 값 캐리포워드,
# None=명시적 제거(현재 호출부 없음 — Phase1엔 이미지 제거 기능이 없다, 장래 대비).
_IMAGE_SHA256_CARRY_FORWARD = object()


class ChannelConnectionNotActiveError(ValueError):
    """AC6 — connection_id가 이 org의 channel_connections 행이 아니거나 status≠active."""

    def __init__(self, *, connection_id: uuid.UUID):
        self.connection_id = connection_id
        super().__init__(f"연결을 찾을 수 없거나 비활성 상태입니다: {connection_id}")


class ChannelPostSourceContentItemNotFoundError(ValueError):
    """story #3437(AC2, 페드루 PO 確定 2026-09-04 보정 ⓐ) — source_content_item_id가 이
    org의 SitePostDraft가 아니다(존재 안 함 또는 다른 org 소속). get_site_post_draft가
    org_id 조건으로 조회하는 자리라 "존재 안 함"과 "다른 org"가 이미 같은 결과(None)를
    낸다 — 두 경우를 굳이 갈라 존재를 비노출한다(이 도메인의 기존 "존재 비노출" 관례
    그대로). PO 確定대로 422(입력 형태 오류 축, CHANNEL_CONNECTION_NOT_ACTIVE의 409와는
    다른 축 — 이건 "그런 원문이 없다"는 형태 오류다)."""

    def __init__(self, *, source_content_item_id: uuid.UUID):
        self.source_content_item_id = source_content_item_id
        super().__init__(f"원문(content_item)을 찾을 수 없습니다: {source_content_item_id}")


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


class ChannelImageContainerFailedError(Exception):
    """story 620beefc(AC5) — Threads IMAGE 컨테이너가 ERROR/EXPIRED로 끝났다(그라운딩
    §② 실측 상태값). 폴링을 더 반복해도 결과가 안 바뀌는 결정적 실패라 needs_check로
    분류돼(publication_command.py) 자동 재시도 없이 사람 재시도(AC5)로 넘어간다."""

    def __init__(self, *, gate_id: uuid.UUID, container_status: str, error_message: str | None):
        self.gate_id = gate_id
        self.container_status = container_status
        self.error_message = error_message
        super().__init__(
            f"이미지 컨테이너 처리 실패(gate_id={gate_id}, status={container_status}): "
            f"{error_message or '(no error_message)'}"
        )


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


class ChannelPostGateNotFoundError(Exception):
    """story #3419 — 취소·회수 대상을 찾으려면 그 draft가 상신된 적(=게이트가 생긴
    적)이 있어야 한다. 순수 초안(상신 전)에 취소/회수를 시도하면 이 예외 — 404."""

    def __init__(self, draft_id: uuid.UUID):
        self.draft_id = draft_id
        super().__init__(f"이 draft는 아직 상신된 적이 없습니다(취소/회수 대상 없음): {draft_id}")


class PublicationCommandNotFoundError(Exception):
    """story #3419 AC1 — 이 draft의 gate에 걸린 publication_command 자체가 없다(발행/예약
    요청을 한 적이 없음). 404."""

    def __init__(self, draft_id: uuid.UUID):
        self.draft_id = draft_id
        super().__init__(f"취소할 발행 명령이 없습니다: {draft_id}")


class PublicationCommandNotCancellableError(Exception):
    """story #3419 AC1 — PO 確定 ①-a: 취소 가능 상태는 pending·blocked·dead_letter뿐
    (사람이 「이 명령을 끝내겠다」는 뜻 — 종결 아닌 상태 전부 허용). in_progress(이미
    실행 중)·completed·voided·cancelled(이미 종결)는 409."""

    def __init__(self, *, command_id: uuid.UUID, current_status: str):
        self.command_id = command_id
        self.current_status = current_status
        super().__init__(
            f"이 명령은 취소할 수 없는 상태입니다(command_id={command_id}, status={current_status})"
        )


class ChannelPostNotPublishedError(Exception):
    """story #3419 AC2 — 회수하려면 이 gate에 status='published' 행이 있어야 한다.
    발행된 적이 없거나 이미 unpublished면 이 예외 — 409."""

    def __init__(self, draft_id: uuid.UUID):
        self.draft_id = draft_id
        super().__init__(f"발행된 적이 없거나 이미 회수된 글입니다: {draft_id}")


class ChannelUnpublishUnsupportedError(Exception):
    """story #3419 AC2 — 어댑터가 `supports_unpublish=False`로 선언한 채널. 화면은
    이 선언값으로 버튼 자체를 안 그리는 게 정상 경로지만(§17-4), 서버도 독립적으로
    거부한다(FE 우회·구버전 클라이언트 대비) — 422."""

    def __init__(self, *, channel: str):
        self.channel = channel
        super().__init__(f"이 채널은 발행 회수를 지원하지 않습니다: {channel}")


class ChannelScopeInsufficientError(Exception):
    """story #3419 AC2·PO 確定 ②-a — 어댑터는 회수를 지원하지만 이 연결에 필요 스코프
    (예: threads_delete)가 없다. 기존 연결(이 스코프 도입 前 저장분)이 항상 여기 걸린다
    (의도) — 재인증하면 새 scope 문자열이 반영돼 해소된다. 422, required_scopes를
    실어 화면이 「재인증하면 회수할 수 있습니다」(유나 §17-11)를 그릴 수 있게 한다."""

    def __init__(self, *, required_scopes: list[str]):
        self.required_scopes = required_scopes
        super().__init__(f"이 연결에 필요한 스코프가 없습니다: {required_scopes}")


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
    자신 또는 그 직후·한글 결합 자모(중성/종성, U+1160~U+11FF). 이 3축 밖의 결합(예:
    국가 국기 이모지의 regional indicator 쌍)은 여전히 쪼개질 수 있다.

    페드루 리뷰(2026-09-04) — cut 지점이 ZWJ **자신**에 떨어지는 경우(`ch == _ZWJ`)를
    처음엔 놓쳤다: `prev == _ZWJ`만 보면 "ZWJ 다음 글자"는 이어 붙이지만, cut이 ZWJ
    코드포인트 그 자체를 가리킬 때는 아직 뒤에 이어질 문자를 안 봐서 여기서 멈춰버려
    앞 글자(예: 👩)만 남고 클러스터(👩‍💻)가 반토막 났다 — `ch == _ZWJ`도 True로 둬서
    ZWJ 자체를 포함하고, 다음 반복에서 `prev == _ZWJ` 조건이 그 뒤 문자까지 마저
    끌고 오게 한다(연쇄)."""
    if unicodedata.combining(ch) != 0:
        return True
    if ch in _VARIATION_SELECTORS:
        return True
    if ch == _ZWJ or prev == _ZWJ:
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
    image_sha256: str | None = _IMAGE_SHA256_CARRY_FORWARD,  # type: ignore[assignment]
    source_content_item_id: uuid.UUID | None = None,
) -> tuple[ChannelPostVersion, str, list[dict]]:
    """초안을 (org, work_item, connection_id)로 upsert하고 새 불변 버전을 추가한다 —
    site_posts.create_site_post_draft_version과 1:1 대응(AC1).

    story #3394 — 반환을 `(version, channel)` 튜플로 넓혔다(회귀 0, 유일한 호출부인
    라우터가 곧바로 unpack하도록 같이 바꾼다) — 라우터가 `tagged_link_preview`(AC5)를
    조립하려면 이 draft의 channel을 알아야 하는데, 여기서 이미 조회한 `connection.channel`을
    그대로 돌려주는 편이 라우터가 별도 쿼리로 다시 찾는 것보다 싸다.

    story #3471(페드루 PO 確定 2026-09-05) — 3-튜플로 다시 넓혔다(`violations` 추가).
    라우터가 응답 body에 그대로 실어 create/update 시점에 위반을 보여준다(비차단 —
    거부는 submit()에서만).

    story 620beefc — `image_sha256` 생략(기본값) 시 draft의 직전 최신 버전 값을 그대로
    캐리포워드한다(§17-14 배지가 「이미지가 텍스트 편집만으로 조용히 사라졌다」를 만들지
    않도록). `channel_post_images.py`의 이미지 첨부 플로우만 이 값을 명시로 넘긴다.

    story #3437(AC2, 페드루 PO 確定 2026-09-04) — `source_content_item_id`는 **초안
    생성 시에만** 반영한다(channel이 connection_id의 파생값으로 생성 시에만 고정되는
    것과 동형 축 — 편집마다 다시 보내는 text/link_url과는 다른 종류의 필드). org
    불일치·존재하지 않는 원문은 `ChannelPostSourceContentItemNotFoundError`(422)."""
    connection = await _get_active_connection(db, org_id=org_id, connection_id=connection_id)
    _validate_text_length(channel=connection.channel, text=text)

    resolved_source_site_post_version_id: uuid.UUID | None = None
    if source_content_item_id is not None:
        content_item = await get_site_post_draft(db, org_id=org_id, draft_id=source_content_item_id)
        if content_item is None:
            raise ChannelPostSourceContentItemNotFoundError(source_content_item_id=source_content_item_id)
        # story #3437(후속 묶음, 페드루 PO 確定 2026-09-05) — 이 시점의 원문 latest
        # version.id를 고정 저장(버전 축, source_content_item_id의 draft 축과 별개).
        # source_content_item_id처럼 **초안 생성 시에만** 반영 — 편집(기존 draft) 호출은
        # source_content_item_id 자체가 무시되므로(위 docstring) 이 값도 함께 무시된다.
        latest_source_version = (await db.execute(
            select(SitePostVersion)
            .where(SitePostVersion.draft_id == source_content_item_id)
            .order_by(SitePostVersion.version.desc())
            .limit(1)
        )).scalar_one_or_none()
        resolved_source_site_post_version_id = (
            latest_source_version.id if latest_source_version is not None else None
        )

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
            source_content_item_id=source_content_item_id,
            source_site_post_version_id=resolved_source_site_post_version_id,
        )
        db.add(draft)
        await db.flush()
        next_version = 1
        carried_image_sha256 = None
        prior_latest = None
    else:
        prior_latest = (await db.execute(
            select(ChannelPostVersion)
            .where(ChannelPostVersion.draft_id == draft.id)
            .order_by(ChannelPostVersion.version.desc())
            .limit(1)
        )).scalar_one_or_none()
        next_version = (prior_latest.version if prior_latest is not None else 0) + 1
        carried_image_sha256 = prior_latest.image_sha256 if prior_latest is not None else None

    resolved_image_sha256 = (
        carried_image_sha256 if image_sha256 is _IMAGE_SHA256_CARRY_FORWARD else image_sha256
    )

    version = ChannelPostVersion(
        id=uuid.uuid4(), draft_id=draft.id, version=next_version,
        text=text, link_url=link_url,
        body_sha256=compute_channel_post_hash(text=text, link_url=link_url),
        image_sha256=resolved_image_sha256,
        author_member_id=author_member_id, author_kind=author_kind,
    )
    db.add(version)
    await db.flush()

    # story 620beefc(페드루 리뷰 블로커 B1, 2026-09-04) — image_sha256을 캐리포워드했을
    # 뿐 실제 `ChannelPostImage` 행은 여전히 직전 버전의 version_id에 남아 있었다. 발행
    # 시점(publish_channel_post_draft)은 gate가 아니라 latest.id로 이미지 행을 찾으므로
    # (동일 버전 스코프 확定), 텍스트만 편집한 새 버전은 이 행이 없어 「빈손」 →
    # image_sha256은 여전히 세팅돼 있어 봉인·재승인은 media 축까지 정확히 도는데
    # 정작 발행은 이미지 없이 TEXT로 나가고 썸네일도 사라지는 모순이 실측 확認됐다.
    # 캐리포워드가 확定될 때(호출부가 명시로 새 이미지를 안 넘겼을 때) 행 자체를
    # 새 version_id로 복제한다 — 파일 재업로드·재변환 없음(object_path·sha256 그대로,
    # 계보만 이어붙임).
    if image_sha256 is _IMAGE_SHA256_CARRY_FORWARD and prior_latest is not None:
        prior_image = (await db.execute(
            select(ChannelPostImage).where(ChannelPostImage.version_id == prior_latest.id)
        )).scalar_one_or_none()
        if prior_image is not None:
            db.add(ChannelPostImage(
                id=uuid.uuid4(), org_id=prior_image.org_id, draft_id=prior_image.draft_id,
                version_id=version.id,
                original_object_path=prior_image.original_object_path,
                original_sha256=prior_image.original_sha256,
                original_content_type=prior_image.original_content_type,
                original_bytes=prior_image.original_bytes,
                original_width=prior_image.original_width,
                original_height=prior_image.original_height,
                derived_object_path=prior_image.derived_object_path,
                derived_sha256=prior_image.derived_sha256,
                derived_content_type=prior_image.derived_content_type,
                derived_bytes=prior_image.derived_bytes,
                derived_width=prior_image.derived_width,
                derived_height=prior_image.derived_height,
                created_by=prior_image.created_by,
            ))
            await db.flush()

    await _reseal_gate_on_new_version(
        db, org_id=org_id, work_item_id=work_item_id, version=version, connection_id=draft.connection_id,
    )

    # story #3471(페드루 PO 確定 2026-09-05) — 초안 create/update는 lint를 비차단으로
    # 실행·draft에 스냅샷 저장만 한다(거부는 submit()만, 아래 함수 참고). rules가 org에
    # 한 번도 PUT 안 됐으면(None) violations=0건.
    rule_row = await get_org_content_rules(db, org_id=org_id)
    violations = lint_content(rule_row.rules if rule_row else None, text=text, link_url=link_url)
    draft.lint_result = {"rules_version": rule_row.version if rule_row else 0, "violations": violations}

    await db.commit()
    await db.refresh(version)
    return version, connection.channel, violations


async def _reseal_gate_on_new_version(
    db: AsyncSession, *, org_id: uuid.UUID, work_item_id: uuid.UUID, version: ChannelPostVersion,
    connection_id: uuid.UUID,
) -> None:
    """site_posts.py::_reseal_gate_on_new_version과 동형 규칙(§3-1-2), 봉인 본문만 이
    도메인의 `text`를 쓴다: pending 中 편집 → 즉시 재봉인, approved 뒤 편집 → pending
    재오픈+reapproval_required=True(옛 봉인은 그대로 보존).

    story #3404(디디 코드 확認 2026-09-03·페드루 PO 지시 2026-09-04) — 이 훅은
    (work_item_id, scope_key)로 게이트를 찾는다(draft 무관, story #3478부터 scope_key
    도 축에 편입 — 안 넣으면 같은 work_item에 목적지가 다른 게이트가 둘 있을 때
    MultipleResultsFound). 승인 대상이 아닌 다른 초안을 편집(새 버전 생성 — 새 draft
    최초 생성 포함, 그 자체가 버전 1 생성)했을 뿐인데 여기서 그 게이트를 되돌리거나
    (approved→pending) 조용히 재봉인하면 submit()의 가드(resolve_gate_holder_draft_id)
    를 거치지 않고도 동일한 파괴가 일어난다 — site_posts.py가 f6d14476에서 이미 막은
    것과 정확히 같은 결함 클래스가 이 파일에 그대로 남아 있었다(직접 재현 확認).
    submit()과 같은 판정 함수를 그대로 쓴다."""
    from app.services.gate_service import resolve_gate_holder_draft_id

    scope_key = str(connection_id)
    gate = (await db.execute(
        select(Gate)
        .where(
            Gate.org_id == org_id, Gate.work_item_id == work_item_id, Gate.scope_key == scope_key,
            Gate.gate_type == _EXTERNAL_PUBLISH_GATE_TYPE, Gate.status.in_(("pending", "approved")),
        )
        .with_for_update()
    )).scalar_one_or_none()
    if gate is None:
        return
    if await resolve_gate_holder_draft_id(db, gate, this_draft_id=version.draft_id) is not None:
        return
    if gate.status == "approved":
        # story 620beefc(AC4) — 무엇이 바뀌어 재승인이 필요해졌는지(본문 vs 이미지)를
        # 되돌리기 전에 판정한다 — submit_channel_post_draft의 content_changed/
        # media_changed와 동형 축(옛 sealed_* 값은 아래서 갱신 안 하므로 「마지막
        # 승인값」 그대로 비교 대상).
        content_changed_here = gate.sealed_content_sha256 != version.body_sha256
        media_changed_here = gate.sealed_media_sha256 != version.image_sha256
        reason_code = "CONTENT_CHANGED" if content_changed_here else (
            "MEDIA_CHANGED" if media_changed_here else "CONTENT_CHANGED"
        )
        set_gate_status(gate, "pending", now=datetime.now(timezone.utc))
        gate.requires_human = True
        gate.resolver_id = None
        gate.resolution_note = None
        gate.resolved_at = None
        gate.reapproval_required = True
        # story #3414 추가② — 조용한 무효화 경로(명시적 재상신이 아니라 새 draft 버전
        # 생성만으로 approved→pending으로 되돌아간 경우)도 대기 중 명령을 즉시
        # 무효화한다. submit_channel_post_draft의 명시적 재상신 경로와 동형 처방.
        from app.services.publication_command import void_pending_commands_for_gate
        await void_pending_commands_for_gate(db, gate_id=gate.id, reason_code=reason_code)
        return
    gate.sealed_content_version = version.version
    gate.sealed_content_sha256 = version.body_sha256
    gate.sealed_content_body = version.text
    gate.sealed_media_sha256 = version.image_sha256


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


async def get_source_titles_and_latest_versions(
    db: AsyncSession, *, org_id: uuid.UUID, content_item_ids: set[uuid.UUID],
) -> dict[uuid.UUID, tuple[str, uuid.UUID]]:
    """story #3437(후속 묶음, 페드루 PO 確定 2026-09-05) — `source_content_item_id`가
    있는 channel_post_drafts 행들의 원문(제목 + 현재 latest version.id)을 배치 1건으로
    조회한다. `campaigns.list_content_items_for_campaign`의 latest-version 서브쿼리와
    동형(campaign_id 필터 대신 draft_id IN 필터) — 새 조인 패턴 발명 0.

    반환: {content_item_id: (title, latest_version_id)}. content_item_ids가 비어 있으면
    쿼리 자체를 안 돈다(N+1 방지 — 소스 없는 초안만 있는 페이지에서 빈 쿼리 스킵)."""
    if not content_item_ids:
        return {}
    latest_version_ids = (
        select(
            SitePostVersion.draft_id,
            func.max(SitePostVersion.version).label("max_version"),
        )
        .group_by(SitePostVersion.draft_id)
        .subquery()
    )
    stmt = (
        select(SitePostDraft.id, SitePostVersion.title, SitePostVersion.id)
        .join(latest_version_ids, latest_version_ids.c.draft_id == SitePostDraft.id)
        .join(
            SitePostVersion,
            (SitePostVersion.draft_id == latest_version_ids.c.draft_id)
            & (SitePostVersion.version == latest_version_ids.c.max_version),
        )
        .where(SitePostDraft.org_id == org_id, SitePostDraft.id.in_(content_item_ids))
    )
    return {row[0]: (row[1], row[2]) for row in (await db.execute(stmt)).all()}


async def list_channel_post_drafts(
    db: AsyncSession, *, org_id: uuid.UUID, limit: int = 50, offset: int = 0,
    draft_id: uuid.UUID | None = None,
    scheduled_from: datetime | None = None,
    scheduled_to: datetime | None = None,
    unscheduled: bool = False,
    source_content_item_id: uuid.UUID | None = None,
) -> list[
    tuple[
        ChannelPostDraft, ChannelPostVersion, ChannelPostVersion,
        Gate | None, ChannelPublication | None, ChannelPublication | None, str | None,
        PublicationCommand | None, ChannelPostImage | None,
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
    페이지 쿼리 1건 + gate 배치 1건 + publication 배치 2건(조건부) + version 해시 배치 1건
    (조건부) + command 배치 1건(story #3415) + image 배치 1건(story 620beefc), 최대 7건,
    draft 수 무관).

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
    - `latest_command`(8번째 원소, story #3415) — 이 gate의 **가장 최근 생성된**
      `publication_command`(created_at 최대, ④의 published_pub_by_gate와 동형 setdefault
      패턴) — `failure_kind`·`next_attempt_at`(응답 필드명은 `next_retry_at`, 유나 §17
      어휘)·`dead_letter_at`의 출처. gate에 발행/예약 요청이 여러 번 있었으면(voided 뒤
      재상신 등) 과거 completed/voided 이력에 안 가려지고 최신 것만 남는다(카디르류 QA —
      "이 게이트의 아무 행이나≠이 게이트의 최신 행").

    반환: (draft, latest_version, origin_version, gate, published_publication,
    latest_version_publication, published_body_sha256, latest_command, latest_image) —
    gate·publication·command·image 계열은 없으면 None(지어내지 않는다, "모른다≠다르다").
    `latest_image`(9번째 원소, story 620beefc)는 **최신 버전**에 붙은 `ChannelPostImage`
    (없으면 None) — 썸네일·§17-14 배지(원본/파생본 width·bytes) 출처, latest_command와
    같은 "최신 버전/게이트 기준" 원칙.

    story #3423(캘린더 #3422 선행) — `scheduled_from`/`scheduled_to`/`unscheduled`.
    기준 컬럼은 **`gate.sealed_scheduled_at`**(승인된 예약 시각) — `publication_command.
    scheduled_at`이 아니다(그 값은 요청 시점 스냅샷, story #3414). "그 게이트"의 정의는
    배치②와 동일(work_item당 가장 최근 생성된 external_publish 게이트) — 필터가
    사후 필터링이 아니라 **페이지 쿼리 자체**에 들어가야 LIMIT/OFFSET이 필터링된
    결과 위에서 동작한다(안 그러면 페이지가 좁아지거나 빈 페이지가 나온다). 필터가
    하나도 없으면 이 조인·정렬 변경 자체를 안 탄다(기존 응답 완전 불변, 회귀 0)."""
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
    )

    schedule_filter_active = unscheduled or scheduled_from is not None or scheduled_to is not None
    if schedule_filter_active:
        latest_gate_ids = (
            select(Gate.work_item_id, func.max(Gate.created_at).label("max_created_at"))
            .where(Gate.org_id == org_id, Gate.gate_type == _EXTERNAL_PUBLISH_GATE_TYPE)
            .group_by(Gate.work_item_id)
            .subquery()
        )
        filter_gate = aliased(Gate)
        stmt = stmt.outerjoin(
            latest_gate_ids, latest_gate_ids.c.work_item_id == ChannelPostDraft.work_item_id,
        ).outerjoin(
            filter_gate,
            (filter_gate.work_item_id == latest_gate_ids.c.work_item_id)
            & (filter_gate.created_at == latest_gate_ids.c.max_created_at)
            & (filter_gate.gate_type == _EXTERNAL_PUBLISH_GATE_TYPE)
            & (filter_gate.org_id == org_id),
        )
        if unscheduled:
            stmt = stmt.where(filter_gate.sealed_scheduled_at.is_(None))
        else:
            if scheduled_from is not None:
                stmt = stmt.where(filter_gate.sealed_scheduled_at >= scheduled_from)
            if scheduled_to is not None:
                stmt = stmt.where(filter_gate.sealed_scheduled_at <= scheduled_to)
        # AC2 — 필터가 활성일 때만 정렬을 예약 시각 기준으로 바꾼다(미정은 NULLS LAST
        # 뒤 created_at으로 2차 정렬). 필터 없는 기본 목록의 정렬(최근 편집순)은 안 건드린다.
        stmt = stmt.order_by(filter_gate.sealed_scheduled_at.asc().nulls_last(), latest.created_at.desc())
    else:
        stmt = stmt.order_by(latest.created_at.desc())

    stmt = stmt.limit(limit).offset(offset)
    if draft_id is not None:
        stmt = stmt.where(ChannelPostDraft.id == draft_id)
    # story #3437(AC2) — 원문(content_item) 쪽 「파생 변형 목록」조회가 이 함수를 그대로
    # 재사용(단건 조회가 draft_id로 재사용하는 것과 동형 — 두 번째 조인 축을 새로 안 짠다).
    if source_content_item_id is not None:
        stmt = stmt.where(ChannelPostDraft.source_content_item_id == source_content_item_id)
    page_rows = [(row[0], row[1], row[2]) for row in (await db.execute(stmt)).all()]
    if not page_rows:
        return []

    work_item_ids = [draft.work_item_id for draft, _, _ in page_rows]

    # 배치 ②: (work_item, scope_key)당 external_publish 게이트(site_posts.list_site_post_
    # drafts와 동형 — 사실상 1개뿐이지만 여럿이면 최신 created_at이 이긴다). story #3478
    # 카디르 REQUEST_CHANGES(2026-09-05) — 예전엔 키가 work_item_id만이라 같은 work_item에
    # 목적지가 다른 draft 둘(예: 커넥션 A·B)이 있으면 그중 하나의 게이트를 서로 나눠 봤다.
    gates_by_scope: dict[tuple[uuid.UUID, str], Gate] = {}
    gate_rows = (await db.execute(
        select(Gate)
        .where(Gate.org_id == org_id, Gate.work_item_id.in_(work_item_ids), Gate.gate_type == "external_publish")
        .order_by(Gate.created_at.desc())
    )).scalars().all()
    for g in gate_rows:
        gates_by_scope.setdefault((g.work_item_id, g.scope_key), g)

    gate_ids = [g.id for g in gates_by_scope.values()]
    latest_version_id_by_gate = {
        gates_by_scope[(draft.work_item_id, str(draft.connection_id))].id: latest_v.id
        for draft, latest_v, _ in page_rows
        if (draft.work_item_id, str(draft.connection_id)) in gates_by_scope
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

    # 배치 ⑥(story #3415) — gate_id당 가장 최근 생성된 publication_command. created_at
    # desc로 받아 setdefault로 첫 것(=최신)만 남긴다 — ④(published_pub_by_gate)와 동형
    # 패턴. 과거 이력에 최신 행이 가려지면 안 된다(QA③ 대상).
    latest_command_by_gate: dict[uuid.UUID, PublicationCommand] = {}
    if gate_ids:
        command_rows = (await db.execute(
            select(PublicationCommand)
            .where(PublicationCommand.gate_id.in_(gate_ids))
            .order_by(PublicationCommand.created_at.desc())
        )).scalars().all()
        for c in command_rows:
            latest_command_by_gate.setdefault(c.gate_id, c)

    # 배치 ⑦(story 620beefc, AC6) — 최신 버전당 첨부 이미지(있으면). version_id UNIQUE
    # (Phase1 1건/버전)라 setdefault 불요 — 단순 dict 매핑. 썸네일 URL·§17-14 배지
    # 재료(원본/최종 width·bytes)의 출처.
    image_by_version: dict[uuid.UUID, ChannelPostImage] = {}
    latest_version_ids_in_page = [latest_v.id for _, latest_v, _ in page_rows]
    if latest_version_ids_in_page:
        image_rows = (await db.execute(
            select(ChannelPostImage).where(ChannelPostImage.version_id.in_(latest_version_ids_in_page))
        )).scalars().all()
        for img in image_rows:
            image_by_version[img.version_id] = img

    result = []
    for draft, latest_v, origin_v in page_rows:
        gate = gates_by_scope.get((draft.work_item_id, str(draft.connection_id)))
        published_pub = published_pub_by_gate.get(gate.id) if gate else None
        latest_pub = latest_version_pub_by_gate.get(gate.id) if gate else None
        published_body_sha256 = (
            body_sha256_by_version_id.get(published_pub.version_id) if published_pub else None
        )
        latest_command = latest_command_by_gate.get(gate.id) if gate else None
        latest_image = image_by_version.get(latest_v.id)
        result.append((
            draft, latest_v, origin_v, gate, published_pub, latest_pub, published_body_sha256,
            latest_command, latest_image,
        ))
    return result


async def submit_channel_post_draft(
    db: AsyncSession,
    *,
    org_id: uuid.UUID,
    draft_id: uuid.UUID,
    version_id: uuid.UUID | None,
    requester_member_id: uuid.UUID,
    scheduled_at: datetime | None = None,
) -> tuple[Gate, uuid.UUID]:
    """초안 버전을 external_publish 게이트에 상신 — site_posts.submit_site_post_draft와
    1:1 대응(AC3). **에이전트도 호출 가능**(AC1, 2026-09-03 dev 실측 정정 — site S2와 동일
    실동작: submit은 게이트 생성까지만, 승인·발행이 human-only다. 이 함수 자체엔 actor_type
    가드가 없다 — 신규 코드 불요).

    story #3414(PO 確定 (B), 2026-09-04) — 재승인 판정 지점은 이 함수 하나다. 판정축은
    본문 해시 **또는** scheduled_at 중 하나라도 봉인값과 다르면 재승인(destination
    축은 이 도메인에서 draft당 connection_id가 구조적으로 불변이라 실질 검사 대상이
    아니다). 즉 "본문은 그대로, 예약 시각만 바꾼다"도 이 함수를 다시 불러 처리한다
    (신규 엔드포인트를 따로 안 만든다 — 판정 지점을 하나로 유지). site_posts는 예약
    개념이 없어 판정축이 하나뿐이라 이 함수와 대칭이 깨지는데, 대칭보다 판정 단일
    지점이 우선이라는 게 PO 확定."""
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

    # story #3471(페드루 PO 確定 2026-09-05) — submit(상신) 시점에 재검사·위반 1건
    # 이상이면 422(금지 AC=서버 거부). create/update의 lint_result 스냅샷을 다시
    # 신뢰하지 않고 이 시점 규칙으로 직접 재검사한다(create 이후 규칙이 PUT됐을 수
    # 있다 — 오래된 스냅샷을 믿으면 그 사이 새로 생긴 위반을 놓친다).
    rule_row = await get_org_content_rules(db, org_id=org_id)
    submit_violations = lint_content(rule_row.rules if rule_row else None, text=target.text, link_url=target.link_url)
    if submit_violations:
        raise ContentRuleViolationError(
            rules_version=rule_row.version if rule_row else 0, violations=submit_violations,
        )

    from app.services.gate_service import create_gate, find_gate_slot_with_pr_fallback, resolve_gate_holder_draft_id
    from app.services.workflow_line_config import _default_role_id

    # story #3478(0328) — scope_key=목적지(connection_id). channel_post도 site_post와
    # 같은 규칙(그라운딩 대조 — resolve_gate_holder_draft_id 공유 함수 드리프트 방지).
    scope_key = str(draft.connection_id)
    existing = await find_gate_slot_with_pr_fallback(
        db, org_id=org_id, work_item_id=draft.work_item_id, work_item_type="story",
        gate_type=_EXTERNAL_PUBLISH_GATE_TYPE, pr_number=None, repo_full_name=None, scope_key=scope_key,
    )

    # story #3404(site_posts.py f6d14476 미러, 판정 로직은 gate_service.py::
    # resolve_gate_holder_draft_id로 공유) — 게이트 슬롯은 (work_item, scope_key) 단위
    # (story #3478부터)라, 같은 목적지를 이미 다른 초안이 그 게이트를 쥐고(pending/
    # approved이면서 그 발행이 지금 실려 있음) 있으면 이 초안의 상신을 막는다.
    holding_draft_id = await resolve_gate_holder_draft_id(db, existing, this_draft_id=draft.id)
    if holding_draft_id is not None:
        holder = await get_channel_post_draft(db, org_id=org_id, draft_id=holding_draft_id)
        if holder is not None:
            raise ChannelPostGateAlreadyHeldError(
                holding_draft_id=holder.id, holding_channel=holder.channel,
                holding_connection_id=holder.connection_id,
            )

    # story #3414 — 무엇이 바뀌었는지(본문 또는 scheduled_at)를 재봉인 前에 먼저
    # 판정한다. 셋 다 안 바뀌었으면 기존처럼 완전 no-op(short-circuit).
    content_changed = existing is None or existing.sealed_content_sha256 != target.body_sha256
    schedule_changed = existing is None or existing.sealed_scheduled_at != scheduled_at
    # story 620beefc(AC4) — 세 번째 축. content_changed/schedule_changed와 나란히 두되
    # 기존 두 축의 판정·no-op short-circuit 조건은 손대지 않는다(회귀 0) — media_changed는
    # short-circuit 조건에도 추가로 들어가 "이미지만 바뀐" 재상신도 더는 no-op되지 않는다.
    media_changed = existing is None or existing.sealed_media_sha256 != target.image_sha256
    if (
        existing is not None
        and not content_changed
        and not schedule_changed
        and not media_changed
        and existing.status in ("pending", "approved")
        # story #3496(site_posts.py와 동형 결함, 페드루 실측 2026-09-05) — reapproval_
        # required도 판정 축이다. 승인 뒤 편집(approved→pending+reapproval_required=
        # True)한 뒤 submit 없이 또 편집하면 재봉인 훅이 sealed_*를 최신으로 동기화
        # 하면서도 reapproval_required는 그대로 True로 남긴다 — 그 상태에서 이 조기
        # return이 content/schedule/media만 보고 "이미 봉인돼 있다"로 넘기면 게이트
        # 재승인 가드가 절대 안 풀리는 영구 막다른 길이 된다.
        and not existing.reapproval_required
    ):
        return existing, target.id

    was_approved = existing is not None and existing.status == "approved"

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
        requester_member_id, role_id, neutral_facts=neutral_facts, scope_key=scope_key,
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
    gate.sealed_scheduled_at = scheduled_at
    gate.sealed_media_sha256 = target.image_sha256
    gate.reapproval_required = False

    if was_approved:
        # story #3414 추가② — 이 재상신이 이미 승인된 게이트를 되돌린 경우(위에서
        # pending으로 되돌렸다), 그 게이트에 걸린 대기 중 명령을 즉시 무효화한다
        # (워커 tick을 기다리지 않고 화면이 바로 "이 예약은 더 이상 유효하지 않다"를
        # 보일 수 있게). 사유 코드는 실제 무엇이 바뀌었는지 그대로 — 본문이 바뀌었으면
        # CONTENT_CHANGED, 본문은 그대로고 시각만 바뀌었으면 SCHEDULE_CHANGED, 본문·
        # 시각 둘 다 그대로고 이미지만 바뀌었으면 MEDIA_CHANGED(story 620beefc AC4 —
        # 기존 두 값의 우선순위는 그대로 유지, media는 셋 다 걸릴 때 가장 낮은 우선순위).
        from app.services.publication_command import void_pending_commands_for_gate
        reason_code = (
            "CONTENT_CHANGED" if content_changed
            else "SCHEDULE_CHANGED" if schedule_changed
            else "MEDIA_CHANGED"
        )
        await void_pending_commands_for_gate(db, gate_id=gate.id, reason_code=reason_code)

    await db.commit()
    await db.refresh(gate)
    return gate, target.id


# ─── story #f8f7cb0f(Phase1·마케팅운영) — 서버 Threads 발행 실행 ───────────────────────
# UTM 조립(link_url이 있으면 본문 끝에 태그된 링크를 덧붙인다)은 publish_channel_post_
# draft() 안에서 draft.channel(어댑터 조회 축)을 안 상태로 직접 한다 — 원본 latest.text/
# latest.link_url은 절대 바꾸지 않는다(봉인 해시가 이미 그 원본 쌍으로 계산돼 있다, #3374).
# UTM은 발행 시점에만 조립되는 배달 계층 부가물이지 승인 대상 내용이 아니다.

# story 5b27b32f(페드루 리뷰 N1) — Threads 429 응답 자체엔 reset 시각이 실려오지 않는다
# (Meta 문서에 Retry-After류 필드 없음, 그라운딩 §③) — provider가 알려주지 않을 때 쓰는
# 기본 유예값. 60초는 임의값이 아니라 story #3414 백오프 최소 단위(_BACKOFF_BASE_SECONDS,
# publication_command.py)와 맞춘 것 — 이보다 짧으면 재시도가 백오프보다 먼저 도래해
# 의미가 없다.
_RATE_LIMIT_DEFAULT_RESET_SECONDS = 60


def _classify_threads_error(
    exc: "ThreadsPublishError", *, connection_id: uuid.UUID,
) -> tuple[str, Exception]:
    """provider 실패를 안정 코드+예외로 분류. 401/403은 토큰 만료(재인증 유도), 429는
    한도 초과(그라운딩 §③), 그 외는 미분류 provider 오류(502) — 담롱 요구 "«막혔다»와
    «막는 장치를 쟀다»는 다르다" 그대로.

    story 5b27b32f — 429 분기는 이 스토리에서 처음 추가(샌드박스 [sandbox:429] 마커가
    create_container 단계에서 429를 내는 걸 정확히 분류하려고 필요해졌다). 기존
    get_publishing_limit 사전조회가 놓친 경우(예: 조회와 실제 생성 호출 사이 경합)에도
    이 분기가 동작해 Threads 실 provider가 create_container에서 직접 429를 낼 가능성
    까지 함께 커버한다 — sandbox 전용 로직이 아니라 일반 강건성 개선."""
    if exc.status_code in (401, 403):
        return "CHANNEL_TOKEN_EXPIRED", ChannelTokenExpiredError(
            connection_id=connection_id, provider_message=exc.message,
        )
    if exc.status_code == 429:
        return "CHANNEL_RATE_LIMITED", ChannelRateLimitedError(
            reset_at=datetime.now(timezone.utc) + timedelta(seconds=_RATE_LIMIT_DEFAULT_RESET_SECONDS),
        )
    return "CHANNEL_PUBLISH_PROVIDER_ERROR", ChannelPublishProviderError(
        provider_code=exc.code, provider_message=exc.message,
    )


async def resolve_command_target(
    db: AsyncSession, *, org_id: uuid.UUID, draft_id: uuid.UUID,
) -> tuple[ChannelPostDraft, ChannelPostVersion, Gate]:
    """story #3414 — `publication_command` 키 조립에 필요한 (draft, latest_version, gate)
    조회 전용. **`publish_channel_post_draft()`의 재검증(봉인 일치·connection 활성)을
    재구현하지 않는다** — 그 함수가 실제 발행(즉시든 워커든) 시점에 이미 한다. 여기선
    "게이트가 이 work_item에 존재하고 approved인지"만 본다(근거 없는 command 생성을
    막는 최소선)."""
    draft = await get_channel_post_draft(db, org_id=org_id, draft_id=draft_id)
    if draft is None:
        raise ChannelPostDraftNotFoundError(draft_id)

    from app.services.gate_service import find_gate_slot_with_pr_fallback

    gate = await find_gate_slot_with_pr_fallback(
        db, org_id=org_id, work_item_id=draft.work_item_id, work_item_type="story",
        gate_type=_EXTERNAL_PUBLISH_GATE_TYPE, pr_number=None, repo_full_name=None,
        scope_key=str(draft.connection_id),
    )
    if gate is None or gate.status != "approved":
        raise ExternalPublishGateNotApprovedError(
            gate_id=gate.id if gate is not None else None,
            status=gate.status if gate is not None else None,
        )
    versions = await list_channel_post_draft_versions(db, draft_id=draft_id)
    if not versions:
        raise ChannelPostDraftNotFoundError(draft_id)
    return draft, versions[-1], gate


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
        scope_key=str(draft.connection_id),
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

    # story 620beefc(AC5) — 이 버전에 이미지가 붙어 있으면 IMAGE 컨테이너 경로(비동기),
    # 아니면 기존 TEXT 경로(동기, 완전 무변경). 이미지 유무는 channel_post_images 행
    # (버전당 1건, Phase1)의 존재로 판단 — latest.image_sha256만으로는 「나가는 파생본」
    # 경로를 못 구하므로 행 자체를 조회한다.
    image_public_url: str | None = None
    if latest.image_sha256 is not None:
        from app.models.channel_post_image import ChannelPostImage
        from app.services.channel_post_images import public_url_for_object_path

        image_row = (await db.execute(
            select(ChannelPostImage).where(ChannelPostImage.version_id == latest.id)
        )).scalar_one_or_none()
        if image_row is not None:
            image_public_url = public_url_for_object_path(image_row.final_object_path)
    has_image = image_public_url is not None

    # 발행 직전 재검증③(연결 활성) — 초안 생성/상신과 같은 헬퍼.
    connection = await _get_active_connection(db, org_id=org_id, connection_id=draft.connection_id)
    access_token = decrypt_for_use(connection)
    if access_token is None:
        raise ChannelConnectionNotActiveError(connection_id=connection.id)

    import httpx
    from app.services.channel_adapters import get_publish_client_module
    from app.services.channel_connection import apply_refresh_failure
    from app.services.threads_publish import ThreadsPublishError

    # story 5b27b32f — sandbox 채널이면 threads_publish 대신 sandbox_publish(같은
    # 함수 시그니처)로 우회. 이 한 줄이 sandbox 개입의 유일한 지점 — 아래 로직은 어느
    # 쪽이 골렸는지 모른다.
    _publish_client = get_publish_client_module(draft.channel)
    create_container = _publish_client.create_container
    get_container_status = _publish_client.get_container_status
    get_permalink = _publish_client.get_permalink
    get_publishing_limit = _publish_client.get_publishing_limit
    publish_container = _publish_client.publish_container

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

            just_created_container = row.external_container_id is None
            if just_created_container:
                try:
                    container_id = await create_container(
                        client, access_token=access_token, threads_user_id=connection.account_id,
                        text=text_to_post, image_url=image_public_url,
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
                if has_image:
                    # story 620beefc(AC5, PO 決定) — IMAGE 컨테이너는 비동기(그라운딩
                    # §② Meta 권장 "평균 30초 대기"). 막 만든 컨테이너를 이 자리에서
                    # 곧바로 poll하지 않는다 — container_created 그대로 반환, 호출부
                    # (cron 워커·즉시발행 라우터 둘 다)가 command를 pending(next_
                    # attempt_at=+30s)으로 남기면 다음 tick이 이어 폴링한다(새 큐 X,
                    # 기존 워커 재사용).
                    return row

            if has_image:
                # story 620beefc(AC5) — 재진입(다음 tick)마다 컨테이너 상태를 먼저
                # 확인한다. FINISHED여야만 publish 호출로 진행 — Meta 문서: 완료 前
                # publish는 실패한다.
                try:
                    container_status, container_error_message = await get_container_status(
                        client, access_token=access_token, creation_id=row.external_container_id,
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
                if container_status == "IN_PROGRESS":
                    # story 620beefc(페드루 리뷰 블로커 B3) — Meta 문서(그라운딩 §②):
                    # 컨테이너 폴링은 "최대 5분"까지만 의미가 있다. 이 상한이 없으면
                    # command가 attempt_count·backoff 어느 것도 안 건드리는 "처리 中"
                    # 분기(pending, +30초)로만 계속 재큐잉돼 진짜 무한루프가 된다(워커가
                    # 절대 dead_letter로 못 빠짐). row.created_at은 이 행이 재사용될 뿐
                    # 재생성 안 되므로 "최초 컨테이너 생성 시각"의 신뢰할 수 있는 근사치.
                    elapsed = datetime.now(timezone.utc) - row.created_at
                    if elapsed > timedelta(minutes=5):
                        row.status = "failed"
                        row.error_code = "CHANNEL_IMAGE_CONTAINER_FAILED"
                        row.last_error = f"IN_PROGRESS {elapsed.total_seconds():.0f}s > 5분 상한(그라운딩 §②)"
                        row.external_container_id = None
                        await db.commit()
                        raise ChannelImageContainerFailedError(
                            gate_id=gate.id, container_status="TIMEOUT", error_message=row.last_error,
                        )
                    return row  # 아직 처리 中(5분 이내) — 다음 tick이 다시 폴링.
                if container_status in ("ERROR", "EXPIRED"):
                    row.status = "failed"
                    row.error_code = "CHANNEL_IMAGE_CONTAINER_FAILED"
                    row.last_error = container_error_message or f"container status={container_status}"
                    # story 620beefc(페드루 리뷰 블로커 B2) — 지우지 않으면 사람이 AC5
                    # retry 엔드포인트로 재시도해도 이 죽은 creation_id를 그대로 다시
                    # poll한다(Threads의 ERROR/EXPIRED 컨테이너는 재활성화되지 않는다 —
                    # 영구 실패 루프). None으로 되돌려 다음 호출이 just_created_container
                    # 분기를 다시 타 완전히 새 컨테이너를 만들게 한다.
                    row.external_container_id = None
                    await db.commit()
                    raise ChannelImageContainerFailedError(
                        gate_id=gate.id, container_status=container_status, error_message=container_error_message,
                    )
                # FINISHED(관측되면 PUBLISHED도 안전하게 통과) — 아래로 진행.

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


# ─── story #3419(Phase1·마케팅운영) — 발행 취소(예약 명령 취소·발행분 회수) ─────────────────
# 둘 다 draft의 gate를 gate.status와 무관하게 조회한다(publish_channel_post_draft의
# "승인 상태 재검증"과 다른 축 — 취소·회수는 "지금 그 게이트가 승인 상태인가"가 아니라
# "이 gate에 걸린 command/publication이 그 자체로 끝낼 수 있는 상태인가"만 본다. 예:
# 승인 뒤 편집으로 게이트가 다시 pending으로 돌아가도, 그 전에 만들어진 blocked/dead_letter
# command는 여전히 사람이 명시 취소할 대상이다).

_CANCELLABLE_COMMAND_STATUSES = frozenset({"pending", "blocked", "dead_letter"})


async def _resolve_gate_for_draft(db: AsyncSession, *, org_id: uuid.UUID, draft_id: uuid.UUID) -> tuple[ChannelPostDraft, Gate]:
    draft = await get_channel_post_draft(db, org_id=org_id, draft_id=draft_id)
    if draft is None:
        raise ChannelPostDraftNotFoundError(draft_id)

    from app.services.gate_service import find_gate_slot_with_pr_fallback

    gate = await find_gate_slot_with_pr_fallback(
        db, org_id=org_id, work_item_id=draft.work_item_id, work_item_type="story",
        gate_type=_EXTERNAL_PUBLISH_GATE_TYPE, pr_number=None, repo_full_name=None,
        scope_key=str(draft.connection_id),
    )
    if gate is None:
        raise ChannelPostGateNotFoundError(draft_id)
    return draft, gate


async def cancel_scheduled_publication(
    db: AsyncSession, *, org_id: uuid.UUID, draft_id: uuid.UUID, cancelled_by_member_id: uuid.UUID,
) -> PublicationCommand:
    """story #3419 AC1·PO 確定 ①-a — 이 gate의 **가장 최근** publication_command가
    pending·blocked·dead_letter 중 하나면 `cancelled`(reason_code=CANCELLED_BY_HUMAN)로
    전이한다. 그 외 상태(in_progress·completed·voided·이미 cancelled)는
    PublicationCommandNotCancellableError(라우터가 409).

    cron(`process_due_publication_commands`)의 클레임 WHERE절은 `status='pending'`만
    본다 — cancelled로 바뀌기만 하면 새 배제 로직 없이 구조적으로 다시 안 집힌다(voided·
    dead_letter·blocked와 동일 원리, story #3414 그라운딩)."""
    draft, gate = await _resolve_gate_for_draft(db, org_id=org_id, draft_id=draft_id)

    command = (await db.execute(
        select(PublicationCommand)
        .where(PublicationCommand.gate_id == gate.id)
        .order_by(PublicationCommand.created_at.desc())
        .limit(1)
        .with_for_update()
    )).scalar_one_or_none()
    if command is None:
        raise PublicationCommandNotFoundError(draft_id)
    if command.status not in _CANCELLABLE_COMMAND_STATUSES:
        raise PublicationCommandNotCancellableError(command_id=command.id, current_status=command.status)

    command.status = "cancelled"
    command.reason_code = "CANCELLED_BY_HUMAN"
    await db.commit()
    await db.refresh(command)

    from app.services.activity_log import ActivityLogService

    await ActivityLogService(db).record(
        org_id=org_id, action="publication_command_cancelled", actor_type="platform", actor_id=None,
        entity_type="publication_command", entity_id=command.id,
        context={
            "gate_id": str(gate.id), "draft_id": str(draft_id),
            "cancelled_by_member_id": str(cancelled_by_member_id),
        },
    )
    await db.commit()
    return command


async def unpublish_channel_post(
    db: AsyncSession, *, org_id: uuid.UUID, draft_id: uuid.UUID, unpublished_by_member_id: uuid.UUID,
) -> ChannelPublication:
    """story #3419 AC2·PO 確定 ②-a — 이 gate의 **가장 최근 status='published'**
    channel_publications 행을 Threads 공식 삭제 API로 회수하고 `unpublished`로 전이한다
    (external_id·permalink는 건드리지 않는다 — "보존", `_to_draft_list_item`의
    published_pub_by_gate가 status='published'만 걸러서 그 뒤로는 목록에서 자연히
    "지금 살아 있는 것"이 아니게 된다, 신규 필터링 코드 불요).

    가드 순서(전부 Threads 호출 前): ①gate 존재 ②published 행 존재 ③어댑터
    supports_unpublish ④연결 활성 ⑤연결 스코프에 필요 스코프 포함. 어느 하나라도
    실패하면 Threads 호출 0건(fail-closed, publish 경로의 "재검증 뒤 호출" 규율과
    동형)."""
    draft, gate = await _resolve_gate_for_draft(db, org_id=org_id, draft_id=draft_id)

    pub = (await db.execute(
        select(ChannelPublication)
        .where(ChannelPublication.gate_id == gate.id, ChannelPublication.status == "published")
        .order_by(ChannelPublication.published_at.desc())
        .limit(1)
        .with_for_update()
    )).scalar_one_or_none()
    if pub is None:
        raise ChannelPostNotPublishedError(draft_id)

    adapter = get_channel_adapter(draft.channel)
    if adapter is None or not adapter.supports_unpublish:
        raise ChannelUnpublishUnsupportedError(channel=draft.channel)

    connection = await _get_active_connection(db, org_id=org_id, connection_id=draft.connection_id)
    if adapter.unpublish_required_scope and adapter.unpublish_required_scope not in (connection.scopes or []):
        raise ChannelScopeInsufficientError(required_scopes=[adapter.unpublish_required_scope])

    access_token = decrypt_for_use(connection)
    if access_token is None:
        raise ChannelConnectionNotActiveError(connection_id=connection.id)

    if pub.external_id is None:
        # 이론상 status='published'면 항상 채워져 있다(publish_channel_post_draft가 media
        # id 확보 뒤에만 published로 전이) — 그래도 발행 provider 호출은 정직한 실패로
        # 낸다(external_id 없이 삭제 호출을 시도하면 무의미한 요청이 나간다).
        raise ChannelPublishProviderError(
            provider_code="MISSING_EXTERNAL_ID", provider_message="published 행에 external_id가 없습니다",
        )

    import httpx
    from app.services.channel_adapters import get_publish_client_module
    from app.services.threads_publish import ThreadsPublishError

    # story 5b27b32f — publish 경로와 동일 디스패치(pub.channel 기준).
    delete_media = get_publish_client_module(pub.channel).delete_media

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            try:
                await delete_media(client, access_token=access_token, media_id=pub.external_id)
            except ThreadsPublishError as exc:
                _, mapped_exc = _classify_threads_error(exc, connection_id=connection.id)
                raise mapped_exc from exc
    finally:
        del access_token  # ⛔즉시 소비 후 폐기 — 기존 관례와 동일.

    pub.status = "unpublished"
    await db.commit()
    await db.refresh(pub)

    from app.services.activity_log import ActivityLogService

    await ActivityLogService(db).record(
        org_id=org_id, action="channel_post_unpublished", actor_type="platform", actor_id=None,
        entity_type="channel_publication", entity_id=pub.id,
        context={
            "gate_id": str(gate.id), "external_id": pub.external_id,
            "unpublished_by_member_id": str(unpublished_by_member_id),
        },
    )
    await db.commit()
    return pub
