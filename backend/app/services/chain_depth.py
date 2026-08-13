"""story #2608 P1(delivery-contract-blueprint-v0-1) — 인간 앵커 없는 에이전트 연쇄의 깊이.

블루프린트 §3: "인간 앵커 없는 에이전트 연쇄에서 전달 계약은 깊이 N까지 유효하다"를
**새 카운터 컬럼이 아니라 매번 유도되는 조회**로 표현한다(디디 그라운딩, PO 승인 08-13).
`conversation_messages`는 이미 conversation_id 인덱스 + created_at을 갖고 있어, 최근
N+1건을 최신순으로 가져와 맨 앞부터 "발신자 type='agent'"인 것만 세다가 처음 human(또는
발신자 없음)을 만나면 멈추는 단일 쿼리(LIMIT N+1, O(N))로 "지금 이 순간의 연쇄 깊이"를
그때그때 다시 계산한다.

state를 안 만드는 것 자체가 요점이다 — 별도 카운터 컬럼이었다면 "언제 리셋하나"가 그 자체로
버그 표면(놓치면 영구 증가·이중 리셋 등)이었을 것을, 매번 human 메시지 유무를 다시 보는
조회로 대체해 그 표면 자체를 없앤다. human 메시지가 오면 다음 조회가 자동으로 그걸 반영
(별도 리셋 로직 불요).

이 모듈은 route_message()(recipient별 필터)와 conversations.py의 human-intervention 이벤트
판정(연쇄당 1회) 양쪽에서 **같은 함수**를 호출한다 — "판정이 단일 함수에서 이루어진다"(AC3)는
계산 로직이 하나라는 뜻이지 호출 지점이 하나여야 한다는 뜻이 아니다(호출부가 둘인 이유:
recipient 필터는 recipient별 반복 안에서, 이벤트 발생은 메시지당 1회만 필요해 자연히
호출 위치가 갈린다 — 로직 자체의 복제는 없다)."""
from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.conversation import ConversationMessage
from app.models.team import TeamMember


async def compute_agent_chain_depth(
    db: AsyncSession, conversation_id: uuid.UUID, *, max_scan: int,
) -> int:
    """이 대화의 "가장 최근 메시지부터 역순으로, human 메시지가 나오기 전까지의 연속 agent
    발신 메시지 수"를 반환한다 — 방금 전송된(호출 시점에 이미 flush된) 메시지 자신도 그
    발신자가 agent면 이 카운트에 포함된다(그게 바로 "이 메시지까지 포함해서 몇 번째 연쇄
    hop인가"라는 질문의 정답이다).

    최신순으로 최대 `max_scan + 1`건만 본다(그 이상은 어차피 cap 판정에 필요 없다 — 조기
    종료로 쿼리·순회 비용을 O(max_scan)으로 고정). **cap 초과 판정은 호출부가 `depth >
    max_scan`으로 한다**(등호 없음 — 정확히 max_scan번째 hop까지는 유효, max_scan+1번째부터
    차단). 발신자가 없거나(시스템 메시지 등) team_members에서 조회 안 되는 경우는 human과
    동형으로 취급(연쇄를 끊음 — 애매하면 더 보수적인 쪽, 즉 "덜 막는" 쪽이 아니라 "확실히
    안전한" 쪽을 택한다)."""
    rows = (
        await db.execute(
            select(ConversationMessage.sender_id)
            .where(ConversationMessage.conversation_id == conversation_id)
            .order_by(ConversationMessage.created_at.desc())
            .limit(max_scan + 1)
        )
    ).scalars().all()
    if not rows:
        return 0

    sender_ids = {sid for sid in rows if sid is not None}
    type_map: dict[uuid.UUID, str] = {}
    if sender_ids:
        type_rows = (
            await db.execute(
                select(TeamMember.id, TeamMember.type).where(TeamMember.id.in_(sender_ids))
            )
        ).all()
        type_map = {r[0]: r[1] for r in type_rows}

    depth = 0
    for sender_id in rows:
        if sender_id is not None and type_map.get(sender_id) == "agent":
            depth += 1
        else:
            break
    return depth
