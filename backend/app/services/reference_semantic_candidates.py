"""story #2328(C-11 ㉡층, E-CONNECT) — 참조(관찰됨, #2269가 이미 함)에 「의미 후보」를 얹는다
(3단계 승격의 ②층: 참조→의미 후보→실행 관계). `entity_references`(Reference)·
`reference_core.py` 둘 다 스스로 「의미(잇따름·필요함 등)를 여기서 저장·판정하지 않는다」고
명시한 그 경계를 그대로 지키고, 별도 표(`ReferenceSemanticCandidate`)에 「추정」으로만 쌓는다.

⛔이 모듈이 다루는 범위는 story description/acceptance_criteria의 맨 번호(`#<번호>`)가 다른
story를 가리키는 경우만이다(#2269 AC0-3이 잰 그 모집단과 동일 — bracket 멘션
(`entity:story:uuid` 문법)은 이 축이 아니다, 섞으면 AC1이 재검증한 57.5% 기준이 흐려진다).

⛔새 참조만 다룬다(PO 판정 2026-07-29 ③, 소급 안 함) — 이 모듈은 스스로 "새것"을 판정하지
않는다. caller(`app/routers/stories.py`의 `update_story`)가 매 story 저장(생성·수정)마다
호출하므로, 호출 시점 자체가 "지금 저장되는 콘텐츠"라는 사실이 새것임을 보장한다 — 배치
백필 진입점은 이 모듈에 없다(의도적으로 만들지 않았다).

⛔미래번호(모집단에 없는 대상, PO 판정 2026-07-29 ②)는 여기서 후보 자체를 안 만든다 —
`resolve_bare_number_story_targets`가 해소하지 못한 번호는 조용히 스킵한다(제외 건수는
호출부가 로그/집계로 남긴다, 이 함수의 반환값 자체가 "몇 건 스킵됐는지"를 셀 수 있게
`len(pairs) - len(rows)`로 계산 가능하다 — 별도 카운터를 안 둔다).
"""
from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.reference_semantic_candidate import (
    RELATION_KINDS,
    ReferenceSemanticCandidate,
)
from app.models.rejected_relation import RejectedRelation
from app.services.mention_parser import (
    _BARE_STORY_NUMBER_RE,
    _redact_code_spans,
    resolve_bare_number_story_targets,
)

# ⭐AC6(2026-07-29, PO 지시로 실측 → PO 자가교정 → PO 최종판정: 되살림): 같은 40건 표본
# (오늘 시드 20260730, story_refcheck_classification_20260728.md 정답표 대조) 실측 결과:
#   ⛔「관계 아님」(근거인용/동종사례) 23건 중 규칙이 「관계」(낳음/잇따름)로 잘못 붙인
#     건수 = 0/23 — 이 판의 유일한 «무서운 실패»(거짓 연결 생성, AC7)는 0건.
#   「관계」(23건의 여집합, 17건) 중 규칙이 관계로 «붙인» 것 = 4/17.
#   ⭐진짜 결정축은 recall(4/17)이 아니라 precision — **규칙이 뭔가를 붙인 4건이 4건 다
#   맞았다**(n=4·모집단 40·시드 20260730 — n이 작아 "100%"라 적지 않는다). 「말을 걸었을
#   때 틀린 적이 없다」가 이 판(AC7: 후보가 배경 소음이 되면 실패)의 핵심 축이고, 놓친
#   13건은 손해가 아니다 — 미분류로 후보에 그대로 남는다(AC10, 안 버려진다).
#
# ⛔⛔절대 하지 말 것(PO 명시): **재현율(recall)을 올리려고 규칙을 늘리지 않는다.** 맞춘
# 4건은 전부 "명시적 화살표 체인"·"검수 중 발견" 같은 **강한 표면단서**뿐이었다 — 약한
# 신호(예: 그냥 "같은" 한 단어, 문맥 추론 필요한 것)까지 잡으러 규칙을 넓히면 0/23이
# 깨질 위험이 있다. "23.5%밖에 안 되니 규칙을 늘리자"는 판단이 이 설계의 진짜 위험이다
# — 그 유혹을 막는 게 아래 회귀테스트(0/23을 실제 코드로 고정)의 목적이다.
#
# ⛔kind(관계 종류)는 낸다 — 단 kind 자체의 정확도는 «측정하지 않았다»(위 실측은 "관계인가
# 아닌가"만 쟀다, "그 관계가 정확히 무슨 종류인가"는 별도 축이라 미측정). 응답 소비자는
# candidate.status가 항상 "estimated"(추정됨, AC3)임을 통해 이게 확정이 아니라는 것을
# 알아야 한다 — kind 필드 자체에 "미측정" 라벨을 얹지 않는 이유는 status 필드가 이미 그
# 신호를 전 레코드에 걸쳐 표현하기 때문이다(중복 표현 안 함).
#
# ⛔PO 지적(2026-07-29, 미르코군의 qa-리터럴-노출 사고와 자매 문제): 값은 영문 식별자여야
# 한다 — DB 값은 식별자, 사람이 읽는 말은 en.json/ko.json 번역 몫. 아래 키는
# `app.models.reference_semantic_candidate.RELATION_KIND_LABELS_KO`로 원표(한글) 대조 유지.
_KEYWORD_RULES: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("followed", re.compile(r"의존[:：]|의존\s*그래프|→.*→|앞에\s*서는가")),
    ("spawned", re.compile(
        r"신규\s*스토리\s*등재|중\s*발견|중\s*적출|발견\s*\(#|발단\s*[—\-]|검수\s*중|"
        r"수행\s*중\s*직접\s*발견"
    )),
    ("similar_case", re.compile(r"같은\s*병|같은\s*성질|같은\s*계열|결함\s*계열|같은\s*클래스")),
    ("explicitly_unrelated", re.compile(r"직교|무관(?!심)")),
    ("cited_as_evidence", re.compile(r"머지\s*`[0-9a-f]+`\s*\(PR\s*#|PR\s*#\d+\s*본문에\s*기록|확認\s*완료")),
)

_SNIPPET_RADIUS = 80


@dataclass(frozen=True)
class CandidateRow:
    """`build_candidate_rows`가 만드는 결과 — 아직 DB에 안 쓴 순수 데이터."""

    matched_number: int
    target_story_id: uuid.UUID
    snippet: str
    relation_kind: str | None  # None = 미분류(AC10, taxonomy 밖도 버리지 않는다)
    matched_keyword: str | None


def classify_relation_kind(snippet: str) -> tuple[str | None, str | None]:
    """규칙 기반 표면단서 매칭(순서=우선순위, AC6 실측으로 precision=4/4 확認된 강한 신호만).
    매치 없으면 (None, None) — 「미분류」도 버리지 않고 저장한다(AC10 — 표본 26번 자기참조
    처럼 taxonomy 밖 사례가 실제로 존재함을 #2328 AC1 재검증에서 확認했다). ⛔이 규칙표에
    약한 신호를 추가하지 않는다(위 모듈 docstring "절대 하지 말 것" 참조)."""
    for kind, pattern in _KEYWORD_RULES:
        if pattern.search(snippet):
            return kind, pattern.pattern
    return None, None


def extract_bare_number_candidates_with_snippets(content: str) -> list[tuple[int, str]]:
    """`mention_parser.extract_bare_number_candidates`와 같은 정규식·코드블록 제외 로직을
    쓰되(regex/redaction 함수를 그대로 재사용 — 정의를 다시 짜지 않는다), 분류기가 읽을
    스니펫도 함께 순서보존+중복제거로 반환한다. 원 함수는 `list[int]` 반환 계약을 그대로
    유지한다(기존 호출부를 안 건드리고 새 함수를 더한다는 이 코드베이스의 반복 원칙 —
    `mention_parser.py` 자체의 여러 docstring이 이 원칙을 반복해서 명시한다)."""
    if not content:
        return []
    redacted = _redact_code_spans(content)
    seen: set[int] = set()
    result: list[tuple[int, str]] = []
    for m in _BARE_STORY_NUMBER_RE.finditer(redacted):
        n = int(m.group(1))
        if n in seen:
            continue
        seen.add(n)
        start = max(0, m.start() - _SNIPPET_RADIUS)
        end = min(len(content), m.end() + _SNIPPET_RADIUS)
        result.append((n, content[start:end]))
    return result


async def build_candidate_rows(
    db: AsyncSession, *, org_id: uuid.UUID, project_id: uuid.UUID, source_id: uuid.UUID,
    content: str,
) -> list[CandidateRow]:
    """맨 번호 후보를 스니펫과 함께 뽑고, 「해소된」(실제 존재하는 story를 가리키는) 것만
    남긴다 — 미래번호(모집단에 없는 대상, PO 판정 2026-07-29 ②)는 여기서 후보 자체를 안
    만든다(조용히 스킵, 별도 로그 없음 — #2269 AC1이 이미 그 11.5%를 문서로 남겼다).

    ⛔자기참조 제외(파울로 판정 2026-07-30, dev 실물 사례 — story #2329가 본문에 자기
    번호("판정: #2329 닫는다")를 적어 자신을 가리키는 후보가 실제로 생겼다): AC10("미분류도
    안 버린다")과는 다른 축이다 — AC10은 «분류가 안 됐을 뿐 실제 관계 가능성이 있는» 것을
    보존하는 것이고, 자기참조는 애초에 사람에게 내밀 값이 없다(자기 자신을 가리킨다는
    사실은 승격 판단 대상이 아니다). 여기서 제외하지 이미 저장된 기존 자기참조 행을
    소급 정리하지는 않는다(#2328 ③ "소급 안 함"과 동일 원칙).

    ⛔story #2221 후속(오르테가 판정, 2026-07-30): 관계 단위로 기각된(target_id) 쌍도 여기서
    제외한다 — 산문이 그대로 남아 있어도 사람이 「아니오」한 관계는 재임포트마다 또 후보로
    뜨면 안 된다(그러면 사람이 같은 것을 영원히 다시 기각하게 된다). `rejected_relations`가
    「기록」(지우지 않음)이라 이 필터가 매 저장마다 다시 걸러낼 수 있다."""
    pairs = extract_bare_number_candidates_with_snippets(content)
    if not pairs:
        return []
    targets = await resolve_bare_number_story_targets(
        db, org_id=org_id, project_id=project_id, content=content,
    )
    rejected_target_ids = await _rejected_target_ids(
        db, org_id=org_id, source_type="story", source_id=source_id,
    )
    rows: list[CandidateRow] = []
    for n, snippet in pairs:
        story_id = targets.get(n)
        if story_id is None:
            continue  # 미래번호(미해소) — PO 판정 ②, 후보 자체를 안 만든다
        if story_id == source_id:
            continue  # 자기참조 — 승격 판단 대상 아님(위 docstring 참조)
        if story_id in rejected_target_ids:
            continue  # 관계 단위 기각됨 — 위 docstring 참조
        kind, keyword = classify_relation_kind(snippet)
        rows.append(CandidateRow(
            matched_number=n, target_story_id=story_id, snippet=snippet,
            relation_kind=kind, matched_keyword=keyword,
        ))
    return rows


async def _rejected_target_ids(
    db: AsyncSession, *, org_id: uuid.UUID, source_type: str, source_id: uuid.UUID,
) -> set[uuid.UUID]:
    """이 source가 이미 관계 단위로 기각한 target_id 집합(target_type="story" 고정 — 이
    모듈의 모집단 자체가 story→story뿐, 위 모듈 docstring 참조)."""
    result = await db.execute(
        select(RejectedRelation.target_id).where(
            RejectedRelation.org_id == org_id,
            RejectedRelation.source_type == source_type,
            RejectedRelation.source_id == source_id,
            RejectedRelation.target_type == "story",
        )
    )
    return set(result.scalars().all())


async def store_semantic_candidates(
    db: AsyncSession, *, org_id: uuid.UUID, source_type: str, source_field: str,
    source_id: uuid.UUID, rows: list[CandidateRow],
) -> int:
    """`reference_semantic_candidates`에 insert-only(멱등 — ON CONFLICT DO NOTHING). 같은
    (source_type, source_field, source_id, target_type, target_id, form) 키가 이미 있으면
    **건드리지 않는다** — 사람이 이미 판단한(status=declared) 후보를 재저장이 조용히
    덮어쓰면 안 된다는 것이 이 함수의 핵심 불변식(AC3/AC5 근거: 사람의 승격 결정은 자동
    재계산으로 지워지지 않는다)."""
    if not rows:
        return 0
    stmt = pg_insert(ReferenceSemanticCandidate).values([
        {
            "id": uuid.uuid4(),
            "org_id": org_id,
            "source_type": source_type,
            "source_field": source_field,
            "source_id": source_id,
            "target_type": "story",
            "target_id": row.target_story_id,
            "form": "mention",
            "relation_kind": row.relation_kind,
            "matched_keyword": row.matched_keyword,
            "snippet": row.snippet,
            "status": "estimated",
        }
        for row in rows
    ])
    stmt = stmt.on_conflict_do_nothing(
        index_elements=[
            "source_type", "source_field", "source_id", "target_type", "target_id", "form",
        ],
    )
    result = await db.execute(stmt)
    return result.rowcount or 0


async def generate_and_store_candidates(
    db: AsyncSession, *, org_id: uuid.UUID, project_id: uuid.UUID, source_type: str,
    source_field: str, source_id: uuid.UUID, content: str,
) -> int:
    """caller(story 저장 write-path) 편의 진입점 — build+store를 한 번에. 같은 트랜잭션
    (caller 세션 그대로 사용, 별도 커밋 없음) — 실패 시 예외가 그대로 propagate되어 story
    저장 전체가 롤백된다(entity_references reconcile과 동일 원자성 계약)."""
    rows = await build_candidate_rows(
        db, org_id=org_id, project_id=project_id, source_id=source_id, content=content,
    )
    return await store_semantic_candidates(
        db, org_id=org_id, source_type=source_type, source_field=source_field,
        source_id=source_id, rows=rows,
    )


async def list_candidates_for_epic_stories(
    db: AsyncSession, *, org_id: uuid.UUID, epic_id: uuid.UUID,
) -> list[ReferenceSemanticCandidate]:
    """story #2223 후속(오르테가군 판정, 2026-07-30) — 캔버스는 에픽 하나치 후보를 «한 번에»
    받아야 한다. story별 왕복(`/stories/{id}/reference-candidates`, N+1)으로는 못 쓴다 —
    stories JOIN으로 그 에픽 소속 story 전체의 candidate를 한 쿼리로 반환한다. 새 재료를
    만들지 않는다(같은 `reference_semantic_candidates` 표, 조회 축만 다르다)."""
    from app.models.pm import Story

    result = await db.execute(
        select(ReferenceSemanticCandidate)
        .join(Story, ReferenceSemanticCandidate.source_id == Story.id)
        .where(
            ReferenceSemanticCandidate.org_id == org_id,
            ReferenceSemanticCandidate.source_type == "story",
            Story.epic_id == epic_id,
        )
        .order_by(ReferenceSemanticCandidate.created_at.asc())
    )
    return list(result.scalars().all())


@dataclass(frozen=True)
class NextUpCandidate:
    """`list_next_up_candidates`가 내는 한 행 — 유나양 규격(2026-07-30) ⑥ "#2123과 이어져
    있습니다" 문구를 FE가 재조회 없이 바로 짤 수 있도록 source/target의 표시용 필드까지
    이미 얹어서 반환한다(계산은 BE, 화면은 그리기만 원칙)."""

    id: uuid.UUID
    source_id: uuid.UUID
    source_story_number: int | None
    source_title: str
    source_closed_at: datetime
    target_id: uuid.UUID
    target_story_number: int | None
    target_title: str
    relation_kind: str | None
    status: str
    is_recent: bool


async def list_next_up_candidates(
    db: AsyncSession, *, org_id: uuid.UUID, project_id: uuid.UUID, recent_days: int = 14,
) -> list[NextUpCandidate]:
    """story #2223 후속(오르테가군 판정, 2026-07-30) — 「방금 닫힌 것의 다음」 재료. 유나양
    규격 정정: 기간은 «필터»가 아니라 «정렬 가중치»다 — 대상(done 소스 → backlog 타깃) 후보를
    «전량» 반환하고, `recent_days`(기본 14 — 오르테가군 판정: 7일 59건/목표 49개=1.2개는
    얇고, 30일은 "최근"이라 부르기 어렵다) 이내에 소스가 done된 것만 `is_recent=True`로
    표시해 정렬 앞쪽에 세운다. 자르지 않는다(유나양 "거르지 않고 근거를 붙여 위로 올린다"
    원칙 — 걸러내면 사람의 판단을 대신하는 것이 된다).

    ⛔`source_closed_at`은 진짜 상태-전이 시각이 아니라 `Story.updated_at`(근사치)이다 — story
    모델에 done 전이 전용 타임스탬프가 없다(activity_events 조인은 이 스토리 스코프 밖, 오르테가군
    "그에 준하는 것" 허용 그대로). done 이후 무관한 필드 편집이 있으면 실제보다 최근으로
    보일 수 있다는 것이 알려진 한계 — 화면에 숨기지 않고 이 docstring과 보고에 남긴다.

    ⛔이 함수는 기각(#2221, `rejected_relations`) 필터를 별도로 안 건다 — 기각된 (source,
    target) 쌍은 `reject_candidate`가 candidate 행 자체를 지우므로, 지금 이 표에 남아 있는
    행은 정의상 기각되지 않은 것이다(build_candidate_rows의 write-time 필터와 동형 보장)."""
    from sqlalchemy.orm import aliased

    from app.models.pm import Story

    Source = aliased(Story)
    Target = aliased(Story)
    result = await db.execute(
        select(
            ReferenceSemanticCandidate.id,
            ReferenceSemanticCandidate.source_id,
            Source.story_number,
            Source.title,
            Source.updated_at,
            ReferenceSemanticCandidate.target_id,
            Target.story_number,
            Target.title,
            ReferenceSemanticCandidate.relation_kind,
            ReferenceSemanticCandidate.status,
        )
        .join(Source, ReferenceSemanticCandidate.source_id == Source.id)
        .join(Target, ReferenceSemanticCandidate.target_id == Target.id)
        .where(
            ReferenceSemanticCandidate.org_id == org_id,
            ReferenceSemanticCandidate.source_type == "story",
            ReferenceSemanticCandidate.target_type == "story",
            Source.project_id == project_id,
            Target.project_id == project_id,
            Source.status == "done",
            Target.status == "backlog",
        )
    )
    cutoff = datetime.now(UTC) - timedelta(days=recent_days)
    rows = [
        NextUpCandidate(
            id=cid, source_id=sid, source_story_number=s_num, source_title=s_title,
            source_closed_at=s_updated, target_id=tid, target_story_number=t_num,
            target_title=t_title, relation_kind=kind, status=status,
            is_recent=s_updated >= cutoff,
        )
        for (cid, sid, s_num, s_title, s_updated, tid, t_num, t_title, kind, status) in result.all()
    ]
    rows.sort(key=lambda r: (not r.is_recent, -r.source_closed_at.timestamp()))
    return rows


async def list_candidates_for_source(
    db: AsyncSession, *, org_id: uuid.UUID, source_type: str, source_id: uuid.UUID,
) -> list[ReferenceSemanticCandidate]:
    """AC5 — 사람이 후보를 고르는 자리가 「그 일이 보이는 곳」이어야 한다(별도 정리 화면
    금지). story 상세 화면이 이 함수를 그 자리에서 직접 호출하도록 라우터가 얇게 감싼다."""
    result = await db.execute(
        select(ReferenceSemanticCandidate).where(
            ReferenceSemanticCandidate.org_id == org_id,
            ReferenceSemanticCandidate.source_type == source_type,
            ReferenceSemanticCandidate.source_id == source_id,
        ).order_by(ReferenceSemanticCandidate.created_at.asc())
    )
    return list(result.scalars().all())


class CandidateNotFoundError(Exception):
    pass


async def declare_candidate(
    db: AsyncSession, *, org_id: uuid.UUID, candidate_id: uuid.UUID, declared_by: uuid.UUID | None,
) -> ReferenceSemanticCandidate:
    """AC5 — 사람이 후보를 골라 「선언됨」으로 승격시킨다. ⛔AC4: 이 함수는 status·
    declared_by·declared_at **셋만** 바꾼다 — 그 외 어떤 부수효과(막힘·대기·종료·에이전트
    실행)도 일으키지 않는다(회귀 테스트+뮤테이션 자가검증이 이 계약을 지킨다).
    이미 declared된 것을 다시 declare해도 멱등(같은 값 재기록, 에러 아님) — 재클릭이
    실패로 보이지 않게 한다."""
    result = await db.execute(
        select(ReferenceSemanticCandidate).where(
            ReferenceSemanticCandidate.org_id == org_id,
            ReferenceSemanticCandidate.id == candidate_id,
        )
    )
    candidate = result.scalar_one_or_none()
    if candidate is None:
        raise CandidateNotFoundError()
    from datetime import datetime

    candidate.status = "declared"
    candidate.declared_by = declared_by
    candidate.declared_at = datetime.now(UTC)
    return candidate


class InvalidRelationKindError(Exception):
    pass


async def set_candidate_relation_kind(
    db: AsyncSession, *, org_id: uuid.UUID, candidate_id: uuid.UUID, relation_kind: str | None,
) -> ReferenceSemanticCandidate:
    """story #2223 판정(오르테가군, 2026-07-30) — "이 연결이 실재하는가"(declare)와 "무슨
    종류인가"(이 함수) 는 «다른 질문»이라 한 클릭에 안 묶는다. declare_candidate와 달리 이
    함수는 relation_kind **하나만** 바꾼다 — status/declared_by/declared_at는 안 건드린다
    (AC4가 declare 쪽에 지운 그 경계를 이 함수 쪽에서도 대칭으로 지킨다 — declare 여부와
    무관하게 종 지정이 가능하다, 순서를 강제하지 않는다).

    relation_kind=None 허용 — 잘못 지정한 것을 「미분류」로 되돌리는 경로(AC10 정신: 모르는
    것을 억지로 채운 채로 안 둔다)."""
    if relation_kind is not None and relation_kind not in RELATION_KINDS:
        raise InvalidRelationKindError(relation_kind)
    result = await db.execute(
        select(ReferenceSemanticCandidate).where(
            ReferenceSemanticCandidate.org_id == org_id,
            ReferenceSemanticCandidate.id == candidate_id,
        )
    )
    candidate = result.scalar_one_or_none()
    if candidate is None:
        raise CandidateNotFoundError()
    candidate.relation_kind = relation_kind
    return candidate


class InvalidPortRelationKindError(Exception):
    pass


class CandidateNotDeclaredError(Exception):
    pass


# story #2355(AC4) — 사람이 「연결 만들기」로 지정할 수 있는 relation_kind는 FE 포트가 실제로
# 그리는 3종뿐이다. DB CHECK(RELATION_KINDS, app/models/reference_semantic_candidate.py)는
# 6종 전부를 허용하지만, 나머지 3종(cited_as_evidence·similar_case·explicitly_unrelated)은
# `derive-flow-map.ts`가 렌더링 축에서 의도적으로 드롭한다(오르테가 실측, 2026-07-31) —
# 저장은 되나 화면엔 «안 그려지는» 값이라, 이 write 경로에서 만들 수 있게 두면 안 된다.
# ⛔나열 안 된 값을 조용히 통과시키지 않는다 — 명시 400(오르테가 지시).
PORT_RELATION_KINDS = frozenset({"spawned", "followed", "superseded"})


async def declare_new_candidate(
    db: AsyncSession, *, org_id: uuid.UUID, source_type: str, source_field: str,
    source_id: uuid.UUID, target_type: str, target_id: uuid.UUID,
    relation_kind: str | None, declared_by: uuid.UUID,
) -> ReferenceSemanticCandidate:
    """story #2355 — 사람이 «후보가 아예 없던» source↔target 쌍을 처음 잇는 write 경로.
    `store_semantic_candidates`(기계 write-path)의 형제 함수 — 같은 자연키(source_type/
    source_field/source_id/target_type/target_id/form)를 쓰지만, status='declared'를
    **생성 시점에 바로** 채운다(estimated 경유 없음).

    AC6(역방향) — 같은 자연키에 이미 estimated 행이 있으면 중복 행을 만들지 않고 그 행을
    declared로 승격한다(ON CONFLICT DO UPDATE, WHERE status='estimated' — 이미 declared인
    행은 건드리지 않는다: 재호출은 멱등이고, 원래 선언자의 declared_by/declared_at·AC3의
    "누가·언제 만들었는가" 서명이 재호출로 지워지지 않는다). 승격 시 relation_kind는 이번
    호출이 명시로 준 값이 있으면 그 값으로 덮어쓰고(사람이 지금 막 고른 종류가 과거 기계
    추정보다 우선), 안 주면(None) 기존 값을 그대로 둔다(COALESCE) — declare와 relation-kind가
    "다른 질문"이라는 계약은 신규 행 생성 축에서는 적용되지 않는다(이 호출 자체가 이미 둘을
    함께 받는 새 계약이므로 모순 없음).

    ⛔relation_kind는 PORT_RELATION_KINDS(3종)만 허용 — 그 외 값은 InvalidPortRelationKindError."""
    if relation_kind is not None and relation_kind not in PORT_RELATION_KINDS:
        raise InvalidPortRelationKindError(relation_kind)

    now = datetime.now(UTC)
    stmt = pg_insert(ReferenceSemanticCandidate).values(
        id=uuid.uuid4(), org_id=org_id, source_type=source_type, source_field=source_field,
        source_id=source_id, target_type=target_type, target_id=target_id, form="mention",
        relation_kind=relation_kind, matched_keyword=None, snippet="",
        status="declared", declared_by=declared_by, declared_at=now,
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=[
            "source_type", "source_field", "source_id", "target_type", "target_id", "form",
        ],
        set_={
            "status": "declared",
            "declared_by": declared_by,
            "declared_at": now,
            "relation_kind": func.coalesce(
                stmt.excluded.relation_kind, ReferenceSemanticCandidate.relation_kind,
            ),
        },
        where=(ReferenceSemanticCandidate.status == "estimated"),
    )
    await db.execute(stmt)
    result = await db.execute(
        select(ReferenceSemanticCandidate).where(
            ReferenceSemanticCandidate.org_id == org_id,
            ReferenceSemanticCandidate.source_type == source_type,
            ReferenceSemanticCandidate.source_field == source_field,
            ReferenceSemanticCandidate.source_id == source_id,
            ReferenceSemanticCandidate.target_type == target_type,
            ReferenceSemanticCandidate.target_id == target_id,
            ReferenceSemanticCandidate.form == "mention",
        )
    )
    return result.scalar_one()


async def undeclare_candidate(
    db: AsyncSession, *, org_id: uuid.UUID, candidate_id: uuid.UUID,
) -> None:
    """story #2355(AC8) — 사람이 만든(또는 승격한) 연결을 지운다. ⛔`reject_candidate`와
    다르다 — reject는 `rejected_relations`에 쌍을 기록해 다음 스캔에서도 영구히 거르지만,
    이 함수는 아무 기록도 남기지 않는다(사람이 실수로 만든 것을 무르는 것이지, 기계 후보를
    영구 기각하는 것이 아니다 — 기록을 남기면 「실수로 지웠는데 영영 다시 못 잇는」 것이 된다).

    ⛔status='declared'가 아닌 행(아직 estimated인 기계 후보)은 지울 수 없다 —
    CandidateNotDeclaredError. 그런 행을 지우고 싶으면 `reject_candidate`가 맞는 경로다(이
    함수와 목적이 다르다: 그 표를 다음 스캔에서도 걸러야 하므로)."""
    result = await db.execute(
        select(ReferenceSemanticCandidate).where(
            ReferenceSemanticCandidate.org_id == org_id,
            ReferenceSemanticCandidate.id == candidate_id,
        )
    )
    candidate = result.scalar_one_or_none()
    if candidate is None:
        raise CandidateNotFoundError()
    if candidate.status != "declared":
        raise CandidateNotDeclaredError()
    await db.delete(candidate)


class RejectedRelationNotFoundError(Exception):
    pass


async def reject_candidate(
    db: AsyncSession, *, org_id: uuid.UUID, candidate_id: uuid.UUID,
    rejected_by: uuid.UUID, reason: str | None = None,
) -> None:
    """story #2221 후속 — 관계 단위 기각. 클릭한 candidate 행의 (source, target) 쌍을
    `rejected_relations`에 기록(멱등 — 이미 기각돼 있으면 그대로 둔다)하고, 같은 org의 같은
    (source, target) 쌍을 가리키는 candidate 행 «전부»(field/form이 달라도)를 지운다 —
    기각은 «간선이 아니라 관계」(오르테가 판정, 유나 지적)라 관계 전체가 화면에서 빠져야
    한다. ⛔ 소급 없음(#2328 ③과 동일 원칙) — 이 함수가 지우는 건 지금 존재하는 candidate
    행뿐, `build_candidate_rows`의 필터(`_rejected_target_ids`)가 다음 저장부터 새로
    생기는 것을 막는다.

    ⛔rejected_by는 필수다(오르테가 지시, 2026-07-30) — 여러 사람이 같은 목록을 보므로
    「누가 기각했나」 없이는 되살릴 때 판단이 안 선다. caller(router)가 항상
    `_resolve_team_member_id`로 실제 team_member id를 넘긴다(그 함수는 non-optional
    반환 계약이라 여기 None이 들어올 일이 없다)."""
    result = await db.execute(
        select(ReferenceSemanticCandidate).where(
            ReferenceSemanticCandidate.org_id == org_id,
            ReferenceSemanticCandidate.id == candidate_id,
        )
    )
    candidate = result.scalar_one_or_none()
    if candidate is None:
        raise CandidateNotFoundError()

    source_type, source_id = candidate.source_type, candidate.source_id
    target_type, target_id = candidate.target_type, candidate.target_id

    stmt = pg_insert(RejectedRelation).values(
        id=uuid.uuid4(), org_id=org_id, source_type=source_type, source_id=source_id,
        target_type=target_type, target_id=target_id, reason=reason, rejected_by=rejected_by,
    )
    stmt = stmt.on_conflict_do_nothing(
        index_elements=["source_type", "source_id", "target_type", "target_id"],
    )
    await db.execute(stmt)

    siblings = await db.execute(
        select(ReferenceSemanticCandidate).where(
            ReferenceSemanticCandidate.org_id == org_id,
            ReferenceSemanticCandidate.source_type == source_type,
            ReferenceSemanticCandidate.source_id == source_id,
            ReferenceSemanticCandidate.target_type == target_type,
            ReferenceSemanticCandidate.target_id == target_id,
        )
    )
    for row in siblings.scalars().all():
        await db.delete(row)


async def undo_rejection(
    db: AsyncSession, *, org_id: uuid.UUID, source_type: str, source_id: uuid.UUID,
    target_type: str, target_id: uuid.UUID,
) -> None:
    """되살리기(오르테가 지시) — rejected_relations 행을 삭제한다(판정: 지금은 단순하게,
    되살린 기록 자체는 안 남긴다). ⛔삭제된 후보 행은 자동으로 안 돌아온다 — 다음 story
    저장(정상 편집)이 있어야 `build_candidate_rows`가 다시 후보를 만든다(이 모듈의
    "새 참조만" 설계와 동일 원칙, #2328 ③)."""
    result = await db.execute(
        select(RejectedRelation).where(
            RejectedRelation.org_id == org_id,
            RejectedRelation.source_type == source_type,
            RejectedRelation.source_id == source_id,
            RejectedRelation.target_type == target_type,
            RejectedRelation.target_id == target_id,
        )
    )
    row = result.scalar_one_or_none()
    if row is None:
        raise RejectedRelationNotFoundError()
    await db.delete(row)
