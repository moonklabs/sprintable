"""story #3262(지원v1·4지식원) — 에이전트가 읽는 정본 문서 v1. Blueprint v0.4 §5-4.

**작성 원칙(no-fiction, story #3261 2차 날조 사고 재발 방지)**: 모든 URL·경로·문구는 실제
sprintable 프론트엔드/백엔드 소스에서 검증한 값만 싣는다 — 지어낸 링크(example.com류) 0건.
각 청크의 `source_note`가 검증 시점의 실 파일:라인을 가리킨다(2026-08-31, apps/web·backend
main 기준 — Explore 조사).

**저장 위치 확定(AC1)**: 이 파일 자체가 정본 — Sprintable 메인 서비스의 docs DB를 실시간
조회하지 않는다(그러려면 fleet 자격이 필요해 support-gateway의 "fleet 자격 0" 불변식이
깨진다, Blueprint §0). 대신 이 청크 세트를 support-gateway 배포 아티팩트에 번들해 코드/배포
버전과 함께 버전관리한다.

**릴리즈 연동 갱신 규칙(AC3)**: 프론트엔드 라우트·문구·플로우가 바뀌면 이 파일을 사람이
갱신하고 `scripts/embed_corpus.py`를 재실행해 `embeddings.json`을 재생성한다(수동 — v1
스코프. 자동 doc-drift 감지는 §5-4 후속 backlog, 지금은 소규모 청크 세트에 비용 대비 과함).
`tests/test_knowledge_corpus_embeddings_sync.py`가 corpus 내용 해시와 embeddings.json에 박힌
해시를 대조해 "내용은 고쳤는데 재생성을 깜빡함"을 구조적으로 잡는다.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class KnowledgeChunk:
    id: str
    title: str
    content: str
    source_note: str  # 내부용 — 고객에게 노출 안 함. 검증 근거 추적용.


KNOWLEDGE_CHUNKS: list[KnowledgeChunk] = [
    KnowledgeChunk(
        id="invite-how-to",
        title="팀원(멤버)을 조직에 초대하는 방법",
        content=(
            "조직 멤버 초대는 '조직 > 멤버' 페이지(/organization/members)에서 합니다. "
            "이 페이지에서 이메일을 입력하고 역할(Member 또는 Admin)을 선택한 뒤 '초대' 버튼을 "
            "누르면 초대 이메일이 발송되고, 복사할 수 있는 초대 링크도 함께 생성됩니다. "
            "설정(Settings) 화면의 '접근 권한(Access)' 탭에 있는 '멤버 추가' 버튼으로도 같은 "
            "조직 초대를 시작할 수 있습니다. 초대는 관리자(Admin) 또는 소유자(Owner) 권한이 "
            "있는 사람만 보낼 수 있습니다."
        ),
        source_note=(
            "apps/web/src/app/(authenticated)/organization/members/page.tsx(OrgMembersSection) "
            "+ org-members-section.tsx:236,238,259,254-256 · "
            "apps/web/src/app/(authenticated)/settings/page.tsx:694,702-705,1227,1230 + "
            "add-member-modal.tsx:59,91 — 2026-08-31 Explore 조사 확認."
        ),
    ),
    KnowledgeChunk(
        id="invite-project-access-scope",
        title="초대와 프로젝트 접근 권한의 관계",
        content=(
            "조직에 멤버를 초대할 때 프로젝트를 함께 선택할 수 있습니다(선택 사항). 프로젝트를 "
            "선택하면 상대방이 초대를 수락한 직후 바로 그 프로젝트에 접근할 수 있습니다. "
            "아무 프로젝트도 선택하지 않으면 조직에만 합류하고, 프로젝트 접근은 별도로 "
            "추가해야 합니다 — 조직 초대가 자동으로 모든 프로젝트 접근권을 주지는 않습니다."
        ),
        source_note=(
            "org-members-section.tsx:263-306 + add-member-modal.tsx — i18n key "
            "inviteProjectsLabel/inviteProjectsHelper. 2026-08-31 Explore 조사 확認."
        ),
    ),
    KnowledgeChunk(
        id="invite-already-member-or-pending",
        title="초대가 실패했다고 나오는 경우 (이미 멤버이거나 이미 초대된 이메일)",
        content=(
            "초대하려는 이메일이 이미 그 조직의 멤버이거나, 이미 그 이메일로 대기 중인 초대가 "
            "있으면 초대가 실패합니다. 다만 화면에는 구체적인 이유 대신 일반적인 '초대 발송에 "
            "실패했습니다' 메시지만 표시됩니다(현재 UI가 이 두 경우를 따로 안내하지 않습니다). "
            "이런 경우 그 이메일이 이미 조직 멤버 목록에 있는지, 또는 이미 보낸 초대 목록에 "
            "있는지 먼저 확인해 보시라고 안내하는 것이 좋습니다."
        ),
        source_note=(
            "backend/app/routers/org_invites.py:93-94(이미 멤버),104(이미 대기중 초대, 둘 다 "
            "409) — 프론트는 org-members-section.tsx:133-141·add-member-modal.tsx:65-74에서 "
            "PLAN_LIMIT_EXCEEDED 외엔 전부 memberInviteFailed/addMemberInviteError 일반 메시지로 "
            "떨어짐(분기 없음). 2026-08-31 Explore 조사 확認."
        ),
    ),
    KnowledgeChunk(
        id="invite-email-mismatch",
        title="초대 수락 시 '가입한 이메일이 초대받은 이메일과 다릅니다' 오류",
        content=(
            "초대 링크를 받은 이메일과 다른 이메일로 가입하거나 로그인한 상태에서 초대를 "
            "수락하려 하면 '가입한 이메일이 초대받은 이메일과 다릅니다'라는 오류가 뜨며 수락에 "
            "실패합니다. 초대받은 것과 정확히 같은 이메일 주소로 로그인(또는 가입)한 뒤 다시 "
            "초대 링크를 열어야 합니다."
        ),
        source_note=(
            "backend/app/routers/invite_accept.py:39-70(이메일 매치 강제, 403) + "
            "apps/web/src/lib/invite-error-message.ts:24-40(FORBIDDEN→inviteEmailMismatch, "
            "ko: '가입한 이메일이 초대받은 이메일과 다릅니다.'). 2026-08-31 Explore 조사 확認."
        ),
    ),
    KnowledgeChunk(
        id="invite-seat-limit-free-plan",
        title="무료 플랜에서 멤버 초대 인원 제한",
        content=(
            "무료 플랜은 초대할 수 있는 멤버 수에 상한이 있습니다(현재 활성 멤버 수 + 아직 "
            "수락되지 않은 대기 중 초대 수를 합산 — AI 에이전트는 이 인원수에 포함되지 않습니다). "
            "정확한 상한 값은 플랜 등급마다 다르게 설정돼 있어 이 문서에 고정된 숫자로 적어둘 "
            "수 없습니다(story #3270 — 정적 문서가 동적 값을 단정하면 그 값이 실제와 달라졌을 "
            "때 오안내가 된다) — 상한을 넘으면 초대 화면에 정확한 숫자가 포함된 안내 메시지가 "
            "표시되니, 고객에게는 그 화면에 뜬 숫자가 현재 조직의 정확한 상한이라고 안내하세요. "
            "더 많은 인원을 초대하려면 플랜 업그레이드가 필요합니다."
        ),
        source_note=(
            "backend/ee/plan_limits.py:286-306(check_member_invite_limit, pending invite 포함 "
            "카운트) + org-members-section.tsx:137-138/add-member-modal.tsx:70-71(memberLimitExceededError). "
            "2026-08-31 Explore 조사 확認. ⚠️story #3270(2026-09-01) — 원래 이 청크 content가 "
            "실 에러 메시지 문자열을 '{N}명까지'로 그대로 인용했다가, Interaction 재서술 단계에서 "
            "모델이 그 미해결 플레이스홀더를 그럴듯한 구체 숫자(10명)로 채워 넣는 사고가 재현됨 "
            "(완전 새 org·이력 0에서도 재현 — 이력 오염이 아니라 재서술 단계의 독립 재추정). "
            "정적 값을 아예 안 적는 쪽으로 정정 — tests/test_knowledge_corpus_no_unresolved_"
            "placeholders.py가 이 클래스의 재발을 구조적으로 잡는다."
        ),
    ),
    KnowledgeChunk(
        id="onboarding-happy-path",
        title="가입 직후 첫 시작 흐름(온보딩)",
        content=(
            "기존 조직 없이 새로 가입하면 온보딩 화면(/onboarding)으로 이동합니다. 순서는: "
            "① 조직 만들기 → ② 첫 프로젝트 만들기 → ③ AI 에이전트 팀원 추가(API 키가 이 "
            "단계에서 발급됩니다) → ④ 에이전트 설정 붙여넣고 재시작 후 실제 연결 확인. 마지막 "
            "'완료 → 대시보드' 버튼을 누르면 채팅 화면(/chats)으로 이동합니다. 반대로 초대를 "
            "받아 이미 소속된 조직이 있는 상태로 가입하면 온보딩을 건너뛰고 받은편지함"
            "(/inbox)으로 바로 이동합니다."
        ),
        source_note=(
            "apps/web/src/app/onboarding/page.tsx + onboarding-form.tsx:65-66(STEPS "
            "org/project/agent/connect),226-234,277-280,282-334,342-386 + connect-step.tsx + "
            "apps/web/src/app/register/page.tsx:82(org_id 있으면 /inbox, 없으면 /onboarding). "
            "2026-08-31 Explore 조사 확認."
        ),
    ),
    KnowledgeChunk(
        id="post-invite-landing-is-chats",
        title="초대 수락 후 이동하는 화면",
        content=(
            "초대 링크(/invite/accept?token=...)를 열어 수락에 성공하면 대시보드가 아니라 "
            "채팅 화면(/chats)으로 이동합니다 — 이 서비스는 대시보드를 홈으로 쓰지 않고 채팅을 "
            "홈으로 씁니다. 로그인이 안 된 상태에서 초대 링크를 열면 먼저 로그인 화면으로 "
            "보내지고, 로그인 후 원래 초대 수락 화면으로 자동 복귀합니다."
        ),
        source_note=(
            "apps/web/src/app/invite/accept/page.tsx:19(미로그인 시 /login?next=...),37 + "
            "invite/page.tsx:86,137 — 둘 다 '/chats'로 귀결(story #3179 S3c, /dashboard 폐합 "
            "주석 확認). 2026-08-31 Explore 조사 확認."
        ),
    ),
]
