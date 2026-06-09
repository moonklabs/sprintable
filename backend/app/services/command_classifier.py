"""채팅 메시지 슬래시 커맨드 판정 — 중앙집중 단일 구현 (E-CHAT-CMD S3).

블루프린트 `blueprint-chat-command-skill-execution` §Policy(Command 판정)·§Task 3.

게이트웨이 dispatch **전**에 호출돼 "이 채팅 메시지가 슬래시 커맨드인가"를 판정한다. ⚠️ 판정
로직은 **이 모듈 하나**에만 존재한다 — adapter/connector 별 parsing 을 추가하지 말 것(AC3).
다운스트림(커맨드 실행/라우팅)은 `classify_command()` 결과를 소비만 한다.

판정 규칙(AC1):
- 커맨드 = 메시지 맨 앞(position 0)이 ``/`` + **ASCII 영문자** → ``^/[a-zA-Z]``.
- 이스케이프(= 커맨드 아님, 리터럴):
    · 선행 공백 ``" /cmd"`` — 맨 앞이 공백이라 ``^/`` 미일치.
    · ``"//cmd"`` — ``/`` 다음이 ``/``(영문자 아님)라 미일치. 리터럴 렌더는 ``//`` → ``/``
      (`dequote_literal`).
- 비대상: ``/123``(숫자)·``/?``(기호)·``/한글``(비-ASCII)·``/``(단독).
"""
from __future__ import annotations

import re
from dataclasses import dataclass

# 맨 앞 '/' + ASCII 영문자로 시작하는 토큰. 선행 공백/'/'(이스케이프)는 자연 미일치.
# [a-zA-Z] 는 ASCII 전용이라 '/한글' 등 비-ASCII 는 매치되지 않는다.
_COMMAND_RE = re.compile(r"^/[a-zA-Z]\S*")


@dataclass(frozen=True)
class CommandCandidate:
    """커맨드 후보 metadata (AC2).

    raw: 원문(전체 메시지, 무변형). normalized: 정규화(트레일링 공백 제거 — 커맨드는 선행
    공백이 없으므로 leading 영향 없음). name: 슬래시 뒤 커맨드 이름(첫 공백 전 토큰). args:
    이름 뒤 인자(trim, 없으면 빈 문자열).
    """

    raw: str
    normalized: str
    name: str
    args: str


def classify_command(text: str | None) -> CommandCandidate | None:
    """채팅 메시지가 슬래시 커맨드면 CommandCandidate, 아니면 None.

    중앙집중 단일 진입점 — 모든 게이트웨이 경로/어댑터가 이 함수만 호출한다.
    """
    if not text:
        return None
    if _COMMAND_RE.match(text) is None:
        return None
    normalized = text.strip()  # 커맨드는 선행 공백 0(매치 조건) → 트레일링만 제거됨
    body = normalized[1:]      # 슬래시 제거
    split = body.split(maxsplit=1)
    name = split[0]
    args = split[1].strip() if len(split) > 1 else ""
    return CommandCandidate(raw=text, normalized=normalized, name=name, args=args)


def is_command(text: str | None) -> bool:
    """커맨드 여부만 필요할 때의 경량 술어."""
    return bool(text) and _COMMAND_RE.match(text) is not None


def dequote_literal(text: str) -> str:
    """이스케이프된 리터럴 렌더링: 선행 ``//`` → ``/``(1개 제거). 선행 공백 이스케이프는
    그대로 둔다(표시 의도 보존). 커맨드 아닌 메시지를 그대로 전달할 때 다운스트림이 사용.
    """
    if text.startswith("//"):
        return text[1:]
    return text
