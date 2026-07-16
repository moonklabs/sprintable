"""story 20f49099(E-AUTH-REBUILD 활성화게이트][C2]·doc e-mobile-per-install-proof-feasibility
§7.4·산티아고 §7.4 SSOT 2026-07-16): Apple App Attest attestation/assertion 서버측 검증.

⚠️§7.0 명시 경고 — 공개 패키지 `expo-app-integrity@0.3.0`을 구현 기반으로 삼지 않는다: 그
패키지는 iOS raw CBOR를 UTF-8 문자열로 변환하는 손실 버그가 있어 서버 검증용 원문 보존을
불보장한다. 이 모듈의 입력 계약은 **무손실 원문 바이트**(attestation object/assertion의
CBOR bytes 그대로, key_id/client_data_hash도 raw bytes)를 전제로 한다 — base64 등 wire
인코딩/디코딩은 호출부(C4 엔드포인트) 책임.

**검증 알고리즘 출처**: Apple Developer Documentation "Validating apps that connect to your
server"(App Attest)의 공식 attestation/assertion 검증 절차를 그대로 구현한다.

⛔**이 모듈이 하지 않는 것**: Apple receipt 검증(attStmt의 `receipt` 필드 — Apple 서버 왕복이
필요한 별도 flow, 이 스토리 스코프 밖). register/consume 엔드포인트 배선·DB 원자적 counter
compare-and-set(C4 스코프 — 이 모듈은 counter가 "이전보다 크다"는 순수 검증만 반환하고,
동시 요청 간 원자성 보장은 호출부의 DB UPDATE...WHERE...RETURNING 책임).
"""
from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass
from datetime import datetime, timezone

import cbor2
from cryptography import x509
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec

logger = logging.getLogger(__name__)


class AppAttestVerificationError(Exception):
    """검증 실패 — 메시지는 로그 전용(enumeration 방지는 호출부가 통일된 401로 흡수)."""


# Apple이 공식 배포하는 App Attestation Root CA(https://www.apple.com/certificateauthority/
# Apple_App_Attestation_Root_CA.pem) — P-384/ECDSA-SHA384, 2020-03-18 발급, 2045-03-15 만료.
# 이 상수를 절대 x5c 체인 안의 값으로 대체하지 않는다(아래 _verify_chain_to_apple_root의
# 핵심 불변조건 — x5c가 자칭하는 root는 신뢰하지 않고 항상 이 고정 anchor로 종료 검증).
APPLE_APP_ATTEST_ROOT_CA_PEM = b"""-----BEGIN CERTIFICATE-----
MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYw
JAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwK
QXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNa
Fw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlv
biBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9y
bmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTtT4dyctdh
NbJhFs/Ii2FdCgAHGbpphY3+d8qjuDngIN3WVhQUBHAoMeQ/cLiP1sOUtgjqK9au
Yen1mMEvRq9Sk3Jm5X8U62H+xTD3FE9TgS41o0IwQDAPBgNVHRMBAf8EBTADAQH/
MB0GA1UdDgQWBBSskRBTM72+aEH/pwyp5frq5eWKoTAOBgNVHQ8BAf8EBAMCAQYw
CgYIKoZIzj0EAwMDaAAwZQIwQgFGnByvsiVbpTKwSga0kP0e8EeDS4+sQmTvb7vn
53O5+FRXgeLhpJ06ysC5PrOyAjEAp5U4xDgEgllF7En3VcE3iexZZtKeYnpqtijV
oyFraWVIyd/dganmrduC1bmTBGwD
-----END CERTIFICATE-----
"""

_NONCE_EXTENSION_OID = x509.ObjectIdentifier("1.2.840.113635.100.8.2")

ENV_PRODUCTION = "production"
ENV_DEVELOPMENT = "development"

# App Attest AAGUID — production은 "appattest"+7 null bytes, development는 정확히
# "appattestdevelop"(둘 다 16바이트). 산티아고 §7.4: "production은 production AAGUID만
# 허용(dev AAGUID는 별도 dev namespace 전용)" — 아래 verify_attestation()의
# expected_environment 강제 일치가 이를 구현한다.
_AAGUID_BY_ENVIRONMENT = {
    ENV_PRODUCTION: b"appattest" + b"\x00" * 7,
    ENV_DEVELOPMENT: b"appattestdevelop",
}
assert all(len(v) == 16 for v in _AAGUID_BY_ENVIRONMENT.values())


@dataclass
class ParsedAuthData:
    rp_id_hash: bytes
    flags: int
    counter: int
    aaguid: bytes | None
    credential_id: bytes | None


def _parse_auth_data(auth_data: bytes) -> ParsedAuthData:
    """WebAuthn authenticatorData 고정 레이아웃(App Attest도 동일 포맷 재사용): rpIdHash[32]+
    flags[1]+counter[4](big-endian)+선택적 attestedCredentialData(aaguid[16]+credIdLen[2]+
    credId[N])."""
    if len(auth_data) < 37:
        raise AppAttestVerificationError("auth_data_too_short")
    rp_id_hash = auth_data[0:32]
    flags = auth_data[32]
    counter = int.from_bytes(auth_data[33:37], "big")
    aaguid: bytes | None = None
    credential_id: bytes | None = None
    if len(auth_data) > 37:
        if len(auth_data) < 37 + 16 + 2:
            raise AppAttestVerificationError("auth_data_attested_credential_truncated")
        aaguid = auth_data[37:53]
        cred_id_len = int.from_bytes(auth_data[53:55], "big")
        cred_id_start = 55
        cred_id_end = cred_id_start + cred_id_len
        if len(auth_data) < cred_id_end:
            raise AppAttestVerificationError("auth_data_credential_id_truncated")
        credential_id = auth_data[cred_id_start:cred_id_end]
    return ParsedAuthData(rp_id_hash=rp_id_hash, flags=flags, counter=counter, aaguid=aaguid, credential_id=credential_id)


def _verify_cert_signed_by(child: x509.Certificate, parent_public_key) -> bool:
    try:
        parent_public_key.verify(
            child.signature,
            child.tbs_certificate_bytes,
            ec.ECDSA(child.signature_hash_algorithm),
        )
        return True
    except InvalidSignature:
        return False
    except Exception:
        # 파싱 불가한 서명/알고리즘 불일치 등 — 전부 검증 실패로 수렴(fail-closed).
        return False


def _verify_chain_to_apple_root(x5c_der: list[bytes]) -> x509.Certificate:
    """x5c_der[0]=leaf, x5c_der[1:]=intermediate(들). **x5c가 자칭하는 root는 절대 신뢰하지
    않는다** — 체인의 마지막 원소가 우리 자신의 고정 `APPLE_APP_ATTEST_ROOT_CA_PEM` 공개키로
    서명됐는지까지 검증해야 성공. 실패 시 AppAttestVerificationError."""
    if not x5c_der:
        raise AppAttestVerificationError("empty_certificate_chain")
    try:
        certs = [x509.load_der_x509_certificate(c) for c in x5c_der]
    except ValueError as exc:
        raise AppAttestVerificationError("malformed_certificate_in_chain") from exc

    now = datetime.now(timezone.utc)
    for c in certs:
        if c.not_valid_before_utc > now or c.not_valid_after_utc < now:
            raise AppAttestVerificationError("certificate_expired_or_not_yet_valid")

    for i in range(len(certs) - 1):
        if not _verify_cert_signed_by(certs[i], certs[i + 1].public_key()):
            raise AppAttestVerificationError("chain_signature_invalid")

    trusted_root = x509.load_pem_x509_certificate(APPLE_APP_ATTEST_ROOT_CA_PEM)
    if not _verify_cert_signed_by(certs[-1], trusted_root.public_key()):
        raise AppAttestVerificationError("chain_does_not_terminate_at_apple_root")

    return certs[0]  # leaf


def _der_length(data: bytes, offset: int) -> tuple[int, int]:
    first = data[offset]
    offset += 1
    if first & 0x80 == 0:
        return first, offset
    num_bytes = first & 0x7F
    length = int.from_bytes(data[offset:offset + num_bytes], "big")
    return length, offset + num_bytes


def _extract_nonce_extension(cert: x509.Certificate) -> bytes:
    """OID 1.2.840.113635.100.8.2 확장값 — DER `SEQUENCE { [1] OCTET STRING nonce }`을
    직접 파싱한다(cryptography가 인식 못 하는 Apple 전용 확장이라 UnrecognizedExtension의
    원시 DER bytes를 수동 파싱)."""
    try:
        ext = cert.extensions.get_extension_for_oid(_NONCE_EXTENSION_OID)
    except x509.ExtensionNotFound as exc:
        raise AppAttestVerificationError("nonce_extension_missing") from exc

    raw = ext.value.value if hasattr(ext.value, "value") else bytes(ext.value)
    try:
        if raw[0] != 0x30:
            raise ValueError("expected SEQUENCE")
        _seq_len, offset = _der_length(raw, 1)
        if raw[offset] != 0xA1:
            raise ValueError("expected context [1]")
        offset += 1
        _ctx_len, offset = _der_length(raw, offset)
        if raw[offset] != 0x04:
            raise ValueError("expected OCTET STRING")
        offset += 1
        octet_len, offset = _der_length(raw, offset)
        return raw[offset:offset + octet_len]
    except (IndexError, ValueError) as exc:
        raise AppAttestVerificationError("nonce_extension_malformed") from exc


@dataclass
class VerifiedAttestation:
    key_id: bytes  # SHA256(leaf 공개키 raw uncompressed point) — authData credentialId와 동일
    public_key_der: bytes  # SubjectPublicKeyInfo DER(assertion 검증 시 재로드용으로 저장)
    environment: str  # ENV_PRODUCTION | ENV_DEVELOPMENT
    counter: int  # 최초 attestation은 항상 0


def verify_attestation(
    *,
    attestation_object: bytes,
    key_id: bytes,
    client_data_hash: bytes,
    expected_team_id: str,
    expected_bundle_id: str,
    expected_environment: str,
) -> VerifiedAttestation:
    """Apple 공식 attestation 검증 절차(Validating apps that connect to your server) —
    실패 시 AppAttestVerificationError, 성공 시 저장할 공개키+환경+초기 counter 반환.

    호출부(C4)가 이 함수 호출 전에 반드시 마쳐야 하는 것(§7.3 3대 증거 중 나머지 2개,
    이 함수 스코프 밖): 최근 Firebase 재인증 확인·앱ID-allowlisted App Check 검증·
    서버측 challenge 발급/바인딩(client_data_hash는 그 challenge의 canonical transcript
    해시여야 함 — C1의 device_proof_challenges가 이미 이 인프라를 제공)."""
    try:
        decoded = cbor2.loads(attestation_object)
    except Exception as exc:
        raise AppAttestVerificationError("attestation_object_not_valid_cbor") from exc

    if not isinstance(decoded, dict):
        raise AppAttestVerificationError("attestation_object_not_a_map")

    if decoded.get("fmt") != "apple-appattest":
        raise AppAttestVerificationError("unexpected_fmt")

    att_stmt = decoded.get("attStmt")
    auth_data = decoded.get("authData")
    if not isinstance(att_stmt, dict) or not isinstance(auth_data, bytes):
        raise AppAttestVerificationError("attestation_object_missing_fields")

    x5c = att_stmt.get("x5c")
    if not isinstance(x5c, list) or not all(isinstance(c, bytes) for c in x5c):
        raise AppAttestVerificationError("x5c_missing_or_malformed")

    leaf = _verify_chain_to_apple_root(x5c)

    nonce = hashlib.sha256(auth_data + client_data_hash).digest()
    cert_nonce = _extract_nonce_extension(leaf)
    if cert_nonce != nonce:
        raise AppAttestVerificationError("nonce_mismatch")

    leaf_public_key = leaf.public_key()
    if not isinstance(leaf_public_key, ec.EllipticCurvePublicKey) or leaf_public_key.curve.name != "secp256r1":
        raise AppAttestVerificationError("leaf_key_not_p256")

    public_key_raw = leaf_public_key.public_bytes(
        encoding=serialization.Encoding.X962, format=serialization.PublicFormat.UncompressedPoint
    )
    computed_key_id = hashlib.sha256(public_key_raw).digest()
    if computed_key_id != key_id:
        raise AppAttestVerificationError("key_id_mismatch")

    parsed = _parse_auth_data(auth_data)
    if parsed.credential_id != computed_key_id:
        raise AppAttestVerificationError("auth_data_credential_id_mismatch")

    expected_rp_id_hash = hashlib.sha256(f"{expected_team_id}.{expected_bundle_id}".encode()).digest()
    if parsed.rp_id_hash != expected_rp_id_hash:
        raise AppAttestVerificationError("rp_id_hash_mismatch")

    if parsed.counter != 0:
        raise AppAttestVerificationError("initial_counter_not_zero")

    if expected_environment not in _AAGUID_BY_ENVIRONMENT:
        raise AppAttestVerificationError("unknown_expected_environment")
    if parsed.aaguid != _AAGUID_BY_ENVIRONMENT[expected_environment]:
        raise AppAttestVerificationError("aaguid_environment_mismatch")

    public_key_der = leaf_public_key.public_bytes(
        encoding=serialization.Encoding.DER, format=serialization.PublicFormat.SubjectPublicKeyInfo
    )

    logger.info("apple_app_attest.verify_attestation success environment=%s", expected_environment)
    return VerifiedAttestation(
        key_id=computed_key_id, public_key_der=public_key_der, environment=expected_environment, counter=0
    )


@dataclass
class VerifiedAssertion:
    counter: int


def verify_assertion(
    *,
    assertion: bytes,
    client_data_hash: bytes,
    stored_public_key_der: bytes,
    stored_counter: int,
    expected_team_id: str,
    expected_bundle_id: str,
) -> VerifiedAssertion:
    """Apple 공식 assertion 검증 — 서명은 등록 시 저장한 공개키로, counter는 저장값보다
    **엄격히 커야**(gap 허용, 동일/역행=replay/clone 의심) 통과. ⚠️여기서의 counter 비교는
    순수 암호검증 계층 판단이다 — 동시 요청 간 진짜 원자성(compare-and-set)은 호출부가 DB
    `UPDATE...WHERE last_sign_count < :new_count RETURNING`으로 별도 보장해야 한다(이 함수
    호출 하나만으로는 TOCTOU를 못 막는다 — check_then_insert_toctou 계열 함정과 동일 원리)."""
    try:
        decoded = cbor2.loads(assertion)
    except Exception as exc:
        raise AppAttestVerificationError("assertion_not_valid_cbor") from exc

    if not isinstance(decoded, dict):
        raise AppAttestVerificationError("assertion_not_a_map")

    signature = decoded.get("signature")
    auth_data = decoded.get("authenticatorData")
    if not isinstance(signature, bytes) or not isinstance(auth_data, bytes):
        raise AppAttestVerificationError("assertion_missing_fields")

    try:
        public_key = serialization.load_der_public_key(stored_public_key_der)
    except Exception as exc:
        raise AppAttestVerificationError("stored_public_key_malformed") from exc
    if not isinstance(public_key, ec.EllipticCurvePublicKey):
        raise AppAttestVerificationError("stored_public_key_not_ec")

    nonce = hashlib.sha256(auth_data + client_data_hash).digest()
    try:
        public_key.verify(signature, nonce, ec.ECDSA(hashes.SHA256()))
    except InvalidSignature as exc:
        raise AppAttestVerificationError("assertion_signature_invalid") from exc

    parsed = _parse_auth_data(auth_data)
    expected_rp_id_hash = hashlib.sha256(f"{expected_team_id}.{expected_bundle_id}".encode()).digest()
    if parsed.rp_id_hash != expected_rp_id_hash:
        raise AppAttestVerificationError("rp_id_hash_mismatch")

    if parsed.counter <= stored_counter:
        raise AppAttestVerificationError("counter_not_strictly_increasing")

    logger.info("apple_app_attest.verify_assertion success counter=%d", parsed.counter)
    return VerifiedAssertion(counter=parsed.counter)
