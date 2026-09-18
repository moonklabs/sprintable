"""story #2428 — 공용 cursor 페이지네이션 헬퍼(#2231 정본 규약 A: limit+1 오버페치 +
has_more/next_cursor body meta).

`encode_cursor`/`decode_cursor`는 story #1994(backlinks.py)가 이미 옳은 형태로 만들어 둔
것을 그대로 옮겨왔다 — `created_at` 단독이 아니라 `(created_at, id)` 복합 opaque 토큰.
`created_at`이 같은 두 행이 있으면(대량 생성·백필 등 흔한 상황) 단독 정렬키로는 페이지
경계에서 행이 누락되거나 중복될 수 있다는 것을 docs.py(story #2191, `encode_doc_cursor`
docstring 참조 — 그쪽은 `sort_order` 축이라 형태는 다르지만 같은 이유로 id 2차 정렬키를
쓴다)와 backlinks.py 둘 다 각자 발견해서 각자 고쳤다.

⚠️그런데 #2231이 정본으로 지목한 원본 구현(stories.py::list_comments/list_activities·
notifications.py·conversations.py::list_messages)은 `created_at` 단독 정렬 + 단독 cursor
그대로였다 — 같은 결함이 문서화되고 두 번 고쳐지는 동안 "정본"이라 불린 원본 넷에는 한
번도 안 돌아갔다. "정본"이라는 라벨이 "가장 옳다"를 뜻하지 않았다(#2412가 story #2248의
`/standups/history`만 고치고 `repo.list()`는 안 고쳤던 것과 같은 얼굴 — 매번 "한쪽만
고친다"). 이 헬퍼로 그 넷을 이관하는 것은 리팩터가 아니라 그 결함의 수정이다 — 기존에
발급된(단독 `created_at.isoformat()` 형태) cursor는 이 형태 변경으로 무효가 된다.
`decode_cursor`가 그 구형 포맷을 구분해 명시적으로 거부한다(조용히 잘못 해석하지 않는다 —
오늘 이 세션이 온종일 잡은 그 병과 동형).
"""
from __future__ import annotations

import base64
import json
import uuid
from collections.abc import Callable, Sequence
from datetime import datetime
from typing import TypeVar

from fastapi import HTTPException

T = TypeVar("T")


def encode_cursor(created_at: datetime, id_: uuid.UUID) -> str:
    """opaque composite keyset cursor — `(created_at, id)` 둘 다 인코드해 같은 `created_at`을
    가진 여러 행이 페이지 경계에서 영구 드롭/중복되지 않게 한다. 클라이언트는 이 토큰을 절대
    파싱하지 않고(불투명) 그대로 다음 요청에 되돌려준다."""
    payload = {"created_at": created_at.isoformat(), "id": str(id_)}
    raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii")


def decode_cursor(token: str) -> tuple[datetime, uuid.UUID]:
    """`encode_cursor`의 역함수. 손상/변조된 토큰은 400(Invalid cursor format).

    story #2428: 이 헬퍼로 막 이관된 호출부(stories.py/notifications.py/conversations.py)는
    이전엔 커서가 `created_at.isoformat()` 평문이었다 — 그 구형 토큰이 들어오면 base64/JSON
    파싱에 실패해 자연스럽게 400이 나지만, 그것만으론 호출자가 "왜" 깨졌는지 모른다(오타
    커서와 구분 안 됨). 원본 토큰이 그 자체로 유효한 ISO datetime으로 파싱되면(신형 토큰은
    base64+JSON이라 이렇게 우연히 파싱될 확률이 사실상 0) 구형 포맷이었다고 보고 전용
    메시지로 명시적으로 안내한다 — 조용히 잘못 해석해 틀린 페이지를 주는 대신, 처음부터
    다시 부르라고 말해준다.
    """
    try:
        raw = base64.urlsafe_b64decode(token.encode("ascii"))
        payload = json.loads(raw)
        return datetime.fromisoformat(payload["created_at"]), uuid.UUID(str(payload["id"]))
    except Exception as exc:
        try:
            datetime.fromisoformat(token)
            is_legacy_cursor = True
        except (ValueError, TypeError):
            is_legacy_cursor = False
        if is_legacy_cursor:
            raise HTTPException(
                status_code=400,
                detail=(
                    "cursor 형식이 바뀌었습니다(story #2428 — 페이지 경계 동률 버그 수정). "
                    "next_cursor 값을 다시 받아 처음부터 호출하세요."
                ),
            ) from exc
        raise HTTPException(status_code=400, detail="Invalid cursor format") from exc


def encode_metric_cursor(metric_value: int | None, published_at: datetime, id_: uuid.UUID) -> str:
    """story #3502(페드루 PO 決定 2026-09-05) — insights-board의 metric 정렬(예: 7일
    views) 전용 3키 컴포지트 — `(metric NULLS LAST, published_at DESC, id)`. 같은
    canonical 모듈에 태운다(`encode_cursor`의 2키 변형 — assets.py의 별도 제네릭
    커서·구식 ISO 커서를 새로 안 늘린다, 4번째 발명 금지). `metric_value=None`은
    "이 지표가 미제공/미측정"(3497의 null≠0 규율) — JSON에 문자열 "null" 마커로
    실어 정수 0과 반드시 구분한다(0은 진짜 실측값)."""
    payload = {
        "metric": metric_value if metric_value is not None else "null",
        "published_at": published_at.isoformat(), "id": str(id_),
    }
    raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii")


def decode_metric_cursor(token: str) -> tuple[int | None, datetime, uuid.UUID]:
    """`encode_metric_cursor`의 역함수. `decode_cursor`와 동형 오류 처리(손상 토큰=400)."""
    try:
        raw = base64.urlsafe_b64decode(token.encode("ascii"))
        payload = json.loads(raw)
        metric = payload["metric"]
        metric_value = None if metric == "null" else int(metric)
        return metric_value, datetime.fromisoformat(payload["published_at"]), uuid.UUID(str(payload["id"]))
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid cursor format") from exc


def assemble_page(
    rows: Sequence[T], limit: int, cursor_key: Callable[[T], tuple[datetime, uuid.UUID]]
) -> tuple[list[T], bool, str | None]:
    """`rows`는 이미 limit+1개까지 조회된 상태로 들어온다(호출부에서 overfetch, order_by는
    반드시 `(정렬컬럼 DESC, id DESC)` 복합이어야 이 헬퍼의 전제가 성립한다). `cursor_key`는
    페이지 마지막 행에서 `(created_at, id)`를 뽑는 함수 — 정렬 기준 컬럼이 `created_at`이
    아닌 경우(예: updated_at)에도 재사용 가능하도록 호출부가 넘긴다.

    반환: (해당 페이지 행 목록, has_more, next_cursor) — `#2231` body meta(`{"has_more":
    ..., "next_cursor": ...}`)에 그대로 넣으면 된다.
    """
    has_more = len(rows) > limit
    page = list(rows[:limit])
    next_cursor = encode_cursor(*cursor_key(page[-1])) if has_more and page else None
    return page, has_more, next_cursor
