"""story #3786(3779 3층 ①, 페드루 PO 判 2026-09-10 10:00Z) — BE 사용자 문장 공용 카탈로그.

story #3778의 `retro_export_i18n.py`(회고 내보내기 전용 미니 카탈로그)와 같은 형(dict 카탈로그 +
`resolve_locale`)을 **범용 모듈로 승격**한 것 — 새 기전 발명 금지, 이 위에 얹는다. 로케일
해석 자체는 재구현하지 않는다: E-I18N Phase C(story 11f1087c) `resolve_locale`/
`resolve_locale_from_request`(`app/services/agent_onboarding_config.py`)를 그대로 재사용한다.

## 사용 패턴 — Header DI는 라우트 경계에서만(까심 QA CI FAILURE 2026-07-08 원칙, `agents.py`
`get_agent_connection_artifact`/`_connection_artifact` 선례 그대로)
`Header()` DI 마커는 FastAPI ASGI 파이프라인을 통해서만 plain str/None으로 풀린다 — realdb/유닛
테스트처럼 라우터 함수를 **직접 호출**하면 `Header` 객체가 그대로 남아 크래시한다(HTTP 경로만
타는 QA로는 안 잡히는 클래스, 이 레포에서 이미 한 번 실사고). 그래서:
  - `@router.xxx` 데코레이터가 붙은 라우트 함수만 `locale: str | None = None` +
    `accept_language: str | None = Header(None, alias="Accept-Language")`를 받고,
    `resolve_locale_from_request(locale, accept_language)`로 즉시 풀어 plain str로 만든다.
  - 그 plain str만 서비스/헬퍼 함수로 내려보낸다(`Header()` 마커가 라우트 경계를 못 넘는다).

## 가드 2종(카드 明示)
  - 가드 1: ko/en 키 집합이 어긋나면(한쪽만 채워진 키) 테스트 RED — `test_3786_i18n_catalog.py`
    참조. 죽은 키(story #3765류) 재발 예방.
  - 가드 2: 카탈로그에 없는 키로 `t()`를 부르면 조용한 폴백 없이 즉시 예외 — 오타 키가
    "그냥 en으로 보인다"처럼 조용히 넘어가는 것을 막는다.
"""
from __future__ import annotations

from app.services.agent_onboarding_config import SUPPORTED_LOCALES, resolve_locale

__all__ = ["MessageCatalog", "UnknownMessageKeyError", "t"]


class UnknownMessageKeyError(KeyError):
    """카탈로그에 없는 key로 t()를 호출했다 — 가드 2. 조용한 폴백 대신 즉시 예외."""


# key → {locale: template}. `.format(**params)`로 렌더 — 지금 슬라이스 1의 모든 문자열은
# 파라미터가 없는 plain literal이라 params 없이도 그대로 반환된다(향후 슬라이스가 f-string
# 동적 값이 섞인 문장을 옮길 때 이 메커니즘을 그대로 재사용).
## en 문장 = 유나 定(2026-09-10, 카드 코멘트 착지) — 이 레포 404/409/422 detail 관례
## (`<Noun> not found`·`<Noun> already exists`·거절 문장형) 실측 대조 근거로 확定됨.
_CATALOG: dict[str, dict[str, str]] = {
    # story #3786 슬라이스 1 — dependencies.py(8건, 고유 키 5개: "의존성을 찾을 수 없음"이
    # 4개 호출부에서 재사용됨).
    "dependencies.item_not_found": {
        "ko": "의존성 대상 아이템을 찾을 수 없음",
        # 새로 짓지 않고 이 레포에 이미 4회 있는 문자열을 재사용(유나 定) — 이 게이트가
        # create/list/update/delete/graph 공유 자리라 목적어를 좁히지 않는 편이 정확하다.
        "en": "Item not found",
    },
    "dependencies.self_reference_not_allowed": {
        "ko": "자기참조 의존성은 허용되지 않음",
        # 집안 `Cannot link a story to itself`와 같은 결(422 거절 문장형, 유나 定).
        "en": "An item cannot depend on itself",
    },
    "dependencies.already_exists": {
        "ko": "이미 존재하는 의존성",
        "en": "Dependency already exists",
    },
    "dependencies.cycle_not_allowed": {
        "ko": "사이클이 발생하는 의존성은 허용되지 않음",
        "en": "This dependency would create a cycle",
    },
    "dependencies.not_found": {
        "ko": "의존성을 찾을 수 없음",
        "en": "Dependency not found",
    },
    # story #3793(3779 3층 ②) — gates.py http_detail 20건. en = 유나 定(2026-09-10, 카드
    # 코멘트 착지) — 이 레포 라우터 en detail 768건 실측 관례(마침표 0%·문장 첫 글자
    # 대문자·"X — Y" em-dash 안내형·집안 어순 "admin/owner") 근거로 확定됨. 마지막 두 건
    # (toss_unsupported_gate_type/toss_requester_or_designated_only)은 「토스」를 그대로
    # 옮기지 않는다 — 화면 어디에도 그 낱말이 없고(`chats.approvalRequestTossTrigger` 등의
    # 표시 문구는 ko/en 둘 다 「다른 방에 보내기/Send to another room」) 유나가 그 은유
    # 누출을 지적했다(ko 원문 두 건의 「토스」 자체는 이 카드 범위 밖 — 별건으로 남김).
    "gates.create_doc_gate_not_allowed": {
        "ko": "doc 결재 게이트는 doc 상신 경로로만 생성됩니다 (직접 생성 불가).",
        "en": "Doc approval gates are created only through the doc submission flow — direct creation is not allowed",
    },
    "gates.approve_human_only": {
        "ko": "게이트 승인/거부는 휴먼 멤버만 가능합니다 (에이전트 승인 불가).",
        "en": "Only human members can approve or reject a gate — agents cannot approve",
    },
    "gates.approve_self_not_allowed": {
        "ko": "본인이 상신한 doc 결재는 본인이 승인/거부할 수 없습니다 (self-approval 금지·상신자 미검증 차단).",
        "en": "You cannot approve or reject a doc approval you submitted — self-approval is not allowed",
    },
    "gates.approve_no_doc_access": {
        "ko": "doc 결재 권한이 없습니다 (대상 프로젝트 접근 필요).",
        "en": "No permission to act on this doc approval — access to the target project is required",
    },
    "gates.approve_no_project_admin_access": {
        "ko": "이 게이트를 승인/거부할 권한이 없습니다 (해당 프로젝트의 owner/admin이어야 합니다). 프로젝트 관리자에게 권한을 요청하세요.",
        "en": "No permission to approve or reject this gate — project owner/admin required; ask a project admin for access",
    },
    "gates.transition_high_risk_note_required": {
        "ko": "고위험(risk_grade=high) 게이트 승인은 사유(note) 입력이 필수입니다.",
        "en": "Approving a high-risk gate (risk_grade=high) requires a note",
    },
    "gates.transition_high_risk_evidence_required": {
        "ko": "고위험(risk_grade=high) 게이트 승인은 근거 열람 확인(evidence_viewed=true)이 필수입니다.",
        "en": "Approving a high-risk gate (risk_grade=high) requires confirming you reviewed the evidence (evidence_viewed=true)",
    },
    "gates.reevaluate_merge_only": {
        "ko": "merge 게이트만 재평가를 지원합니다.",
        "en": "Only merge gates support re-evaluation",
    },
    "gates.reevaluate_no_pr_info": {
        "ko": "게이트에 연결된 PR 정보가 없어 재평가할 수 없습니다.",
        "en": "Cannot re-evaluate — this gate has no linked PR",
    },
    "gates.reevaluate_no_github_app": {
        "ko": "GitHub App 설치가 없어 재평가할 수 없습니다.",
        "en": "Cannot re-evaluate — no GitHub App installation",
    },
    "gates.reevaluate_token_fetch_failed": {
        "ko": "GitHub 인증 토큰 발급 실패 — 잠시 후 다시 시도해 주세요.",
        "en": "GitHub auth token request failed — please try again shortly",
    },
    "gates.reevaluate_pr_fetch_failed": {
        "ko": "GitHub PR 정보 조회 실패 — 잠시 후 다시 시도해 주세요.",
        "en": "GitHub PR lookup failed — please try again shortly",
    },
    "gates.reevaluate_head_sha_unavailable": {
        "ko": "GitHub PR head SHA를 확인할 수 없습니다.",
        "en": "Couldn't determine the GitHub PR head SHA",
    },
    "gates.void_owner_admin_only": {
        "ko": "게이트 무효화는 org owner/admin 만 가능합니다.",
        "en": "Voiding a gate requires org admin/owner",
    },
    "gates.require_admin_generic": {
        "ko": "이 액션은 org owner/admin 만 가능합니다.",
        "en": "This action requires org admin/owner",
    },
    "gates.delegate_designated_only": {
        "ko": "지정 결재자 본인만 위임할 수 있습니다.",
        "en": "Only the designated approver can delegate",
    },
    "gates.delegate_self_not_allowed": {
        "ko": "본인에게 위임할 수 없습니다.",
        "en": "You cannot delegate to yourself",
    },
    "gates.toss_unsupported_gate_type": {
        # 페드루 PO 전달 유나 定(2026-09-10 13:08Z) — ko도 「토스」 은유를 걷어 화면 낱말
        # 「다른 방에도 보내기」로 정렬(별건 승인, 이 카드에 동봉). 「게이트 유형」도 화면
        # 낱말 「결재」로.
        "ko": "이 결재는 다른 방에 보낼 수 없습니다.",
        # 유나 정정(2026-09-10 13:50Z, 페드루 전달) — 시트 en이 "this approval"이라
        # ko와 같은 화면·같은 낱말("gate type"이 아니라 "approval")로 맞춘다.
        "en": "This approval can't be sent to another room",
    },
    "gates.toss_requester_or_designated_only": {
        "ko": "상신자 또는 지정 결재자 본인만 다른 방에 보낼 수 있습니다.",
        "en": "Only the submitter or the designated approver can send this approval to another room",
    },
    # story #3793 후속(페드루 전달 유나 定, 2026-09-10 13:57Z) — 원래 http_detail 20건
    # 밖(이미 code 붙어 있어 스캐너가 안 잡음, 카드 코멘트 표 주석 참고)이었으나, toss
    # 어휘 정렬 김에 이 둘도 같은 PR에서 카탈로그로 이관.
    "gates.toss_no_designated_approver": {
        "ko": "지정 결재자가 없는 결재는 다른 방에 보낼 수 없습니다.",
        "en": "An approval with no designated approver can't be sent to another room.",
    },
    # 페드루 判(2026-09-10 13:57Z, "선택·미르코 판단") — 같은 toss 자리·같은 어휘 정렬
    # 이유라 같이 이관. FE는 code로 갈아끼우지만 API 직접 소비자(에이전트 등)에겐
    # message 원문이 그대로 노출된다.
    "gates.toss_gate_already_resolved": {
        "ko": "이미 처리된 결재는 다른 방에 보낼 수 없습니다.",
        "en": "An approval that's already been decided can't be sent to another room.",
    },
    "gates.require_owner_generic": {
        "ko": "이 액션은 org owner 만 가능합니다.",
        "en": "This action requires org owner",
    },
    # story #3796(페드루 PO 確定 2026-09-10 — 2차 CHANGES 2026-09-11, 3779 가드 발견) —
    # 애초에 미존재·타 org 소유 둘 다 이 문구로 404(존재 자체 비노출, 응답 완전 동일
    # — insight_snapshots.py 라우터 docstring 참조).
    "insight_snapshots.publication_not_found_in_org": {
        "ko": "이 조직에 없는 발행물입니다",
        "en": "Publication not found in this organization",
    },
}


def t(key: str, locale: str, **params: object) -> str:
    """카탈로그 조회 + 렌더. `locale`은 이미 resolve_locale_from_request()를 거친 plain str이어야
    한다(이 함수 자신은 로케일을 재해석하지 않음 — 이중 해석 금지, SSOT는 Phase C 쪽 하나)."""
    entry = _CATALOG.get(key)
    if entry is None:
        # 개발자 대상 내부 에러(사용자 비노출) — 영문 고정: 1층 가드(verify_no_new_korean_
        # user_strings.py)가 app/ 전체를 한글 리터럴로 스캔하므로, 이 모듈 자신의 진단
        # 메시지에 한글을 쓰면 그 가드에 스스로 걸린다(2026-09-10 실측으로 발견).
        raise UnknownMessageKeyError(
            f"i18n_catalog: unregistered key {key!r} — register both ko/en in _CATALOG first."
        )
    resolved_locale = resolve_locale(locale)
    template = entry.get(resolved_locale, entry[resolved_locale])  # KeyError면 가드1 위반 신호
    return template.format(**params) if params else template


class MessageCatalog:
    """테스트 전용 접근자 — `_CATALOG`를 직접 import하지 않고 가드 테스트가 이 클래스를 통해서만
    검사하게 해, 카탈로그 내부 구조가 바뀌어도 가드 테스트 파일이 안 흔들리게 한다."""

    @staticmethod
    def keys() -> frozenset[str]:
        return frozenset(_CATALOG.keys())

    @staticmethod
    def locales_for(key: str) -> frozenset[str]:
        return frozenset(_CATALOG[key].keys())

    @staticmethod
    def all_entries() -> dict[str, dict[str, str]]:
        return {k: dict(v) for k, v in _CATALOG.items()}


assert set(SUPPORTED_LOCALES) == {"ko", "en"}, (
    "i18n_catalog assumes SUPPORTED_LOCALES is exactly {ko,en} — if Phase C ever adds a "
    "locale, this module's guard-1 logic must be updated too (would silently drift otherwise)."
)
