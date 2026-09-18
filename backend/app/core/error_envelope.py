"""story #3615(BE·계약, 페드루 PO 確定 2026-09-07) — 오류 봉투에 `user_message`/
`user_message_key` additive 계약을 더한다.

그라운딩(develop 실물) — `app/main.py::http_exception_handler`가 dict detail의
"code"·"message" 외 모든 키를 그대로 `error` 객체로 패스스루한다(:280~284, 새 필드를
받기 위해 그 핸들러를 바꿀 필요가 이미 없다). 문제는 §object 형(`{code, message}`)
그 자체다 — `message`는 raise 자리마다 형이 다르다: 어떤 코드(COMMENT_REFRESH_HUMAN_
ONLY 등 7종, `api-error-message.ts::HUMAN_SAFE_ERROR_MESSAGE_CODES`)는 이미 사람
문장이고, 어떤 코드(`CHANNEL_CONNECTION_NOT_ACTIVE`의 다수 자리 등)는 uuid·내부
필드를 그대로 담는다. 지금까지의 처방(#3601·#3957)은 **FE가 코드별로 어느 쪽인지
암기**하는 allowlist였다 — 코드가 늘 때마다(#3605 CHANGES-3처럼) FE도 손으로
따라 고쳐야 했다.

이 계약의 판별 — 「값 없을 때 누가 채우나」: **BE**(그 오류를 낸 쪽, 사람 문장인지
아는 유일한 쪽)가 채운다. FE는 그 오류가 안전한지 다시 판단하지 않는다:
  - `user_message`가 있으면 그대로 보여준다(내부 식별자·스택·uuid가 섞이지 않게
    만드는 책임은 이 함수를 호출하는 BE 쪽에 있다 — 원문 message를 그대로
    넘기지 말 것, 손으로 쓴 문장만 넘길 것).
  - 없고 `user_message_key`만 있으면 FE i18n 키로 렌더(로케일별 문구는 §22
    규격을 따르는 FE 쪽 책임).
  - 둘 다 없으면 FE가 코드별 generic 문구로 폴백(원문 `message`는 화면에 0 —
    「서버 응답 보기」 details 자리는 예외, 그건 원래 진단용).

전환은 점진적이다(AC 범위 밖 — 모든 raise 자리 일괄 전환 아님) — 이 함수를 아직
안 쓰는 자리는 지금처럼 `message`만 있고 `user_message`가 없어 FE가 안전하게
generic으로 떨어진다(회귀 0, 원문 노출도 0 — 3601 allowlist가 그 자리들의 안전망
으로 당분간 남는다)."""
from __future__ import annotations


def human_error(
    code: str,
    message: str,
    *,
    user_message: str | None = None,
    user_message_key: str | None = None,
    **extra: object,
) -> dict[str, object]:
    """FastAPI `HTTPException(detail=...)`에 바로 넣는 dict를 만든다. `message`는
    지금처럼 진단용 원문(「서버 응답 보기」에서만 노출) — `user_message`/
    `user_message_key`가 그 자리에서 사람에게 보여도 되는 문장을 아는 경우에만
    채운다(둘 다 선택, 있으면 사람 화면행·없으면 FE가 코드별 generic 문구로).
    `extra`는 기존 raise 자리들이 이미 얹던 부가 키(예: retry_after)를 그대로
    통과시키기 위함 — human_error 도입이 기존 부가 키 계약을 안 깬다."""
    detail: dict[str, object] = {"code": code, "message": message}
    if user_message is not None:
        detail["user_message"] = user_message
    if user_message_key is not None:
        detail["user_message_key"] = user_message_key
    detail.update(extra)
    return detail
