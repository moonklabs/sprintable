"""결제②-C1(story #2492) — org_billing_keys.encrypted_billing_key 암호화/복호화.

PO 결정(2026-08-07, `toss-adapter-c-plan-v0-1` §9): `cryptography.fernet.MultiFernet` +
`settings.org_billing_key_encryption_key`(Secret Manager, 회전 지원 콤마구분 다건 — 맨 앞이
암호화 키, 나머지는 복호 전용). 신규 의존성 0(cryptography는 python-jose[cryptography] 경유로
이미 설치돼 있음).

⛔가드 두 개(PO):
① 회전 대비 — 단일 Fernet 대신 MultiFernet. 새 키를 앞에 두고 재배포하면 옛 값은 기존 키로
   계속 복호되고(rotate 전까지), 재암호화하면 새 키로 옮겨간다.
② 평문 절대 비영속 — `decrypt_billing_key()`가 반환하는 값은 호출자가 즉시 소비(Toss charge
   API 요청 바디 구성)하고 변수를 더 들고 있지 않아야 한다. 로거에 절대 넘기지 않는다 — 이
   모듈 자체도 plaintext를 로깅하지 않는다.
"""
from __future__ import annotations

from functools import lru_cache

from cryptography.fernet import Fernet, MultiFernet

from app.core.config import settings


class BillingKeyEncryptionNotConfigured(RuntimeError):
    """org_billing_key_encryption_key 미설정 — dev에서 시크릿 배선 전이거나 설정 누락."""


def _parse_keys(raw: str) -> list[bytes]:
    keys = [k.strip().encode() for k in raw.split(",") if k.strip()]
    if not keys:
        raise BillingKeyEncryptionNotConfigured(
            "org_billing_key_encryption_key not set — cannot encrypt/decrypt billing keys"
        )
    return keys


@lru_cache(maxsize=1)
def _get_multi_fernet() -> MultiFernet:
    """프로세스 수명 동안 1회만 구성 — settings 값이 바뀌는 경우(테스트)는
    ``_get_multi_fernet.cache_clear()``로 재구성."""
    keys = _parse_keys(settings.org_billing_key_encryption_key)
    return MultiFernet([Fernet(k) for k in keys])


def ensure_configured() -> None:
    """PO nit①(C1 리뷰, #2880 — 2026-08-07): 되돌릴 수 없는 외부 호출(Toss authKey 소모·
    charge 승인) 前에 암호화 키 가용성을 먼저 확認한다 — 호출 後에야 encrypt 실패로 502가
    나면 1회용 authKey/승인 시도를 헛되이 태운 것이 된다. C1의 issue_billing_key와 C2의
    charge_org 둘 다 Toss 호출 直前에 이 함수를 먼저 부른다."""
    _parse_keys(settings.org_billing_key_encryption_key)


def encrypt_billing_key(plaintext: str) -> str:
    """평문 빌링키 → Fernet 토큰(맨 앞 키로 암호화). DB 저장용."""
    token = _get_multi_fernet().encrypt(plaintext.encode())
    return token.decode()


def decrypt_billing_key(token: str) -> str:
    """Fernet 토큰 → 평문 빌링키. ⛔호출자는 이 반환값을 charge 요청 구성에만 즉시 쓰고
    변수를 더 들고 있거나 로깅하지 않는다. 등록된 키 어느 것으로도 복호 실패 시
    ``InvalidToken``이 그대로 전파된다(회전 중 옛 키가 빠졌다는 신호 — 조용히 삼키지 않는다)."""
    return _get_multi_fernet().decrypt(token.encode()).decode()
