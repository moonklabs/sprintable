"""story #2629(챗·전달계약) — 본문의 맨 스토리 번호(`#24`류)를 서버가 entity 임베드로
자동 승격한다. P0의 본문 `@handle` 파서(story #2646로 은퇴, 과거 `handle_mention_parser.py`)
와 정확히 동형 철학이었다 — 에이전트가 임베드 문법을 배우든 말든, 서버가 발신 시점에
흡수한다(규율/문서화로 가르치지 않는다, 선생님 08-13 판정).

그 파서와의 차이(설계 비교, 파서 자체는 이제 없음): 그쪽은 **read-only 해석**(본문은
그대로 두고 mentioned_ids만 파생) — 이 모듈은 **본문 자체를 저장 시점에 치환**하는 첫
사례다(PO 지적, 2026-08-14). 그래서 편집(edit) 경로가 있으면 같은 승격이 거기도 걸려야 하는데,
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

# story #2651 — PR 번호와 스토리 번호가 같은 `#N` 표기 공간을 공유(이 조직은 둘 다
# 일상적으로 쓴다: PR 3033~3052 · 스토리 2637~2650). 직전 토큰이 「PR」/「pr」(대소문자
# 무관, 단어 경계 — `SUPR #21`처럼 알파벳/숫자/밑줄 뒤에 곧장 붙은 것은 「PR」이 아니므로
# 제외 대상이 아니다)이면 그 매치는 story 승격에서 제외한다. 실물 피해 2건(9e19d9b2 "PR
# [E-01-S-07…]"·45e9e868 "PR [E-02-S-02…]") 전부 「PR #N」(공백+해시) 형태였다 — dev
# 라이브 실측(2026-08-14, 착수 시 재검증)으로 「PR N」(해시 없는 형태)의 실사례는
# 확인되지 않았다: 그 형태는 애초에 `_BARE_STORY_REF_RE`가 `#`을 요구해 매치 자체가 없다.
_PR_PREFIX_RE = re.compile(r"(?<![A-Za-z0-9_])[Pp][Rr]\s*$")

# story #2660(#2651 후속) — GitHub 크로스레포 관례 "repo-name#N"(예: agent-plugins#25·
# gemini#3)이 실피해로 재발(실측: 실제 원문은 `agent-plugins#25`·`gemini#3` — 백틱 無,
# 카디르 05f52181 메시지 170c7b98, dev DB 조회 확인). 직전 토큰이 "PR"/"pr"이 아니라
# 레포명류라 _PR_PREFIX_RE로는 안 걸린다.
#
# ⛔AC2 GROUP BY 양성대조(2026-08-14, dev conversation_messages 60일치 실측 —
# pgstat-probe-dev job) 결과 «라틴 단어문자가 #N 직전에 붙는» 축을 통째로 막으면 안 된다는
# 것이 확定됐다: "story#2588"(11건)·"BE#1839"/"FE#1840"(다수)류 정상 팀 표기가 같은
# 표면(레터+#N, 공백 없음)을 쓴다 — 최초 설계(임의 라틴 단어문자/하이픈/점/언더스코어
# 전부 제외)는 이 정상 표기까지 깨뜨리는 과잉 제외였다(#2629/#2651 선례의 "실측 우선"
# 그대로 이 설계를 걷어냄). 대신 **이 조직이 실제 쓰는 레포 짧은 이름만** 등재 —
# `INJECTABLE_EVENT_TYPES`(sprintable_sse.py)와 같은 성격의 닫힌 허용목록. 새 레포가
# 생기면 이 목록에 추가할 것(자동 발견 불가 — 그 자체가 이 클래스의 한계, 가드가 못
# 잡는 것으로 명시).
_REPO_SHORTHAND_SUFFIX_RE = re.compile(
    r"(?i:agent-plugins|gemini|admin|claude-plugin|mobile)$"
)

# 보호 구간(스캔에서 제외) — fenced 코드블록·인라인 코드·이미 만들어진 entity 토큰.
_FENCED_CODE_RE = re.compile(r"```.*?```", re.DOTALL)
_INLINE_CODE_RE = re.compile(r"`[^`\n]+`")
_ENTITY_TOKEN_RE = re.compile(r"\[[^\]]*\]\(entity:[a-z_]+:[^)]+\)")

# story #3162(채팅·치환 결함 조사) — 인용부호/블록인용 안의 `#N`은 「예시로 재인용」이지
# 「새로 참조하려는 의도」가 아니다(디캄포 오늘 밤 재발 실사고: 정정 메시지에서 오염된
# 원문을 그대로 다시 인용해 재승격됨). 코드블록·인라인코드와 같은 성격의 "이 안은 예시
# 영역"으로 취급한다 — 같은 줄 안에서 닫히는 짝만(여러 줄에 걸친 따옴표는 보호 대상
# 밖으로 두어 과잉 보호를 피한다, 기존 인라인코드 규율과 동형). 한글 채팅 관례의
# 「」『』《》〈〉도 같은 원칙으로 포함.
_DOUBLE_QUOTE_RE = re.compile(r'"[^"\n]*"')
_SINGLE_QUOTE_RE = re.compile(r"'[^'\n]*'")
_KOREAN_BRACKET_QUOTE_RE = re.compile(r"「[^」\n]*」|『[^』\n]*』|《[^》\n]*》|〈[^〉\n]*〉")
# 블록인용(마크다운 `>` 관례) — 줄 전체를 보호(그 줄 안의 `#N`은 다른 사람 말/과거 발화를
# 그대로 옮긴 것이지 이 발신자의 새 참조 의도가 아니다).
_BLOCKQUOTE_LINE_RE = re.compile(r"^>.*$", re.MULTILINE)


def extract_bare_story_ref_candidates(content: str) -> list[tuple[int, int, int]]:
    """본문에서 «#숫자» 후보 위치를 뽑는다(DB 조회 없는 순수 함수 — 모양만 본다, 존재 여부는
    별도 async 함수의 몫. 은퇴한 @handle 파서의 `extract_handle_tokens`와 같은 형태였다).

    반환: (start, end, story_number) 튜플 리스트. 매치 직후 문자가 라틴 알파벳이면
    헥스 컬러류(`#74747c`)로 보고 그 후보 자체를 버린다(dev 실측 근거 — 모듈 docstring
    참조). 매치 직전 토큰이 「PR」/「pr」이면(story #2651) PR 번호로 보고 마찬가지로
    버린다 — `_PR_PREFIX_RE` 참조. 매치 직전이 알려진 레포 짧은이름 접미사로 끝나면
    (story #2660) GitHub「repo-name#N」류로 보고 버린다 — `_REPO_SHORTHAND_SUFFIX_RE`
    참조(⛔허용목록 방식 — "라틴 단어문자 전부"가 아니다. story#N/BE#N류 정상 팀 표기는
    이 목록에 없어 계속 승격된다, #2660 GROUP BY 실측). 코드블록/인라인코드/기존 entity
    토큰 내부는 여기서 걸러지지 않는다 — 그건 `_protected_spans`가 별도로 처리(관심사
    분리: 이 함수는 "무엇이 숫자 토큰처럼 생겼는가"만, 저건 "어디를 건드리면 안 되는가"만)."""
    if not content:
        return []
    candidates: list[tuple[int, int, int]] = []
    for m in _BARE_STORY_REF_RE.finditer(content):
        start = m.start()
        end = m.end()
        if end < len(content) and _LATIN_RE.match(content[end]):
            continue
        if _PR_PREFIX_RE.search(content, 0, start):
            continue
        if _REPO_SHORTHAND_SUFFIX_RE.search(content, 0, start):
            continue
        candidates.append((start, end, int(m.group(1))))
    return candidates


def _protected_spans(content: str) -> list[tuple[int, int]]:
    """fenced 코드블록·인라인 코드·기존 entity 토큰·인용부호·블록인용의 (start, end) 구간.
    이 구간에서 시작하는 후보는 승격 대상에서 제외한다(AC2 — 코드블록 미변환·이중 변환
    금지, story #3162 — 인용부호/블록인용도 같은 "예시 영역" 원칙으로 추가)."""
    spans: list[tuple[int, int]] = []
    for pat in (
        _FENCED_CODE_RE, _INLINE_CODE_RE, _ENTITY_TOKEN_RE,
        _DOUBLE_QUOTE_RE, _SINGLE_QUOTE_RE, _KOREAN_BRACKET_QUOTE_RE, _BLOCKQUOTE_LINE_RE,
    ):
        spans.extend(m.span() for m in pat.finditer(content))
    return spans


def _in_protected_span(pos: int, spans: list[tuple[int, int]]) -> bool:
    return any(start <= pos < end for start, end in spans)


async def promote_bare_story_refs(
    db: AsyncSession, *, org_id: uuid.UUID, project_id: uuid.UUID, content: str,
) -> tuple[str, set[uuid.UUID]]:
    """본문의 «#N» 후보를 org+project 스코프 story_number로 resolve해 entity 참조 토큰
    (`build_reference_token`, #2282 SSOT 그대로 재사용 — 새 escape 규칙 발명 안 함)으로
    치환한다.

    resolve 실패(그 번호의 story가 없음·타 project 소속)면 **그 매치만** 원문 그대로
    남긴다(전체 all-or-nothing 아님 — 은퇴한 @handle 파서의 "매치 0건=조회도 없이 조기
    반환" 관대함과 동형 철학, 성실한 오독에서도 메시지 발신 자체는 막지 않는다).

    story #2679(BE): 반환이 `str`에서 `(content, auto_story_ids)`로 바뀌었다 — 이번 호출에서
    **실제로 성공 치환한** story_id 집합을 같이 돌려준다(resolve 실패로 원문 그대로 남은
    번호는 안 들어간다). caller(conversations.py)가 이 집합을 `insert_chat_mentions`에
    그대로 전달해 «caller가 명시로 타이핑한 브라켓 토큰»과 «서버가 여기서 승격한 것»을
    entity_references.origin에서 가른다(explicit vs auto) — 본문 자체(치환된 브라켓 토큰)는
    이 함수가 이미 심어 둔 그대로, 파싱만으로는 두 출처를 구분할 수 없기 때문에 별도 채널로
    넘긴다."""
    if not content:
        return content, set()
    candidates = extract_bare_story_ref_candidates(content)
    if not candidates:
        return content, set()
    protected = _protected_spans(content)
    candidates = [c for c in candidates if not _in_protected_span(c[0], protected)]
    if not candidates:
        return content, set()

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
        return content, set()

    # 뒤에서부터 치환 — 앞쪽 매치의 인덱스가 뒤 치환으로 밀리지 않게.
    result = content
    promoted_ids: set[uuid.UUID] = set()
    for start, end, number in sorted(candidates, key=lambda c: c[0], reverse=True):
        found = story_by_number.get(number)
        if found is None:
            continue
        story_id, title = found
        token = build_reference_token("story", story_id, title)
        if token is None:
            continue
        result = result[:start] + token + result[end:]
        promoted_ids.add(story_id)
    return result, promoted_ids
