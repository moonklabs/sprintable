"""story #1993(E-KNOWLEDGE-LINK S1) — mentions write-path 파서. 근본 설계 doc
design-org-knowledge-mentions-backlinks §2.

순수 추출 함수 + DB write 헬퍼로 구성된다:

  · `extract_chat_entity_mentions` — 채팅 메시지 content 에서 `[title](entity:<type>:<uuid>)`
    토큰(FE `apps/web/src/components/chat/chat-input.tsx` applyEntity 가 만드는 정확한 포맷 —
    `#` 트리거 검색 결과 선택 시 삽입)을 (entity_type, id) 쌍으로 **전부** 추출한다. 채팅
    메시지는 수정 불가 전제라 파서도 매번 전체를 새로 파싱해 insert-only 로 쓴다(재조정 불필요).
  · `extract_chat_doc_mention_ids` — 위의 doc-only 하위호환 래퍼(기존 호출부/테스트용).
  · `extract_doc_mention_ids` — doc content(HTML — tiptap `editor.getHTML()` 그대로 저장,
    content_format 무관하게 실제 마크업은 HTML)에서 wikiLink(`<span data-type="wikiLink"
    data-doc-id="...">`) 와 pageEmbed(`<div data-page-embed data-doc-id="...">`) 의
    `data-doc-id` attribute 를 추출한다. **정규식이 아닌 `html.parser.HTMLParser` 사용** —
    attribute 순서가 보장되지 않는다는 게 설계 doc 의 근거(mergeAttributes 가 만드는 순서는
    tiptap 내부 구현에 의존하므로 위치 기반 정규식은 취약).

추출 함수는 malformed 토큰(파싱 실패·잘못된 UUID)을 **조용히 스킵**한다 — 멘션 파싱 실패로
본 메시지/문서 저장 전체가 실패하면 안 된다는 원칙(AC와 별개로, 파서 자체의 malformed-tolerance).
자기참조(target doc == source doc)는 doc write 헬퍼가 드롭한다.

⛔story #2260: **어떤 entity_type 이 지원되는지는 추출 함수의 관심사가 아니다** — 추출은
`entity:<type>:<id>` 토큰을 있는 그대로 전부 뽑고, "지금 이 write-path 가 뭘 쓰기 허용하는가"는
`insert_chat_mentions(target_types=...)` 파라미터가 결정한다. 새 타입을 열려면 registry(아래
참조) + 그 기본값만 넓히면 되고, 추출 함수나 write 헬퍼 몸통에 분기를 추가할 필요가 없다 —
«메시지→문서만 되고 메시지→스토리는 파서가 막는» 죽은 경로가 이 구조에서는 재발하지 않는다.

⛔story #2273(C-1b): write 대상이 옛 `mentions` 표에서 **`entity_references` 표로 재배선**됐다
(#2259가 세운 그 표). `target_types` 기본값도 `app.models.mention.TARGET_TYPES`(스키마 CHECK)
대신 `app.services.reference_registry.ENTITY_RESOLVERS`(실제 쓰기 가능한 타입의 진짜 SSOT —
이제 Mention이 아니라 Reference가 write target이므로 그쪽 registry가 맞는 기준)를 쓴다.
옛 `mentions` 표는 이 모듈에서 더 이상 쓰지 않는다(지우지는 않는다 — 되돌릴 길, #2273 AC7).

기존 `mentioned_ids`(ConversationMessage 컬럼·멤버 알림용) 파이프라인은 이 모듈이 전혀
참조하지 않는다 — 완전히 독립된 병행 경로.

⛔story #2284: 이 모듈이 쓰는 form은 `mention`·`embed` 둘뿐이다. `proof`는 여기서 만들지
않는다 — 「지원 안 함」이 아니라 「아직 안 만듦」이다: proof는 #2265(대화 일부를 view-only로
잘라 박는 기능, 별도 write 경로)의 몫으로 설계돼 있고 그 write 경로 자체가 아직 없다(코드
0줄). doc의 wikiLink→mention·pageEmbed→embed 구분은 파싱 시점에 이미 있던 재료를 저장
시점에 버리지 않게 고친 것뿐이라 작은 일이었지만, proof는 새 UI 흐름(어느 대화 구간을
자를지)과 새 write 경로가 통째로 필요해 크기가 다르다.

⛔story #2316 AC5(미르코 문안, 디디 반영): 이 파서가 «못 보는» 것:
  ①맨 번호 — 본문의 `#2249`처럼 대괄호·`entity:` 문법이 **아예 없는** 참조. 이 판은 그것을
    **한 건도 안 센다.** 사람이 손으로 쓴 참조 대부분이 이 모양이다(C-11이 다룬다).
  ②닫힌 문법 밖 — `](entity:`를 포함한 무관한 텍스트가 오탐을 낼 수 있다(기존).
  ⇒ 즉 이 파서의 수치는 **「멘션 문법으로 쓰인 것」의 전수**이지 **「본문에 있는 참조」의
    전수가 아니다.** 두 수를 같은 이름으로 부르면 안 된다 — #2269(C-11)의 원석 830~1993건이
    전부 ①모양이라, 이 파서로 재고 "참조 N건"이라 부르면 그 수가 실제의 몇십 분의 일이다.
"""
from __future__ import annotations

import logging
import re
import uuid
from dataclasses import dataclass
from html.parser import HTMLParser
from typing import Any

from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.models.reference import Reference
from app.services.member_resolver import canonicalize_member_id
from app.services.reference_core import _batch_resolve_existence
from app.services.reference_registry import ENTITY_RESOLVERS

logger = logging.getLogger(__name__)

_UUID_RE = r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"

# FE `applyEntity`(chat-input.tsx) 가 만드는 정확한 토큰: `[title](entity:<type>:<id>) `.
# id 는 UUID. type 그룹을 남겨 향후 story/epic 확장 시 재사용 가능하게 하되, 이번엔 doc 만 필터.
#
# ⛔story #2282(PO critical, 2026-07-28): title 안의 `[^\]]*`(그냥 "]가 아닌 문자 반복")는
# escape 를 전혀 모른다 — title 에 `]`가 들어가면(이 조직의 실제 명명 관례 `[TAG] 제목`이
# 정확히 이 경우다) **어디서 escape 했든 안 했든** 그 `]`에서 무조건 멈추고, 그 뒤에
# `(entity:...)`가 바로 안 오면(제목이 이어지므로 안 온다) **매치 자체가 통째로 실패**한다
# (조용히 0건 추출 — AC4 왕복 실증 중 직접 재현). `(?:[^\]\\]|\\.)*`로 교체: "]나 \가 아닌
# 문자" 또는 "\+아무문자(escape 시퀀스)"의 반복 — escape된 `\]`는 멈추지 않고 진짜(escape
# 안 된) `]`에서만 멈춘다. `build_reference_token`(reference_token.py)이 title을
# backslash-escape하는 것과 **짝**이다 — 한쪽만 고치면(escape만 하고 파서는 그대로) 여전히
# 안 열린다는 것을 실측으로 확인했다.
_CHAT_TOKEN_RE = re.compile(
    r"\[(?:[^\]\\]|\\.)*\]\(entity:(?P<type>[a-z]+):(?P<id>" + _UUID_RE + r")\)"
)


def extract_chat_entity_mentions(content: str) -> list[tuple[str, uuid.UUID]]:
    """채팅 메시지 content 에서 `entity:<type>:<uuid>` 토큰 전부를 (entity_type, id) 쌍으로,
    순서 보존 + 중복 제거해 추출한다.

    ⛔story #2260: 어떤 entity_type 이 "지원되는지"는 이 함수의 관심사가 아니다 — 그 판단은
    write-path 호출부가 target_types 로 내린다(추출/저장의 경계를 함수 시그니처로 옮김).
    이 함수를 다시 열어 타입별 분기를 추가하는 일은 이제 없다(그러면 죽은 경로가 재발한다).

    malformed(정규식 미매치·잘못된 UUID)는 자연히 스킵된다.

    ⛔story #2282(PO 판정, 2026-07-28): "매치 실패가 조용했던 것" 자체가 사고였다 — 예전
    `_CHAT_TOKEN_RE`가 escape를 몰라 `[TAG] 제목`류(이 조직의 실제 명명 관례)에서 매치가
    통째로 실패했는데도 아무 신호가 없었다(사람은 picker로 골랐고 화면엔 링크처럼 보이는데
    데이터엔 아무것도 안 남는 — "실패가 성공처럼 보이는" 최악의 판). 그래서 이 함수는 이제
    "토큰 모양"(`](entity:`)이 본문에 있는데 실제 추출 건수가 그보다 적으면 경고 로그를
    남긴다 — 재발해도 조용히 안 넘어가게 하는 최소 감시망(완벽한 검출은 아니다 — 우연히
    `](entity:`를 포함한 무관한 텍스트가 오탐을 낼 수 있다는 것도 안다, 그래도 "0신호"보다
    낫다)."""
    if not content:
        return []
    seen: set[tuple[str, uuid.UUID]] = set()
    result: list[tuple[str, uuid.UUID]] = []
    for m in _CHAT_TOKEN_RE.finditer(content):
        entity_type = m.group("type")
        try:
            entity_id = uuid.UUID(m.group("id"))
        except (ValueError, AttributeError):
            continue
        key = (entity_type, entity_id)
        if key not in seen:
            seen.add(key)
            result.append(key)
    shape_count = content.count("](entity:")
    if len(result) < shape_count:
        logger.warning(
            "mention_parser: token-shaped substring count(%d) exceeds extracted count(%d) — "
            "possible silent parse failure. content_snippet=%r",
            shape_count, len(result), content[:200],
        )
    return result


# story #2316(2026-07-29, 까심 라이브 실측 — dev, 읽기 전용): id 부분이 UUID 모양이 아닌
# 토큰(`](entity:task:not-a-uuid)`)은 `_CHAT_TOKEN_RE`의 id 그룹이 `_UUID_RE`를 강제하므로
# 매치 자체가 실패한다 — `try/except ValueError`(위 106-109행)는 그래서 사실상 도달 불가
# 코드다. 그 결과 `count_phantom_task_mentions`(AC6)가 이 케이스를 영원히 "0건"으로
# 보고한다 — "탐지가 없다"가 아니라 "탐지된 게(위 shape_count 경고 로그) 도달하는 자리가
# 없다"(PO 표현). id를 느슨하게(`[^)]*`) 잡는 별도 정규식으로 "모양은 맞는데 못 파싱한"
# 토큰만 골라 caller(`insert_chat_mentions`)에 반환 — 그쪽이 `dropped`에
# `reason="malformed_token"`으로 얹는다. 코어(`reconcile_entity_references`)에 안 넣는
# 이유: 코어는 이미 파싱된 `extracted_refs`만 받는 계약이라(#2301) 애초에 추출조차 안 된
# 토큰은 코어의 시야 밖 — #2301의 "얇은 변환" 원칙 위반이 아니라 코어가 볼 수 없는 축이다.
_CHAT_TOKEN_SHAPE_RE = re.compile(
    r"\[(?:[^\]\\]|\\.)*\]\(entity:(?P<type>[a-z]+):(?P<id>[^)]*)\)"
)


def find_malformed_chat_tokens(content: str) -> list[dict[str, str]]:
    """모양(`](entity:<type>:...)`)은 맞지만 id가 UUID가 아니라 `extract_chat_entity_
    mentions`가 애초에 못 뽑은 토큰을 찾는다. 순서 무관, 중복 제거(동일 (type, raw_id)
    반복은 한 건으로)."""
    if not content:
        return []
    strict_matches = {
        (m.group("type"), m.group("id")) for m in _CHAT_TOKEN_RE.finditer(content)
    }
    seen: set[tuple[str, str]] = set()
    malformed: list[dict[str, str]] = []
    for m in _CHAT_TOKEN_SHAPE_RE.finditer(content):
        entity_type, raw_id = m.group("type"), m.group("id")
        key = (entity_type, raw_id)
        if key in strict_matches or key in seen:
            continue
        seen.add(key)
        malformed.append({"target_type": entity_type, "target_id": raw_id, "reason": "malformed_token"})
    return malformed


def extract_chat_doc_mention_ids(content: str) -> list[uuid.UUID]:
    """`extract_chat_entity_mentions`의 doc-only 하위집합(하위호환 편의 래퍼) — 순서 보존.
    ⛔새 호출부는 이 함수 대신 `extract_chat_entity_mentions`를 쓸 것(타입 필터링이 이미
    걸려 있어 story #2260이 고친 문제를 다시 들여올 수 있다)."""
    return [eid for etype, eid in extract_chat_entity_mentions(content) if etype == "doc"]


class _DocMentionHTMLParser(HTMLParser):
    """wikiLink(`span[data-type=wikiLink]`)·pageEmbed(`div[data-page-embed]`) 의 data-doc-id
    attribute 를 순서 무관하게 추출. 정규식 대신 HTMLParser 를 쓰는 이유(설계 doc §2 근거):
    tiptap `mergeAttributes`/`renderHTML` 이 만드는 attribute 순서가 보장되지 않아 위치 기반
    정규식은 attribute 순서가 바뀌면 깨진다 — HTMLParser 는 attrs 를 (name, value) 튜플 리스트로
    주므로 dict 화해 이름으로 조회하면 순서 무관.

    story #2284: 어느 태그였는지(wikiLink=인라인 멘션 / pageEmbed=카드 임베드)를 **버리지
    않고** (doc_id, form) 쌍으로 남긴다 — 파싱 시점엔 이미 있던 구분이 예전엔 저장 시점에
    뭉개졌다(#2259 이후 form이 리터럴 "mention"으로 하드코딩됐던 자리).
    """

    def __init__(self) -> None:
        super().__init__()
        self.doc_refs: list[tuple[str, str]] = []  # (raw_doc_id, form)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr_map = dict(attrs)
        if tag == "span" and attr_map.get("data-type") == "wikiLink":
            doc_id = attr_map.get("data-doc-id")
            if doc_id:
                self.doc_refs.append((doc_id, "mention"))
        elif tag == "div" and "data-page-embed" in attr_map:
            doc_id = attr_map.get("data-doc-id")
            if doc_id:
                self.doc_refs.append((doc_id, "embed"))


def extract_doc_mention_targets(html_content: str) -> list[tuple[uuid.UUID, str]]:
    """doc content(HTML) 에서 wikiLink/pageEmbed 의 data-doc-id 를 **형태(form)와 함께** 순서
    보존 + 중복 제거로 추출한다. 반환: `[(target_doc_id, form), ...]` — wikiLink→"mention",
    pageEmbed→"embed"(story #2284). 같은 doc이 인라인 멘션과 카드 임베드 둘 다로 등장하면
    서로 다른 (id, form) 쌍이라 둘 다 남는다(entity_references의 partial unique index가
    form을 키에 포함하므로 공존 가능 — 우연이 아니라 설계).

    malformed HTML(HTMLParser 가 못 견디는 조각)·malformed UUID 는 조용히 스킵 — 파서 예외로
    전체 doc 저장이 실패하면 안 된다."""
    if not html_content:
        return []
    parser = _DocMentionHTMLParser()
    try:
        parser.feed(html_content)
        parser.close()
    except Exception:
        # HTMLParser 는 malformed 마크업에도 대체로 관대(best-effort recovery)하지만, 방어적으로
        # 예외 자체도 삼킨다 — 여기까지 왔으면 이미 파싱된 partial 결과를 그대로 쓴다(전체 실패 금지).
        pass
    seen: set[tuple[uuid.UUID, str]] = set()
    result: list[tuple[uuid.UUID, str]] = []
    for raw_id, form in parser.doc_refs:
        try:
            doc_id = uuid.UUID(raw_id)
        except ValueError:
            continue
        key = (doc_id, form)
        if key not in seen:
            seen.add(key)
            result.append(key)
    return result


def extract_doc_mention_ids(html_content: str) -> list[uuid.UUID]:
    """하위호환 편의 래퍼(story #2284) — id만 필요한 호출부용. form 정보가 필요하면
    `extract_doc_mention_targets`를 직접 쓸 것(reconcile_doc_mentions가 그렇게 한다)."""
    seen: set[uuid.UUID] = set()
    result: list[uuid.UUID] = []
    for doc_id, _form in extract_doc_mention_targets(html_content):
        if doc_id not in seen:
            seen.add(doc_id)
            result.append(doc_id)
    return result


@dataclass(frozen=True)
class ChatMentionResult:
    """story #2294 ③ — 메시지 전송 응답의 `references` 사이드밴드가 그대로 실어 나르는 모양
    (`command_gate.blocked[]` 선례와 동일 원칙, 재구현 0). `stored`는 이번 호출에서 실제로
    쓰기를 시도한 건수(등록된 target_type만), `dropped`는 토큰은 파싱됐지만 target_type이
    `target_types`(registry) 밖이라 걸러진 것들 — 화면이 "연결했다고 믿었는데 조용히 안
    만들어진" 경우를 볼 수 있는 유일한 창구다(#2294 발견의 근본 원인)."""

    stored: int
    dropped: list[dict[str, str]]


@dataclass(frozen=True)
class ReconcileResult:
    """story #2301(E-CONNECT, 오르테가 판정 2026-07-29) — `insert_chat_mentions`(마크다운
    파서·target_types 인자·dropped 추적)와 `reconcile_doc_mentions`(diff 기반 stale 삭제)를
    한 벌로 병합한 코어 `reconcile_entity_references`의 반환값.

    ⛔파서(어떤 문법에서 어떤 토큰을 뽑는가)는 이 코어 밖이다 — caller가 source-format에
    맞는 추출 함수(마크다운은 `extract_chat_entity_mentions`, doc HTML은
    `extract_doc_mention_targets`)를 미리 돌려 `(target_type, target_id, form)` 3튜플
    집합으로 넘긴다. 한 함수 안에 마크다운·HTML 파서 둘을 분기로 박지 않는다(PO 지시,
    AC1: "story 전용 write 헬퍼가 0" — 이 병합 자체가 그 요건).

    diff-against-empty(신규 source, 기존 참조 0건)는 순수 insert와 결과가 같다 — 그래서
    이 코어는 "insert-only냐 reconcile이냐"를 인자로 안 가른다(항상 diff). 채팅처럼 불변
    콘텐츠는 매번 기존 참조가 0건이라 stale 삭제가 구조적으로 안 도는 것으로 회귀 0을
    보장한다(AC4 — insert_chat_mentions 래퍼가 이 사실에 의존)."""

    stored: int
    removed: int
    dropped: list[dict[str, str]]


async def reconcile_entity_references(
    db: AsyncSession,
    *,
    org_id: uuid.UUID,
    source_type: str,
    source_field: str,
    source_id: uuid.UUID,
    extracted_refs: list[tuple[str, uuid.UUID, str]],
    created_by: uuid.UUID | None,
    target_types: frozenset[str] = frozenset(ENTITY_RESOLVERS),
    known_new: bool = False,
) -> ReconcileResult:
    """story #2301 — `(source_type, source_field, source_id)` 하나가 «지금» 가리키는 대상
    전체를 diff로 맞춘다: 사라진 토큰의 참조는 삭제(`removed`), 새로 생긴 토큰은 insert
    (`stored`). 자기참조(target==source, 예: doc이 자기 자신을 wikiLink)는 드롭(doc의
    기존 self-ref 가드를 일반화한 것 — `tt == source_type and tid == source_id`).

    `extracted_refs`는 caller가 이미 파싱해 온 (target_type, target_id, form) 3튜플이다 —
    이 함수는 파싱을 하지 않는다(`ReconcileResult` docstring 참조). `target_types` 밖의
    target_type은 registry 미등록으로 걸러 `dropped`에 담는다(#2294 관례 그대로 — 침묵 거부
    금지). 이 필터·dropped·경고 로직은 **여기 한 곳에만** 있다 — caller(래퍼)가 같은 로직을
    다시 하면 코어가 나중에 바뀔 때 래퍼만 옛 모양으로 남는 twin-system 갭이 된다(오르테가
    리뷰 지적, 2026-07-29 — `insert_chat_mentions`가 실제로 이 갭에 걸렸었다).

    `known_new=True`(채팅 전용): source_id가 **이번에 처음 생긴 것이라 기존 참조가 있을
    수 없다는 걸 caller가 이미 아는 경우**(메시지는 불변·매번 신규) — existing-refs SELECT와
    stale-delete를 통째로 건너뛴다(insert-only 고속 경로). ⛔이걸 "valid가 비면 스킵"으로
    일반화하면 안 된다 — doc/story처럼 **재조정되는** source는 이번 저장에 유효한 대상이
    0개여도(토큰을 전부 지운 경우) 삭제해야 할 **기존** stale 참조가 있을 수 있어(`test_doc_
    reconcile_adds_and_removes_stale_mentions`·`test_clearing_description_entirely_removes_
    all_its_references` 참조) existing-refs 조회를 건너뛸 수 없다. `known_new`는 "이 source_id
    자체가 신규"라는 caller의 사전 지식이지, "이번 파싱 결과가 비었다"는 사후 계산이 아니다
    — 그래서 기본값 False(안전한 쪽)이고 chat만 명시적으로 True를 넘긴다.

    같은 트랜잭션(caller 세션 그대로 사용, 별도 커밋 없음) — 실패 시 예외가 그대로
    propagate되어 caller(story/doc/chat 저장 트랜잭션) 전체가 롤백된다(chat/doc 기존
    AC4 원자성 계약과 동일)."""
    valid = [(tt, tid, form) for tt, tid, form in extracted_refs if tt in target_types]
    dropped = [
        {"target_type": tt, "target_id": str(tid), "reason": "unregistered_target_type"}
        for tt, tid, _form in extracted_refs if tt not in target_types
    ]
    if dropped:
        logger.warning(
            "reconcile_entity_references: dropped %d ref(s) with unregistered target_type "
            "(source_type=%s, source_field=%s, source_id=%s, target_types=%s) dropped=%s",
            len(dropped), source_type, source_field, source_id, sorted(target_types), dropped,
        )

    target_refs = {
        (tt, tid, form) for tt, tid, form in valid
        if not (tt == source_type and tid == source_id)
    }

    # ⛔story #2294 후속(2026-07-29, 오르테가 라이브 실측): 실재하지 않는(또는 이 org 밖)
    # target_id가 그대로 저장되던 결함 — POST /references(insert_reference 호출부)·
    # GET /entities/search는 이미 존재판정을 거치는데 이 write-path만 target_types(등록된
    # «타입»인가)만 보고 target_id의 «실재»는 한 번도 확認하지 않았다(미르코 코드 추적으로
    # 좁힌 자리, PO가 dev 라이브에서 직접 재현). `reference_core._batch_resolve_existence`
    # (POST /references·GET /search와 같은 계열, ENTITY_RESOLVERS 그 자체)를 그대로 재사용
    # — 세 번째 게이트를 새로 짓지 않는다(PO 지시). 각 resolver가 `WHERE org_id == org_id`로
    # 스코프하므로 크로스-org 실재 UUID도 "없음"으로 걸린다(존재+org 소속을 한 번에 검증).
    # 존재하지 않는 target은 `dropped`로(사유를 `unregistered_target_type`과 구분되게
    # `target_not_found`로 — "타입이 미등록"과 "대상이 없음"은 사람이 할 일이 다르다는 PO
    # 판단). ㉠target_refs가 비면 ids_by_type도 비어 `_batch_resolve_existence`가 session을
    # 아예 안 건드린다 — known_new=True·db=None 자기검증 경로(아래 known_new 분기 참조)의
    # "DB 왕복 0" 불변식을 이 게이트가 깨지 않는다.
    if target_refs:
        ids_by_type: dict[str, set[uuid.UUID]] = {}
        for tt, tid, _form in target_refs:
            ids_by_type.setdefault(tt, set()).add(tid)
        existing_by_type = await _batch_resolve_existence(db, org_id, ids_by_type)
        not_found = [
            (tt, tid, form) for tt, tid, form in target_refs
            if tid not in existing_by_type.get(tt, set())
        ]
        if not_found:
            dropped.extend(
                {"target_type": tt, "target_id": str(tid), "reason": "target_not_found"}
                for tt, tid, _form in not_found
            )
            logger.warning(
                "reconcile_entity_references: dropped %d ref(s) whose target does not exist "
                "(source_type=%s, source_field=%s, source_id=%s) dropped=%s",
                len(not_found), source_type, source_field, source_id,
                [{"target_type": tt, "target_id": str(tid)} for tt, tid, _form in not_found],
            )
            target_refs -= set(not_found)

    if known_new:
        # insert-only 고속 경로 — existing-refs SELECT/stale-delete 자체를 건너뛴다(DB 왕복
        # 0~1회: target_refs가 비면 그마저도 0). `test_dropped_logging_red_green_mutation_
        # self_check`가 db=None으로 이 경로를 직접 실증한다.
        existing_refs: set[tuple[str, uuid.UUID, str]] = set()
        stale_refs: set[tuple[str, uuid.UUID, str]] = set()
    else:
        existing_rows = await db.execute(
            select(Reference.target_type, Reference.target_id, Reference.form).where(
                Reference.org_id == org_id,
                Reference.source_type == source_type,
                Reference.source_field == source_field,
                Reference.source_id == source_id,
                Reference.form.in_(("mention", "embed")),
            )
        )
        existing_refs = {(row.target_type, row.target_id, row.form) for row in existing_rows.all()}

        stale_refs = existing_refs - target_refs
        if stale_refs:
            from sqlalchemy import delete as sa_delete, tuple_

            await db.execute(
                sa_delete(Reference).where(
                    Reference.org_id == org_id,
                    Reference.source_type == source_type,
                    Reference.source_field == source_field,
                    Reference.source_id == source_id,
                    tuple_(Reference.target_type, Reference.target_id, Reference.form).in_(stale_refs),
                )
            )

    new_refs = target_refs - existing_refs
    if new_refs:
        canonical_created_by = await canonicalize_member_id(created_by, db)
        stmt = pg_insert(Reference).values([
            {
                "id": uuid.uuid4(),
                "org_id": org_id,
                "source_type": source_type,
                "source_field": source_field,
                "source_id": source_id,
                "target_type": target_type,
                "target_id": target_id,
                "form": form,
                "created_by": canonical_created_by,
            }
            for target_type, target_id, form in new_refs
        ])
        stmt = stmt.on_conflict_do_nothing(
            index_elements=[
                Reference.source_type, Reference.source_field, Reference.source_id,
                Reference.target_type, Reference.target_id, Reference.form,
            ],
            index_where=Reference.form != "proof",
        )
        await db.execute(stmt)

    return ReconcileResult(stored=len(new_refs), removed=len(stale_refs), dropped=dropped)


async def insert_chat_mentions(
    db: AsyncSession,
    *,
    org_id: uuid.UUID,
    message_id: uuid.UUID,
    content: str,
    created_by: uuid.UUID,
    target_types: frozenset[str] = frozenset(ENTITY_RESOLVERS),
) -> ChatMentionResult:
    """채팅 write-path: insert-only(메시지 불변 전제 — 재조정 불필요). 같은 트랜잭션(caller 의
    세션 그대로 사용·별도 커밋 없음) — 실패 시 예외가 그대로 propagate 되어 caller(메시지 전송
    트랜잭션) 전체가 롤백된다(AC4 원자성).

    ⛔story #2284 AC3: 채팅 쪽엔 **멘션/임베드를 가를 재료가 없다** — `_CHAT_TOKEN_RE`가 아는
    토큰 문법은 `[title](entity:type:id)` **하나뿐**(doc의 wikiLink/pageEmbed 같은 두 번째
    문법이 없다). 그래서 채팅은 지금 「없는데 있는 척」이 아니라 **문자 그대로 mention만
    만든다** — 아래 `"form": "mention"`이 하드코딩이 아니라 지금 있는 유일한 값이다. 채팅에
    임베드 문법을 추가하는 건 이 스토리 범위 밖(새 문법을 만드는 별건 — #2284 본문 참조).

    story #2260: target_type 은 본문에서 추출된 값을 그대로 쓴다(내부에서 결정하지 않는다) —
    이 함수엔 entity type 리터럴이 하나도 없다. `target_types`는 **지금 이 write-path 가
    실제로 쓰기를 허용하는 타입의 경계**(기본값 = reference_registry.ENTITY_RESOLVERS, story
    #2273부터 진짜 SSOT — write target이 Reference라 그쪽 registry가 기준) — 새 타입을
    지원하려면 registry + 이 기본값만 넓히면 되고, 이 함수 몸통에 분기를 추가할 필요가 없다.

    story #2273: write target이 옛 `mentions`(Mention)에서 `entity_references`(Reference)로
    재배선됐다. source_field="body"(채팅 메시지는 텍스트 필드가 하나뿐 — PO 정정, NULL로
    "없음"을 표현하지 않는다).

    ⛔story #2294 AC3/③(2026-07-28, 미르코 실측·PO 판정): 예전엔 `target_types` 밖 타입을
    **완전히 침묵하며** 걸렀다(반환값 `None`, 로그 0) — "화면은 링크를 그려 주는데 서버는
    조용히 거부"하는 결함이 여기서 났다(`task`가 실제로 이 자리에 걸렸다: 검색은 내주는데
    registry엔 없었다). 이제 걸러진 것을 `ChatMentionResult.dropped`로 반환 + `logger.warning`
    으로 남긴다 — 호출자(conversations.py)가 이걸 메시지 응답의 `references` 사이드밴드로
    실어 화면이 "저장 결과를 실제로 볼" 창구를 준다. `stored`는 성공(등록된 타입) 건수 —
    #2294 ①(검색 허용목록이 registry에서 파생)이 서면 화면이 애초에 못 고르는 종류를 보낼 수
    없어져 정상 경로에선 `dropped`가 항상 빈 배열이다. 그래도 이 필드를 남기는 이유: 사람이
    손으로 토큰을 치거나 에이전트가 API로 본문을 직접 쓸 수 있어(PO가 직접 실측 — escape
    안 된 raw `]` 토큰이 조용히 버려지는 것을 확인) 그 경로는 여전히 registry 밖 타입을 만들
    수 있다 — `dropped`가 비지 않는 것 자체가 그 신호(기능이 아니라 가드)다.

    ⛔story #2301(2026-07-29, 오르테가 리뷰 반영): 이 함수는 `reconcile_entity_references`
    (공용 코어)의 **얇은 변환**이다 — 파싱(`extract_chat_entity_mentions`, form 항상
    "mention")만 여기서 하고, 필터링·dropped 계산·경고 로그는 전부 코어에 맡긴다(코어를
    두 번째로 재구현하지 않는다 — 최초 리뷰에서 이 래퍼가 코어와 같은 필터/dropped/로그
    로직을 중복 소유해 "코어의 dropped 경로를 실제로 타는 호출부가 0"이 되는 twin-system
    갭이었다는 지적을 반영해 고쳤다).

    `known_new=True`를 코어에 넘긴다 — 채팅 메시지는 매번 신규(불변·재조정 불필요)라는
    사실을 caller가 이미 알고 있다는 선언(`reconcile_entity_references` docstring 참조).
    이 플래그 하나로 existing-refs 조회/stale-delete가 통째로 스킵되고, `extracted_refs`가
    비거나 전부 dropped라 insert할 것도 없으면 DB 왕복이 0회로 자연히 귀결한다 — 별도의
    "비면 skip" 분기를 이 래퍼에 따로 두지 않는다(`test_dropped_logging_red_green_mutation_
    self_check`가 `db=None`으로 이 경로를 직접 실증한다)."""
    all_pairs = extract_chat_entity_mentions(content)
    extracted_refs = [(etype, eid, "mention") for etype, eid in all_pairs]
    result = await reconcile_entity_references(
        db, org_id=org_id, source_type="chat_message", source_field="body",
        source_id=message_id, extracted_refs=extracted_refs, created_by=created_by,
        target_types=target_types, known_new=True,
    )
    # story #2316: 코어가 못 보는 축(추출조차 실패한 토큰) — 래퍼가 직접 찾아 dropped에
    # 얹는다(위 find_malformed_chat_tokens docstring 참조, #2301 "얇은 변환" 예외 아님).
    malformed = find_malformed_chat_tokens(content)
    if malformed:
        logger.warning(
            "insert_chat_mentions: dropped %d malformed-id token(s) — shape matched but id "
            "is not a UUID (message_id=%s) dropped=%s",
            len(malformed), message_id, malformed,
        )
    return ChatMentionResult(stored=result.stored, dropped=[*result.dropped, *malformed])


async def count_phantom_task_mentions(db: AsyncSession) -> int:
    """story #2294 AC6 — `task`가 registry 밖이던 시절 `insert_chat_mentions`가 조용히
    걸러낸 흔적을 센다: content에 `entity:task:<uuid>` 토큰이 있는데 `entity_references`에
    대응 행이 없는 메시지 수. 백필 여부는 PO가 판단 — 이 함수는 세기만 한다(조용히
    가정하지 않는다).

    N+1 금지 — 후보 메시지 id를 먼저 모아 한 번의 IN 조회로 존재 여부를 대조한다(reference_
    core.py의 `_batch_resolve_existence`와 동일 원칙)."""
    from app.models.conversation import ConversationMessage

    candidate_rows = (
        await db.execute(
            select(ConversationMessage.id, ConversationMessage.content).where(
                ConversationMessage.content.like("%entity:task:%")
            )
        )
    ).all()
    candidate_ids = [
        msg_id for msg_id, content in candidate_rows
        if any(etype == "task" for etype, _ in extract_chat_entity_mentions(content))
    ]
    if not candidate_ids:
        return 0

    existing_ids = set(
        (
            await db.execute(
                select(Reference.source_id).where(
                    Reference.source_type == "chat_message",
                    Reference.target_type == "task",
                    Reference.source_id.in_(candidate_ids),
                )
            )
        ).scalars().all()
    )
    return sum(1 for mid in candidate_ids if mid not in existing_ids)


async def reconcile_doc_mentions(
    db: AsyncSession,
    *,
    org_id: uuid.UUID,
    doc_id: uuid.UUID,
    html_content: str,
    created_by: uuid.UUID,
) -> None:
    """doc write-path: diff 기반 reconcile(create/update 공용 — create 는 existing=∅ 이라 순수
    insert 로 귀결). 새 content 에 더 이상 없는 기존 참조는 삭제, 새로 생긴 건
    ON CONFLICT DO NOTHING 으로 insert. 자기참조(target doc == source doc)는 드롭.

    ⛔story #2316 AC7(못 잡는 것 선언): 채팅 write-path의 `find_malformed_chat_tokens`
    (모양은 맞는데 id가 UUID가 아닌 토큰을 `dropped(reason="malformed_token")`로 잡는
    가드)는 이 함수(doc write-path)엔 없다 — `extract_doc_mention_targets`는 정규식이
    아니라 `HTMLParser`로 `data-doc-id` attribute를 읽는 구조라 "모양은 맞는데 파싱
    실패"라는 실패 축 자체가 성립하지 않는다(attribute가 없으면 그 태그를 그냥 못
    본 것 — "본 것 같은데 못 뽑았다"가 없다). 그래서 doc write-path는 malformed_token
    탐지 대상이 아니고, target 존재+org 소속 검증(story #2294 후속, 아래)만 적용된다.

    같은 트랜잭션(caller 세션 그대로) — 실패 시 예외 propagate 로 caller(doc 저장 트랜잭션)
    전체가 롤백된다(AC4 원자성).

    story #2273: write target이 `entity_references`로 재배선됐다. source_field="body"(doc
    본문은 텍스트 필드가 하나뿐).

    story #2284: diff 단위가 target_id 하나였던 것을 **(target_id, form) 쌍**으로 넓혔다 —
    같은 대상이라도 wikiLink(mention)와 pageEmbed(embed)는 서로 다른 행이라(파서가 이제
    구분을 보존한다). ⛔이 함수는 mention/embed 두 form만 다룬다 — proof(form)는 이 write
    경로가 만들지도 지우지도 않는다(#2265 전용 별도 write 경로 몫 — 아직 존재하지 않는다).
    그래서 존재-조회에 `Reference.form.in_(("mention", "embed"))`로 명시해 proof 행을
    이 diff의 시야 밖에 둔다(실수로 지우는 사고 원천 차단).

    ⛔AC4(기존 행 소급 재분류 안 함, 별개 판단): 이 함수는 «마이그레이션 스크립트»가 아니라
    doc이 저장될 때마다 도는 diff다 — 예전에 form="mention"으로 잘못 저장된 pageEmbed
    참조가 있는 doc을 사용자가 «다시 저장」하면, 그 저장이 새 파서로 다시 diff되어 자연히
    embed로 갈린다(그 doc이 재저장되지 않는 한 예전 값 그대로 남는다). 이건 소급 일괄
    재분류(=이 스토리가 안 하는 것)가 아니라 정상적인 reconcile-on-save의 자연스러운 결과다
    — 그래서 별도 backfill 코드는 없다. 그 doc의 `entity_references` row가 갈린 시점(=이
    행의 `created_at`)이 그 doc 한정으로는 경계다.

    ⛔story #2301(2026-07-29): 이 함수는 이제 `reconcile_entity_references`(공용 코어)의
    얇은 래퍼다 — 파싱(`extract_doc_mention_targets`, HTML wikiLink/pageEmbed)만 여기서
    하고 diff/write는 코어에 위임한다. self-ref 가드(`tid != doc_id`)는 코어의 일반화된
    가드(`target_type==source_type and target_id==source_id`, source_type이 항상 "doc"
    이므로 동치)로 대체됐다 — 동작 동일.

    ⛔`target_types`는 명시로 안 넘긴다(코어 기본값 = registry 전체를 그대로 쓴다) — 지금은
    추출 결과가 항상 "doc" 타입뿐이라 no-op이지만(오르테가 리뷰 지적, 2026-07-29), "doc은
    doc만 가리킨다"를 여기 하드코딩(`target_types={"doc"}`)해 두면 파서가 나중에 다른
    entity_type을 뽑게 되는 날(선생님 지시 원문 "어떤 엔티티든 임베드") 파서는 뽑았는데
    필터가 조용히 막는 벽이 된다. no-op인 지금 없애 두면 파서가 늘 때 이 함수를 안 고쳐도
    자동으로 따라온다."""
    extracted_refs = [
        ("doc", target_id, form) for target_id, form in extract_doc_mention_targets(html_content)
    ]
    await reconcile_entity_references(
        db, org_id=org_id, source_type="doc", source_field="body", source_id=doc_id,
        extracted_refs=extracted_refs, created_by=created_by,
    )


async def fetch_stored_references(
    db: AsyncSession, *, org_id: uuid.UUID, source_type: str, source_ids: list[uuid.UUID],
) -> dict[uuid.UUID, list[dict[str, str]]]:
    """story #2263 AC6 / #2262(C-4) 첫 발(오르테가 판정 2026-07-29, 스레드 7256d5cc) — 읽기
    경로용. 채팅 `#` 검색이 만든 칩은 write 응답(`references.dropped[]`, #2294)으로만
    한 번 확인되고 새로고침하면 사라진다 — `get_chat_message`가 그 메시지가 실제로 건
    참조를 다시 안 실어서(파서가 `content`를 재작성하지 않는 insert-only라 화면은 본문
    정규식 매치만으로 칩을 그리므로, dropped된 참조도 저장된 것과 똑같은 칩으로 보인다).

    ⛔이 함수는 **stored 참조만** 되살린다(`target_type`·`target_id` — "무엇을 가리키나"까지).
    `dropped`는 그 저장 시점의 이야기라 영속이 아니다(오르테가 판정) — 복원 대상이 아니고,
    FE는 "본문 토큰 N개 ↔ stored M개"를 대조해 어느 칩이 안 걸렸는지 스스로 가른다. 「지금
    상태·다음 행동」(status 등)은 여기서 안 얹는다 — #2262 본체가 얹을 자리(그 순간부터는
    새 노출이라 C-3/#2261 권한 게이트가 #2262 前에 서야 한다, 오르테가 판정 그대로).

    N+1 방지 — 호출자가 여러 source_id(예: `list_messages`의 페이지 전체)를 한 번에 넘기면
    쿼리 1회로 전부 해소한다(개별 message마다 왕복하지 않는다). `ix_entity_references_source`
    (org_id, source_type, source_id)가 이 IN 쿼리를 커버한다.

    반환: `source_id -> [{"target_type", "target_id", "form", "proof_payload"}, ...]`. 호출자는
    이 dict에 없는 source_id를 **빈 리스트**로 취급해야 한다(그 source가 stored 참조 0건이라는
    뜻 — "옛 서버라 필드가 없다"와 구분하기 위해 호출자가 payload에 항상 `references: []`를
    싣는 것이 이 함수의 계약이 아니라 **호출자의 책임**이다, 아래 conversations.py 참조).

    ⛔story #2262 후속(오르테가 지시, 2026-07-29): `form`·`proof_payload`를 추가한다 —
    `insert_reference`는 form 매개변수·FORMS 검증·proof_payload 필드까지 이미 갖췄는데(쓰기는
    갈리는데) 이 읽기 함수가 그 둘을 안 실어 와 화면이 mention/embed/proof를 못 갈랐다("저장·
    쓰기·읽기·표시" 중 읽기에서 끊기는 이 에픽의 반복 패턴). C-7(#2265)이 이 값으로 세 형태를
    가르는 첫 소비자가 된다."""
    if not source_ids:
        return {}
    rows = (await db.execute(
        select(
            Reference.source_id, Reference.target_type, Reference.target_id,
            Reference.form, Reference.proof_payload,
        ).where(
            Reference.org_id == org_id,
            Reference.source_type == source_type,
            Reference.source_id.in_(source_ids),
        )
    )).all()
    result: dict[uuid.UUID, list[dict[str, Any]]] = {}
    for source_id, target_type, target_id, form, proof_payload in rows:
        result.setdefault(source_id, []).append({
            "target_type": target_type, "target_id": str(target_id),
            "form": form, "proof_payload": proof_payload,
        })
    return result
