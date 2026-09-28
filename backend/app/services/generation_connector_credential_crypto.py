"""story #4101(#4095 그라운딩 doc c65ce586 §3-4·PO Q②병렬 確定, 2026-09-21) —
org_generation_connectors.credentials(고객 소유 생성 모델 provider 자격) 암호화/복호화.
`app/services/channel_credential_crypto.py`(story #3373)의 그대로 미러 — envelope
encryption에 새 패턴을 발명하지 않는다.

`cryptography.fernet.MultiFernet` + `settings.generation_connector_credential_encryption_key`
(Secret Manager, 회전 지원 콤마구분 다건). channel_credential_key와 독립된 시크릿(도메인
분리 — 발행 채널 토큰 회전이 생성 커넥터 자격에 영향 주지 않고 그 반대도 마찬가지).

⛔가드(channel_credential_crypto.py와 동일 원칙):
① 회전 대비 — 단일 Fernet 대신 MultiFernet.
② 평문 절대 비영속 — `decrypt_generation_connector_credential()` 반환값은 호출자가 즉시
   소비(provider config 구성)하고 변수를 더 들고 있지 않는다. 로거·API 응답에 절대 넘기지 않는다."""
from __future__ import annotations

from functools import lru_cache

from cryptography.fernet import Fernet, MultiFernet

from app.core.config import settings


class GenerationConnectorCredentialEncryptionNotConfigured(RuntimeError):
    """generation_connector_credential_encryption_key 미설정 — dev에서 시크릿 배선 전이거나 설정 누락."""


def _parse_keys(raw: str) -> list[bytes]:
    keys = [k.strip().encode() for k in raw.split(",") if k.strip()]
    if not keys:
        raise GenerationConnectorCredentialEncryptionNotConfigured(
            "generation_connector_credential_encryption_key not set — "
            "cannot encrypt/decrypt generation connector credentials"
        )
    return keys


@lru_cache(maxsize=1)
def _get_multi_fernet() -> MultiFernet:
    """프로세스 수명 동안 1회만 구성 — settings 값이 바뀌는 경우(테스트)는
    ``_get_multi_fernet.cache_clear()``로 재구성."""
    keys = _parse_keys(settings.generation_connector_credential_encryption_key)
    return MultiFernet([Fernet(k) for k in keys])


def ensure_configured() -> None:
    """channel_credential_crypto.ensure_configured()와 동일 근거 — 되돌릴 수 없는 자격 저장
    前에 암호화 키 가용성·형식을 먼저 확認한다."""
    _get_multi_fernet()


def encrypt_generation_connector_credential(plaintext: str) -> str:
    """평문 자격(API 키 등) → Fernet 토큰(맨 앞 키로 암호화). DB 저장용."""
    token = _get_multi_fernet().encrypt(plaintext.encode())
    return token.decode()


def decrypt_generation_connector_credential(token: str) -> str:
    """Fernet 토큰 → 평문. ⛔호출자는 이 반환값을 provider config 구성에만 즉시 쓰고 변수를
    더 들고 있거나 로깅·API 응답에 넣지 않는다. 등록된 키 어느 것으로도 복호 실패 시
    ``InvalidToken``이 그대로 전파된다(회전 중 옛 키가 빠졌다는 신호 — 조용히 삼키지 않는다)."""
    return _get_multi_fernet().decrypt(token.encode()).decode()
