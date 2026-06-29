"""local disk storage provider. OSS zero-config 기본(BYO 디스크/공유 볼륨).

download = STORAGE_LOCAL_ROOT 하위 직접 read. signed_read_url = FE serve 라우트
(`/api/storage/local/...`)를 가리키는 단기 HMAC capability URL(FE `local-sign.ts`와 동일 규칙·
공유 secret). env 는 호출 시점 read(테스트 setenv 정합).
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import logging
import os
import time
from datetime import timedelta
from pathlib import Path
from urllib.parse import urlencode

from .base import StorageProvider

logger = logging.getLogger(__name__)

# FE `config.ts` 의 dev 기본과 동일(공유 secret 미설정 시 서명 불일치 방지). prod 에서는 사용 안 함(fail-closed).
_DEFAULT_SECRET = "sprintable-local-dev-unsafe"
_DEFAULT_SERVE_BASE = "http://localhost:3000"


def _root() -> Path:
    return Path(os.environ.get("STORAGE_LOCAL_ROOT", ".storage"))


def _signing_secret() -> str:
    """local HMAC 서명 비밀 resolve — fail-closed.

    미설정 + production(APP_ENV) 이면 raise(공개 소스 기본값으로 HMAC 위조→authorize 우회 차단).
    dev/test 에서는 미설정 시 dev 기본값으로 zero-config 유지. FE `resolveLocalSigningSecret()` 와 동형.
    """
    secret = (os.environ.get("STORAGE_LOCAL_SIGNING_SECRET") or "").strip()
    if secret:
        return secret
    # APP_ENV 또는 NODE_ENV 중 하나라도 production 이면 fail-closed(운영 BE 가 NODE_ENV 만 세팅하는
    # 경우 우회 방지 — 까심 적출). FE `resolveLocalSigningSecret()` 와 동형.
    is_prod = (
        os.environ.get("APP_ENV", "development").strip().lower() == "production"
        or os.environ.get("NODE_ENV", "").strip().lower() == "production"
    )
    if is_prod:
        raise RuntimeError(
            "STORAGE_LOCAL_SIGNING_SECRET is required when STORAGE_PROVIDER=local in production"
        )
    return _DEFAULT_SECRET


def _resolve_safe(container: str, object_path: str) -> Path:
    """container/object_path 를 root 아래로 정규화하고 이탈 시 거부(path traversal 차단)."""
    base = (_root() / container).resolve()
    target = (base / object_path).resolve()
    if target != base and base not in target.parents:
        raise ValueError("local storage: path traversal blocked")
    return target


class LocalStorageProvider(StorageProvider):
    async def download_object(self, container: str, object_path: str) -> bytes:
        def _blocking() -> bytes:
            return _resolve_safe(container, object_path).read_bytes()

        return await asyncio.to_thread(_blocking)

    async def signed_read_url(
        self, container: str, object_path: str, *, ttl: timedelta
    ) -> str | None:
        # fail-closed: prod 에서 secret 미설정이면 raise(swallow 금지·보안). try 밖에서 resolve.
        secret = _signing_secret()
        try:
            base = os.environ.get("STORAGE_LOCAL_SERVE_BASE_URL", _DEFAULT_SERVE_BASE).rstrip("/")
            exp = int((time.time() + ttl.total_seconds()) * 1000)  # ms(FE Date.now() 정합)
            payload = f"{container}/{object_path}:{exp}".encode()
            sig = hmac.new(secret.encode(), payload, hashlib.sha256).hexdigest()
            qs = urlencode({"exp": exp, "sig": sig})
            return f"{base}/api/storage/local/{container}/{object_path}?{qs}"
        except Exception:
            logger.warning("local storage: signed url 생성 실패 path=%s", object_path, exc_info=True)
            return None

    async def delete_object(self, container: str, object_path: str) -> bool:
        def _blocking() -> bool:
            _resolve_safe(container, object_path).unlink(missing_ok=True)  # 없어도 OK = 멱등
            return True

        try:
            return await asyncio.to_thread(_blocking)
        except Exception:
            logger.warning("local storage: delete 실패 path=%s", object_path, exc_info=True)
            return False

    async def head_object(self, container: str, object_path: str) -> int | None:
        def _blocking() -> int | None:
            p = _resolve_safe(container, object_path)
            return p.stat().st_size if p.exists() else None

        try:
            return await asyncio.to_thread(_blocking)
        except Exception:
            logger.warning("local storage: head 실패 path=%s", object_path, exc_info=True)
            return None

    async def put_object(
        self, container: str, object_path: str, data: bytes, *, content_type: str | None = None
    ) -> bool:
        def _blocking() -> bool:
            p = _resolve_safe(container, object_path)
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(data)
            return True

        try:
            return await asyncio.to_thread(_blocking)
        except Exception:
            logger.warning("local storage: put 실패 path=%s", object_path, exc_info=True)
            return False
