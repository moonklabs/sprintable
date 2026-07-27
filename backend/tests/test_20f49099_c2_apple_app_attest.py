"""story 20f49099(E-AUTH-REBUILD 활성화게이트][C2]·산티아고 §7.4 SSOT) 게이트: Apple App
Attest attestation/assertion 서버측 검증 — 정상/전수 음성 케이스.

실 Apple 인증서는 당연히 없으므로, 모듈이 신뢰하는 root anchor(`APPLE_APP_ATTEST_ROOT_CA_PEM`)
를 테스트 전용 self-signed root로 monkeypatch해 **동일한 검증 알고리즘**을 테스트 root
기준으로 실증한다 — 알고리즘 자체(체인 검증·nonce 확장 파싱·rpIdHash·AAGUID·counter)는
실 Apple root든 테스트 root든 완전히 동일한 코드 경로를 탄다.
"""
from __future__ import annotations

import hashlib
from datetime import datetime, timedelta, timezone

import cbor2
import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

from app.services.apple_app_attest import (
    ENV_DEVELOPMENT,
    ENV_PRODUCTION,
    AppAttestVerificationError,
    verify_assertion,
    verify_attestation,
)

TEAM_ID = "ABCDE12345"
BUNDLE_ID = "com.sprintable.app"
NONCE_OID = x509.ObjectIdentifier("1.2.840.113635.100.8.2")

_AAGUID_PRODUCTION = b"appattest" + b"\x00" * 7
_AAGUID_DEVELOPMENT = b"appattestdevelop"


def _self_signed_root():
    key = ec.generate_private_key(ec.SECP384R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Test App Attestation Root CA")])
    cert = (
        x509.CertificateBuilder()
        .subject_name(name).issuer_name(name).public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.now(timezone.utc) - timedelta(days=1))
        .not_valid_after(datetime.now(timezone.utc) + timedelta(days=3650))
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .sign(key, hashes.SHA384())
    )
    return key, cert


def _signed_intermediate(root_key, root_cert):
    key = ec.generate_private_key(ec.SECP384R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Test App Attestation CA 1")])
    cert = (
        x509.CertificateBuilder()
        .subject_name(name).issuer_name(root_cert.subject).public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.now(timezone.utc) - timedelta(days=1))
        .not_valid_after(datetime.now(timezone.utc) + timedelta(days=3650))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .sign(root_key, hashes.SHA384())
    )
    return key, cert


def _nonce_extension_der(nonce: bytes) -> bytes:
    """DER SEQUENCE { [1] OCTET STRING nonce } — 손으로 인코딩(짧고 고정된 구조)."""
    octet = bytes([0x04, len(nonce)]) + nonce
    ctx = bytes([0xA1, len(octet)]) + octet
    seq = bytes([0x30, len(ctx)]) + ctx
    return seq


def _leaf_cert_with_nonce(intermediate_key, intermediate_cert, nonce: bytes):
    leaf_key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Test App Attest Leaf")])
    builder = (
        x509.CertificateBuilder()
        .subject_name(name).issuer_name(intermediate_cert.subject).public_key(leaf_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.now(timezone.utc) - timedelta(days=1))
        .not_valid_after(datetime.now(timezone.utc) + timedelta(days=365))
        .add_extension(
            x509.UnrecognizedExtension(NONCE_OID, _nonce_extension_der(nonce)), critical=False
        )
    )
    cert = builder.sign(intermediate_key, hashes.SHA256())
    return leaf_key, cert


def _auth_data(rp_id_hash: bytes, counter: int, aaguid: bytes | None, credential_id: bytes | None) -> bytes:
    flags = 0x40 if aaguid is not None else 0x00  # attested-credential-data flag
    out = rp_id_hash + bytes([flags]) + counter.to_bytes(4, "big")
    if aaguid is not None:
        out += aaguid + len(credential_id).to_bytes(2, "big") + credential_id
    return out


def _rp_id_hash(team_id: str = TEAM_ID, bundle_id: str = BUNDLE_ID) -> bytes:
    return hashlib.sha256(f"{team_id}.{bundle_id}".encode()).digest()


def _build_valid_attestation(monkeypatch, *, environment: str = ENV_PRODUCTION, counter: int = 0, tamper_nonce: bool = False):
    root_key, root_cert = _self_signed_root()
    import app.services.apple_app_attest as module
    monkeypatch.setattr(
        module, "APPLE_APP_ATTEST_ROOT_CA_PEM", root_cert.public_bytes(serialization.Encoding.PEM)
    )
    intermediate_key, intermediate_cert = _signed_intermediate(root_key, root_cert)

    client_data_hash = hashlib.sha256(b"challenge-transcript").digest()
    aaguid = _AAGUID_PRODUCTION if environment == ENV_PRODUCTION else _AAGUID_DEVELOPMENT

    # nonce는 authData+clientDataHash에 의존하는데 authData의 credentialId는 leaf 공개키에
    # 의존한다 — 먼저 임시 키로 공개키를 얻은 뒤 authData/nonce/leaf cert를 순서대로 구성.
    probe_key = ec.generate_private_key(ec.SECP256R1())
    probe_pub_raw = probe_key.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    key_id = hashlib.sha256(probe_pub_raw).digest()

    auth_data = _auth_data(_rp_id_hash(), counter, aaguid, key_id)
    nonce = hashlib.sha256(auth_data + client_data_hash).digest()
    if tamper_nonce:
        nonce = b"\x00" * 32

    # probe_key를 그대로 leaf 개인키로 재사용(공개키가 key_id/credentialId와 반드시 일치해야 함).
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Test App Attest Leaf")])
    leaf_cert = (
        x509.CertificateBuilder()
        .subject_name(name).issuer_name(intermediate_cert.subject).public_key(probe_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.now(timezone.utc) - timedelta(days=1))
        .not_valid_after(datetime.now(timezone.utc) + timedelta(days=365))
        .add_extension(x509.UnrecognizedExtension(NONCE_OID, _nonce_extension_der(nonce)), critical=False)
        .sign(intermediate_key, hashes.SHA256())
    )

    x5c = [
        leaf_cert.public_bytes(serialization.Encoding.DER),
        intermediate_cert.public_bytes(serialization.Encoding.DER),
    ]
    attestation_object = cbor2.dumps({
        "fmt": "apple-appattest",
        "attStmt": {"x5c": x5c, "receipt": b"opaque-receipt-not-verified-here"},
        "authData": auth_data,
    })
    return {
        "attestation_object": attestation_object,
        "key_id": key_id,
        "client_data_hash": client_data_hash,
        "leaf_key": probe_key,
    }


# ─── verify_attestation ──────────────────────────────────────────────────────

def test_valid_attestation_accepted(monkeypatch):
    fx = _build_valid_attestation(monkeypatch)
    result = verify_attestation(
        attestation_object=fx["attestation_object"], key_id=fx["key_id"],
        client_data_hash=fx["client_data_hash"], expected_team_id=TEAM_ID, expected_bundle_id=BUNDLE_ID,
        expected_environment=ENV_PRODUCTION,
    )
    assert result.key_id == fx["key_id"]
    assert result.environment == ENV_PRODUCTION
    assert result.counter == 0
    assert result.public_key_der


def test_wrong_team_id_rejected(monkeypatch):
    fx = _build_valid_attestation(monkeypatch)
    with pytest.raises(AppAttestVerificationError, match="rp_id_hash_mismatch"):
        verify_attestation(
            attestation_object=fx["attestation_object"], key_id=fx["key_id"],
            client_data_hash=fx["client_data_hash"], expected_team_id="WRONGTEAMID", expected_bundle_id=BUNDLE_ID,
            expected_environment=ENV_PRODUCTION,
        )


def test_wrong_bundle_id_rejected(monkeypatch):
    fx = _build_valid_attestation(monkeypatch)
    with pytest.raises(AppAttestVerificationError, match="rp_id_hash_mismatch"):
        verify_attestation(
            attestation_object=fx["attestation_object"], key_id=fx["key_id"],
            client_data_hash=fx["client_data_hash"], expected_team_id=TEAM_ID, expected_bundle_id="com.wrong.app",
            expected_environment=ENV_PRODUCTION,
        )


def test_dev_aaguid_rejected_in_production(monkeypatch):
    fx = _build_valid_attestation(monkeypatch, environment=ENV_DEVELOPMENT)
    with pytest.raises(AppAttestVerificationError, match="aaguid_environment_mismatch"):
        verify_attestation(
            attestation_object=fx["attestation_object"], key_id=fx["key_id"],
            client_data_hash=fx["client_data_hash"], expected_team_id=TEAM_ID, expected_bundle_id=BUNDLE_ID,
            expected_environment=ENV_PRODUCTION,
        )


def test_development_environment_accepts_dev_aaguid(monkeypatch):
    fx = _build_valid_attestation(monkeypatch, environment=ENV_DEVELOPMENT)
    result = verify_attestation(
        attestation_object=fx["attestation_object"], key_id=fx["key_id"],
        client_data_hash=fx["client_data_hash"], expected_team_id=TEAM_ID, expected_bundle_id=BUNDLE_ID,
        expected_environment=ENV_DEVELOPMENT,
    )
    assert result.environment == ENV_DEVELOPMENT


def test_forged_chain_not_terminating_at_trusted_root_rejected(monkeypatch):
    """attacker가 자체 root/intermediate로 완결된 체인을 들이밀어도(자체 서명 정합은 맞음)
    우리 고정 trusted root로 안 끝나면 거부 — x5c 안의 아무 root도 신뢰하지 않는 불변조건."""
    # monkeypatch로 진짜 trusted root를 심지 않고(기본값=실 Apple root 유지), attacker 자신의
    # 가짜 root/intermediate/leaf로 내부적으로는 정합한 체인을 구성 — 실 Apple root와 무관.
    fake_root_key, fake_root_cert = _self_signed_root()
    fake_intermediate_key, fake_intermediate_cert = _signed_intermediate(fake_root_key, fake_root_cert)

    client_data_hash = hashlib.sha256(b"x").digest()
    probe_key = ec.generate_private_key(ec.SECP256R1())
    probe_pub_raw = probe_key.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    key_id = hashlib.sha256(probe_pub_raw).digest()
    auth_data = _auth_data(_rp_id_hash(), 0, _AAGUID_PRODUCTION, key_id)
    nonce = hashlib.sha256(auth_data + client_data_hash).digest()

    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Attacker Leaf")])
    leaf_cert = (
        x509.CertificateBuilder()
        .subject_name(name).issuer_name(fake_intermediate_cert.subject).public_key(probe_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.now(timezone.utc) - timedelta(days=1))
        .not_valid_after(datetime.now(timezone.utc) + timedelta(days=365))
        .add_extension(x509.UnrecognizedExtension(NONCE_OID, _nonce_extension_der(nonce)), critical=False)
        .sign(fake_intermediate_key, hashes.SHA256())
    )
    x5c = [
        leaf_cert.public_bytes(serialization.Encoding.DER),
        fake_intermediate_cert.public_bytes(serialization.Encoding.DER),
    ]
    attestation_object = cbor2.dumps({
        "fmt": "apple-appattest", "attStmt": {"x5c": x5c, "receipt": b"x"}, "authData": auth_data,
    })

    with pytest.raises(AppAttestVerificationError, match="chain_does_not_terminate_at_apple_root"):
        verify_attestation(
            attestation_object=attestation_object, key_id=key_id, client_data_hash=client_data_hash,
            expected_team_id=TEAM_ID, expected_bundle_id=BUNDLE_ID, expected_environment=ENV_PRODUCTION,
        )


def test_nonce_mismatch_rejected(monkeypatch):
    fx = _build_valid_attestation(monkeypatch, tamper_nonce=True)
    with pytest.raises(AppAttestVerificationError, match="nonce_mismatch"):
        verify_attestation(
            attestation_object=fx["attestation_object"], key_id=fx["key_id"],
            client_data_hash=fx["client_data_hash"], expected_team_id=TEAM_ID, expected_bundle_id=BUNDLE_ID,
            expected_environment=ENV_PRODUCTION,
        )


def test_key_id_mismatch_rejected(monkeypatch):
    fx = _build_valid_attestation(monkeypatch)
    with pytest.raises(AppAttestVerificationError, match="key_id_mismatch"):
        verify_attestation(
            attestation_object=fx["attestation_object"], key_id=b"\x00" * 32,
            client_data_hash=fx["client_data_hash"], expected_team_id=TEAM_ID, expected_bundle_id=BUNDLE_ID,
            expected_environment=ENV_PRODUCTION,
        )


def test_initial_counter_nonzero_rejected(monkeypatch):
    fx = _build_valid_attestation(monkeypatch, counter=1)
    with pytest.raises(AppAttestVerificationError, match="initial_counter_not_zero"):
        verify_attestation(
            attestation_object=fx["attestation_object"], key_id=fx["key_id"],
            client_data_hash=fx["client_data_hash"], expected_team_id=TEAM_ID, expected_bundle_id=BUNDLE_ID,
            expected_environment=ENV_PRODUCTION,
        )


def test_not_apple_appattest_fmt_rejected(monkeypatch):
    fx = _build_valid_attestation(monkeypatch)
    decoded = cbor2.loads(fx["attestation_object"])
    decoded["fmt"] = "packed"
    tampered = cbor2.dumps(decoded)
    with pytest.raises(AppAttestVerificationError, match="unexpected_fmt"):
        verify_attestation(
            attestation_object=tampered, key_id=fx["key_id"], client_data_hash=fx["client_data_hash"],
            expected_team_id=TEAM_ID, expected_bundle_id=BUNDLE_ID, expected_environment=ENV_PRODUCTION,
        )


def test_malformed_cbor_rejected(monkeypatch):
    # \xa5 = "map with 5 key/value pairs follows" 헤더만 있고 실제 데이터가 없는 truncated
    # CBOR — 진짜 디코드 에러(CBORDecodeEOF)를 유발한다.
    with pytest.raises(AppAttestVerificationError, match="attestation_object_not_valid_cbor"):
        verify_attestation(
            attestation_object=b"\xa5", key_id=b"\x00" * 32, client_data_hash=b"\x00" * 32,
            expected_team_id=TEAM_ID, expected_bundle_id=BUNDLE_ID, expected_environment=ENV_PRODUCTION,
        )


def test_non_map_cbor_rejected(monkeypatch):
    """CBOR 자체는 유효하지만 최상위가 map이 아니면(예: 정수 하나) 거부."""
    with pytest.raises(AppAttestVerificationError, match="attestation_object_not_a_map"):
        verify_attestation(
            attestation_object=cbor2.dumps(42), key_id=b"\x00" * 32, client_data_hash=b"\x00" * 32,
            expected_team_id=TEAM_ID, expected_bundle_id=BUNDLE_ID, expected_environment=ENV_PRODUCTION,
        )


def test_empty_x5c_rejected(monkeypatch):
    root_key, root_cert = _self_signed_root()
    import app.services.apple_app_attest as module
    monkeypatch.setattr(module, "APPLE_APP_ATTEST_ROOT_CA_PEM", root_cert.public_bytes(serialization.Encoding.PEM))
    attestation_object = cbor2.dumps({
        "fmt": "apple-appattest", "attStmt": {"x5c": [], "receipt": b"x"}, "authData": b"\x00" * 37,
    })
    with pytest.raises(AppAttestVerificationError, match="empty_certificate_chain"):
        verify_attestation(
            attestation_object=attestation_object, key_id=b"\x00" * 32, client_data_hash=b"\x00" * 32,
            expected_team_id=TEAM_ID, expected_bundle_id=BUNDLE_ID, expected_environment=ENV_PRODUCTION,
        )


# ─── verify_assertion ────────────────────────────────────────────────────────

def _assertion_cbor(auth_data: bytes, signing_key, client_data_hash: bytes) -> bytes:
    nonce = hashlib.sha256(auth_data + client_data_hash).digest()
    signature = signing_key.sign(nonce, ec.ECDSA(hashes.SHA256()))
    return cbor2.dumps({"signature": signature, "authenticatorData": auth_data})


def test_valid_assertion_accepted(monkeypatch):
    fx = _build_valid_attestation(monkeypatch)
    leaf_key = fx["leaf_key"]
    public_key_der = leaf_key.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    client_data_hash = hashlib.sha256(b"assertion-challenge").digest()
    auth_data = _auth_data(_rp_id_hash(), 1, None, None)
    assertion = _assertion_cbor(auth_data, leaf_key, client_data_hash)

    result = verify_assertion(
        assertion=assertion, client_data_hash=client_data_hash, stored_public_key_der=public_key_der,
        stored_counter=0, expected_team_id=TEAM_ID, expected_bundle_id=BUNDLE_ID,
    )
    assert result.counter == 1


def test_assertion_counter_equal_rejected(monkeypatch):
    fx = _build_valid_attestation(monkeypatch)
    leaf_key = fx["leaf_key"]
    public_key_der = leaf_key.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    client_data_hash = hashlib.sha256(b"assertion-challenge").digest()
    auth_data = _auth_data(_rp_id_hash(), 5, None, None)
    assertion = _assertion_cbor(auth_data, leaf_key, client_data_hash)

    with pytest.raises(AppAttestVerificationError, match="counter_not_strictly_increasing"):
        verify_assertion(
            assertion=assertion, client_data_hash=client_data_hash, stored_public_key_der=public_key_der,
            stored_counter=5, expected_team_id=TEAM_ID, expected_bundle_id=BUNDLE_ID,
        )


def test_assertion_counter_regression_rejected(monkeypatch):
    fx = _build_valid_attestation(monkeypatch)
    leaf_key = fx["leaf_key"]
    public_key_der = leaf_key.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    client_data_hash = hashlib.sha256(b"assertion-challenge").digest()
    auth_data = _auth_data(_rp_id_hash(), 3, None, None)
    assertion = _assertion_cbor(auth_data, leaf_key, client_data_hash)

    with pytest.raises(AppAttestVerificationError, match="counter_not_strictly_increasing"):
        verify_assertion(
            assertion=assertion, client_data_hash=client_data_hash, stored_public_key_der=public_key_der,
            stored_counter=5, expected_team_id=TEAM_ID, expected_bundle_id=BUNDLE_ID,
        )


def test_assertion_counter_gap_allowed(monkeypatch):
    """산티아고 §7.4: "gap 허용" — signCount는 엄격히 증가하기만 하면 되고 연속일 필요 없다."""
    fx = _build_valid_attestation(monkeypatch)
    leaf_key = fx["leaf_key"]
    public_key_der = leaf_key.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    client_data_hash = hashlib.sha256(b"assertion-challenge").digest()
    auth_data = _auth_data(_rp_id_hash(), 100, None, None)
    assertion = _assertion_cbor(auth_data, leaf_key, client_data_hash)

    result = verify_assertion(
        assertion=assertion, client_data_hash=client_data_hash, stored_public_key_der=public_key_der,
        stored_counter=1, expected_team_id=TEAM_ID, expected_bundle_id=BUNDLE_ID,
    )
    assert result.counter == 100


def test_assertion_wrong_signing_key_rejected(monkeypatch):
    """다른(등록되지 않은) 키로 서명하면 저장된 공개키로 검증 실패 — 키 탈취/클론 방지."""
    fx = _build_valid_attestation(monkeypatch)
    leaf_key = fx["leaf_key"]
    public_key_der = leaf_key.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    imposter_key = ec.generate_private_key(ec.SECP256R1())
    client_data_hash = hashlib.sha256(b"assertion-challenge").digest()
    auth_data = _auth_data(_rp_id_hash(), 1, None, None)
    assertion = _assertion_cbor(auth_data, imposter_key, client_data_hash)

    with pytest.raises(AppAttestVerificationError, match="assertion_signature_invalid"):
        verify_assertion(
            assertion=assertion, client_data_hash=client_data_hash, stored_public_key_der=public_key_der,
            stored_counter=0, expected_team_id=TEAM_ID, expected_bundle_id=BUNDLE_ID,
        )


def test_assertion_rp_id_hash_mismatch_rejected(monkeypatch):
    fx = _build_valid_attestation(monkeypatch)
    leaf_key = fx["leaf_key"]
    public_key_der = leaf_key.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    client_data_hash = hashlib.sha256(b"assertion-challenge").digest()
    auth_data = _auth_data(_rp_id_hash(team_id="OTHERTEAM"), 1, None, None)
    assertion = _assertion_cbor(auth_data, leaf_key, client_data_hash)

    with pytest.raises(AppAttestVerificationError, match="rp_id_hash_mismatch"):
        verify_assertion(
            assertion=assertion, client_data_hash=client_data_hash, stored_public_key_der=public_key_der,
            stored_counter=0, expected_team_id=TEAM_ID, expected_bundle_id=BUNDLE_ID,
        )
