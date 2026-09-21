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

__all__ = ["MessageCatalog", "TIMEZONE_DISPLAY_NAMES", "UnknownMessageKeyError", "t"]


class UnknownMessageKeyError(KeyError):
    """카탈로그에 없는 key로 t()를 호출했다 — 가드 2. 조용한 폴백 대신 즉시 예외."""


# story #3815(배포 83 픽셀 결함, 페드루 PO 지적 2026-09-12 23:50Z) — 채널 어댑터
# `quota_reset_timezone`(youtube/youtube_sandbox 선언값)의 IANA 이름 → 로케일별
# 사람이 읽는 표기. `youtube_quota.py`가 아니라 이 파일에 두는 이유: 이 스캐너
# (verify_no_new_korean_user_strings.py)가 이 파일 하나만 EXEMPT_FILES로 등록돼
# 있다(story #3786 페드루 PO 明示 2026-09-10) — 사용자 문장 리터럴은 전부 여기
# 한 곳에 모여야 그 예외가 성립한다. `channel_posts.youtube_usage_exceeded`가
# `{tz_display}` 자리에 이 값을 그대로 받는다(reset_at 계산과 같은 선언값에서
# 파생 — 두 곳이 각자 짓지 않는다). 선언되지 않은 IANA 이름이 오면 즉시
# KeyError(fail-closed — 지어낸 표기를 내느니 죽는 편이 낫다, insight_metrics류
# "지어내지 않는다" 원칙과 동형).
TIMEZONE_DISPLAY_NAMES: dict[str, dict[str, str]] = {
    "America/Los_Angeles": {"ko": "태평양 시간", "en": "Pacific Time"},
}


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
        "ko": "doc 결재 게이트는 doc 상신 경로로만 생성돼요 (직접 생성 불가).",
        "en": "Doc approval gates are created only through the doc submission flow — direct creation is not allowed",
    },
    "gates.approve_human_only": {
        "ko": "게이트 승인/거부는 휴먼 멤버만 가능해요 (에이전트 승인 불가).",
        "en": "Only human members can approve or reject a gate — agents cannot approve",
    },
    "gates.approve_self_not_allowed": {
        "ko": "본인이 상신한 doc 결재는 본인이 승인/거부할 수 없어요 (self-approval 금지·상신자 미검증 차단).",
        "en": "You cannot approve or reject a doc approval you submitted — self-approval is not allowed",
    },
    # story #4083 — recipe_gate_default_approver_member_id도 merge_gate_default_approver_
    # member_id(hitl_config.py, story #3319)와 같은 불변식(사람 owner/admin, 에이전트 불가)이라
    # 검증 자체는 같은 형으로 짓는다(발명 0). 다만 그 문구는 #3319 당시 grandfather돼
    # baseline에 남아 있고, 이 필드는 새로 만드는 거라 korean_user_strings_baseline.txt에 얹지
    # 않고(#4092 PO 정정 재적용) 이 카탈로그로 바로 옮긴다.
    #
    # ⚠️정정(페드루 PO 리뷰, 2026-09-21, PR #4477) — 최초 문구가 필드명(snake_case)·영문
    # 내부 속성어("human owner/admin"·"requires_human")를 그대로 담아 API 소비자 전용
    # 표현이었다. 이 카탈로그는 «사용자 문장 자리»(파일 docstring)이므로 화면에 그대로
    # 떠도 되는 사람 문장으로 다시 짓는다 — API detail이 곧 화면 문구가 되는 이 레포 관례
    # (story e0c1b24c, HTTPException.detail raw passthrough)상 카탈로그 쪽이 뿌리.
    "gates.recipe_default_approver_invalid_member": {
        "ko": "레시피 게이트 기본 승인자는 이 조직의 소유자 또는 관리자(사람)만 지정할 수 있어요.",
        "en": "The recipe gate default approver must be a human owner or admin of this organization.",
    },
    "gates.approve_no_doc_access": {
        "ko": "doc 결재 권한이 없어요 (대상 프로젝트 접근 필요).",
        "en": "No permission to act on this doc approval — access to the target project is required",
    },
    "gates.approve_no_project_admin_access": {
        "ko": "이 게이트를 승인/거부할 권한이 없어요 (해당 프로젝트의 소유자/관리자여야 해요). 프로젝트 관리자에게 권한을 요청하세요.",
        "en": "No permission to approve or reject this gate — project owner/admin required; ask a project admin for access",
    },
    "gates.transition_high_risk_note_required": {
        "ko": "고위험(risk_grade=high) 게이트 승인은 사유(note) 입력이 필수예요.",
        "en": "Approving a high-risk gate (risk_grade=high) requires a note",
    },
    "gates.transition_high_risk_evidence_required": {
        "ko": "고위험(risk_grade=high) 게이트 승인은 근거 열람 확인(evidence_viewed=true)이 필수예요.",
        "en": "Approving a high-risk gate (risk_grade=high) requires confirming you reviewed the evidence (evidence_viewed=true)",
    },
    "gates.reevaluate_merge_only": {
        "ko": "병합 게이트만 재평가를 지원해요.",
        "en": "Only merge gates support re-evaluation",
    },
    "gates.reevaluate_no_pr_info": {
        "ko": "게이트에 연결된 PR 정보가 없어 재평가할 수 없어요.",
        "en": "Cannot re-evaluate — this gate has no linked PR",
    },
    "gates.reevaluate_no_github_app": {
        "ko": "GitHub App 설치가 없어 재평가할 수 없어요.",
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
        "ko": "GitHub PR head SHA를 확인할 수 없어요.",
        "en": "Couldn't determine the GitHub PR head SHA",
    },
    "gates.void_owner_admin_only": {
        "ko": "게이트 무효화는 조직 소유자/관리자만 가능해요.",
        "en": "Voiding a gate requires org admin/owner",
    },
    "gates.require_admin_generic": {
        "ko": "이 액션은 조직 소유자/관리자만 가능해요.",
        "en": "This action requires org admin/owner",
    },
    "gates.delegate_designated_only": {
        "ko": "지정 결재자 본인만 위임할 수 있어요.",
        "en": "Only the designated approver can delegate",
    },
    "gates.delegate_self_not_allowed": {
        "ko": "본인에게 위임할 수 없어요.",
        "en": "You cannot delegate to yourself",
    },
    "gates.toss_unsupported_gate_type": {
        # 페드루 PO 전달 유나 定(2026-09-10 13:08Z) — ko도 「토스」 은유를 걷어 화면 낱말
        # 「다른 방에도 보내기」로 정렬(별건 승인, 이 카드에 동봉). 「게이트 유형」도 화면
        # 낱말 「결재」로.
        "ko": "이 결재는 다른 방에 보낼 수 없어요.",
        # 유나 정정(2026-09-10 13:50Z, 페드루 전달) — 시트 en이 "this approval"이라
        # ko와 같은 화면·같은 낱말("gate type"이 아니라 "approval")로 맞춘다.
        "en": "This approval can't be sent to another room",
    },
    "gates.toss_requester_or_designated_only": {
        "ko": "상신자 또는 지정 결재자 본인만 다른 방에 보낼 수 있어요.",
        "en": "Only the submitter or the designated approver can send this approval to another room",
    },
    # story #3793 후속(페드루 전달 유나 定, 2026-09-10 13:57Z) — 원래 http_detail 20건
    # 밖(이미 code 붙어 있어 스캐너가 안 잡음, 카드 코멘트 표 주석 참고)이었으나, toss
    # 어휘 정렬 김에 이 둘도 같은 PR에서 카탈로그로 이관.
    "gates.toss_no_designated_approver": {
        "ko": "지정 결재자가 없는 결재는 다른 방에 보낼 수 없어요.",
        "en": "An approval with no designated approver can't be sent to another room.",
    },
    # 페드루 判(2026-09-10 13:57Z, "선택·미르코 판단") — 같은 toss 자리·같은 어휘 정렬
    # 이유라 같이 이관. FE는 code로 갈아끼우지만 API 직접 소비자(에이전트 등)에겐
    # message 원문이 그대로 노출된다.
    "gates.toss_gate_already_resolved": {
        "ko": "이미 처리된 결재는 다른 방에 보낼 수 없어요.",
        "en": "An approval that's already been decided can't be sent to another room.",
    },
    "gates.require_owner_generic": {
        "ko": "이 액션은 조직 소유자만 가능해요.",
        "en": "This action requires org owner",
    },
    # story #3796(페드루 PO 確定 2026-09-10 — 2차 CHANGES 2026-09-11, 3779 가드 발견) —
    # 애초에 미존재·타 org 소유 둘 다 이 문구로 404(존재 자체 비노출, 응답 완전 동일
    # — insight_snapshots.py 라우터 docstring 참조).
    "insight_snapshots.publication_not_found_in_org": {
        "ko": "이 조직에 없는 발행물이에요",
        "en": "Publication not found in this organization",
    },
    # story #3806(Phase3·3-2 PR1, 페드루 PO 確定 2026-09-11) — Meta Ads 광고 계정
    # 연결. channel_connections.py는 이 스토리 前엔 i18n_catalog을 안 쓰던 파일(기존
    # 문구는 story #3779 baseline에 grandfather) — 새로 추가하는 4개만 카탈로그로
    # (freeze 가드가 신규 0건을 요구, 파일 전체 이관은 이 PR 범위 밖).
    "channel_connections.meta_ads_no_accounts_available": {
        "ko": "연결할 수 있는 광고 계정이 없어요 — 이 계정이 접근 가능한 Meta 광고 계정이 없거나, "
              "광고 계정 권한을 허용하지 않았어요.",
        "en": "No ad accounts available to connect — this account has no accessible Meta ad accounts, "
              "or ad account permissions were not granted.",
    },
    "channel_connections.pending_selection_forbidden_ads": {
        "ko": "이 선택 대기 상태를 시작한 사람만 광고 계정을 고를 수 있어요.",
        "en": "Only the person who started this pending selection can choose an ad account.",
    },
    "channel_connections.pending_selection_invalid_account": {
        "ko": "선택한 광고 계정이 이 선택 대기 상태의 후보 목록에 없어요.",
        "en": "The selected ad account is not in this pending selection's candidate list.",
    },
    "ads_sandbox.review_rejected": {
        "ko": "이 앱 자격의 ads_management 권한 심사가 거부됐어요 — Meta 앱 검수를 다시 신청해 주세요.",
        "en": "This app credential's ads_management permission review was rejected — please reapply for Meta App Review.",
    },
    # story #3369(BE, 페드루 PO 確定 2026-09-11) — events.py::_render_gate_verdict_
    # message의 external_publish 승인 「다음 행동」 2갈래(site_post 발행 명령 자동 생성
    # vs 휴먼 화면 발행). BE 한글 사용자 문장 가드 baseline에서 이 2줄을 걷고 카탈로그로
    # 이관(#3796/#3614와 같은 형).
    "events.gate_verdict_next_action_publish_command_created": {
        "ko": "다음 행동: 없음 — 승인으로 발행 명령이 만들어졌고 다음 워커 tick(최대 1분)에 발행돼요. 결과는 원문 상세 «발행 결과» 줄에서 확인해요.",
        "en": "Next action: none — approval created the publish command, and it will publish on the next worker tick (within 1 minute). Check the result in the \"Publish result\" line on the source detail page.",
    },
    "events.gate_verdict_next_action_publish_human_only": {
        "ko": "다음 행동: 할 일 없음 — 발행은 휴먼이 화면에서 해요.",
        "en": "Next action: nothing to do — a human publishes this from the screen.",
    },
    # story #4076(BE, 페드루 PO 確定 2026-09-21) — events.py 레시피 stage 자기설명 렌더러
    # (사이클)·판정 렌더러(_render_gate_verdict_message) 공용. stage_metadata[stage].gate
    # 선언이 어느 발행에 묶이는지에 따라 두 문장으로 갈린다(recipe_gate_hooks.py::
    # maybe_create_stage_gate — routing 직후·메시지 발송 전에 "지금 발행되는 그 stage"의
    # 게이트를 만든다, events.py:1845-1854).
    "events.stage_gate_already_open": {
        "ko": "지금 사람 승인 게이트가 열려 있어요(승인자 역할: {approver}) — 승인 알림"
        "(preset.gate.verdict) 뒤 다음 단계를 발행해 주세요.",
        "en": "A human approval gate is already open (approver role: {approver}) — publish "
        "the next stage after you receive the approval notification (preset.gate.verdict).",
    },
    "events.stage_gate_opens_on_publish": {
        "ko": "이 발행을 하면 사람 승인 게이트가 열려요 — 승인 알림(preset.gate.verdict) "
        "뒤에 그다음 단계를 발행해 주세요.",
        "en": "Publishing this will open a human approval gate — publish the following stage "
        "only after you receive the approval notification (preset.gate.verdict).",
    },
    # story #4090([E-RECIPE-1] Publisher 슬롯) AC3(페드루 PO 確定 2026-09-21) — 다음
    # stage가 채널 자동발행 대상(capability.target=="channel_connection")일 때의
    # 네 갈래 안내(AC2 훅의 실제 gate.publish_outcome을 그대로 반영, 지어내지 않는다).
    "events.gate_verdict_recipe_auto_published": {
        "ko": "다음 행동: 할 일 없음 — 이 승인으로 바인딩된 채널에 이미 자동 발행됐어요.",
        "en": "Next action: nothing — this approval already auto-published to the bound "
        "channel connection.",
    },
    "events.gate_verdict_recipe_auto_publish_scheduled": {
        "ko": "다음 행동: 할 일 없음 — 예약 시각에 자동 발행돼요.",
        "en": "Next action: nothing — this will auto-publish at the scheduled time.",
    },
    "events.gate_verdict_recipe_auto_publish_skipped": {
        "ko": "다음 행동: {reason}",
        "en": "Next action: {reason}",
    },
    "events.gate_verdict_recipe_auto_publish_pending": {
        "ko": "다음 행동: 채널 포스트 초안을 만들어 제출하면 승인이 자동으로 발행까지 이어져요.",
        "en": "Next action: create and submit a channel post draft — approval will auto-publish it.",
    },
    # story #4090 AC3 정정(story #3779 가드, 2026-09-21) — gate.publish_outcome은 닫힌
    # 어휘 코드(no_channel_binding|no_submitted_draft|no_resolver|publish_failed:*)라
    # skipped 안내문의 {reason} 자리에 코드→문구 번역이 필요해졌다(4갈래 세분).
    "events.gate_verdict_recipe_auto_publish_reason_no_channel": {
        "ko": "발행 채널이 아직 지정되지 않았어요 — 레시피 적용 화면에서 발행 채널을 먼저 지정해 주세요.",
        "en": "No publish channel is bound yet — bind one from the recipe apply screen first.",
    },
    "events.gate_verdict_recipe_auto_publish_reason_no_draft": {
        "ko": "제출된 채널 포스트 초안이 없어 발행을 건너뛰었어요 — 채널 포스트 초안을 만들어 제출한 뒤 "
        "다시 승인해 주세요.",
        "en": "No submitted channel post draft — create and submit one, then re-approve.",
    },
    "events.gate_verdict_recipe_auto_publish_reason_no_resolver": {
        "ko": "승인자를 확인할 수 없어 발행을 건너뛰었어요.",
        "en": "Skipped — could not resolve an approver.",
    },
    # story #4090/#4093 정정(페드루 PO 지적 2026-09-21) — "publish_failed:<code>"의
    # code도 닫힌 어휘(connector_error|rate_limited|auth_expired, channel_posts.py::
    # classify_publish_failure_outcome)라 커넥터 원문을 안 싣고 각 코드별로 번역한다.
    "events.gate_verdict_recipe_auto_publish_reason_auth_expired": {
        "ko": "채널 연결이 끊겼거나 만료됐어요 — 조직 설정에서 연결을 갱신한 뒤 다시 승인해 주세요.",
        "en": "The channel connection expired or was revoked — reconnect it, then re-approve.",
    },
    "events.gate_verdict_recipe_auto_publish_reason_rate_limited": {
        "ko": "채널 발행 한도에 걸렸어요 — 잠시 뒤 다시 승인해 주세요.",
        "en": "Hit the channel's rate limit — re-approve again shortly.",
    },
    "events.gate_verdict_recipe_auto_publish_reason_connector_error": {
        "ko": "자동 발행이 실패했어요 — 채널 상태를 확인한 뒤 다시 승인해 주세요.",
        "en": "Auto-publish failed — check the channel, then re-approve.",
    },
    "events.gate_verdict_recipe_auto_publish_reason_unknown_failure": {
        "ko": "자동 발행이 실패했어요 — 다시 승인해 주세요.",
        "en": "Auto-publish failed — re-approve.",
    },
    # story #4076 CI 정정(2026-09-21, 페드루 PO 지적) — 아래 두 키는 원래 events.py에
    # f-string 리터럴로 있었으나(라벨+발행 예시 JSON을 한 문자열로), 사이클 렌더러와
    # verdict 렌더러가 JSON 빌더 헬퍼(`_next_stage_publish_payload_json`)를 공유하도록
    # 리팩터하면서 라벨 부분의 AST 리터럴 경계가 바뀌어 BE 한글 사용자 문장 가드(#3779)가
    # "신규 한글"로 잡았다 — 라벨을 카탈로그로 옮겨 근본 해결(리터럴 경계가 코드 구조를
    # 바꿀 때마다 다시 걸리는 일을 막는다).
    "events.stage_next_publish_example": {
        "ko": "다음 단계로 넘기는 발행 예시: publish_event({example})",
        "en": "Publish example for the next stage: publish_event({example})",
    },
    "events.gate_verdict_next_action_publish_example": {
        "ko": "다음 행동: 이 정의의 다음 stage 이벤트를 발행하세요: publish_event({example})",
        "en": "Next action: publish the next stage event for this definition: "
        "publish_event({example})",
    },
    # story #4085(리허설 1호 실측, PO 확定 2026-09-21) — gate_type={gate_type} 게이트를
    # 여는 stage 발행에 봉인 필드가 빠졌을 때의 422 메시지(recipe_gate_hooks.py::
    # MissingGateSealedFieldError, events.py 라우터가 그대로 옮겨 담는다). 해요체 규칙.
    "events.gate_sealed_field_missing": {
        "ko": "gate_type={gate_type} 게이트를 열려면 다음 필드가 필요해요: {fields}.",
        "en": "Opening a gate_type={gate_type} gate requires the following field(s): {fields}.",
    },
    # story #4092(E-RECIPE-1 팔로우업, PO 확定 2026-09-21) — 사람 역할 stage(role_actor_kinds
    # 선언 human) 발행은 애초 에이전트 바인딩이 없는 게 정상이라 zero_reach 경고 대신 이
    # 중립 안내를 싣는다(MCP 표면은 "[안내] "로 강조, tools/events.py 참조).
    "events.human_stage_zero_reach_notice": {
        "ko": "이 단계는 사람이 판단해요 — 에이전트 바인딩이 필요 없어요.",
        "en": "This stage is handled by a human — no agent binding is needed.",
    },
    # story #4092(§b) — validate_role_actor_kinds(정의 등록/수정 시점 검증)의 거부 사유 3종.
    # 페드루 PO CHANGES(2026-09-21) — 정의 저자에게 닿는 사용자 문장이라 baseline grandfather
    # 대신 이 카탈로그로. 플레이스홀더 뒤 고정 조사 결합(#4086류 결함) 회피 위해 값 자리는
    # 전부 "라벨: 값" 콜론 형태로 — 받침 유무와 무관하게 항상 맞는다.
    "events.role_actor_kinds_not_object": {
        "ko": "role_actor_kinds는 role명과 human/agent 값으로 이루어진 객체여야 해요 — 받은 타입: {type_name}",
        "en": "role_actor_kinds must be an object mapping role names to human/agent — received type: {type_name}",
    },
    "events.role_actor_kinds_value_outside_vocabulary": {
        "ko": "role_actor_kinds[{role}]의 값이 닫힌 어휘(human/agent) 밖이에요 — 받은 값: {kind}",
        "en": "role_actor_kinds[{role}] value is outside the closed vocabulary (human/agent) — received: {kind}",
    },
    "events.role_actor_kinds_role_not_declared": {
        "ko": "role_actor_kinds에 선언한 role명이 stage_metadata 어디에도 없어요(오타로 의심돼요) — "
        "선언한 role: {role} · 실재하는 role: {declared_roles}",
        "en": "The role name declared in role_actor_kinds isn't found anywhere in stage_metadata (likely "
        "a typo) — declared role: {role} · roles present: {declared_roles}",
    },
    # story #4085 AC1 — 자기설명 렌더러가 다음 stage 발행 예시에 봉인 필드(예:
    # estimated_cost_minor)를 실값 예시로 채운 뒤, 그 값이 왜 필요한지 바로 아래 한 줄로
    # 붙이는 설명(recipe_gate_hooks.py::SealedFieldSpec.explanation_catalog_key).
    "events.sealed_field_estimated_cost_minor": {
        "ko": "estimated_cost_minor는 위 예시값이 아니라 실제 예상 비용(정수, 조직 통화의"
        " 최소 단위)으로 바꿔서 채워야 해요 — 이 값이 승인 카드에 예상 비용으로 봉인돼요.",
        "en": "Replace the example above with the actual estimated cost (an integer, in the"
        " organization's minor currency unit) for estimated_cost_minor — this value is sealed"
        " onto the approval card as the estimated cost.",
    },
    # story #4088(E-RECIPE-1, PO 분담조정 2026-09-21 "2/2") — 리허설 1호가 잡은 자기설명
    # 멘션 구멍 3종. 전부 stage_metadata.capability.kind/gate.type 선언에서 유도(하드코딩
    # 0) — _render_event_message_content의 capability/gate 분기가 이 3키를 참조한다.
    "events.capability_hint_attach_video": {
        "ko": "영상은 attach_channel_post_video로 초안에 첨부해요.",
        "en": "Attach the video to the draft using attach_channel_post_video.",
    },
    # story #4111(#4110 BE 후속, 페드루 PO 지시 2026-09-21) — 연산 단계 자기설명 멘션에
    # get_generation_connector(#4110 REST를 부르는 플러그인 도구, sprintable-agent-plugins
    # PR #52) 안내 1줄 추가. 기존 마스터컷 evidence 문장은 무변(별개 사실 — "무엇을 남겨야
    # 하는지"와 "무엇으로 실행하는지"는 다른 축) · 새 문장을 그 뒤에 붙인다.
    "events.capability_hint_master_cut_evidence": {
        "ko": "type=url·ref=live-run:master-cut evidence를 남겨야 계보가 생겨요."
        " 연산 단계에서는 get_generation_connector로 org 커넥터 config·자격을 받아 자기 실행해요.",
        "en": "Record evidence with type=url and ref=live-run:master-cut so lineage gets created."
        " For the generation stage, call get_generation_connector to get the org connector's"
        " config and credentials, then run it yourself.",
    },
    # story #4088 CHANGES(페드루 PO 리뷰, 2026-09-21) — 원문 "승인이 자동 충족돼요"는
    # "사람 승인이 아예 불요"로 오독될 수 있었다. 실물(#4069 자동충족 훅 + #4090 승인→
    # 자동발행)은 "제출해 두면 그 뒤 사람 승인 한 번이 발행까지 이어진다"는 뜻 — 승인
    # 단계 자체가 없어지는 게 아니라 승인 이후 사람 손(발행 클릭)이 없어지는 것.
    "events.gate_hint_external_publish_auto_satisfy": {
        "ko": "같은 스토리에 채널 초안을 만들어 제출해 두면 사람 승인 한 번으로 자동 발행까지 이어져요.",
        "en": "Create and submit a channel draft for the same story; one human approval then publishes it automatically.",
    },
    # story #4104(페드루 PO 라이브 실측, 2026-09-21) — apply 준비 경고 루프(story #3317 PR B)
    # 두 문구가 "설정 스킬을 먼저 실행하세요"라는 내부어(고객이 뭘 해야 할지 모르는 표현)를
    # 담고 있었다 — apply 다이얼로그가 warnings를 화면에 그대로 보여주므로 사용자 문장이어야
    # 한다. 합니다체 → 해요체 전환 겸.
    #
    # story #4108(페드루 PO 確定, 2026-09-21) — #4104가 해요체·목적지 문장으로 바꿨지만
    # `stage={stage!r}`·`kind={kind!r}` 등 파이썬 repr 토큰은 그대로 남아 있었다(#4107이
    # 이 warnings를 마케팅 v2 다이얼로그에도 노출하면서 실사용자가 읽음). `stage` 자리는
    # 호출부(events.py)가 이미 사람말 라벨로 바꿔 `stage_label`로 넘긴다 — 여기서는 그
    # 라벨과 나머지 값(kind/connector_key/channel)을 따옴표·repr 없이 그대로 문장에 싣는다.
    # story #4108 — "단계" 접미사 자체가 새 한글 사용자 문장이라(BE 한글 가드 story #3779가
    # 잡음) 이 조각도 events.py의 raw f-string이 아니라 카탈로그 항목으로 뽑는다. role이
    # 없으면(방어적 폴백) events.py가 이 키를 아예 안 부르고 stage 키를 그대로 쓴다.
    #
    # story #4108 design CHANGES(유나·페드루 PO, 2026-09-21) — 첫 push는
    # `stage_metadata[stage].role`을 그대로 사람말이라 가정했지만, 실 정의는 그 자리에
    # 영어 enum(Publisher/Creator/Compute/Director 등, story #4049/#3773 정본)을 쓴다 —
    # 고치기 전이면 "Publisher 단계: …"로 원어가 그대로 샜을 것(story #4460류 재발).
    # FE `apps/web/src/lib/stage-role.ts`(story #3773, 유나 定)가 이미 이 17종의
    # 한글 라벨 정본이라 그 집합과 1:1로 여기 옮긴다(새 어휘 발명 0) — events.py가
    # role → 이 카탈로그 라벨(미등재 role은 원시값 그대로 pass-through, FE와 동형
    # 원칙) → 아래 apply_stage_role_label로 "{role} 단계" 조립.
    "events.stage_role.Agent": {"ko": "에이전트", "en": "Agent"},
    "events.stage_role.Any": {"ko": "누구나", "en": "Any"},
    "events.stage_role.Approver": {"ko": "승인자", "en": "Approver"},
    "events.stage_role.Compute": {"ko": "연산", "en": "Compute"},
    "events.stage_role.Creator": {"ko": "크리에이터", "en": "Creator"},
    "events.stage_role.Dev": {"ko": "개발자", "en": "Dev"},
    "events.stage_role.Director": {"ko": "디렉터", "en": "Director"},
    "events.stage_role.Executor": {"ko": "실행자", "en": "Executor"},
    "events.stage_role.Human": {"ko": "사람", "en": "Human"},
    "events.stage_role.Lead": {"ko": "리드", "en": "Lead"},
    "events.stage_role.Maker": {"ko": "제작자", "en": "Maker"},
    "events.stage_role.Member": {"ko": "구성원", "en": "Member"},
    "events.stage_role.PO": {"ko": "PO", "en": "PO"},
    "events.stage_role.Publisher": {"ko": "발행자", "en": "Publisher"},
    "events.stage_role.QA": {"ko": "QA", "en": "QA"},
    "events.stage_role.Reviewer": {"ko": "검토자", "en": "Reviewer"},
    "events.stage_role.Worker": {"ko": "작업자", "en": "Worker"},
    "events.apply_stage_role_label": {
        "ko": "{role} 단계",
        "en": "{role} stage",
    },
    "events.apply_connector_registered_missing": {
        "ko": "{stage_label}: {connector_key} 커넥터가 아직 등록돼 있지 않아요 — 조직 설정에서 채널을 먼저 연결하세요.",
        "en": "{stage_label}: connector {connector_key} is not registered yet — connect the channel in organization settings first",
    },
    "events.apply_kind_connector_not_registered": {
        "ko": "{stage_label}: {kind} 종류 커넥터가 이 조직에 등록돼 있지 않아요 — 조직 설정에서 채널을 먼저 연결하세요.",
        "en": "{stage_label}: no connector supporting kind {kind} is registered for this organization — connect the channel in organization settings first",
    },
    # story #4104 CHANGES(페드루 PO 리뷰, 2026-09-21) — 같은 루프의 나머지 3줄도 같은
    # 클래스(합니다체·내부 용어)였다. "channel_connector_map"은 내부 테이블/설정 키 이름
    # (화면에 노출하면 고객이 그 이름으로 뭘 찾아야 할지 모름) — 목적지 문장("그 채널을
    # 먼저 연결하세요")으로 교체.
    "events.apply_channel_connector_map_missing": {
        "ko": "{stage_label}: {channel} 채널에 대한 커넥터 연결이 없어요 — 조직 설정에서 그 채널을 먼저 연결하세요.",
        "en": "{stage_label}: no connector is mapped for channel {channel} — connect that channel in organization settings first",
    },
    "events.apply_connector_config_incomplete": {
        "ko": "{stage_label}: {connector_key} 커넥터의 필수 설정값이 비어 있어요 — {missing}. 조직 설정 화면에서 채워주세요.",
        "en": "{stage_label}: connector {connector_key} is missing required configuration — {missing}. Fill it in from organization settings",
    },
    "events.apply_kind_connector_config_incomplete": {
        "ko": "{stage_label}: {kind} 종류 커넥터는 등록돼 있지만 필수 설정값이 아직 비어 있어요 — 조직 설정 화면에서 등록하세요.",
        "en": "{stage_label}: a connector supporting kind {kind} is registered but its required configuration is incomplete — register it from organization settings",
    },
    # story #3614 갭(BE, 페드루 PO 確定 2026-09-11) — 폐기(withdrawn, 종결)된 초안
    # submit 거부(409). 새 한글 사용자 문장이라 3796(insight_snapshots.py)과 같은
    # 형으로 처음부터 카탈로그에 등재(BE 한글 사용자 문장 가드 신규 위반 대응).
    "channel_posts.draft_withdrawn": {
        "ko": "폐기된 초안은 다시 상신할 수 없어요 — 새 초안을 만드세요.",
        "en": "A discarded draft can't be resubmitted — create a new draft.",
    },
    # story #3805 CI 정정(2026-09-11, 카디르 실측·페드루 전달) — engagement_items.py
    # PATCH 3자리(휴먼 전용 403·404·422)의 신규 한글 사용자 문장. 처음부터 카탈로그로
    # 등재(#3796/#3614·events.py와 같은 형).
    "engagement_items.patch_human_only": {
        "ko": "반응 항목의 배정·상태 변경은 휴먼 멤버만 가능해요.",
        "en": "Only human members can change engagement item assignment or status",
    },
    "engagement_items.not_found": {
        "ko": "반응 항목을 찾을 수 없어요",
        "en": "Engagement item not found",
    },
    "engagement_items.invalid_status": {
        "ko": "알 수 없는 처리 상태예요.",
        "en": "Unknown triage status",
    },
    # story #3806(Phase3·3-2 PR2, 페드루 PO 確定 2026-09-11) — ads_boost 게이트
    # 라우터(app/routers/ads_boost.py)의 5개 사용자 문장. 유나 §절 카드 본문 착지
    # (2026-09-11) — boost의 사람 낱말="홍보"(en Boost), 재승인 409 user_message는
    # 이 레포 다른 재승인류와 동형("예산/기간이 바뀌어 재승인이 필요합니다"류)이나
    # 이 PR엔 재승인 자체가 409를 별도로 내지 않아(201로 그대로 반환·reapproval_
    # required 필드로 신호) 해당 문장은 등재 대상 밖 — 미사용.
    "ads_boost.create_human_only": {
        "ko": "광고 홍보(boost) 요청은 휴먼 멤버만 가능해요(에이전트는 제안만).",
        "en": "Only human members can request an ads boost (agents may only propose).",
    },
    "ads_boost.invalid_schedule": {
        "ko": "시작 시각은 종료 시각보다 빨라야 해요.",
        "en": "The start time must be earlier than the end time.",
    },
    "ads_boost.publication_not_found": {
        "ko": "이 조직에 없는 발행물이에요.",
        "en": "Publication not found in this organization.",
    },
    # 페드루 PO 追加 確定(2026-09-11, PR 3 착수 직전 보완) — ad_connection_id 검증
    # 실패(존재 안 함/타 org/채널 불일치/비활성) 전부 이 한 문장으로 뭉뚱그린다
    # (필드별 원인 노출은 채널연결 구조를 캐는 오라클이 된다, ads_boost.py 예외
    # docstring과 동일 판단).
    "ads_boost.invalid_ad_connection": {
        "ko": "지정한 광고 계정 연결을 쓸 수 없어요 — 이 조직의 활성 Meta 광고 계정 연결인지 확인하세요.",
        "en": "The specified ad account connection can't be used — check that it's an active Meta ads connection in this organization.",
    },
    "ads_boost.approver_role_missing": {
        "ko": "승인할 사람이 지정되지 않았어요 — 승인자 역할을 먼저 두어 주세요.",
        "en": "No one is set up to approve this — please set an approver role first.",
    },
    "ads_boost.budget_exceeds_seal": {
        "ko": "요청 예산이 봉인된 예산({sealed_budget_minor})보다 커요 — 증액은 지원하지 않아요.",
        "en": "The requested budget exceeds the sealed budget ({sealed_budget_minor}) — increasing it is not supported.",
    },
    # story #3806(Phase3·3-2 PR3, 페드루 PO 確定 2026-09-11) — ads_boost 실행·중지·
    # 재개 라우터(app/routers/ads_boost_execution.py)의 사용자 문장. PR 2와 같은
    # 「홍보」(en Boost) 낱말 유지(유나 §절 카드 본문, 2026-09-11 착지).
    "ads_boost.execute_human_only": {
        "ko": "광고 홍보(boost) 실행·중지·재개는 휴먼 멤버만 가능해요.",
        "en": "Only human members can start, pause, or resume an ads boost.",
    },
    "ads_boost.gate_not_found": {
        "ko": "이 조직에 없는 광고 홍보(boost) 건이에요.",
        "en": "Ads boost not found in this organization.",
    },
    "ads_boost.gate_not_approved": {
        "ko": "아직 승인되지 않은 광고 홍보(boost) 건이에요.",
        "en": "This ads boost hasn't been approved yet.",
    },
    "ads_boost.not_started": {
        "ko": "아직 시작하지 않은 광고 홍보(boost) 건이에요.",
        "en": "This ads boost hasn't been started yet.",
    },
    "ads_boost.already_paused": {
        "ko": "이미 중지된 광고 홍보(boost) 건이에요.",
        "en": "This ads boost is already paused.",
    },
    "ads_boost.not_paused": {
        "ko": "중지 상태가 아닌 광고 홍보(boost) 건이에요.",
        "en": "This ads boost is not paused.",
    },
    "ads_boost.already_running": {
        "ko": "이미 진행 중인 광고 홍보(boost) 건이에요.",
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
        "ko": "API 키가 유효하지 않아요 · 스티비 설정에서 다시 발급해 주세요.",
        "en": "Your API key isn't valid — reissue it from your Stibee settings.",
    },
    # story #3813(Phase3·3-4 PR5-a CHANGES, 페드루 PO 確定 2026-09-12) — 스티비가
    # 안 닿는 것(네트워크·타임아웃·5xx)과 키가 틀린 것(스티비가 응답해서 거절)은
    # 사람이 할 일이 다르다(전자=잠시 뒤 재시도, 후자=키 재발급) — 별도 문구.
    "channel_connections.stibee_auth_check_unavailable": {
        "ko": "스티비에 연결할 수 없어요 · 잠시 뒤 다시 시도해 주세요.",
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
        "ko": "Admin API 키가 유효하지 않아요 · Ghost 설정에서 다시 확인해 주세요.",
        "en": "Your Admin API key isn't valid — check it in your Ghost settings.",
    },
    # story #3816 CHANGES 1(페드루 PO 지목 2026-09-12) — site_url 자체가 틀림
    # (오타·Ghost가 아닌 사이트, 흔히 404)은 키 오류와 다른 처방(주소를 고쳐야
    # 풀림)이라 별도 코드·문구.
    "channel_connections.ghost_site_not_found": {
        "ko": "Ghost 사이트를 찾을 수 없어요 · 사이트 주소를 확인해 주세요.",
        "en": "Couldn't find a Ghost site at that address — check the site URL.",
    },
    # story #3816(Phase3·3-6 PR1) — Ghost 사이트가 안 닿는 것(네트워크·타임아웃·5xx)과
    # 키가 틀린 것은 사람이 할 일이 다르다 — stibee_auth_check_unavailable 동형.
    "channel_connections.ghost_site_verify_unavailable": {
        "ko": "Ghost 사이트에 연결할 수 없어요 · 잠시 뒤 다시 시도해 주세요.",
        "en": "Couldn't reach your Ghost site — please try again in a moment.",
    },
    # story #3813(Phase3·3-4 PR2, 페드루 PO 確定 2026-09-12) — 뉴스레터 발송
    # 요청 API 사용자 문구(ads_boost.* 형제와 동형 어조, newsletter_send.py 라우터).
    "newsletter_send.create_human_only": {
        "ko": "뉴스레터 발송 요청은 휴먼 멤버만 가능해요(에이전트는 초안 작성만).",
        "en": "Only human members can request a newsletter send (agents may only draft).",
    },
    "newsletter_send.publication_not_found": {
        "ko": "이 조직에 없는 발행물이에요.",
        "en": "Publication not found in this organization.",
    },
    "newsletter_send.invalid_channel": {
        "ko": "이 발행물은 뉴스레터 채널이 아니에요.",
        "en": "This publication is not on a newsletter channel.",
    },
    "newsletter_send.not_published": {
        "ko": "아직 발행(캠페인 생성)이 끝나지 않은 발행물이에요.",
        "en": "This publication hasn't finished being created as a campaign yet.",
    },
    "newsletter_send.approver_role_missing": {
        "ko": "승인할 사람이 지정되지 않았어요 — 승인자 역할을 먼저 두어 주세요.",
        "en": "No one is set up to approve this — please set an approver role first.",
    },
    # story #3813(Phase3·3-4 PR5-b CHANGES, 카디르 실측 2026-09-12 — 가드 #3779
    # FAIL 3건) — command.last_error/예외 메시지가 사람에게 닿는 자리인데 하드코딩
    # 한글 문자열이었다. 코드는 키+파라미터만 넘긴다.
    "newsletter_send.channel_unsupported": {
        "ko": "newsletter_send에 배선되지 않은 채널이에요(channel={channel}).",
        "en": "This channel isn't wired for newsletter_send (channel={channel}).",
    },
    "newsletter_send.connection_unavailable": {
        "ko": "연결·봉인 시각·캠페인 id 중 하나가 없어요.",
        "en": "One of connection, sealed schedule time, or campaign id is missing.",
    },
    "stibee_publish.connection_incomplete": {
        "ko": "stibee 발행에 필요한 제목·주소록 ID·발신자 정보가 없어요.",
        "en": "Missing subject, address book ID, or sender info required to publish to Stibee.",
    },
    # story #3815(Phase3·3-5 PR2, 페드루 PO 낱말 확定 2026-09-12 10:46Z, CHANGES①
    # 2026-09-12 11:34Z 정정) — 코드(YOUTUBE_QUOTA_EXCEEDED)·마커(sandbox:youtube-
    # quota-exceeded)는 그대로. 최초엔 "내일 다시"(상대 표현)로 확定했으나, 리셋
    # 경계가 자정 «시각»이라 다른 시간대 사용자에겐 "내일"이 실제로는 그날 오후
    # 부터라 거짓 — 정적 절대 시각 문장으로 교체(경계 자체가 고정값이라 정적
    # 문자열로 충분·`reset_at` 필드는 여전히 응답에 실어 FE가 필요하면 참고).
    #
    # story #3815(배포 83 픽셀 결함, 페드루 PO 지적 2026-09-12 23:50Z) — 이전엔
    # "매일 오전 9시(한국 시간)"/"00:00 UTC"가 UTC 자정을 전제로 한 문장이었으나
    # 실 YouTube quota는 태평양 시간(America/Los_Angeles, DST 관례 有) 자정에
    # 리셋된다(공개 문서 지식, ⚠️미확認 — channel_adapters.py quota_reset_timezone
    # 필드 주석 참고) — UTC 고정 가정이던 "오전 9시"류 절대 시각 표기는 PDT/PST
    # 전환에 따라 실제로 8시/9시를 오간다는 뜻이라 애초에 정적 절대 시각으로
    # 못 박을 수 없다(그때그때 달라지는 KST 환산 시각을 문구에 하드코딩하면
    # 그 자체가 거짓말이 된다). `{tz_display}`로 시간대 명칭만 표기하고 정확한
    # 순간은 `reset_at` 필드(FE가 필요하면 로컬 시각으로 환산)에 맡긴다 —
    # `{tz_display}`는 라우터가 `youtube_quota.TIMEZONE_DISPLAY_NAMES`에서
    # `reset_timezone`(=채널 어댑터의 `quota_reset_timezone` 선언값, `reset_at`과
    # 같은 소스)으로 조회해 넘긴다(두 곳이 각자 짓지 않는다).
    "channel_posts.youtube_usage_exceeded": {
        "ko": "오늘 YouTube 사용량을 다 썼어요 — 사용량은 매일 {tz_display} 자정에 초기화돼요(플랫폼 공유 한도).",
        "en": "Today's YouTube usage limit has been reached — it resets daily at midnight {tz_display} (shared platform-wide limit).",
    },
    # story #3815(Phase3·3-5, 미르코 PR4 그라운딩 발견 → 페드루 PO 지적 2026-09-12
    # 14:37Z) — `_validate_youtube_metadata`가 던지는 `ChannelYouTubeMetadataError`
    # 를 라우터 어디서도 안 잡아 사용자에게 코드 없는 500이 나가던 실 결함. 이
    # 문장은 4필드(title/tags/categoryId/privacyStatus) 중 어느 게 틀렸는지
    # 구체적으로 말하지 않는다(field/reason은 detail의 별도 키로 실림, 문장 자체는
    # 그 4필드 전체를 가리키는 안내).
    "channel_posts.youtube_metadata_invalid": {
        "ko": "YouTube 제목·태그·카테고리·공개 범위 값을 확인해 주세요.",
        "en": "Check the YouTube title, tags, category, and privacy values.",
    },
    # story #3821(customer-zero 실측, 페드루 PO 확定 2026-09-13, PR B) —
    # approval_delivery.py::dispatch_approval_request_cards의 스레드 답글 문구.
    # 그 파일 자신은 EXEMPT_FILES 대상이 아니라(verify_no_new_korean_user_
    # strings.py) 새 한글 리터럴을 직접 못 심는다 — 이 신규 문구만 이 카탈로그를
    # 경유한다(그 파일의 기존 문구들, 예: "'{title}' 결재 요청"은 그 가드 도입
    # 前부터 있던 grandfather 항목이라 무변경). 이 소비처는 locale 협상이 없는
    # 내부 시스템 챗 메시지라 항상 "ko"로만 호출한다 — en 값은 가드 1(ko/en 키
    # 짝 무결성) 충족용.
    "approval_delivery.reopen_reply": {
        "ko": "다시 결재가 필요해요",
        "en": "Re-approval is needed",
    },
    # story #4042(evidence.py::_validate_and_normalize_evidence_payload, kind fail-closed
    # 화이트리스트) — 신규 코드라 verify_no_new_korean_user_strings.py 대상, EXEMPT_FILES가
    # 아닌 evidence.py 자신에 리터럴로 못 심어 이 카탈로그를 경유한다.
    "evidence.kind_unregistered": {
        "ko": "payload.kind={kind}는 등재되지 않은 kind예요 — 허용: {allowed}.",
        "en": "payload.kind={kind} is not a registered kind — allowed: {allowed}.",
    },
    "evidence.kind_type_mismatch": {
        "ko": "payload.kind={kind}는 type={expected_type}로 실려야 해요 (받은 type={received_type}).",
        "en": "payload.kind={kind} must be sent with type={expected_type} (received type={received_type}).",
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
