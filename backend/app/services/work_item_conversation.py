"""story #3860(customer-zero·BE·게이트 답하기, 2026-09-14) — work_item↔conversation 파생 SSOT.

두 경로를 today_service.py(`_resolve_needs_me`·`_resolve_agent_progress`, story #3823/
PR #4253 PO 리뷰)에서 그대로 뽑았다 — 로직 복제가 아니라 **이관**이다(today_service.py는
이 모듈을 호출하도록 리팩터됐다, 옛 인라인 코드는 남지 않는다).

⛔둘 다 **caller(member_id)-scoped**다 — 의도적: 캐폴러가 참여하지 않은 대화(특히 DM)의
id를 그대로 내보내면 클릭 시 403 죽은 링크이자 그 대화 존재 자체를 캐폴러에게 노출한다
(PR #4253 PO 리뷰 CHANGES가 이 두 경로 모두에 심은 불변식 — 이 모듈이 그 불변식을 한
곳으로 모은다). caller-agnostic 버전을 만들지 않는다.

- 경로 A(태그 기반, `derive_conversation_ids_for_tagged_work_items`) — work_item이 채팅
  메시지에서 `msg_metadata["work_item"]` 태그로 언급된 적이 있으면, 캐폴러가 참여자인
  그 대화 중 가장 최근 것. Gate(work_item_type/id 페어)가 이 경로를 쓴다.
- 경로 B(run 기반, `filter_participant_conversation_ids`) — 이미 `conversation_id`를
  들고 있는 레코드(AgentRun 등)가 있을 때, 캐폴러가 실제 참여자인 것만 통과시키는
  필터. HitlRequest(run_id→AgentRun.conversation_id)가 이 경로를 쓴다.

두 함수 다 배치(N+1 0) — 빈 입력이면 쿼리 자체를 안 던진다(today_service.py의 기존
`if work_item_pairs:`/`if conv_ids:` 가드와 동일 원칙, 그대로 이관)."""
from __future__ import annotations

import uuid

from sqlalchemy import Text, literal_column, select
from sqlalchemy.ext.asyncio import AsyncSession


async def derive_conversation_ids_for_tagged_work_items(
    session: AsyncSession,
    *,
    org_id: uuid.UUID,
    member_id: uuid.UUID,
    work_item_pairs: set[tuple[str, uuid.UUID]] | list[tuple[str, uuid.UUID]],
) -> dict[tuple[str, uuid.UUID], uuid.UUID]:
    """work_item(type, id) 페어별로, 캐폴러가 참여자인 대화 중 그 work_item을 태그한
    가장 최근 메시지의 conversation_id. 태그 이력이 없거나 캐폴러가 그 대화 참여자가
    아니면 그 페어는 반환 dict에 아예 없다(값 None이 아니라 키 자체가 없음 — 호출부가
    `.get(key)`로 자연히 None을 받는다)."""
    conversation_by_work_item: dict[tuple[str, uuid.UUID], uuid.UUID] = {}
    pairs = list(work_item_pairs)
    if not pairs:
        return conversation_by_work_item

    from app.models.conversation import Conversation, ConversationMessage, ConversationParticipant

    wi_types = {t for t, _ in pairs}
    wi_ids = {str(i) for _, i in pairs}
    # story #4332 — 식은 인덱스 `ix_conversation_messages_work_item_tag`(0412)와 **같은 식**이어야 인덱스를 탄다. 예전엔 이 조회가
    # conversation_messages를 전부 훑었다(dev 98,776행 · 69~169ms · 게이트 목록 요청마다). JSON 키는 리터럴 SQL로 박는다 —
    # `msg_metadata["work_item"]["type"]`은 `metadata[$1] ->> $2`(첨자 + 바인드 키)로 나가 인덱스 식(`->` 연산자 · 상수 키)과 다른 식이라
    # 플래너가 절대 못 맞춘다(events.py `_find_existing_stage_publish` · 0384와 같은 함정 · 같은 처방). 키는 코드 상수라 주입 위험 없음 ·
    # 비교 값만 바인드. work item마다 최신 1건만(DISTINCT ON — 인덱스 순서 (type, id, created_at DESC) 그대로).
    tag_type = literal_column("(conversation_messages.metadata->'work_item'->>'type')", Text)
    tag_id = literal_column("(conversation_messages.metadata->'work_item'->>'id')", Text)
    tag_rows = (await session.execute(
        select(tag_type, tag_id, ConversationMessage.conversation_id)
        .join(Conversation, Conversation.id == ConversationMessage.conversation_id)
        .join(
            ConversationParticipant,
            ConversationParticipant.conversation_id == ConversationMessage.conversation_id,
        )
        .where(
            Conversation.org_id == org_id,
            ConversationParticipant.member_id == member_id,
            tag_type.in_(wi_types),
            tag_id.in_(wi_ids),
        )
        .distinct(tag_type, tag_id)
        .order_by(tag_type, tag_id, ConversationMessage.created_at.desc())
    )).all()
    for wi_type, wi_id, conv_id in tag_rows:
        conversation_by_work_item[(wi_type, uuid.UUID(wi_id))] = conv_id
    return conversation_by_work_item


async def filter_participant_conversation_ids(
    session: AsyncSession,
    *,
    member_id: uuid.UUID,
    conversation_ids: set[uuid.UUID],
) -> set[uuid.UUID]:
    """주어진 conversation_id 후보 집합 중 캐폴러가 실제 참여자인 것만. 빈 입력이면
    쿼리 0(N+1 회피 가드 그대로 이관)."""
    if not conversation_ids:
        return set()

    from app.models.conversation import ConversationParticipant

    return set((await session.execute(
        select(ConversationParticipant.conversation_id).where(
            ConversationParticipant.conversation_id.in_(conversation_ids),
            ConversationParticipant.member_id == member_id,
        )
    )).scalars().all())


async def conversation_project_ids(
    session: AsyncSession,
    *,
    conversation_ids: set[uuid.UUID],
) -> dict[uuid.UUID, uuid.UUID]:
    """story #4231 — 대화 id별 그 대화의 프로젝트(`conversations.project_id` · nullable=False). 위 두 경로가 고른 대화는
    work_item · 요청자 프로젝트와 다를 수 있어(대화는 조직 안 어느 프로젝트에나 있다), FE 딥링크가 현재 p가 아니라 대화
    자기 프로젝트(`?p=`)를 싣게 같이 낸다. 배치 · 빈 입력이면 쿼리 0."""
    if not conversation_ids:
        return {}

    from app.models.conversation import Conversation

    return {
        cid: pid
        for cid, pid in (await session.execute(
            select(Conversation.id, Conversation.project_id).where(Conversation.id.in_(conversation_ids))
        )).all()
    }
