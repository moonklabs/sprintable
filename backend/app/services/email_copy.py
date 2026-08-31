"""story #3205(선생님 방향 결정 2026-08-29) — 발송 메일 7종의 locale별 카피 사전.

로케일 판별은 `app.services.agent_onboarding_config.resolve_locale`/`SUPPORTED_LOCALES`/
`DEFAULT_LOCALE`을 그대로 재사용한다(이 파일은 새 locale 정규화 로직을 만들지 않는다).

ko 카피는 기존 발송 문구 그대로(무회귀 — #3196-⑤ 유나 카피 제안이 이미 확定한 톤).
en 카피는 이 스토리에서 신규 추가 — **유나 검수 대기 초안**이다(doc
`email-locale-copy-proposal-3205`으로 상신). 검수 확정 전까지는 구조/파라미터만
믿을 것 — en 문면 자체는 검수 결과로 바뀔 수 있다.
"""
from __future__ import annotations

TRANSACTIONAL_COPY: dict[str, dict[str, dict]] = {
    "verify_email": {
        "ko": {
            "subject": "Sprintable 이메일 인증을 완료해 주세요",
            "intro_lines": [
                "Sprintable에 가입해 주셔서 감사합니다.",
                "아래 버튼을 눌러 이메일 인증을 완료하시면 바로 시작하실 수 있습니다.",
            ],
            "cta_label": "이메일 인증하기",
            "expiry_note": "이 링크는 24시간 동안 유효합니다.",
            "security_note": "본인이 요청한 가입이 아니라면 이 메일을 무시하셔도 됩니다.",
            "fallback_label": "버튼이 열리지 않으면 아래 주소를 브라우저에 붙여넣어 주세요:",
        },
        "en": {
            "subject": "Please verify your Sprintable email",
            "intro_lines": [
                "Thank you for signing up for Sprintable.",
                "Click the button below to verify your email and get started right away.",
            ],
            "cta_label": "Verify email",
            "expiry_note": "This link is valid for 24 hours.",
            "security_note": "If you didn't sign up for this, you can safely ignore this email.",
            # 유나 홀름 결선(2026-08-29) — 초대 메일 기존 en 폴백과 자구 정렬(work/open 통일).
            "fallback_label": "If the button doesn't work, paste this address into your browser:",
        },
    },
    "reset_password": {
        "ko": {
            "subject": "Sprintable 비밀번호 재설정 안내",
            "intro_lines": [
                "비밀번호 재설정을 요청하셨습니다.",
                "아래 버튼을 눌러 새 비밀번호를 설정해 주세요.",
            ],
            "cta_label": "비밀번호 재설정",
            "expiry_note": "이 링크는 30분 동안 유효합니다.",
            "security_note": "본인이 요청하지 않으셨다면 이 메일을 무시하셔도 됩니다 — 비밀번호는 변경되지 않습니다.",
            "fallback_label": "버튼이 열리지 않으면 아래 주소를 브라우저에 붙여넣어 주세요:",
        },
        "en": {
            "subject": "Reset your Sprintable password",
            "intro_lines": [
                "We received a request to reset your password.",
                "Click the button below to set a new password.",
            ],
            "cta_label": "Reset password",
            "expiry_note": "This link is valid for 30 minutes.",
            "security_note": "If you didn't request this, you can safely ignore this email — your password will not be changed.",
            # 유나 홀름 결선(2026-08-29) — 전 템플릿 work로 통일(open 잔존은 페드루군 지적).
            "fallback_label": "If the button doesn't work, paste this address into your browser:",
        },
    },
    # story #3209(PR-2, 2026-08-29) — 결제 완료 안내. 다른 트랜잭셔널 3종과 골격 동일
    # (intro_lines/cta_label/expiry_note/security_note/fallback_label — render_action_email
    # 그대로 재사용, 새 렌더러 발명 없음). intro_lines[1]은 결제액 삽입용 {amount} 자리
    # 표시자(billing_receipt_email.py가 .format()으로 채움 — STORAGE_WARN_COPY의 {pct}
    # 등과 동형 관례). expiry_note/security_note는 "만료/보안" 문면 그대로가 아니라 영수증
    # 맥락에 맞게 내용을 바꿔 채웠다(파라미터 이름은 골격 재사용, 내용은 이 메일의 실제
    # 의미에 맞춤 — expiry_note 자리엔 "영수증은 Toss가 제공하며 링크로 계속 확인 가능"을,
    # security_note 자리엔 "본인 결제가 아니면 즉시 문의" 안내를 담는다). en은 유나 검수
    # 대기 초안(다른 5종과 동일 상태).
    "payment_receipt": {
        "ko": {
            "subject": "Sprintable 결제가 완료됐습니다",
            "intro_lines": [
                "결제가 정상적으로 완료됐습니다.",
                "결제 금액: {amount}",
            ],
            "cta_label": "영수증 보기",
            "expiry_note": "영수증은 결제사(Toss)가 제공하며, 이 링크로 언제든 다시 확인하실 수 있습니다.",
            "security_note": "본인이 결제하지 않으셨다면 즉시 고객센터로 문의해 주세요.",
            "fallback_label": "버튼이 열리지 않으면 아래 주소를 브라우저에 붙여넣어 주세요:",
        },
        "en": {
            "subject": "Your Sprintable payment is complete",
            "intro_lines": [
                "Your payment was completed successfully.",
                "Amount charged: {amount}",
            ],
            "cta_label": "View receipt",
            "expiry_note": "The receipt is provided by our payment processor (Toss) and can be viewed anytime via this link.",
            "security_note": "If you didn't make this payment, please contact support immediately.",
            "fallback_label": "If the button doesn't work, paste this address into your browser:",
        },
    },
}

REMINDER_COPY: dict[str, dict[str, str]] = {
    "ko": {
        "subject": "Sprintable — 가입 완료까지 몇 단계 남았습니다",
        "intro": (
            "Sprintable 가입을 환영합니다. 아직 에이전트 연결이나 첫 지시를 완료하지 않으셨네요"
            " — 몇 분이면 끝나는 남은 단계를 마무리하면 Sprintable의 진짜 가치를 바로 확인하실 수"
            " 있습니다."
        ),
        "cta_label": "이어서 진행하기",
        "unsub_label": "이런 안내를 더 이상 받고 싶지 않다면 여기를 눌러 주세요",
    },
    "en": {
        "subject": "Sprintable — a few steps left to finish setup",
        "intro": (
            "Welcome to Sprintable. You haven't finished connecting an agent or sending your"
            " first instruction yet — the remaining steps take just a few minutes and show you"
            " what Sprintable can really do."
        ),
        "cta_label": "Continue setup",
        "unsub_label": "Click here if you'd rather not receive these reminders",
    },
}

INVITE_COPY: dict[str, dict[str, str]] = {
    "ko": {
        "subject": "[Sprintable] {org_name} 조직에 초대됐습니다",
        "heading": "팀에 초대됐어요!",
        "body": "<strong>{inviter_name}</strong>님이 <strong>{org_name}</strong> 조직에 <strong>{role}</strong>로 초대했습니다.",
        "sub_body": "아래 버튼을 클릭하면 초대를 수락할 수 있습니다. 링크는 7일간 유효합니다.",
        "cta_label": "초대 수락하기",
        "fallback_label": "버튼이 보이지 않으면 아래 주소를 브라우저에 붙여 넣으세요:",
        # story #3206 — 공용 셸(render_email_shell)이 회사정보·연도·법적 링크 푸터를
        # 전담하면서 이 필드의 "© {year} Sprintable." 부분은 셸과 중복이라 걷어냈다(유나
        # doc email-brand-shell-proposal-3206 ③ 수렴 지시). "왜 이 메일을 받았는지"만
        # 콘텐츠 영역 마지막 줄로 남긴다.
        "auto_generated_note": "이 이메일은 초대 발송으로 자동 생성되었습니다.",
        "default_inviter": "팀 관리자",
    },
    "en": {
        "subject": "[Sprintable] You've been invited to {org_name}",
        "heading": "You're invited!",
        # 유나 검수 수정의견②(2026-08-29) — role은 소문자 raw 값(member/admin/owner)이라
        # 관사 없이 "as admin"은 어색. _build_invite_html이 관사 붙인 role_display를 넘긴다.
        "body": "<strong>{inviter_name}</strong> invited you to join <strong>{org_name}</strong> as {role_display}.",
        "sub_body": "Click the button below to accept the invitation. This link is valid for 7 days.",
        "cta_label": "Accept invitation",
        "fallback_label": "If the button doesn't work, paste this address into your browser:",
        "auto_generated_note": "This email was sent automatically because you were invited.",
        "default_inviter": "a team admin",
    },
}

# 운영 알림 2종(스토리지/AU 임계) — 기존엔 en 고정이었다(이 스토리 이전엔 ko 카피 자체가
# 없었음 — 무회귀 대상이 없는 신규 추가).
STORAGE_WARN_COPY: dict[str, dict[str, str]] = {
    "ko": {
        "subject": "[Sprintable] 스토리지 사용량 {pct}% 도달",
        "body": (
            "<p>안녕하세요, Sprintable입니다.</p>"
            "<p>조직의 스토리지 사용량이 <b>{pct}%</b>({used_mb}MB / {cap_mb}MB)에 도달했습니다.</p>"
            "<p>업로드 제한을 피하려면 사용하지 않는 파일을 정리하거나 플랜을 업그레이드해 주세요.</p>"
        ),
    },
    "en": {
        "subject": "[Sprintable] Storage usage at {pct}%",
        "body": (
            "<p>Hello, this is Sprintable.</p>"
            "<p>Your organization's storage usage has reached <b>{pct}%</b>"
            " ({used_mb}MB / {cap_mb}MB).</p>"
            "<p>Free up space (delete unused files) or upgrade your plan to avoid upload limits.</p>"
        ),
    },
}

AU_WARN_COPY: dict[str, dict[str, str]] = {
    "ko": {
        "subject": "[Sprintable] 자동화 사용량(AU) {pct}% 도달",
        "body": (
            "<p>안녕하세요, Sprintable입니다.</p>"
            "<p>조직의 이번 달 자동화 사용량(AU)이 <b>{pct}%</b>({current} / {au_limit} AU)에"
            " 도달했습니다.</p>"
            "<p>100%에 도달하면 MCP/API 쓰기 및 자동화가 일시 중지됩니다(읽기와 사람 UI는 계속"
            " 사용 가능합니다). 한도에 도달하기 전 플랜 업그레이드를 검토해 주세요.</p>"
        ),
    },
    "en": {
        "subject": "[Sprintable] Automation usage (AU) at {pct}%",
        "body": (
            "<p>Hello, this is Sprintable.</p>"
            "<p>Your organization's automation usage (AU) has reached <b>{pct}%</b>"
            " ({current} / {au_limit} AU this month).</p>"
            "<p>At 100% MCP/API writes and automation will pause (reads and human UI stay"
            " available). Consider upgrading before the limit is reached.</p>"
        ),
    },
}
