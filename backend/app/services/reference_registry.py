"""story #2259(C-1) — entity type resolver registry.

⛔0-diff 확장 원칙: 대상 종류를 CHECK 로 나열하지 않는 대신, write-time 검증과 read-time
존재판정(§`reference_core.py`)을 이 registry 하나로 몬다. 새 타입을 열려면 여기 항목 하나만
추가하면 되고, `reference.py`/`reference_core.py` 몸통은 손대지 않는다.

⛔PO 판정(2026-07-28): "나열 안 한다"가 "아무거나 받는다"는 아니다 — registry 에 없는
타입은 write 시 거부한다(조용히 통과 금지). 그리고 이미 저장된 행 중 registry 에 없는
타입이 있는지 세는 점검(`count_orphan_types`)을 별도로 둔다(오타 타입이 조용히 쌓여도
DB CHECK 가 안 지켜 주니 이게 유일한 감시망).

⛔지금 실제로 등록하는 것은 **딱 3종**(doc·story·epic) — #2259 착수 시점에 실제로 도는
것만. 블루프린트가 언급한 나머지(sprint·artifact·hypothesis·goal·task·chat message·
evidence)는 "등록되면 열리는" 것이지, 쓰지도 않을 resolver 를 미리 짓는 것은 그 자체가
"만들어졌는데 도는 자리가 없는" 죽은 경로다(#2260이 고친 그 클래스를 재발시키지 않는다).

⛔story #2294(2026-07-28): 4번째로 `task` 를 연다 — 위 경계("쓰지도 않을 resolver 를
미리 짓지 않는다")에 어긋나지 않는다. `task` 는 이미 검색 허용목록(`entities.py
VALID_TYPES`)에 있어 화면이 이미 고를 수 있게 주고 있었다(소비자가 이미 서 있다) —
그런데 이 registry 에는 없어 `insert_chat_mentions` 의 `target_types` 기본값(=이 dict)이
`task` 를 조용히 걸러내고 있었다("화면은 주는데 서버가 막는" 제3의 결함 클래스, #2259
AC2가 요구한 "종류 하나 추가 + `reference.py`/`reference_core.py` diff 0"의 실증이기도
하다). `goal` 은 열지 않는다 — `epic` 과 물리적으로 같은 테이블(`Goal` = 구
"Epic"의 리네이밍, B1 계층 리네이밍) 이라 이미 `epic` 으로 열려 있다.

⛔B단계(2026-07-29, PO 판정 — "선생님 원문 «어떤 엔티티든지»를 채우는 것"): sprint·
artifact(VisualArtifact)·hypothesis·evidence 4종을 더 연다 — doc·story·epic·task가
이미 세운 "resolver + project_id resolver + TARGET 게이트" 절차를 그대로 반복한다.
  · sprint·hypothesis — Goal(epic)과 동형: SoftDeleteMixin 없음(하드 삭제) — row 존재
    자체가 존재판정. Hypothesis의 `archived_at`은 삭제 마커가 아니라 라이프사이클
    상태(§3.10 "archive=soft, hard delete는 정책 확定 전까지 금지" — 즉 archived여도
    row는 여전히 "존재"하고 참조 가능해야 한다)라 필터하지 않는다.
  · artifact(VisualArtifact) — doc과 동형: `deleted_at` soft-delete 필터.
  · evidence — project_id 컬럼이 없다(work_item_id/work_item_type로 story/task를
    폴리모픽 참조). project_id 해석은 work_item_type으로 분기해 Story 또는
    Task→Story join으로 간접 해소한다(task의 project_id resolver와 동일 join 패턴).

⛔story #2273(C-1b) 실측으로 발견: source(자리)와 target(대상)은 "존재판정이 필요한가"가
다르다 — chat_message는 정당한 source_type(채팅 write-path가 실제로 매일 쓰는 값)이지만
**target으로 가리켜질 일이 없어 resolver가 없다**(메시지는 불변·삭제돼도 backlinks
read-path의 LEFT JOIN이 자연히 걸러낸다, 별도 존재판정 불필요). 이걸 ENTITY_RESOLVERS
(target 전용 registry)에 없다고 "오타/미등록"으로 취급하면 **정상 데이터를 사고로 오탐**한다
(count_orphan_types 실측에서 직접 걸림 — chat_message가 source로 366건 "orphan"으로
잡혔던 것). `SOURCE_ONLY_TYPES`가 그 구분을 명시한다: source로는 유효하나 target
존재판정은 없는 타입.
"""
from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

EntityExistsResolver = Callable[[AsyncSession, uuid.UUID, list[uuid.UUID]], Awaitable[set[uuid.UUID]]]


async def _resolve_docs(session: AsyncSession, org_id: uuid.UUID, ids: list[uuid.UUID]) -> set[uuid.UUID]:
    from app.models.doc import Doc

    rows = (
        await session.execute(
            select(Doc.id).where(Doc.org_id == org_id, Doc.id.in_(ids), Doc.deleted_at.is_(None))
        )
    ).scalars().all()
    return set(rows)


async def _resolve_stories(session: AsyncSession, org_id: uuid.UUID, ids: list[uuid.UUID]) -> set[uuid.UUID]:
    from app.models.pm import Story

    rows = (
        await session.execute(
            select(Story.id).where(Story.org_id == org_id, Story.id.in_(ids), Story.deleted_at.is_(None))
        )
    ).scalars().all()
    return set(rows)


async def _resolve_epics(session: AsyncSession, org_id: uuid.UUID, ids: list[uuid.UUID]) -> set[uuid.UUID]:
    from app.models.pm import Goal

    # Goal(epic)엔 SoftDeleteMixin이 없다(하드 삭제) — row 존재 자체가 존재판정.
    rows = (
        await session.execute(select(Goal.id).where(Goal.org_id == org_id, Goal.id.in_(ids)))
    ).scalars().all()
    return set(rows)


async def _resolve_tasks(session: AsyncSession, org_id: uuid.UUID, ids: list[uuid.UUID]) -> set[uuid.UUID]:
    from app.models.pm import Task

    rows = (
        await session.execute(
            select(Task.id).where(Task.org_id == org_id, Task.id.in_(ids), Task.deleted_at.is_(None))
        )
    ).scalars().all()
    return set(rows)


async def _resolve_sprints(session: AsyncSession, org_id: uuid.UUID, ids: list[uuid.UUID]) -> set[uuid.UUID]:
    from app.models.pm import Sprint

    # Sprint엔 SoftDeleteMixin이 없다(하드 삭제) — row 존재 자체가 존재판정(epic과 동형).
    rows = (
        await session.execute(select(Sprint.id).where(Sprint.org_id == org_id, Sprint.id.in_(ids)))
    ).scalars().all()
    return set(rows)


async def _resolve_artifacts(session: AsyncSession, org_id: uuid.UUID, ids: list[uuid.UUID]) -> set[uuid.UUID]:
    from app.models.visual_artifact import VisualArtifact

    rows = (
        await session.execute(
            select(VisualArtifact.id).where(
                VisualArtifact.org_id == org_id, VisualArtifact.id.in_(ids),
                VisualArtifact.deleted_at.is_(None),
            )
        )
    ).scalars().all()
    return set(rows)


async def _resolve_hypotheses(session: AsyncSession, org_id: uuid.UUID, ids: list[uuid.UUID]) -> set[uuid.UUID]:
    from app.models.hypothesis import Hypothesis

    # archived_at은 삭제 마커가 아니라 라이프사이클 상태(하드 삭제 정책 확定 전까지 금지) —
    # 필터하지 않는다. row 존재 자체가 존재판정(epic·sprint와 동형).
    rows = (
        await session.execute(select(Hypothesis.id).where(Hypothesis.org_id == org_id, Hypothesis.id.in_(ids)))
    ).scalars().all()
    return set(rows)


async def _resolve_chat_messages(session: AsyncSession, org_id: uuid.UUID, ids: list[uuid.UUID]) -> set[uuid.UUID]:
    """story #2263(C-7, 2026-07-29) — chat_message가 처음으로 TARGET이 되는 자리(proof가
    대화 메시지를 인용). ⛔ENTITY_RESOLVERS에는 안 들어간다(PO 판정, 아래 TARGET_ONLY_TYPES
    참조) — 검색 대상도 project축도 MCP mention 대상도 아니라 "완전지원 엔티티" 다섯 계약을
    구조적으로 못 갖춘다. 이 resolver는 TARGET_ONLY_RESOLVERS를 통해 존재판정에만 쓰인다.
    (메시지 자체엔 org_id 컬럼이 없어 Conversation을 통해서만 org 스코프 가능 — join 필요.)"""
    from app.models.conversation import Conversation, ConversationMessage

    rows = (
        await session.execute(
            select(ConversationMessage.id)
            .join(Conversation, Conversation.id == ConversationMessage.conversation_id)
            .where(Conversation.org_id == org_id, ConversationMessage.id.in_(ids))
        )
    ).scalars().all()
    return set(rows)


async def _resolve_evidence(session: AsyncSession, org_id: uuid.UUID, ids: list[uuid.UUID]) -> set[uuid.UUID]:
    from app.models.evidence import Evidence

    rows = (
        await session.execute(select(Evidence.id).where(Evidence.org_id == org_id, Evidence.id.in_(ids)))
    ).scalars().all()
    return set(rows)


# entity_type(str) -> resolver. 각 resolver 는 (session, org_id, ids) -> {존재하는 id 집합}.
# ⛔이 dict 가 «완전지원 엔티티» SSOT다 — 여기 들어가면 다섯 계약을 전부 진다: ①존재판정
# ②entities/search handler ③PROJECT_ID_RESOLVERS 동일 키 ④MCP mention 엔드포인트
# ⑤reference_token 빌더 대상. story #2263(C-7, 2026-07-29)에서 chat_message를 «존재판정만»
# 필요해서 여기 넣었다가 CI 13건이 한 번에 깨졌다(PO 판정, 2026-07-29) — 검색 대상이 아니고
# ·project 축이 아니고·단독조회 라우트가 없어 ②③④를 구조적으로 못 갖추는데 그 셋을
# 강제로 요구받은 것. 「target이 될 수 있다」와 「완전지원 엔티티다」는 다른 축이라 — 그
# 둘을 가르는 자리가 아래 TARGET_ONLY_TYPES다.
ENTITY_RESOLVERS: dict[str, EntityExistsResolver] = {
    "doc": _resolve_docs,
    "story": _resolve_stories,
    "epic": _resolve_epics,
    "task": _resolve_tasks,
    "sprint": _resolve_sprints,
    "artifact": _resolve_artifacts,
    "hypothesis": _resolve_hypotheses,
    "evidence": _resolve_evidence,
}


# source_type으로는 유효하나 target 존재판정(resolver)은 없는 타입 — 위 모듈 docstring
# 참조. chat_message가 그 멤버다(채팅 write-path가 매일 쓰는 정당한 source — mention_parser.py
# 참조, 이 PR과 무관한 원래 용도). ⛔story #2263(2026-07-29) 한때 이 집합을 비우고 chat_message
# 를 ENTITY_RESOLVERS로 옮겼었으나 되돌렸다(그 등록이 검색·MCP·project축 계약까지 강제해
# CI 13건이 깨졌다, PO 판정) — chat_message는 source_only이면서 «동시에» target_only(아래)
# 이기도 하다, 서로 배타적이지 않다.
SOURCE_ONLY_TYPES: frozenset[str] = frozenset({"chat_message"})

# ⛔TARGET_ONLY_TYPES(SOURCE_ONLY_TYPES와 대칭, story #2263 PO 판정 2026-07-29) — target은
# 될 수 있으나(존재판정 가능) ENTITY_RESOLVERS의 나머지 네 계약(검색·project축·MCP
# mention·reference_token)은 구조적으로 못 갖추는 타입. chat_message가 첫 멤버 — proof
# form이 대화 메시지를 인용해 target이 되지만, 메시지는 검색 대상이 아니고(민 확認)
# project로 스코프되지 않고(참여자 기반, #2261부터 알려진 "넷째 경계") 단독조회 라우트가
# 없다(conversations.py의 메시지 라우트 4개 전부 conversation_id를 path에 요구). 위
# SOURCE_ONLY_TYPES와 겹치는 멤버(chat_message)가 있는 것은 정상이다 — source 자격과
# target 자격은 독립된 두 질문이다.
TARGET_ONLY_TYPES: frozenset[str] = frozenset({"chat_message"})

# TARGET_ONLY_TYPES 멤버의 존재판정 resolver. ENTITY_RESOLVERS와 분리된 이유는 위와 동일 —
# 이 dict에 들어간다고 검색/MCP/project축 계약까지 진 것으로 오인되면 안 된다.
TARGET_ONLY_RESOLVERS: dict[str, EntityExistsResolver] = {
    "chat_message": _resolve_chat_messages,
}


def is_registered_entity_type(entity_type: str) -> bool:
    """«완전지원 엔티티» 판정용(검색·MCP mention·reference_token 등) — ENTITY_RESOLVERS
    멤버인가. TARGET_ONLY_TYPES는 의도적으로 포함하지 않는다(위 모듈 주석 참조)."""
    return entity_type in ENTITY_RESOLVERS


def is_valid_target_type(entity_type: str) -> bool:
    """target_type 검증용(write-path, insert_reference가 부른다) — 존재판정(resolver)이
    있는 타입인가. ENTITY_RESOLVERS(완전지원)이거나 TARGET_ONLY_TYPES(target 전용)면 OK —
    `is_registered_entity_type`과 달리 TARGET_ONLY_TYPES도 통과시킨다(그게 이 함수가
    따로 존재하는 이유)."""
    return entity_type in ENTITY_RESOLVERS or entity_type in TARGET_ONLY_TYPES


def is_valid_source_type(entity_type: str) -> bool:
    """source_type 검증용 — target-capable(ENTITY_RESOLVERS) 이거나 source-only 인가."""
    return entity_type in ENTITY_RESOLVERS or entity_type in SOURCE_ONLY_TYPES


# ─── story #2283 — target TARGET 접근 게이트(project_id 조회) ────────────────
# ⛔ENTITY_RESOLVERS(존재판정)와 별개 축이다: "이 id가 존재하는가"와 "그 엔티티의 project_id는
# 무엇인가"는 다른 질문이다(has_project_access가 project_id를 요구한다). 같은 3개 타입에
# 대해 각각 별도 함수가 필요하지만(테이블이 다르므로 구조적으로 불가피), registry 자체는
# ENTITY_RESOLVERS와 **동형 dict**로 둔다 — 새 타입을 열 때 두 registry에 항목을 "같이"
# 추가하게 강제하려면 dict가 갈라져 있어야 한다(합치면 "존재판정만 있고 project_id 조회는
# 없는" 조용한 누락이 가능해진다). 두 registry의 key 집합이 같은지는 테스트로 고정한다
# (test_2283_references_realdb.py) — twin-system drift 방지.

EntityProjectIdResolver = Callable[[AsyncSession, uuid.UUID, uuid.UUID], Awaitable["uuid.UUID | None"]]


async def _project_id_of_doc(session: AsyncSession, org_id: uuid.UUID, entity_id: uuid.UUID) -> uuid.UUID | None:
    from app.models.doc import Doc

    return (
        await session.execute(
            select(Doc.project_id).where(Doc.id == entity_id, Doc.org_id == org_id, Doc.deleted_at.is_(None))
        )
    ).scalar_one_or_none()


async def _project_id_of_story(session: AsyncSession, org_id: uuid.UUID, entity_id: uuid.UUID) -> uuid.UUID | None:
    from app.models.pm import Story

    return (
        await session.execute(
            select(Story.project_id).where(Story.id == entity_id, Story.org_id == org_id, Story.deleted_at.is_(None))
        )
    ).scalar_one_or_none()


async def _project_id_of_epic(session: AsyncSession, org_id: uuid.UUID, entity_id: uuid.UUID) -> uuid.UUID | None:
    from app.models.pm import Goal

    return (
        await session.execute(select(Goal.project_id).where(Goal.id == entity_id, Goal.org_id == org_id))
    ).scalar_one_or_none()


async def _project_id_of_task(session: AsyncSession, org_id: uuid.UUID, entity_id: uuid.UUID) -> uuid.UUID | None:
    from app.models.pm import Story, Task

    # Task엔 project_id 컬럼이 없다(story_id FK만) — entities.py search_entities의 task 분기와
    # 동일하게 Story를 join해 project_id를 얻는다(재구현 0 — 같은 스코핑 규칙).
    return (
        await session.execute(
            select(Story.project_id)
            .join(Task, Task.story_id == Story.id)
            .where(Task.id == entity_id, Task.org_id == org_id, Task.deleted_at.is_(None))
        )
    ).scalar_one_or_none()


async def _project_id_of_sprint(session: AsyncSession, org_id: uuid.UUID, entity_id: uuid.UUID) -> uuid.UUID | None:
    from app.models.pm import Sprint

    return (
        await session.execute(
            select(Sprint.project_id).where(Sprint.id == entity_id, Sprint.org_id == org_id)
        )
    ).scalar_one_or_none()


async def _project_id_of_artifact(session: AsyncSession, org_id: uuid.UUID, entity_id: uuid.UUID) -> uuid.UUID | None:
    from app.models.visual_artifact import VisualArtifact

    return (
        await session.execute(
            select(VisualArtifact.project_id).where(
                VisualArtifact.id == entity_id, VisualArtifact.org_id == org_id,
                VisualArtifact.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()


async def _project_id_of_hypothesis(session: AsyncSession, org_id: uuid.UUID, entity_id: uuid.UUID) -> uuid.UUID | None:
    from app.models.hypothesis import Hypothesis

    return (
        await session.execute(
            select(Hypothesis.project_id).where(Hypothesis.id == entity_id, Hypothesis.org_id == org_id)
        )
    ).scalar_one_or_none()


async def _project_id_of_evidence(session: AsyncSession, org_id: uuid.UUID, entity_id: uuid.UUID) -> uuid.UUID | None:
    from app.models.evidence import Evidence
    from app.models.pm import Story, Task

    # Evidence엔 project_id가 없다 — work_item_id/work_item_type(story|task 폴리모픽)을
    # 통해 간접 해소한다. task 케이스는 task의 project_id resolver와 동일한 Story join.
    row = (
        await session.execute(
            select(Evidence.work_item_id, Evidence.work_item_type).where(
                Evidence.id == entity_id, Evidence.org_id == org_id,
            )
        )
    ).first()
    if row is None:
        return None
    work_item_id, work_item_type = row
    if work_item_type == "story":
        return (
            await session.execute(
                select(Story.project_id).where(
                    Story.id == work_item_id, Story.org_id == org_id, Story.deleted_at.is_(None),
                )
            )
        ).scalar_one_or_none()
    if work_item_type == "task":
        return (
            await session.execute(
                select(Story.project_id)
                .join(Task, Task.story_id == Story.id)
                .where(Task.id == work_item_id, Task.org_id == org_id, Task.deleted_at.is_(None))
            )
        ).scalar_one_or_none()
    # work_item_type이 알려진 두 값(story·task) 밖이면 project_id를 모른다 — has_project_access
    # 호출부가 None을 404로 번역한다(조용히 통과 금지).
    return None


PROJECT_ID_RESOLVERS: dict[str, EntityProjectIdResolver] = {
    "doc": _project_id_of_doc,
    "story": _project_id_of_story,
    "epic": _project_id_of_epic,
    "task": _project_id_of_task,
    "sprint": _project_id_of_sprint,
    "artifact": _project_id_of_artifact,
    "hypothesis": _project_id_of_hypothesis,
    "evidence": _project_id_of_evidence,
}


async def count_orphan_types(session: AsyncSession, org_id: uuid.UUID | None = None) -> dict[str, int]:
    """⭐PO가 요구한 감시망 — entity_references 에 저장된 행 중 source_type/target_type 이
    registry(+source-only 허용목록)에 없는 것을 종류별로 센다. 0이 정상 — 0이 아니면
    오타/미등록 타입이 조용히 쓰기를 통과한 사고(이 함수가 잡아야 하는 그 사고)다.
    org_id=None(기본) = 전체 org.

    ⛔story #2273(C-1b) AC10: "도는 자리"(cron endpoint)를 주는 배선은 이 PR에서 CI 회귀를
    일으켜(전역 CRON_SECRET 누수 의심) 별도 PR로 분리했다 — 이 함수 자체는 그대로 두되,
    호출자 배선은 그 후속 PR 몫이다.

    ⛔source_type과 target_type은 다른 "known" 집합으로 판정한다(SOURCE_ONLY_TYPES 참조) —
    같은 집합으로 재면 chat_message 같은 정상 source가 오탐된다(실측으로 걸린 자리).

    ⛔story #2263(C-7) 후속: target 쪽도 ENTITY_RESOLVERS만으로는 부족하다 — TARGET_ONLY_TYPES
    (chat_message)를 뺴면 proof가 만든 정당한 target이 orphan으로 오탐된다."""
    from collections import Counter

    from app.models.reference import Reference

    known_targets = set(ENTITY_RESOLVERS) | TARGET_ONLY_TYPES
    known_sources = known_targets | SOURCE_ONLY_TYPES
    stmt = select(Reference.source_type, Reference.target_type)
    if org_id is not None:
        stmt = stmt.where(Reference.org_id == org_id)
    rows = (await session.execute(stmt)).all()
    counts: Counter[str] = Counter()
    for source_type, target_type in rows:
        if source_type not in known_sources:
            counts[f"source:{source_type}"] += 1
        if target_type not in known_targets:
            counts[f"target:{target_type}"] += 1
    return dict(counts)
