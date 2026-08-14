"""story #2629(챗·전달계약) — 본문의 맨 스토리 번호(`#24`류)를 서버가 entity 임베드로
자동 승격한다. P0의 본문 `@handle` 파서(`handle_mention_parser.py`)와 정확히 동형 철학
— 에이전트가 임베드 문법을 배우든 말든, 서버가 발신 시점에 흡수한다(규율/문서화로
가르치지 않는다, 선생님 08-13 판정).

`handle_mention_parser.py`와의 차이: 그쪽은 **read-only 해석**(본문은 그대로 두고
mentioned_ids만 파생) — 이 모듈은 **본문 자체를 저장 시점에 치환**하는 첫 사례다(PO
지적, 2026-08-14). 그래서 편집(edit) 경로가 있으면 같은 승격이 거기도 걸려야 하는데,
grep 전수 확認 결과 `ConversationMessage.content` 재대입 지점은 전체 백엔드에 2곳뿐
(생성 시점=이 모듈이 거는 자리, DELETE tombstone=story #2319의 `content = ""` 스크럽 —
새 사용자 텍스트가 없어 승격 대상 자체가 없다) — PATCH/PUT류 "메시지 수정" 엔드포인트는
0건이라 비대칭 표면 자체가 없다.

오탐 경계(2026-08-14, dev 실측 — 심은 표본이 아니라 dev conversation_messages 45일치
4000건·11,634 매치 GROUP BY): 이 팀 실사용에서 `#숫자`의 1위 오탐 축은 **헥스 컬러**
(`#74747c` 등 — CSS/디자인 토큰 논의가 잦음)였다. 반면 **한글 조사 직결**(`#2629와`·
`#2642로`)은 정상 매치의 다수 형태였다 — 공백 경계만 요구하면 실 사용례 다수를 놓친다.
그래서 처방은 "매치 직후 문자가 라틴 알파벳이면 스킵"(헥스 컬러류 배제) + "한글/공백/
문장부호/문자열 끝은 전부 통과"다."""
from __future__ import annotations

import re
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.services.reference_token import build_reference_token

# `#` 뒤에 연속 숫자 — 앞에 또 다른 `#`이 오면 스킵(마크다운 `##` 헤더 등과의 혼동 방지,
# lookbehind로 `##42`의 두 번째 `#`부터 매치 시작하는 것 자체를 막는다).
_BARE_STORY_REF_RE = re.compile(r"(?<!#)#(\d+)")
_LATIN_RE = re.compile(r"[A-Za-z]")

# 보호 구간(스캔에서 제외) — fenced 코드블록·인라인 코드·이미 만들어진 entity 토큰.
_FENCED_CODE_RE = re.compile(r"```.*?```", re.DOTALL)
_INLINE_CODE_RE = re.compile(r"`[^`\n]+`")
_ENTITY_TOKEN_RE = re.compile(r"\[[^\]]*\]\(entity:[a-z_]+:[^)]+\)")


def extract_bare_story_ref_candidates(content: str) -> list[tuple[int, int, int]]:
    """본문에서 «#숫자» 후보 위치를 뽑는다(DB 조회 없는 순수 함수, resolve_handle_mentions의
    `extract_handle_tokens`와 동형 — 모양만 본다, 존재 여부는 별도 async 함수의 몫).

    반환: (start, end, story_number) 튜플 리스트. 매치 직후 문자가 라틴 알파벳이면
    헥스 컬러류(`#74747c`)로 보고 그 후보 자체를 버린다(dev 실측 근거 — 모듈 docstring
    참조). 코드블록/인라인코드/기존 entity 토큰 내부는 여기서 걸러지지 않는다 — 그건
    `_protected_spans`가 별도로 처리(관심사 분리: 이 함수는 "무엇이 숫자 토큰처럼
    생겼는가"만, 저건 "어디를 건드리면 안 되는가"만)."""
    if not content:
        return []
    candidates: list[tuple[int, int, int]] = []
    for m in _BARE_STORY_REF_RE.finditer(content):
        end = m.end()
        if end < len(content) and _LATIN_RE.match(content[end]):
            continue
        candidates.append((m.start(), end, int(m.group(1))))
    return candidates


def _protected_spans(content: str) -> list[tuple[int, int]]:
    """fenced 코드블록·인라인 코드·기존 entity 토큰의 (start, end) 구간. 이 구간에서
    시작하는 후보는 승격 대상에서 제외한다(AC2 — 코드블록 미변환·이중 변환 금지)."""
    spans: list[tuple[int, int]] = []
    for pat in (_FENCED_CODE_RE, _INLINE_CODE_RE, _ENTITY_TOKEN_RE):
        spans.extend(m.span() for m in pat.finditer(content))
    return spans


def _in_protected_span(pos: int, spans: list[tuple[int, int]]) -> bool:
    return any(start <= pos < end for start, end in spans)


async def promote_bare_story_refs(
    db: AsyncSession, *, org_id: uuid.UUID, project_id: uuid.UUID, content: str,
) -> str:
    """본문의 «#N» 후보를 org+project 스코프 story_number로 resolve해 entity 참조 토큰
    (`build_reference_token`, #2282 SSOT 그대로 재사용 — 새 escape 규칙 발명 안 함)으로
    치환한다.

    resolve 실패(그 번호의 story가 없음·타 project 소속)면 **그 매치만** 원문 그대로
    남긴다(전체 all-or-nothing 아님 — resolve_handle_mentions의 "매치 0건=조회도 없이
    조기 반환" 관대함과 동형 철학, 성실한 오독에서도 메시지 발신 자체는 막지 않는다)."""
    if not content:
        return content
    candidates = extract_bare_story_ref_candidates(content)
    if not candidates:
        return content
    protected = _protected_spans(content)
    candidates = [c for c in candidates if not _in_protected_span(c[0], protected)]
    if not candidates:
        return content

    numbers = {c[2] for c in candidates}
    from app.models.pm import Story

    rows = (await db.execute(
        select(Story.story_number, Story.id, Story.title).where(
            Story.org_id == org_id,
            Story.project_id == project_id,
            Story.story_number.in_(numbers),
            Story.deleted_at.is_(None),
        )
    )).all()
    story_by_number = {number: (story_id, title) for number, story_id, title in rows}
    if not story_by_number:
        return content

    # 뒤에서부터 치환 — 앞쪽 매치의 인덱스가 뒤 치환으로 밀리지 않게.
    result = content
    for start, end, number in sorted(candidates, key=lambda c: c[0], reverse=True):
        found = story_by_number.get(number)
        if found is None:
            continue
        story_id, title = found
        token = build_reference_token("story", story_id, title)
        if token is None:
            continue
        result = result[:start] + token + result[end:]
    return result
