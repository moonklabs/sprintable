"""story #3373(Phase1·마케팅운영) — channel_connections.encrypted_access_token/refresh_token
암호화/복호화. `app/services/billing_key_crypto.py`(story #2492, PO 결정 2026-08-07)의 그대로
미러 — envelope encryption에 새 패턴을 발명하지 않는다(그라운딩 doc 6766a399 §3).

`cryptography.fernet.MultiFernet` + `settings.channel_credential_encryption_key`(Secret
Manager, 회전 지원 콤마구분 다건 — 맨 앞이 암호화 키, 나머지는 복호 전용). billing_key와
독립된 시크릿 — 결제 키 회전이 채널 토큰에 영향 주지 않고, 그 반대도 마찬가지(도메인 분리).

⛔가드(billing_key_crypto.py와 동일 원칙):
① 회전 대비 — 단일 Fernet 대신 MultiFernet.
② 평문 절대 비영속 — `decrypt_channel_credential()` 반환값은 호출자가 즉시 소비(provider API
   요청 구성)하고 변수를 더 들고 있지 않는다. 로거에 절대 넘기지 않는다."""
from __future__ import annotations

from functools import lru_cache

from cryptography.fernet import Fernet, MultiFernet

from app.core.config import settings


class ChannelCredentialEncryptionNotConfigured(RuntimeError):
    """channel_credential_encryption_key 미설정 — dev에서 시크릿 배선 전이거나 설정 누락."""


def _parse_keys(raw: str) -> list[bytes]:
    keys = [k.strip().encode() for k in raw.split(",") if k.strip()]
    if not keys:
        raise ChannelCredentialEncryptionNotConfigured(
            "channel_credential_encryption_key not set — cannot encrypt/decrypt channel credentials"
        )
    return keys


@lru_cache(maxsize=1)
def _get_multi_fernet() -> MultiFernet:
    """프로세스 수명 동안 1회만 구성 — settings 값이 바뀌는 경우(테스트)는
    ``_get_multi_fernet.cache_clear()``로 재구성."""
    keys = _parse_keys(settings.channel_credential_encryption_key)
    return MultiFernet([Fernet(k) for k in keys])


def ensure_configured() -> None:
    """billing_key_crypto.ensure_configured()와 동일 근거 — 되돌릴 수 없는 외부 OAuth 호출
    (token 교환) 전에 암호화 키 가용성·형식을 먼저 확認한다."""
    _get_multi_fernet()


def encrypt_channel_credential(plaintext: str) -> str:
    """평문 토큰 → Fernet 토큰(맨 앞 키로 암호화). DB 저장용."""
    token = _get_multi_fernet().encrypt(plaintext.encode())
    return token.decode()


def decrypt_channel_credential(token: str) -> str:
    """Fernet 토큰 → 평문. ⛔호출자는 이 반환값을 provider API 호출 구성에만 즉시 쓰고 변수를
    더 들고 있거나 로깅하지 않는다. 등록된 키 어느 것으로도 복호 실패 시 ``InvalidToken``이
    그대로 전파된다(회전 중 옛 키가 빠졌다는 신호 — 조용히 삼키지 않는다)."""
    return _get_multi_fernet().decrypt(token.encode()).decode()
