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

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.reference_semantic_candidate import ReferenceSemanticCandidate
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
_KEYWORD_RULES: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("잇따름", re.compile(r"의존[:：]|의존\s*그래프|→.*→|앞에\s*서는가")),
    ("낳음", re.compile(
        r"신규\s*스토리\s*등재|중\s*발견|중\s*적출|발견\s*\(#|발단\s*[—\-]|검수\s*중|"
        r"수행\s*중\s*직접\s*발견"
    )),
    ("동종사례", re.compile(r"같은\s*병|같은\s*성질|같은\s*계열|결함\s*계열|같은\s*클래스")),
    ("명시적_무관", re.compile(r"직교|무관(?!심)")),
    ("근거인용", re.compile(r"머지\s*`[0-9a-f]+`\s*\(PR\s*#|PR\s*#\d+\s*본문에\s*기록|확認\s*완료")),
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
    db: AsyncSession, *, org_id: uuid.UUID, project_id: uuid.UUID, content: str,
) -> list[CandidateRow]:
    """맨 번호 후보를 스니펫과 함께 뽑고, 「해소된」(실제 존재하는 story를 가리키는) 것만
    남긴다 — 미래번호(모집단에 없는 대상, PO 판정 2026-07-29 ②)는 여기서 후보 자체를 안
    만든다(조용히 스킵, 별도 로그 없음 — #2269 AC1이 이미 그 11.5%를 문서로 남겼다)."""
    pairs = extract_bare_number_candidates_with_snippets(content)
    if not pairs:
        return []
    targets = await resolve_bare_number_story_targets(
        db, org_id=org_id, project_id=project_id, content=content,
    )
    rows: list[CandidateRow] = []
    for n, snippet in pairs:
        story_id = targets.get(n)
        if story_id is None:
            continue  # 미래번호(미해소) — PO 판정 ②, 후보 자체를 안 만든다
        kind, keyword = classify_relation_kind(snippet)
        rows.append(CandidateRow(
            matched_number=n, target_story_id=story_id, snippet=snippet,
            relation_kind=kind, matched_keyword=keyword,
        ))
    return rows


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
    rows = await build_candidate_rows(db, org_id=org_id, project_id=project_id, content=content)
    return await store_semantic_candidates(
        db, org_id=org_id, source_type=source_type, source_field=source_field,
        source_id=source_id, rows=rows,
    )


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
    from datetime import datetime, timezone

    candidate.status = "declared"
    candidate.declared_by = declared_by
    candidate.declared_at = datetime.now(timezone.utc)
    return candidate
