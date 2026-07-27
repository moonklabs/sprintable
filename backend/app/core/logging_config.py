"""Cloud Logging 호환 JSON 구조화 로깅 설정."""
from __future__ import annotations

import logging
import os
import sys
from typing import Any


class JsonFormatter(logging.Formatter):
    """Cloud Logging JSON 포맷 — severity + message + labels."""

    def format(self, record: logging.LogRecord) -> str:
        import json
        severity_map = {
            logging.DEBUG: "DEBUG",
            logging.INFO: "INFO",
            logging.WARNING: "WARNING",
            logging.ERROR: "ERROR",
            logging.CRITICAL: "CRITICAL",
        }
        message = record.getMessage()
        payload: dict[str, Any] = {
            "severity": severity_map.get(record.levelno, "DEFAULT"),
            "message": message,
            "logger": record.name,
        }
        if record.exc_info:
            formatted_exc = self.formatException(record.exc_info)
            # story #1743: 기존 jsonPayload.exception(커스텀 필드)은 하위호환을 위해 유지한다
            # (다른 소비자 없음을 grep으로 확인했지만 breaking 방지 차 additive만 적용).
            # GCP Error Reporting은 jsonPayload.message(또는 stack_trace/exception) 필드 값이
            # 지원 언어의 스택 트레이스 포맷을 담고 있어야 자동 감지/그룹핑한다
            # (https://cloud.google.com/error-reporting/docs/formatting-error-messages
            # "Log a stack trace" 섹션). message에도 traceback 텍스트를 포함시켜 자동 감지
            # 경로를 명시적으로 커버 — exception 필드만 있을 때 발생할 수 있는 파서 엣지케이스에
            # 대한 안전망(additive, 회귀 없음).
            payload["message"] = f"{message}\n{formatted_exc}" if message else formatted_exc
            payload["exception"] = formatted_exc
            # Cloud Run에서 serviceContext.service/version 부재 시 리소스 타입이 cloud_run_revision이
            # 아닌 global로 잡혀 Error Reporting이 에러를 그룹핑하지 못하는 알려진 함정이 있다
            # (K_SERVICE/K_REVISION은 Cloud Run이 자동 주입하는 표준 env var — 로컬/테스트 환경에서는
            # 없으므로 고정 fallback 사용). exc_info가 있을 때만 부여 — 평시 로그 스키마는 불변.
            payload["serviceContext"] = {
                "service": os.getenv("K_SERVICE", "sprintable-backend"),
                "version": os.getenv("K_REVISION", "unknown"),
            }
        if hasattr(record, "request_id"):
            payload["httpRequest"] = {"requestId": record.request_id}
        # E-LOOP-LEDGER P1-S8: 임의 구조화 필드 pass-through(logger.info(..., extra={"structured": {...}}))
        # — Cloud Logging jsonPayload에서 필드별 필터/집계 가능(메시지 문자열 파싱보다 A2 임계치
        # 실측에 유리). 화이트리스트 없이 그대로 병합 — 호출부가 키 이름 충돌만 스스로 피하면 됨.
        if hasattr(record, "structured"):
            payload.update(record.structured)
        return json.dumps(payload, ensure_ascii=False)


def configure_logging(json_logs: bool = True) -> None:
    """Cloud Run 환경: JSON 로그. 로컬: 일반 텍스트."""
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.handlers.clear()

    handler = logging.StreamHandler(sys.stdout)
    if json_logs:
        handler.setFormatter(JsonFormatter())
    else:
        handler.setFormatter(logging.Formatter(
            "%(asctime)s %(levelname)s %(name)s — %(message)s"
        ))
    root.addHandler(handler)

    # uvicorn 로거 레벨 통일
    for name in ("uvicorn", "uvicorn.access", "uvicorn.error"):
        logging.getLogger(name).handlers.clear()
        logging.getLogger(name).propagate = True
