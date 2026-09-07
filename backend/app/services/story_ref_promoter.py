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
# story #3652(PO 確定 2026-09-07) — 「pull #N」도 「PR #N」과 같은 축(PR을 풀어 쓴 형).
_PR_PREFIX_RE = re.compile(r"(?<![A-Za-z0-9_])(?:[Pp][Rr]|[Pp]ull)\s*$")

# story #3652(PO 確定 2026-09-07) — «owner/repo#N»(슬래시 있음)은 레포가 org 원장에
# 있는지와 무관하게 항상 story 승격에서 제외한다(rule① "owner/repo#N → 치환 0"은
# 조건부가 아니다 — 원장 유일 일치 여부는 «PR 링크로 대신 해석할지」만 가른다,
# _find_explicit_repo_pr_candidates 참조). ⚠️잃는 것(선언) — "owner"/"repo" 자리가
# 실제 GitHub 식별자인지 확인할 길이 없어(러너가 GitHub API를 안 부름) "a/b #24"류
# 우연한 슬래시 텍스트도 같은 모양이면 제외된다 — dev 실측(#2660 GROUP BY)이 이런
# 표현이 실사용에 없었음을 보였으나, 새로 생기면 이 클래스가 못 잡는다.
_SLASH_QUALIFIED_REPO_RE = re.compile(r"(?<![\w/])[\w.-]+/[\w.-]+\s*$")

# story #3652 — GitHub PR URL(owner/repo/pull/N). 이 형은 `#`이 없어 `_BARE_STORY_REF_RE`
# 자체가 안 물지만(URL 안에 매치 대상 자체가 없음), 이 URL을 «명시 repo#N 후보»로도
# 함께 뽑아 PR 링크 해석을 시도한다(_find_explicit_repo_pr_candidates 참조).
_GITHUB_PR_URL_RE = re.compile(r"https://github\.com/([\w.-]+/[\w.-]+)/pull/(\d+)\b")
# owner/repo#N — 슬래시 필수(바로 위 _SLASH_QUALIFIED_REPO_RE와 같은 판별축, PR 링크
# 해석 시도 대상만 별도로 뽑는다).
_OWNER_REPO_HASH_RE = re.compile(r"(?<![\w/])([\w.-]+/[\w.-]+)#(\d+)\b")

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
#
# story #3652(PO 確定 2026-09-07) — 이 정적 다섯 개는 «닫힌 허용목록»으로 계속 남는다
# (예: "admin"은 pull_request_story_link에 없는 별개 제품일 수 있어 원장이 못 대신함).
# 실피해(디디 conv 52fd99d0, 2026-09-07)는 **공백**이 낀 「sprintable-agent-plugins #46」
# 형태였는데 이 정적 목록엔 원래 공백 허용(`\s*`)이 없었다(#2660 당시 실측이 전부
# 공백-無 형태였기 때문 — 모듈 docstring "공백 없음" 문구가 그 경계를 그대로 선언한다).
# 이번에 `\s*`를 더해 「이름 + 공백 + #N」도 같이 잡는다(_PR_PREFIX_RE가 이미 쓰던
# 관례 그대로 확장 — 새 패턴 발명 0). `extra_repo_short_names`(org 원장 파생, 동적)가
# 이 정적 다섯과 합쳐진다 — `extract_bare_story_ref_candidates` 참조.
_STATIC_REPO_SHORTHANDS: frozenset[str] = frozenset(
    {"agent-plugins", "gemini", "admin", "claude-plugin", "mobile"}
)


def _repo_shorthand_suffix_re(extra_repo_short_names: frozenset[str]) -> re.Pattern[str]:
    names = _STATIC_REPO_SHORTHANDS | extra_repo_short_names
    alternation = "|".join(re.escape(n) for n in sorted(names, key=len, reverse=True))
    return re.compile(rf"(?i:{alternation})\s*$")

# 보호 구간(스캔에서 제외) — fenced 코드블록·인라인 코드·이미 만들어진 entity 토큰.
_FENCED_CODE_RE = re.compile(r"```.*?```", re.DOTALL)
_INLINE_CODE_RE = re.compile(r"`[^`\n]+`")
# 페드루 PO CHANGES(카디르 발견, 2026-09-07) — `[^\]]*`는 라벨 안의 escape된 `\]`도
# 그 자리에서 매치를 끊는다(문자 클래스는 백슬래시 유무를 안 본다, `]` 자체를
# 제외했을 뿐). `reference_token`이 대괄호로 시작하는 제목("[BE·insights] 제목…")을
# `[\[BE·insights\] 제목…](entity:story:…)`처럼 escape해 실어 보내는데(우리 스토리
# 제목 대부분이 이 모양) — 그 escape된 `\]`에서 라벨 매치가 조기종료되면 토큰의
# 나머지 절반(예: 라벨 안의 「PR #4003」 같은 bare 번호)이 보호 구간 밖으로 새어나가
# 2단계 재스캔에서 다시 치환되어 중첩·깨진 토큰이 된다. `(?:\\.|[^\]\\])*`로 —
# escape 시퀀스(`\.`아무거나) 하나로 통째 소비하거나, 대괄호·백슬래시가 아닌 문자를
# 소비 — 진짜 닫는 `]`에 도달할 때까지 안 끊긴다.
_ENTITY_TOKEN_RE = re.compile(r"\[(?:\\.|[^\]\\])*\]\(entity:[a-z_]+:[^)]+\)")

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


def extract_bare_story_ref_candidates(
    content: str, *, extra_repo_short_names: frozenset[str] = frozenset(),
) -> list[tuple[int, int, int]]:
    """본문에서 «#숫자» 후보 위치를 뽑는다(DB 조회 없는 순수 함수 — 모양만 본다, 존재 여부는
    별도 async 함수의 몫. 은퇴한 @handle 파서의 `extract_handle_tokens`와 같은 형태였다).

    `extra_repo_short_names`(story #3652) — org의 `pull_request_story_link.repo_full_name`
    (원장, 동적)에서 파생한 짧은이름 집합. 정적 다섯(`_STATIC_REPO_SHORTHANDS`)과 합쳐
    레포명 배제 판별에 쓴다 — 호출부(`promote_bare_story_refs`)가 DB 조회 결과를 넘긴다
    (이 함수 자신은 여전히 DB 왕복 0).

    반환: (start, end, story_number) 튜플 리스트. 매치 직후 문자가 라틴 알파벳이면
    헥스 컬러류(`#74747c`)로 보고 그 후보 자체를 버린다(dev 실측 근거 — 모듈 docstring
    참조). 매치 직전 토큰이 「PR」/「pr」/「pull」이면(story #2651·#3652) PR 번호로 보고
    마찬가지로 버린다 — `_PR_PREFIX_RE` 참조. 매치 직전이 「owner/repo」꼴(슬래시 있음)
    이면(story #3652) 레포가 원장에 있는지와 무관하게 항상 버린다 — `_SLASH_QUALIFIED_
    REPO_RE` 참조(PR 링크 해석 시도는 `_find_explicit_repo_pr_candidates`가 별도로
    한다). 매치 직전이 알려진 레포 짧은이름(정적+동적, 공백 유무 무관)으로 끝나면
    (story #2660·#3652) GitHub「repo-name#N」류로 보고 버린다 — `_repo_shorthand_
    suffix_re` 참조(⛔허용목록 방식 — "라틴 단어문자 전부"가 아니다. story#N/BE#N류
    정상 팀 표기는 이 목록에 없어 계속 승격된다, #2660 GROUP BY 실측). 코드블록/
    인라인코드/기존 entity 토큰 내부는 여기서 걸러지지 않는다 — 그건 `_protected_spans`
    가 별도로 처리(관심사 분리: 이 함수는 "무엇이 숫자 토큰처럼 생겼는가"만, 저건
    "어디를 건드리면 안 되는가"만)."""
    if not content:
        return []
    repo_shorthand_re = _repo_shorthand_suffix_re(extra_repo_short_names)
    candidates: list[tuple[int, int, int]] = []
    for m in _BARE_STORY_REF_RE.finditer(content):
        start = m.start()
        end = m.end()
        if end < len(content) and _LATIN_RE.match(content[end]):
            continue
        if _PR_PREFIX_RE.search(content, 0, start):
            continue
        if _SLASH_QUALIFIED_REPO_RE.search(content, 0, start):
            continue
        if repo_shorthand_re.search(content, 0, start):
            continue
        candidates.append((start, end, int(m.group(1))))
    return candidates


def _repo_short_name(full_name: str) -> str:
    return full_name.rsplit("/", 1)[-1]


def _find_explicit_repo_pr_candidates(
    content: str, *, known_full_names: frozenset[str],
) -> list[tuple[int, int, str, int]]:
    """story #3652(PO 確定 2026-09-07) — GitHub PR URL·`owner/repo#N`·(원장 유일 일치 시)
    맨 `repo#N`을 찾아 (start, end, repo_full_name, pr_number) 4-tuple로 돌려준다.
    repo_full_name은 `normalize_repo()`로 정규화(lowercase) — `pull_request_story_link`
    조회 키와 항상 같은 프레임(PO 재確定 — "다른 출처 둘을 비교하면 갈리는 창이 생긴다").

    ⛔`repo#N`(슬래시 없는 맨 이름)은 `known_full_names`의 짧은이름이 **유일하게** 일치할
    때만 후보가 된다 — 두 개 이상의 full_name이 같은 짧은이름을 공유하면(예: 서로 다른
    owner의 동명 레포) 어느 쪽인지 원리적으로 모른다는 뜻이라 후보에서 뺀다(모호=조용히
    스킵, `owner/repo#N`으로 명시하면 이 모호함 자체가 없다)."""
    from app.services.pr_story_link import normalize_repo

    found: list[tuple[int, int, str, int]] = []
    consumed: list[tuple[int, int]] = []

    for m in _GITHUB_PR_URL_RE.finditer(content):
        found.append((m.start(), m.end(), normalize_repo(m.group(1)), int(m.group(2))))
        consumed.append(m.span())

    for m in _OWNER_REPO_HASH_RE.finditer(content):
        if _in_protected_span(m.start(), consumed):
            continue
        found.append((m.start(), m.end(), normalize_repo(m.group(1)), int(m.group(2))))
        consumed.append(m.span())

    if known_full_names:
        short_to_fulls: dict[str, set[str]] = {}
        for full in known_full_names:
            short_to_fulls.setdefault(_repo_short_name(normalize_repo(full)), set()).add(normalize_repo(full))
        unique_shorts = {short: next(iter(fulls)) for short, fulls in short_to_fulls.items() if len(fulls) == 1}
        if unique_shorts:
            alternation = "|".join(re.escape(s) for s in sorted(unique_shorts, key=len, reverse=True))
            bare_repo_hash_re = re.compile(rf"(?<![\w/])({alternation})\s*#(\d+)\b", re.IGNORECASE)
            for m in bare_repo_hash_re.finditer(content):
                if _in_protected_span(m.start(), consumed):
                    continue
                full = unique_shorts.get(m.group(1).lower())
                if full is None:
                    continue
                found.append((m.start(), m.end(), full, int(m.group(2))))
                consumed.append(m.span())

    return found


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
    """본문의 «#N» 후보를 두 갈래로 나눠 처리한다(story #3652, PO 確定 2026-09-07 —
    실사고: 「sprintable-agent-plugins #46」이 이 org의 story #46로 옷을 입었다. story
    번호와 PR 번호가 같은 `#N` 표기 공간을 공유하는데, 치환기가 그 사실을 몰랐다).

    ① 명시 repo#N(`owner/repo#N`·GitHub PR URL·원장 유일 일치 시 맨 `repo#N`) — 항상
    story_number 승격 대상에서 빠진다. repo가 org의 `pull_request_story_link`
    (repo_full_name, pr_number)와 일치하면 그 PR의 연결 스토리로(있으면), 없으면
    본문 그대로(«아니면 침묵» — PO rule①, 새 참조 종류를 만들지 않는다: PR 자체를
    가리키는 entity type이 없어 «연결된 스토리»로만 표현 가능하다).
    ② 맨 `#N`(레포 표식 0) — 지금처럼 org+project 스코프 story_number로 resolve하되,
    같은 N이 org 전체(레포 무관) `pull_request_story_link.pr_number`에도 있으면
    모호(스토리 번호와 PR 번호가 우연히 겹침)로 보고 치환하지 않는다(PO rule② — 둘
    다 이 플랫폼 원장이라 "같은 프레임"으로 판정, 다른 소스를 비교하지 않는다).

    두 갈래 모두 resolve 실패(그 번호/PR의 대상이 없음·타 project 소속)면 **그 매치만**
    원문 그대로 남긴다(전체 all-or-nothing 아님 — 은퇴한 @handle 파서의 "매치 0건=조회도
    없이 조기 반환" 관대함과 동형 철학, 성실한 오독에서도 메시지 발신 자체는 막지 않는다).

    치환된 링크 텍스트는 원문 `#N`을 제목 앞에 남긴다(PO rule③ — 사람이 오인을 바로
    잡을 수 있게, 예: `#46 → [#46 S209: pm-api 정리…]`).

    story #2679(BE): 반환이 `str`에서 `(content, auto_story_ids)`로 바뀌었다 — 이번 호출에서
    **실제로 성공 치환한** story_id 집합을 같이 돌려준다(resolve 실패로 원문 그대로 남은
    번호는 안 들어간다). caller(conversations.py)가 이 집합을 `insert_chat_mentions`에
    그대로 전달해 «caller가 명시로 타이핑한 브라켓 토큰»과 «서버가 여기서 승격한 것»을
    entity_references.origin에서 가른다(explicit vs auto) — 본문 자체(치환된 브라켓 토큰)는
    이 함수가 이미 심어 둔 그대로, 파싱만으로는 두 출처를 구분할 수 없기 때문에 별도 채널로
    넘긴다."""
    if not content:
        return content, set()
    # story #3652 CHANGES(자체 발견, 실사고 없이 회귀 테스트로 적발 — test_conversations.py
    # ::test_send_message_201) — 아래 PullRequestStoryLink 조회를 무조건 앞세우면 「#」도
    # 「/pull/」도 없는 평범한 메시지("안녕")마다 매 발신 시 DB 왕복 1회가 새로 붙는다(기존
    # 계약: 후보 0건이면 DB 왕복 0회, extract_bare_story_ref_candidates의 早期 반환과
    # 동형). 세 정규식 중 하나도 안 물면 이 함수가 만질 수 있는 게 원리적으로 없다(맨
    # #N·owner/repo#N 전부 `#`을 요구, GitHub URL은 `/pull/`을 요구) — 이 셋 다 없으면
    # DB 조회 자체를 건너뛴다.
    if not (
        _BARE_STORY_REF_RE.search(content)
        or _OWNER_REPO_HASH_RE.search(content)
        or _GITHUB_PR_URL_RE.search(content)
    ):
        return content, set()

    from app.models.pm import Story
    from app.models.pull_request_story_link import PullRequestStoryLink

    # org 전체(모든 repo) PR 링크 원장 — story #3652의 SSOT(둘 다 이 원장을 쓴다: ①의
    # repo_full_name 대조·②의 pr_number 모호 판정).
    pr_link_rows = (await db.execute(
        select(
            PullRequestStoryLink.repo_full_name, PullRequestStoryLink.pr_number,
            PullRequestStoryLink.story_id,
        ).where(PullRequestStoryLink.org_id == org_id, PullRequestStoryLink.deleted_at.is_(None))
    )).all()
    known_full_names = frozenset(r.repo_full_name for r in pr_link_rows)
    pr_story_by_key: dict[tuple[str, int], uuid.UUID] = {
        (r.repo_full_name, r.pr_number): r.story_id for r in pr_link_rows
    }
    org_pr_numbers = frozenset(r.pr_number for r in pr_link_rows)

    result = content
    promoted_ids: set[uuid.UUID] = set()

    # ── ① 명시 repo#N — story_number 승격보다 먼저(우선순위가 이긴다, PO rule①).
    # 코드블록/인용부호/블록인용 안은 맨 #N과 같은 이유로 여기서도 보호(story #3162
    # 원칙 — 예시로 재인용된 repo#N도 "새로 참조하려는 의도"가 아니다).
    explicit_protected = _protected_spans(content)
    explicit = [
        c for c in _find_explicit_repo_pr_candidates(content, known_full_names=known_full_names)
        if not _in_protected_span(c[0], explicit_protected)
    ]
    if explicit:
        story_ids_needed = {
            pr_story_by_key[(repo, n)]
            for _, _, repo, n in explicit
            if (repo, n) in pr_story_by_key
        }
        title_by_id: dict[uuid.UUID, str] = {}
        if story_ids_needed:
            rows = (await db.execute(
                select(Story.id, Story.title).where(
                    Story.id.in_(story_ids_needed), Story.deleted_at.is_(None),
                )
            )).all()
            title_by_id = {sid: title for sid, title in rows}
        for start, end, repo, pr_number in sorted(explicit, key=lambda c: c[0], reverse=True):
            story_id = pr_story_by_key.get((repo, pr_number))
            if story_id is None or story_id not in title_by_id:
                continue  # 레포는 식별됐지만(원장 유일 일치) 그 PR에 스토리 링크가 없다 — 본문 그대로.
            token = build_reference_token("story", story_id, f"#{pr_number} {title_by_id[story_id]}")
            if token is None:
                continue
            result = result[:start] + token + result[end:]
            promoted_ids.add(story_id)

    # ── ② 맨 #N(스토리 번호) — ①이 이미 치환한 자리는 지금 entity 토큰이라
    # `_protected_spans`의 `_ENTITY_TOKEN_RE`가 자연히 다시 보호한다(별도 좌표 보정 불요).
    known_short_names = frozenset(_repo_short_name(f) for f in known_full_names)
    candidates = extract_bare_story_ref_candidates(result, extra_repo_short_names=known_short_names)
    if not candidates:
        return result, promoted_ids
    protected = _protected_spans(result)
    candidates = [c for c in candidates if not _in_protected_span(c[0], protected)]
    # PO rule② — 같은 N이 org(레포 무관) pr_number에도 있으면 모호. story_number와
    # pr_number가 같은 플랫폼 원장(다른 소스가 아니다)이라 이 대조가 "같은 프레임"이다.
    candidates = [c for c in candidates if c[2] not in org_pr_numbers]
    if not candidates:
        return result, promoted_ids

    numbers = {c[2] for c in candidates}
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
        return result, promoted_ids

    # 뒤에서부터 치환 — 앞쪽 매치의 인덱스가 뒤 치환으로 밀리지 않게.
    for start, end, number in sorted(candidates, key=lambda c: c[0], reverse=True):
        found = story_by_number.get(number)
        if found is None:
            continue
        story_id, title = found
        token = build_reference_token("story", story_id, f"#{number} {title}")
        if token is None:
            continue
        result = result[:start] + token + result[end:]
        promoted_ids.add(story_id)
    return result, promoted_ids
