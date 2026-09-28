"""story #4157(BE·테스트 하네스 정합, 페드루 PO 確定 2026-09-22) — ORM이 team_members.id
FK 7곳(conversation.py 4·event.py 2·api_key.py 1)을 아직 선언했지만, 실 DB(마이그 경유
fresh DB + baseline/schema.sql 직접 대조로 실측, PR 본문 AC1 표)는 그 중 어느 곳에도
FK가 없다 — 6곳은 0092가 DROP(canonical members.id로 정규화), 1곳(agent_api_keys.
team_member_id)은 baseline(0096) 스냅샷에도 부재(옛 코드주석의 "team_members_legacy를
가리킨다"는 주장은 이번 실측으로 틀렸음이 드러남).

ORM 선언만 남아 있으면 `Base.metadata.create_all()`(마이그 미경유) 테스트 하네스에서만
team_members가 실 테이블 + FK가 살아, prod에 없는 FK 위반이 테스트에서만 나고 시드마다
`TeamMember` 행을 손으로 심어야 통과한다(test_3313/4153/4156이 오늘 반복한 우회).

AC2 — 이 카드는 batch1/1b/2/2d(test_member_ssot_ac3_2*.py) 선례와 동형으로 "team_members
FK 전수 스캔" 가드로 스코프를 좁힌다(PO 確定 2026-09-22). 전수 ORM↔DB FK 비교는 이 카드
스코프 밖의 별개 드리프트 35건(0114 PK 드리프트와 같은 baseline-squash 클래스, ORM-only
28·DB-only 10)이 섞여 나와 별도 카드 후보로 PR 본문에 적어만 둔다(발명 0 — 실측 그대로)."""
from __future__ import annotations

from app.core.database import Base
import app.models  # noqa: F401 — 전 모델 임포트해 Base.metadata 완전 로드

_BLOCKED_TARGETS = ("team_members", "team_members_legacy")


def _team_members_fk_violations() -> list[str]:
    violations = []
    for table in sorted(Base.metadata.tables.values(), key=lambda t: t.name):
        for fk in table.foreign_keys:
            if fk.column.table.name in _BLOCKED_TARGETS:
                violations.append(f"{table.name}.{fk.parent.name} -> {fk.column.table.name}.{fk.column.name}")
    return violations


def test_no_orm_column_declares_team_members_foreign_key():
    """AC2 핵심 — ORM 어디에도 team_members(뷰)/team_members_legacy를 가리키는 FK가 없다
    (7곳 전수 정정 + 재발 방지: 누구든 새 컬럼에 `ForeignKey("team_members.id")`를 선언하면
    이 테스트가 RED로 잡는다 — 실 DB에 존재하지 않는 제약을 ORM에만 남기지 못하게)."""
    violations = _team_members_fk_violations()
    assert violations == [], f"team_members(뷰)/team_members_legacy를 가리키는 ORM FK 잔존: {violations}"


def test_seven_known_locations_are_clean_by_name():
    """AC1 표의 7곳을 이름으로 직접 지목해 회귀를 명시적으로 고정(위 전수 스캔의 부분집합
    이지만, "정확히 이 7곳이 고쳐졌다"를 이름으로 못박아 향후 리팩터로 컬럼명이 바뀌어도
    무엇을 지켜야 했는지 이 목록에서 드러나게 한다)."""
    from app.models.api_key import ApiKey
    from app.models.conversation import Conversation, ConversationMessage, ConversationParticipant
    from app.models.event import Event

    known = [
        (Conversation, "created_by"),
        (Conversation, "resolved_by"),
        (ConversationParticipant, "member_id"),
        (ConversationMessage, "sender_id"),
        (Event, "sender_id"),
        (Event, "recipient_id"),
        (ApiKey, "team_member_id"),
    ]
    for model, col in known:
        referred = {fk.column.table.name for fk in model.__table__.c[col].foreign_keys}
        assert not referred & set(_BLOCKED_TARGETS), (
            f"{model.__name__}.{col}에 team_members 계열 FK 잔존: {referred}"
        )
