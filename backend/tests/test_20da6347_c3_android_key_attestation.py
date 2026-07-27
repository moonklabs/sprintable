"""story 20da6347(E-AUTH-REBUILD 활성화게이트][C3]·산티아고 §7.4 SSOT) 게이트: Android Key
Attestation X.509 chain+KeyDescription 검증 — 정상/전수 음성 케이스.

실 Google 인증서는 당연히 없으므로, 모듈이 신뢰하는 root anchor를 테스트 전용 self-signed
root로 주입(`trusted_roots=` 파라미터)해 **동일 검증 알고리즘**을 실증한다. KeyDescription
확장은 DER TLV를 손으로 정확히 인코딩해 구성 — 파서(app 코드)와 완전히 독립적인 인코더로
검증해야 파서의 숨은 가정을 우연히 안 맞춰주는 진짜 라운드트립 테스트가 된다.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

from app.services.android_key_attestation import (
    KEY_DESCRIPTION_OID,
    AndroidAttestationVerificationError,
    verify_bootstrap_signature,
    verify_key_attestation,
)

PACKAGE_NAME = b"com.sprintable.app"
CERT_DIGEST = bytes(range(32))  # 가짜 SHA-256 다이제스트 형태(32바이트)
CHALLENGE = b"server-issued-256bit-challenge-x"[:32]


# ─── 최소 DER 인코더(파서와 독립 구현) ───────────────────────────────────────

def _der_length_bytes(length: int) -> bytes:
    if length < 0x80:
        return bytes([length])
    length_bytes = length.to_bytes((length.bit_length() + 7) // 8, "big")
    return bytes([0x80 | len(length_bytes)]) + length_bytes


def _encode_tag_number(tag_number: int) -> bytes:
    parts = [tag_number & 0x7F]
    n = tag_number >> 7
    while n:
        parts.append((n & 0x7F) | 0x80)
        n >>= 7
    parts.reverse()
    return bytes(parts)


def _der_tag_and_length(tag_class: int, constructed: bool, tag_number: int, content_len: int) -> bytes:
    first_byte = (tag_class << 6) | (0x20 if constructed else 0x00)
    if tag_number < 31:
        tag_bytes = bytes([first_byte | tag_number])
    else:
        tag_bytes = bytes([first_byte | 0x1F]) + _encode_tag_number(tag_number)
    return tag_bytes + _der_length_bytes(content_len)


def _der_universal(tag_number: int, constructed: bool, content: bytes) -> bytes:
    return _der_tag_and_length(0, constructed, tag_number, len(content)) + content


def _der_context_explicit(tag_number: int, inner: bytes) -> bytes:
    return _der_tag_and_length(2, True, tag_number, len(inner)) + inner


def _integer(value: int) -> bytes:
    if value == 0:
        content = b"\x00"
    else:
        nbytes = (value.bit_length() + 7) // 8
        content = value.to_bytes(nbytes, "big")
        if content[0] & 0x80:
            content = b"\x00" + content
    return _der_universal(0x02, False, content)


def _octet_string(data: bytes) -> bytes:
    return _der_universal(0x04, False, data)


def _boolean(value: bool) -> bytes:
    return _der_universal(0x01, False, b"\xff" if value else b"\x00")


def _enumerated(value: int) -> bytes:
    return _der_universal(0x0A, False, bytes([value]))


def _sequence(*items: bytes) -> bytes:
    return _der_universal(0x10, True, b"".join(items))


def _set_of(*items: bytes) -> bytes:
    return _der_universal(0x11, True, b"".join(items))


def _build_authorization_list(
    *, purposes=None, digests=None, origin=None, root_of_trust=None, package_name=None, version=1, cert_digest=None,
):
    fields = []
    if purposes is not None:
        fields.append(_der_context_explicit(1, _set_of(*[_integer(p) for p in purposes])))
    if digests is not None:
        fields.append(_der_context_explicit(5, _set_of(*[_integer(d) for d in digests])))
    if origin is not None:
        fields.append(_der_context_explicit(702, _integer(origin)))
    if root_of_trust is not None:
        verified_boot_key, device_locked, verified_boot_state = root_of_trust
        rot_seq = _sequence(_octet_string(verified_boot_key), _boolean(device_locked), _enumerated(verified_boot_state))
        fields.append(_der_context_explicit(704, rot_seq))
    if package_name is not None:
        pkg_record = _sequence(_octet_string(package_name), _integer(version))
        aai_seq = _sequence(_set_of(pkg_record), _set_of(_octet_string(cert_digest)))
        fields.append(_der_context_explicit(709, _octet_string(aai_seq)))
    return _sequence(*fields)


def _build_key_description(
    *, challenge, security_level=1, keymaster_security_level=1, hardware_enforced_der,
):
    return _sequence(
        _integer(200), _enumerated(security_level), _integer(200), _enumerated(keymaster_security_level),
        _octet_string(challenge), _octet_string(b""), _sequence(), hardware_enforced_der,
    )


def _default_hardware_enforced(**overrides) -> bytes:
    kwargs = dict(
        purposes=[2], digests=[4], origin=0,
        root_of_trust=(b"\x01" * 32, True, 0),
        package_name=PACKAGE_NAME, version=1, cert_digest=CERT_DIGEST,
    )
    kwargs.update(overrides)
    return _build_authorization_list(**kwargs)


# ─── 인증서 체인 빌더 ────────────────────────────────────────────────────────

def _self_signed_root():
    key = ec.generate_private_key(ec.SECP384R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Test Key Attestation Root")])
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
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Test Key Attestation CA1")])
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


def _leaf_with_key_description(intermediate_key, intermediate_cert, key_description_der: bytes):
    leaf_key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Test Key Attestation Leaf")])
    cert = (
        x509.CertificateBuilder()
        .subject_name(name).issuer_name(intermediate_cert.subject).public_key(leaf_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.now(timezone.utc) - timedelta(days=1))
        .not_valid_after(datetime.now(timezone.utc) + timedelta(days=365))
        .add_extension(x509.UnrecognizedExtension(KEY_DESCRIPTION_OID, key_description_der), critical=False)
        .sign(intermediate_key, hashes.SHA256())
    )
    return leaf_key, cert


def _build_chain(*, hardware_enforced_kwargs=None, security_level=1, challenge=CHALLENGE):
    root_key, root_cert = _self_signed_root()
    intermediate_key, intermediate_cert = _signed_intermediate(root_key, root_cert)

    hw_kwargs = hardware_enforced_kwargs or {}
    hardware_enforced = _default_hardware_enforced(**hw_kwargs)
    key_description = _build_key_description(
        challenge=challenge, security_level=security_level, keymaster_security_level=security_level,
        hardware_enforced_der=hardware_enforced,
    )
    leaf_key, leaf_cert = _leaf_with_key_description(intermediate_key, intermediate_cert, key_description)

    chain_der = [
        leaf_cert.public_bytes(serialization.Encoding.DER),
        intermediate_cert.public_bytes(serialization.Encoding.DER),
    ]
    return {"chain_der": chain_der, "leaf_key": leaf_key, "trusted_roots": [root_cert]}


# ─── verify_key_attestation ─────────────────────────────────────────────────

def test_valid_attestation_accepted():
    fx = _build_chain()
    result = verify_key_attestation(
        certificate_chain=fx["chain_der"], expected_challenge=CHALLENGE,
        expected_package_name=PACKAGE_NAME, expected_signing_cert_digest=CERT_DIGEST,
        trusted_roots=fx["trusted_roots"],
    )
    assert result.security_level == "hardware"
    assert result.public_key_der


def test_strongbox_security_level_recorded():
    fx = _build_chain(security_level=2)
    result = verify_key_attestation(
        certificate_chain=fx["chain_der"], expected_challenge=CHALLENGE,
        expected_package_name=PACKAGE_NAME, expected_signing_cert_digest=CERT_DIGEST,
        trusted_roots=fx["trusted_roots"],
    )
    assert result.security_level == "strongbox"


def test_software_security_level_rejected():
    fx = _build_chain(security_level=0)
    with pytest.raises(AndroidAttestationVerificationError, match="not_hardware_backed"):
        verify_key_attestation(
            certificate_chain=fx["chain_der"], expected_challenge=CHALLENGE,
            expected_package_name=PACKAGE_NAME, expected_signing_cert_digest=CERT_DIGEST,
            trusted_roots=fx["trusted_roots"],
        )


def test_wrong_package_name_rejected():
    fx = _build_chain()
    with pytest.raises(AndroidAttestationVerificationError, match="package_name_mismatch"):
        verify_key_attestation(
            certificate_chain=fx["chain_der"], expected_challenge=CHALLENGE,
            expected_package_name=b"com.wrong.app", expected_signing_cert_digest=CERT_DIGEST,
            trusted_roots=fx["trusted_roots"],
        )


def test_wrong_cert_digest_rejected():
    fx = _build_chain()
    with pytest.raises(AndroidAttestationVerificationError, match="signing_cert_digest_mismatch"):
        verify_key_attestation(
            certificate_chain=fx["chain_der"], expected_challenge=CHALLENGE,
            expected_package_name=PACKAGE_NAME, expected_signing_cert_digest=b"\x99" * 32,
            trusted_roots=fx["trusted_roots"],
        )


def test_challenge_mismatch_rejected():
    fx = _build_chain(challenge=CHALLENGE)
    with pytest.raises(AndroidAttestationVerificationError, match="attestation_challenge_mismatch"):
        verify_key_attestation(
            certificate_chain=fx["chain_der"], expected_challenge=b"different-challenge-bytes-here!!",
            expected_package_name=PACKAGE_NAME, expected_signing_cert_digest=CERT_DIGEST,
            trusted_roots=fx["trusted_roots"],
        )


def test_key_origin_not_generated_rejected():
    fx = _build_chain(hardware_enforced_kwargs={"origin": 1})  # 1=IMPORTED, not GENERATED
    with pytest.raises(AndroidAttestationVerificationError, match="key_origin_not_generated"):
        verify_key_attestation(
            certificate_chain=fx["chain_der"], expected_challenge=CHALLENGE,
            expected_package_name=PACKAGE_NAME, expected_signing_cert_digest=CERT_DIGEST,
            trusted_roots=fx["trusted_roots"],
        )


def test_purpose_not_sign_rejected():
    fx = _build_chain(hardware_enforced_kwargs={"purposes": [0]})  # 0=ENCRYPT, not SIGN
    with pytest.raises(AndroidAttestationVerificationError, match="purpose_sign_not_present"):
        verify_key_attestation(
            certificate_chain=fx["chain_der"], expected_challenge=CHALLENGE,
            expected_package_name=PACKAGE_NAME, expected_signing_cert_digest=CERT_DIGEST,
            trusted_roots=fx["trusted_roots"],
        )


def test_digest_not_sha256_rejected():
    fx = _build_chain(hardware_enforced_kwargs={"digests": [1]})  # 1=SHA1, not SHA256
    with pytest.raises(AndroidAttestationVerificationError, match="digest_sha256_not_present"):
        verify_key_attestation(
            certificate_chain=fx["chain_der"], expected_challenge=CHALLENGE,
            expected_package_name=PACKAGE_NAME, expected_signing_cert_digest=CERT_DIGEST,
            trusted_roots=fx["trusted_roots"],
        )


def test_verified_boot_state_not_verified_rejected():
    fx = _build_chain(hardware_enforced_kwargs={"root_of_trust": (b"\x01" * 32, True, 2)})  # Unverified
    with pytest.raises(AndroidAttestationVerificationError, match="verified_boot_state_not_verified"):
        verify_key_attestation(
            certificate_chain=fx["chain_der"], expected_challenge=CHALLENGE,
            expected_package_name=PACKAGE_NAME, expected_signing_cert_digest=CERT_DIGEST,
            trusted_roots=fx["trusted_roots"],
        )


def test_device_not_locked_rejected():
    fx = _build_chain(hardware_enforced_kwargs={"root_of_trust": (b"\x01" * 32, False, 0)})
    with pytest.raises(AndroidAttestationVerificationError, match="device_not_locked"):
        verify_key_attestation(
            certificate_chain=fx["chain_der"], expected_challenge=CHALLENGE,
            expected_package_name=PACKAGE_NAME, expected_signing_cert_digest=CERT_DIGEST,
            trusted_roots=fx["trusted_roots"],
        )


def test_forged_chain_not_terminating_at_trusted_root_rejected():
    """attacker가 자체 root로 완결된(내부 정합은 맞는) 체인을 들이밀어도 우리 trusted_roots
    파라미터로 안 끝나면 거부."""
    attacker_root_key, attacker_root_cert = _self_signed_root()
    attacker_intermediate_key, attacker_intermediate_cert = _signed_intermediate(attacker_root_key, attacker_root_cert)
    hardware_enforced = _default_hardware_enforced()
    key_description = _build_key_description(
        challenge=CHALLENGE, security_level=1, keymaster_security_level=1, hardware_enforced_der=hardware_enforced,
    )
    _leaf_key, leaf_cert = _leaf_with_key_description(attacker_intermediate_key, attacker_intermediate_cert, key_description)
    chain_der = [
        leaf_cert.public_bytes(serialization.Encoding.DER),
        attacker_intermediate_cert.public_bytes(serialization.Encoding.DER),
    ]
    real_root_key, real_root_cert = _self_signed_root()

    with pytest.raises(AndroidAttestationVerificationError, match="chain_does_not_terminate_at_google_root"):
        verify_key_attestation(
            certificate_chain=chain_der, expected_challenge=CHALLENGE,
            expected_package_name=PACKAGE_NAME, expected_signing_cert_digest=CERT_DIGEST,
            trusted_roots=[real_root_cert],  # attacker root와 무관한 별도 trusted root
        )


def test_revoked_certificate_rejected():
    fx = _build_chain()

    def revoked_checker(cert):
        return True  # 모든 인증서를 폐기된 것으로 취급

    with pytest.raises(AndroidAttestationVerificationError, match="certificate_revoked"):
        verify_key_attestation(
            certificate_chain=fx["chain_der"], expected_challenge=CHALLENGE,
            expected_package_name=PACKAGE_NAME, expected_signing_cert_digest=CERT_DIGEST,
            trusted_roots=fx["trusted_roots"], revocation_checker=revoked_checker,
        )


def test_empty_chain_rejected():
    with pytest.raises(AndroidAttestationVerificationError, match="empty_certificate_chain"):
        verify_key_attestation(
            certificate_chain=[], expected_challenge=CHALLENGE,
            expected_package_name=PACKAGE_NAME, expected_signing_cert_digest=CERT_DIGEST,
        )


def test_missing_key_description_extension_rejected():
    root_key, root_cert = _self_signed_root()
    intermediate_key, intermediate_cert = _signed_intermediate(root_key, root_cert)
    leaf_key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "No KeyDescription Leaf")])
    leaf_cert = (
        x509.CertificateBuilder()
        .subject_name(name).issuer_name(intermediate_cert.subject).public_key(leaf_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.now(timezone.utc) - timedelta(days=1))
        .not_valid_after(datetime.now(timezone.utc) + timedelta(days=365))
        .sign(intermediate_key, hashes.SHA256())
    )
    chain_der = [
        leaf_cert.public_bytes(serialization.Encoding.DER),
        intermediate_cert.public_bytes(serialization.Encoding.DER),
    ]
    with pytest.raises(AndroidAttestationVerificationError, match="key_description_extension_missing"):
        verify_key_attestation(
            certificate_chain=chain_der, expected_challenge=CHALLENGE,
            expected_package_name=PACKAGE_NAME, expected_signing_cert_digest=CERT_DIGEST,
            trusted_roots=[root_cert],
        )


# ─── verify_bootstrap_signature ──────────────────────────────────────────────

def test_valid_bootstrap_signature_accepted():
    fx = _build_chain()
    leaf_key = fx["leaf_key"]
    public_key_der = leaf_key.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    signed_bytes = b"canonical-challenge-transcript-bytes"
    signature = leaf_key.sign(signed_bytes, ec.ECDSA(hashes.SHA256()))

    result = verify_bootstrap_signature(signed_bytes=signed_bytes, signature=signature, stored_public_key_der=public_key_der)
    assert result.verified is True


def test_bootstrap_signature_wrong_key_rejected():
    fx = _build_chain()
    leaf_key = fx["leaf_key"]
    public_key_der = leaf_key.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    imposter_key = ec.generate_private_key(ec.SECP256R1())
    signed_bytes = b"canonical-challenge-transcript-bytes"
    signature = imposter_key.sign(signed_bytes, ec.ECDSA(hashes.SHA256()))

    with pytest.raises(AndroidAttestationVerificationError, match="bootstrap_signature_invalid"):
        verify_bootstrap_signature(signed_bytes=signed_bytes, signature=signature, stored_public_key_der=public_key_der)


def test_bootstrap_signature_tampered_bytes_rejected():
    fx = _build_chain()
    leaf_key = fx["leaf_key"]
    public_key_der = leaf_key.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    signature = leaf_key.sign(b"original-bytes", ec.ECDSA(hashes.SHA256()))

    with pytest.raises(AndroidAttestationVerificationError, match="bootstrap_signature_invalid"):
        verify_bootstrap_signature(signed_bytes=b"tampered-bytes", signature=signature, stored_public_key_der=public_key_der)
