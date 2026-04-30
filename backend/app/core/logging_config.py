"""Cloud Logging 호환 JSON 구조화 로깅 설정."""
from __future__ import annotations

import logging
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
        payload: dict[str, Any] = {
            "severity": severity_map.get(record.levelno, "DEFAULT"),
            "message": record.getMessage(),
            "logger": record.name,
        }
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        if hasattr(record, "request_id"):
            payload["httpRequest"] = {"requestId": record.request_id}
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
