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
    # story #3806(Phase3·3-2 PR1, 페드루 PO 確定 2026-09-11) — Meta Ads 광고 계정
    # 연결. channel_connections.py는 이 스토리 前엔 i18n_catalog을 안 쓰던 파일(기존
    # 문구는 story #3779 baseline에 grandfather) — 새로 추가하는 4개만 카탈로그로
    # (freeze 가드가 신규 0건을 요구, 파일 전체 이관은 이 PR 범위 밖).
    "channel_connections.meta_ads_no_accounts_available": {
        "ko": "연결할 수 있는 광고 계정이 없습니다 — 이 계정이 접근 가능한 Meta 광고 계정이 없거나, "
              "광고 계정 권한을 허용하지 않았습니다.",
        "en": "No ad accounts available to connect — this account has no accessible Meta ad accounts, "
              "or ad account permissions were not granted.",
    },
    "channel_connections.pending_selection_forbidden_ads": {
        "ko": "이 선택 대기 상태를 시작한 사람만 광고 계정을 고를 수 있습니다.",
        "en": "Only the person who started this pending selection can choose an ad account.",
    },
    "channel_connections.pending_selection_invalid_account": {
        "ko": "선택한 광고 계정이 이 선택 대기 상태의 후보 목록에 없습니다.",
        "en": "The selected ad account is not in this pending selection's candidate list.",
    },
    "ads_sandbox.review_rejected": {
        "ko": "이 앱 자격의 ads_management 권한 심사가 거부됐습니다 — Meta 앱 검수를 다시 신청해주세요.",
        "en": "This app credential's ads_management permission review was rejected — please reapply for Meta App Review.",
    },
    # story #3369(BE, 페드루 PO 確定 2026-09-11) — events.py::_render_gate_verdict_
    # message의 external_publish 승인 「다음 행동」 2갈래(site_post 발행 명령 자동 생성
    # vs 휴먼 화면 발행). BE 한글 사용자 문장 가드 baseline에서 이 2줄을 걷고 카탈로그로
    # 이관(#3796/#3614와 같은 형).
    "events.gate_verdict_next_action_publish_command_created": {
        "ko": "다음 행동: 없음 — 승인으로 발행 명령이 만들어졌고 다음 워커 tick(최대 1분)에 발행됩니다. 결과는 원문 상세 «발행 결과» 줄에서 확認합니다.",
        "en": "Next action: none — approval created the publish command, and it will publish on the next worker tick (within 1 minute). Check the result in the \"Publish result\" line on the source detail page.",
    },
    "events.gate_verdict_next_action_publish_human_only": {
        "ko": "다음 행동: 할 일 없음 — 발행은 휴먼이 화면에서 합니다.",
        "en": "Next action: nothing to do — a human publishes this from the screen.",
    },
    # story #3614 갭(BE, 페드루 PO 確定 2026-09-11) — 폐기(withdrawn, 종결)된 초안
    # submit 거부(409). 새 한글 사용자 문장이라 3796(insight_snapshots.py)과 같은
    # 형으로 처음부터 카탈로그에 등재(BE 한글 사용자 문장 가드 신규 위반 대응).
    "channel_posts.draft_withdrawn": {
        "ko": "폐기된 초안은 다시 상신할 수 없습니다 — 새 초안을 만드세요.",
        "en": "A discarded draft can't be resubmitted — create a new draft.",
    },
    # story #3805 CI 정정(2026-09-11, 카디르 실측·페드루 전달) — engagement_items.py
    # PATCH 3자리(휴먼 전용 403·404·422)의 신규 한글 사용자 문장. 처음부터 카탈로그로
    # 등재(#3796/#3614·events.py와 같은 형).
    "engagement_items.patch_human_only": {
        "ko": "반응 항목의 배정·상태 변경은 휴먼 멤버만 가능합니다.",
        "en": "Only human members can change engagement item assignment or status",
    },
    "engagement_items.not_found": {
        "ko": "반응 항목을 찾을 수 없습니다",
        "en": "Engagement item not found",
    },
    "engagement_items.invalid_status": {
        "ko": "알 수 없는 처리 상태입니다.",
        "en": "Unknown triage status",
    },
    # story #3806(Phase3·3-2 PR2, 페드루 PO 確定 2026-09-11) — ads_boost 게이트
    # 라우터(app/routers/ads_boost.py)의 5개 사용자 문장. 유나 §절 카드 본문 착지
    # (2026-09-11) — boost의 사람 낱말="홍보"(en Boost), 재승인 409 user_message는
    # 이 레포 다른 재승인류와 동형("예산/기간이 바뀌어 재승인이 필요합니다"류)이나
    # 이 PR엔 재승인 자체가 409를 별도로 내지 않아(201로 그대로 반환·reapproval_
    # required 필드로 신호) 해당 문장은 등재 대상 밖 — 미사용.
    "ads_boost.create_human_only": {
        "ko": "광고 홍보(boost) 요청은 휴먼 멤버만 가능합니다(에이전트는 제안만).",
        "en": "Only human members can request an ads boost (agents may only propose).",
    },
    "ads_boost.invalid_schedule": {
        "ko": "시작 시각은 종료 시각보다 빨라야 합니다.",
        "en": "The start time must be earlier than the end time.",
    },
    "ads_boost.publication_not_found": {
        "ko": "이 조직에 없는 발행물입니다.",
        "en": "Publication not found in this organization.",
    },
    # 페드루 PO 追加 確定(2026-09-11, PR 3 착수 직전 보완) — ad_connection_id 검증
    # 실패(존재 안 함/타 org/채널 불일치/비활성) 전부 이 한 문장으로 뭉뚱그린다
    # (필드별 원인 노출은 채널연결 구조를 캐는 오라클이 된다, ads_boost.py 예외
    # docstring과 동일 판단).
    "ads_boost.invalid_ad_connection": {
        "ko": "지정한 광고 계정 연결을 쓸 수 없습니다 — 이 조직의 활성 Meta 광고 계정 연결인지 확인하세요.",
        "en": "The specified ad account connection can't be used — check that it's an active Meta ads connection in this organization.",
    },
    "ads_boost.approver_role_missing": {
        "ko": "승인할 사람이 지정되지 않았습니다 — 승인자 역할을 먼저 두어주세요.",
        "en": "No one is set up to approve this — please set an approver role first.",
    },
    "ads_boost.budget_exceeds_seal": {
        "ko": "요청 예산이 봉인된 예산({sealed_budget_minor})보다 큽니다 — 증액은 지원하지 않습니다.",
        "en": "The requested budget exceeds the sealed budget ({sealed_budget_minor}) — increasing it is not supported.",
    },
    # story #3806(Phase3·3-2 PR3, 페드루 PO 確定 2026-09-11) — ads_boost 실행·중지·
    # 재개 라우터(app/routers/ads_boost_execution.py)의 사용자 문장. PR 2와 같은
    # 「홍보」(en Boost) 낱말 유지(유나 §절 카드 본문, 2026-09-11 착지).
    "ads_boost.execute_human_only": {
        "ko": "광고 홍보(boost) 실행·중지·재개는 휴먼 멤버만 가능합니다.",
        "en": "Only human members can start, pause, or resume an ads boost.",
    },
    "ads_boost.gate_not_found": {
        "ko": "이 조직에 없는 광고 홍보(boost) 건입니다.",
        "en": "Ads boost not found in this organization.",
    },
    "ads_boost.gate_not_approved": {
        "ko": "아직 승인되지 않은 광고 홍보(boost) 건입니다.",
        "en": "This ads boost hasn't been approved yet.",
    },
    "ads_boost.not_started": {
        "ko": "아직 시작하지 않은 광고 홍보(boost) 건입니다.",
        "en": "This ads boost hasn't been started yet.",
    },
    "ads_boost.already_paused": {
        "ko": "이미 중지된 광고 홍보(boost) 건입니다.",
        "en": "This ads boost is already paused.",
    },
    "ads_boost.not_paused": {
        "ko": "중지 상태가 아닌 광고 홍보(boost) 건입니다.",
        "en": "This ads boost is not paused.",
    },
    "ads_boost.already_running": {
        "ko": "이미 진행 중인 광고 홍보(boost) 건입니다.",
        "en": "This ads boost is already running.",
    },
    # story #3806(Phase3·3-2 PR 12, 페드루 PO 確定 2026-09-11 17:26Z) — 「광고비
    # 다시 수집」 429 rate-limit 문구(comments/refresh와 동형 뜻, 그 파일은 이
    # 가드(#3779) 시행 前 코드라 baseline 잔존 — 여기서 새로 만드는 자리는 처음부터
    # 이 카탈로그를 거친다).
    "ads_boost.spend_refresh_rate_limited": {
        "ko": "{seconds}초 뒤 다시 시도하세요.",
        "en": "Please try again in {seconds} seconds.",
    },
    # story #3813(Phase3·3-4 PR1, 페드루 PO 確定 2026-09-12) — 스티비(Stibee) 연결
    # 생성/자격교체 공용 422 문구. wordpress/webhook 형제(WORDPRESS_FIELDS_REQUIRED·
    # WEBHOOK_FIELDS_REQUIRED)는 이 가드(#3779) 시행 前 baseline 잔존 raw 문자열이라
    # 안 옮기지만, 새 등재는 처음부터 이 카탈로그를 거친다(spend_refresh_rate_limited
    # 키 주석과 동형 판단). 페드루 PO CHANGES(2026-09-12 00:29Z) — 필드명(api_key)이
    # 사람 대상 폼 문구에 그대로 새는 클래스, 자연어 문장으로 정정(합니다체·한자 0).
    "channel_connections.stibee_fields_required": {
        "ko": "스티비 API 키·주소록 ID·발신자 이메일·발신자 이름을 모두 입력해 주세요.",
        "en": "Enter your Stibee API key, address book ID, sender email, and sender name.",
    },
    # story #3813(Phase3·3-4 PR5-a, 페드루 PO 確定 2026-09-12) — 저장 시 auth-check
    # 실호출이 실패(401/403/네트워크)했을 때의 fail-closed 문구. 연결 행 자체를
    # 저장하지 않는다(「가짜 키=초록 Connected」 결함의 처방).
    "channel_connections.stibee_api_key_invalid": {
        "ko": "API 키가 유효하지 않습니다 · 스티비 설정에서 다시 발급해 주세요.",
        "en": "Your API key isn't valid — reissue it from your Stibee settings.",
    },
    # story #3813(Phase3·3-4 PR5-a CHANGES, 페드루 PO 確定 2026-09-12) — 스티비가
    # 안 닿는 것(네트워크·타임아웃·5xx)과 키가 틀린 것(스티비가 응답해서 거절)은
    # 사람이 할 일이 다르다(전자=잠시 뒤 재시도, 후자=키 재발급) — 별도 문구.
    "channel_connections.stibee_auth_check_unavailable": {
        "ko": "스티비에 연결할 수 없습니다 · 잠시 뒤 다시 시도해 주세요.",
        "en": "Couldn't reach Stibee — please try again in a moment.",
    },
    # story #3816(Phase3·3-6 PR1, 페드루 PO 確定 2026-09-12) — Ghost 연결 생성/자격
    # 교체 공용 422 문구. stibee_fields_required와 동형 관례(처음부터 이 카탈로그를
    # 거친다).
    "channel_connections.ghost_fields_required": {
        "ko": "사이트 주소와 Admin API 키를 모두 입력해 주세요.",
        "en": "Enter your site URL and Admin API key.",
    },
    # story #3816(Phase3·3-6 PR1, 페드루 PO §낱말 확定 2026-09-12 10:46Z) — 저장 시
    # site 검증(GET /ghost/api/admin/site/) 실호출이 실패(4xx·형식 오류)했을 때의
    # fail-closed 문구. PO 明示 — 이 문구는 PR2의 발행 시점 GHOST_AUTH_FAILED(JWT
    # 401→재서명 1회→401)와도 같은 낱말을 쓴다("다시 확인" — stibee의 "다시 발급"과
    # 다른 어조, 지어내지 않고 PO 지정 그대로).
    "channel_connections.ghost_admin_key_invalid": {
        "ko": "Admin API 키가 유효하지 않습니다 · Ghost 설정에서 다시 확인해 주세요.",
        "en": "Your Admin API key isn't valid — please double-check it in your Ghost settings.",
    },
    # story #3816(Phase3·3-6 PR1) — Ghost 사이트가 안 닿는 것(네트워크·타임아웃·5xx)과
    # 키가 틀린 것은 사람이 할 일이 다르다 — stibee_auth_check_unavailable 동형.
    "channel_connections.ghost_site_verify_unavailable": {
        "ko": "Ghost 사이트에 연결할 수 없습니다 · 잠시 뒤 다시 시도해 주세요.",
        "en": "Couldn't reach your Ghost site — please try again in a moment.",
    },
    # story #3813(Phase3·3-4 PR2, 페드루 PO 確定 2026-09-12) — 뉴스레터 발송
    # 요청 API 사용자 문구(ads_boost.* 형제와 동형 어조, newsletter_send.py 라우터).
    "newsletter_send.create_human_only": {
        "ko": "뉴스레터 발송 요청은 휴먼 멤버만 가능합니다(에이전트는 초안 작성만).",
        "en": "Only human members can request a newsletter send (agents may only draft).",
    },
    "newsletter_send.publication_not_found": {
        "ko": "이 조직에 없는 발행물입니다.",
        "en": "Publication not found in this organization.",
    },
    "newsletter_send.invalid_channel": {
        "ko": "이 발행물은 뉴스레터 채널이 아닙니다.",
        "en": "This publication is not on a newsletter channel.",
    },
    "newsletter_send.not_published": {
        "ko": "아직 발행(캠페인 생성)이 끝나지 않은 발행물입니다.",
        "en": "This publication hasn't finished being created as a campaign yet.",
    },
    "newsletter_send.approver_role_missing": {
        "ko": "승인할 사람이 지정되지 않았습니다 — 승인자 역할을 먼저 두어주세요.",
        "en": "No one is set up to approve this — please set an approver role first.",
    },
    # story #3813(Phase3·3-4 PR5-b CHANGES, 카디르 실측 2026-09-12 — 가드 #3779
    # FAIL 3건) — command.last_error/예외 메시지가 사람에게 닿는 자리인데 하드코딩
    # 한글 문자열이었다. 코드는 키+파라미터만 넘긴다.
    "newsletter_send.channel_unsupported": {
        "ko": "newsletter_send에 배선되지 않은 채널입니다(channel={channel}).",
        "en": "This channel isn't wired for newsletter_send (channel={channel}).",
    },
    "newsletter_send.connection_unavailable": {
        "ko": "연결·봉인 시각·캠페인 id 중 하나가 없습니다.",
        "en": "One of connection, sealed schedule time, or campaign id is missing.",
    },
    "stibee_publish.connection_incomplete": {
        "ko": "stibee 발행에 필요한 제목·주소록 ID·발신자 정보가 없습니다.",
        "en": "Missing subject, address book ID, or sender info required to publish to Stibee.",
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
