"""story #3953(마케팅·안전장치·블루프린트 §1-5, 페드루 PO 確定 2026-09-16) — 조직
전체 「외부 발행 일시 중지」 스위치. owner가 켜면 모든 외부 쓰기(발행 명령·댓글
답변·뉴스레터 발송·광고 boost)가 어댑터 호출 前에 멈추고, 끄면 재개된다.

AC1 그라운딩 결론(디디, 2026-09-16·페드루 PO 확認) — 삽입점은 실은 5곳이 아니라
3곳이다: `channel_posts.py::publish_channel_post_draft`·`site_posts.py::
publish_site_post_from_draft`(둘 다 즉시-발행 라우터와 워커가 "3중 재검증
재구현 금지" 원칙으로 그대로 호출하는 공용 함수라 한 번의 삽입으로 sync/async
두 경로를 동시에 덮는다) + `publication_command.py::_process_one_command`(맨 위,
comment_reply·ads_boost·newsletter_send 3도메인은 이 워커 전용이라 직행 sync
경로가 없다 — grep 확認).

저장 자리(그라운딩 결론) — `org_content_rules.rules`(JSONB)는 모델 자체
docstring이 "콘텐츠 린트 전용 자루"라 의미상 안 맞아 기각. `organizations`에
`agent_session.py`·`github_installation.py`가 이미 쓰는 `suspended_at` 관례를
그대로 미러(마이그 0393 — rebase 개명 前엔 0379)."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.external_publish_pause_audit_log import ExternalPublishPauseAuditLog
from app.models.organization import Organization
from app.models.publication_command import PublicationCommand
from app.services.publication_command import FAILURE_KIND_PAUSED


class ExternalPublishPausedError(Exception):
    """story #3953 — 조직이 외부 발행을 일시 중지한 상태에서 어댑터 호출 직전
    삽입점(publish_channel_post_draft·publish_site_post_from_draft·워커)에
    도달했다. `.reason`은 owner가 적은 사유(없으면 None).

    story #3779(페드루 PO 정정 2026-09-17) — BE는 사람 문장을 싣지 않는다: 이
    예외 메시지는 publication_command.py::_process_one_command의 기존
    `last_error`(`EXTERNAL_PUBLISH_PAUSED: {reason}`류, Korean 0)와 같은 코드꼴
    중립 문자열이고, 호출부(site_posts.py/channel_posts.py)도 이걸 그대로
    `str(exc)`로 실을 뿐 한글로 다시 조립하지 않는다 — 실제 한글 문장은 FE
    `errorExternalPublishPaused` 정적 labelKey가 짓는다(api-error.ts, "reason
    표시 0" — reason은 감사 로그행에만 남는다, external-publish-pause-card.tsx와
    동형). ExternalPublishGateNotApprovedError는 구파일(baseline 등재)이라
    한글을 그대로 둬도 안전하지만, 이 신규 파일은 0→N 성장 자체가 §3779 가드
    위반이라 애초에 한글을 안 싣는다."""

    def __init__(self, *, reason: str | None):
        self.reason = reason
        detail = f"EXTERNAL_PUBLISH_PAUSED: {reason}" if reason else "EXTERNAL_PUBLISH_PAUSED"
        super().__init__(detail)


async def is_external_publish_paused(db: AsyncSession, *, org_id: uuid.UUID) -> tuple[bool, str | None]:
    """(paused?, reason). 3곳 삽입점이 어댑터 호출 直前에 부르는 유일한 조회
    함수 — 판정 로직을 한 곳에만 둔다(각 삽입점이 컬럼을 직접 읽지 않는다)."""
    org = (await db.execute(
        select(Organization.external_publish_paused_at, Organization.external_publish_pause_reason)
        .where(Organization.id == org_id)
    )).first()
    if org is None or org.external_publish_paused_at is None:
        return False, None
    return True, org.external_publish_pause_reason


async def set_external_publish_pause(
    db: AsyncSession, *, org_id: uuid.UUID, paused: bool, reason: str | None, actor_member_id: uuid.UUID,
) -> Organization:
    """AC2/AC3 — 스위치 전이 + 감사 로그 1건. 해제(paused=False)면 이 전이가 만든
    `blocked`+`failure_kind=paused` 명령을 자동 재큐까지 한 트랜잭션에서 마친다
    (신규 상태기계 0 — `retry_dead_letter_command`가 이미 blocked→pending 부활을
    하므로 그대로 재사용, story #3414 AC5 원래 용도는 connection 복구 대기였지만
    "사람이 재시도 개념을 다시 열어준다"는 사실 자체는 pause 해제와 동형).

    호출자가 커밋한다(이 함수는 flush만) — 라우터 트랜잭션 경계에 맞춘다(다른
    서비스 함수들과 동형 관례)."""
    org = await db.get(Organization, org_id)
    if org is None:
        raise ValueError(f"organization not found: {org_id}")

    now = datetime.now(timezone.utc)
    if paused:
        org.external_publish_paused_at = now
        org.external_publish_paused_by = actor_member_id
        org.external_publish_pause_reason = reason
        db.add(ExternalPublishPauseAuditLog(
            org_id=org_id, actor_member_id=actor_member_id, action="pause", reason=reason,
        ))
    else:
        org.external_publish_paused_at = None
        org.external_publish_paused_by = None
        org.external_publish_pause_reason = None
        db.add(ExternalPublishPauseAuditLog(
            org_id=org_id, actor_member_id=actor_member_id, action="resume", reason=reason,
        ))
        await _requeue_paused_commands(db, org_id=org_id)

    await db.flush()
    return org


async def _requeue_paused_commands(db: AsyncSession, *, org_id: uuid.UUID) -> int:
    """해제 시 이 조직이 pause 때문에 `blocked`된 명령만(다른 사유로 blocked된
    connection 복구 대기 명령은 절대 안 건드린다 — failure_kind로 구분) 골라
    `retry_dead_letter_command`로 하나씩 되돌린다. 같은 행을 pending으로 되돌릴 뿐 새 명령을
    만들지 않으므로 이 재큐가 명령을 두 벌로 만들지는 않는다(멱등키 UNIQUE org_id+destination+
    approved_version+operation+toggle_seq가 막는 건 «명령 삽입» 중복이다 — 발행 자체의 중복
    방지는 워커의 클레임(in_progress)과 게이트 재검증 몫, story #4195 문구 정정).

    ⚠️이 1회 스캔은 호출 순간 이미 blocked/paused인 행만 본다 — 워커가 pause를 읽은 뒤 blocked를
    커밋하기 전(in_progress)인 명령은 못 본다. 그 경합은 크론 tick마다 도는
    `requeue_paused_commands_of_unpaused_orgs`가 닫는다(story #4195 ①)."""
    from app.services.publication_command import retry_dead_letter_command

    rows = (await db.execute(
        select(PublicationCommand.id).where(
            PublicationCommand.org_id == org_id,
            PublicationCommand.status == "blocked",
            PublicationCommand.failure_kind == FAILURE_KIND_PAUSED,
        )
    )).scalars().all()
    requeued = 0
    for command_id in rows:
        revived = await retry_dead_letter_command(db, org_id=org_id, command_id=command_id, only_paused=True)
        if revived is not None:
            requeued += 1
    return requeued


async def requeue_paused_commands_of_unpaused_orgs(db: AsyncSession) -> int:
    """story #4195 ① — 크론 tick마다: pause가 풀린(external_publish_paused_at IS NULL) 조직의
    `blocked`·`failure_kind=paused` 명령을 `_requeue_paused_commands`로 되살린다. resume 한 번의 스캔이
    놓친 명령(차단 커밋 직전 in_progress)도 다음 tick에 복귀한다. 아직 멈춘 조직은 안 건드린다."""
    org_ids = (await db.execute(
        select(PublicationCommand.org_id).distinct()
        .join(Organization, Organization.id == PublicationCommand.org_id)
        .where(
            PublicationCommand.status == "blocked",
            PublicationCommand.failure_kind == FAILURE_KIND_PAUSED,
            Organization.external_publish_paused_at.is_(None),
        )
    )).scalars().all()
    requeued = 0
    for org_id in org_ids:
        requeued += await _requeue_paused_commands(db, org_id=org_id)
    return requeued
