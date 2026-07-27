"""story 20da6347(E-AUTH-REBUILD 활성화게이트][C3]·doc e-mobile-per-install-proof-feasibility
§7.4·산티아고 §7.4 SSOT 2026-07-16): Android Key Attestation 서버측 검증.

**검증 알고리즘 출처**: Android 공식 문서(source.android.com/docs/security/features/keystore/
attestation)의 Key Attestation 인증서 확장(OID 1.3.6.1.4.1.11129.2.1.17, KeyDescription) 스키마.

⚠️Android엔 iOS signCount 상당 개념이 없다 — 이 모듈은 "등록"(key attestation chain+
KeyDescription 검증)과 "부트스트랩 서명"(Keystore private key로 canonical bytes ECDSA
서명 검증)만 다룬다. `server_seq`/challenge 원자적 compare-and-set은 DB 트랜잭션 책임이라
C4 스코프 — 이 모듈은 순수 암호검증만.

⛔이 모듈이 하지 않는 것: Play Integrity 토큰 검증(별도 모듈 `play_integrity.py`)·revocation
list의 실제 HTTP 페치(mock-first — `RevocationChecker` 프로토콜을 호출부가 주입, S4/S5
패턴과 동일 원칙)·register/consume 엔드포인트 배선(C4).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Callable

from cryptography import x509
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec

KEY_DESCRIPTION_OID = x509.ObjectIdentifier("1.3.6.1.4.1.11129.2.1.17")

# Google 공식 배포 Hardware Attestation Root — 두 세대 모두 유효(신규 리프는 2026-02-01부터
# EC root, 기존 기기는 여전히 RSA root 체인을 낼 수 있어 양쪽 다 신뢰 anchor로 유지).
# 출처: https://developer.android.com/privacy-and-security/security-key-attestation ·
# https://android.googleapis.com/attestation/root
GOOGLE_HARDWARE_ATTESTATION_ROOT_RSA_PEM = b"""-----BEGIN CERTIFICATE-----
MIIFHDCCAwSgAwIBAgIJAPHBcqaZ6vUdMA0GCSqGSIb3DQEBCwUAMBsxGTAXBgNV
BAUTEGY5MjAwOWU4NTNiNmIwNDUwHhcNMjIwMzIwMTgwNzQ4WhcNNDIwMzE1MTgw
NzQ4WjAbMRkwFwYDVQQFExBmOTIwMDllODUzYjZiMDQ1MIICIjANBgkqhkiG9w0B
AQEFAAOCAg8AMIICCgKCAgEAr7bHgiuxpwHsK7Qui8xUFmOr75gvMsd/dTEDDJdS
Sxtf6An7xyqpRR90PL2abxM1dEqlXnf2tqw1Ne4Xwl5jlRfdnJLmN0pTy/4lj4/7
tv0Sk3iiKkypnEUtR6WfMgH0QZfKHM1+di+y9TFRtv6y//0rb+T+W8a9nsNL/ggj
nar86461qO0rOs2cXjp3kOG1FEJ5MVmFmBGtnrKpa73XpXyTqRxB/M0n1n/W9nGq
C4FSYa04T6N5RIZGBN2z2MT5IKGbFlbC8UrW0DxW7AYImQQcHtGl/m00QLVWutHQ
oVJYnFPlXTcHYvASLu+RhhsbDmxMgJJ0mcDpvsC4PjvB+TxywElgS70vE0XmLD+O
JtvsBslHZvPBKCOdT0MS+tgSOIfga+z1Z1g7+DVagf7quvmag8jfPioyKvxnK/Eg
sTUVi2ghzq8wm27ud/mIM7AY2qEORR8Go3TVB4HzWQgpZrt3i5MIlCaY504LzSRi
igHCzAPlHws+W0rB5N+er5/2pJKnfBSDiCiFAVtCLOZ7gLiMm0jhO2B6tUXHI/+M
RPjy02i59lINMRRev56GKtcd9qO/0kUJWdZTdA2XoS82ixPvZtXQpUpuL12ab+9E
aDK8Z4RHJYYfCT3Q5vNAXaiWQ+8PTWm2QgBR/bkwSWc+NpUFgNPN9PvQi8WEg5Um
AGMCAwEAAaNjMGEwHQYDVR0OBBYEFDZh4QB8iAUJUYtEbEf/GkzJ6k8SMB8GA1Ud
IwQYMBaAFDZh4QB8iAUJUYtEbEf/GkzJ6k8SMA8GA1UdEwEB/wQFMAMBAf8wDgYD
VR0PAQH/BAQDAgIEMA0GCSqGSIb3DQEBCwUAA4ICAQB8cMqTllHc8U+qCrOlg3H7
174lmaCsbo/bJ0C17JEgMLb4kvrqsXZs01U3mB/qABg/1t5Pd5AORHARs1hhqGIC
W/nKMav574f9rZN4PC2ZlufGXb7sIdJpGiO9ctRhiLuYuly10JccUZGEHpHSYM2G
tkgYbZba6lsCPYAAP83cyDV+1aOkTf1RCp/lM0PKvmxYN10RYsK631jrleGdcdkx
oSK//mSQbgcWnmAEZrzHoF1/0gso1HZgIn0YLzVhLSA/iXCX4QT2h3J5z3znluKG
1nv8NQdxei2DIIhASWfu804CA96cQKTTlaae2fweqXjdN1/v2nqOhngNyz1361mF
mr4XmaKH/ItTwOe72NI9ZcwS1lVaCvsIkTDCEXdm9rCNPAY10iTunIHFXRh+7KPz
lHGewCq/8TOohBRn0/NNfh7uRslOSZ/xKbN9tMBtw37Z8d2vvnXq/YWdsm1+JLVw
n6yYD/yacNJBlwpddla8eaVMjsF6nBnIgQOf9zKSe06nSTqvgwUHosgOECZJZ1Eu
zbH4yswbt02tKtKEFhx+v+OTge/06V+jGsqTWLsfrOCNLuA8H++z+pUENmpqnnHo
vaI47gC+TNpkgYGkkBT6B/m/U01BuOBBTzhIlMEZq9qkDWuM2cA5kW5V3FJUcfHn
w1IdYIg2Wxg7yHcQZemFQg==
-----END CERTIFICATE-----
"""
GOOGLE_HARDWARE_ATTESTATION_ROOT_EC_PEM = b"""-----BEGIN CERTIFICATE-----
MIICIjCCAaigAwIBAgIRAISp0Cl7DrWK5/8OgN52BgUwCgYIKoZIzj0EAwMwUjEc
MBoGA1UEAwwTS2V5IEF0dGVzdGF0aW9uIENBMTEQMA4GA1UECwwHQW5kcm9pZDET
MBEGA1UECgwKR29vZ2xlIExMQzELMAkGA1UEBhMCVVMwHhcNMjUwNzE3MjIzMjE4
WhcNMzUwNzE1MjIzMjE4WjBSMRwwGgYDVQQDDBNLZXkgQXR0ZXN0YXRpb24gQ0Ex
MRAwDgYDVQQLDAdBbmRyb2lkMRMwEQYDVQQKDApHb29nbGUgTExDMQswCQYDVQQG
EwJVUzB2MBAGByqGSM49AgEGBSuBBAAiA2IABCPaI3FO3z5bBQo8cuiEas4HjqCt
G/mLFfRT0MsIssPBEEU5Cfbt6sH5yOAxqEi5QagpU1yX4HwnGb7OtBYpDTB57uH5
Eczm34A5FNijV3s0/f0UPl7zbJcTx6xwqMIRq6NCMEAwDwYDVR0TAQH/BAUwAwEB
/zAOBgNVHQ8BAf8EBAMCAQYwHQYDVR0OBBYEFFIyuyz7RkOb3NaBqQ5lZuA0QepA
MAoGCCqGSM49BAMDA2gAMGUCMETfjPO/HwqReR2CS7p0ZWoD/LHs6hDi422opifH
EUaYLxwGlT9SLdjkVpz0UUOR5wIxAIoGyxGKRHVTpqpGRFiJtQEOOTp/+s1GcxeY
uR2zh/80lQyu9vAFCj6E4AXc+osmRg==
-----END CERTIFICATE-----
"""

SECURITY_LEVEL_SOFTWARE = 0
SECURITY_LEVEL_TRUSTED_ENVIRONMENT = 1
SECURITY_LEVEL_STRONGBOX = 2

VERIFIED_BOOT_STATE_VERIFIED = 0
VERIFIED_BOOT_STATE_SELF_SIGNED = 1
VERIFIED_BOOT_STATE_UNVERIFIED = 2
VERIFIED_BOOT_STATE_FAILED = 3

ORIGIN_GENERATED = 0
KM_PURPOSE_SIGN = 2
KM_DIGEST_SHA_2_256 = 4

# AuthorizationList의 context-tag 번호(Android Keystore Attestation 스키마, source.android.com).
_TAG_PURPOSE = 1
_TAG_DIGEST = 5
_TAG_ORIGIN = 702
_TAG_ROOT_OF_TRUST = 704
_TAG_ATTESTATION_APPLICATION_ID = 709


class AndroidAttestationVerificationError(Exception):
    """검증 실패 — 메시지는 로그 전용(enumeration 방지는 호출부 401 통일 책임)."""


# ─── 최소 범용 DER TLV 파서(§7.0 정신과 동일 이유 — KeyDescription의 깊은 중첩 구조를
# 정확히 파싱 못 하면 crypto 검증 자체가 우회될 수 있어 pyasn1 같은 검증된 저수준 프리미티브
# 대신 이 스토리 스코프에 정확히 필요한 필드만 손으로 정밀 파싱한다) ────────────────────

@dataclass
class _DerTlv:
    tag_class: int  # 0=universal,1=application,2=context,3=private
    constructed: bool
    tag_number: int
    content: bytes


def _read_der_length(data: bytes, offset: int) -> tuple[int, int]:
    first = data[offset]
    offset += 1
    if first & 0x80 == 0:
        return first, offset
    num_bytes = first & 0x7F
    if num_bytes == 0:
        raise AndroidAttestationVerificationError("der_indefinite_length_unsupported")
    length = int.from_bytes(data[offset:offset + num_bytes], "big")
    return length, offset + num_bytes


def _read_der_tlv(data: bytes, offset: int) -> tuple[_DerTlv, int]:
    tag_byte = data[offset]
    tag_class = (tag_byte >> 6) & 0x03
    constructed = bool(tag_byte & 0x20)
    tag_number = tag_byte & 0x1F
    pos = offset + 1
    if tag_number == 0x1F:
        tag_number = 0
        while True:
            b = data[pos]
            pos += 1
            tag_number = (tag_number << 7) | (b & 0x7F)
            if not (b & 0x80):
                break
    length, pos = _read_der_length(data, pos)
    content = data[pos:pos + length]
    return _DerTlv(tag_class=tag_class, constructed=constructed, tag_number=tag_number, content=content), pos + length


def _read_der_sequence_items(content: bytes) -> list[_DerTlv]:
    items = []
    pos = 0
    while pos < len(content):
        item, pos = _read_der_tlv(content, pos)
        items.append(item)
    return items


def _der_integer(tlv: _DerTlv) -> int:
    return int.from_bytes(tlv.content, "big", signed=False) if tlv.content else 0


def _find_context_tag(items: list[_DerTlv], tag_number: int) -> _DerTlv | None:
    for item in items:
        if item.tag_class == 2 and item.tag_number == tag_number:
            return item
    return None


def _unwrap_explicit(tlv: _DerTlv) -> _DerTlv:
    """AuthorizationList 필드는 전부 `[N] EXPLICIT <type>` — context tag의 content가 그
    자체로 완전한 하나의 내부 TLV를 담는다(IMPLICIT 아님)."""
    inner, _ = _read_der_tlv(tlv.content, 0)
    return inner


@dataclass
class ParsedRootOfTrust:
    verified_boot_key: bytes
    device_locked: bool
    verified_boot_state: int


@dataclass
class ParsedAttestationApplicationId:
    package_names: set[bytes] = field(default_factory=set)
    signature_digests: set[bytes] = field(default_factory=set)


@dataclass
class ParsedKeyDescription:
    attestation_version: int
    attestation_security_level: int
    keymaster_security_level: int
    attestation_challenge: bytes
    purposes: set[int]
    digests: set[int]
    origin: int | None
    root_of_trust: ParsedRootOfTrust | None
    attestation_application_id: ParsedAttestationApplicationId | None


def _parse_authorization_list(content: bytes) -> tuple[set[int], set[int], int | None, ParsedRootOfTrust | None, ParsedAttestationApplicationId | None]:
    items = _read_der_sequence_items(content)

    purposes: set[int] = set()
    purpose_tag = _find_context_tag(items, _TAG_PURPOSE)
    if purpose_tag is not None:
        purpose_set = _unwrap_explicit(purpose_tag)
        purposes = {_der_integer(t) for t in _read_der_sequence_items(purpose_set.content)}

    digests: set[int] = set()
    digest_tag = _find_context_tag(items, _TAG_DIGEST)
    if digest_tag is not None:
        digest_set = _unwrap_explicit(digest_tag)
        digests = {_der_integer(t) for t in _read_der_sequence_items(digest_set.content)}

    origin: int | None = None
    origin_tag = _find_context_tag(items, _TAG_ORIGIN)
    if origin_tag is not None:
        origin = _der_integer(_unwrap_explicit(origin_tag))

    root_of_trust: ParsedRootOfTrust | None = None
    rot_tag = _find_context_tag(items, _TAG_ROOT_OF_TRUST)
    if rot_tag is not None:
        rot_seq = _unwrap_explicit(rot_tag)
        rot_items = _read_der_sequence_items(rot_seq.content)
        if len(rot_items) < 3:
            raise AndroidAttestationVerificationError("root_of_trust_truncated")
        verified_boot_key = rot_items[0].content
        device_locked = rot_items[1].content != b"\x00"
        verified_boot_state = _der_integer(rot_items[2])
        root_of_trust = ParsedRootOfTrust(
            verified_boot_key=verified_boot_key, device_locked=device_locked, verified_boot_state=verified_boot_state
        )

    attestation_application_id: ParsedAttestationApplicationId | None = None
    aai_tag = _find_context_tag(items, _TAG_ATTESTATION_APPLICATION_ID)
    if aai_tag is not None:
        # [709] EXPLICIT OCTET STRING — 그 OCTET STRING의 content 자체가 다시 하나의 완전한
        # DER SEQUENCE(AttestationApplicationId, 이중 인코딩)라 한 번 더 파싱해야 한다.
        octet_tlv = _unwrap_explicit(aai_tag)
        aai_seq, _ = _read_der_tlv(octet_tlv.content, 0)
        aai_items = _read_der_sequence_items(aai_seq.content)
        if len(aai_items) < 2:
            raise AndroidAttestationVerificationError("attestation_application_id_truncated")
        package_records = _read_der_sequence_items(aai_items[0].content)
        package_names = set()
        for record in package_records:
            record_items = _read_der_sequence_items(record.content)
            if not record_items:
                continue
            package_names.add(record_items[0].content)
        signature_digest_items = _read_der_sequence_items(aai_items[1].content)
        signature_digests = {t.content for t in signature_digest_items}
        attestation_application_id = ParsedAttestationApplicationId(
            package_names=package_names, signature_digests=signature_digests
        )

    return purposes, digests, origin, root_of_trust, attestation_application_id


def parse_key_description(extension_der: bytes) -> ParsedKeyDescription:
    """OID 1.3.6.1.4.1.11129.2.1.17 확장값(전체 KeyDescription DER)을 파싱. 스토리 스코프에
    필요한 필드만(purpose/digest/origin/rootOfTrust/attestationApplicationId) hardwareEnforced
    에서 추출 — softwareEnforced는 신뢰 anchor가 아니므로 안 본다(공격자가 software-enforced
    필드는 자유롭게 조작 가능)."""
    top, _ = _read_der_tlv(extension_der, 0)
    items = _read_der_sequence_items(top.content)
    if len(items) < 8:
        raise AndroidAttestationVerificationError("key_description_truncated")

    attestation_version = _der_integer(items[0])
    attestation_security_level = _der_integer(items[1])
    keymaster_security_level = _der_integer(items[3])
    attestation_challenge = items[4].content
    hardware_enforced = items[7]

    purposes, digests, origin, root_of_trust, attestation_application_id = _parse_authorization_list(
        hardware_enforced.content
    )

    return ParsedKeyDescription(
        attestation_version=attestation_version,
        attestation_security_level=attestation_security_level,
        keymaster_security_level=keymaster_security_level,
        attestation_challenge=attestation_challenge,
        purposes=purposes,
        digests=digests,
        origin=origin,
        root_of_trust=root_of_trust,
        attestation_application_id=attestation_application_id,
    )


# ─── 인증서 체인 검증 ─────────────────────────────────────────────────────────

def _verify_cert_signed_by(child: x509.Certificate, parent_public_key) -> bool:
    try:
        if isinstance(parent_public_key, ec.EllipticCurvePublicKey):
            parent_public_key.verify(child.signature, child.tbs_certificate_bytes, ec.ECDSA(child.signature_hash_algorithm))
        else:
            from cryptography.hazmat.primitives.asymmetric import padding
            parent_public_key.verify(
                child.signature, child.tbs_certificate_bytes, padding.PKCS1v15(), child.signature_hash_algorithm
            )
        return True
    except InvalidSignature:
        return False
    except Exception:
        return False


def _trusted_roots() -> list[x509.Certificate]:
    return [
        x509.load_pem_x509_certificate(GOOGLE_HARDWARE_ATTESTATION_ROOT_RSA_PEM),
        x509.load_pem_x509_certificate(GOOGLE_HARDWARE_ATTESTATION_ROOT_EC_PEM),
    ]


RevocationChecker = Callable[[x509.Certificate], bool]
"""cert → True면 폐기됨. 실 HTTP 페치(https://android.googleapis.com/attestation/status)는
호출부 책임(mock-first) — 이 모듈은 검사 시점(now)에 주어진 checker를 체인의 모든 인증서에
적용만 한다."""


def _verify_chain_to_google_root(
    chain_der: list[bytes], *, trusted_roots: list[x509.Certificate] | None = None,
    revocation_checker: RevocationChecker | None = None,
) -> x509.Certificate:
    if not chain_der:
        raise AndroidAttestationVerificationError("empty_certificate_chain")
    try:
        certs = [x509.load_der_x509_certificate(c) for c in chain_der]
    except ValueError as exc:
        raise AndroidAttestationVerificationError("malformed_certificate_in_chain") from exc

    now = datetime.now(timezone.utc)
    for c in certs:
        if c.not_valid_before_utc > now or c.not_valid_after_utc < now:
            raise AndroidAttestationVerificationError("certificate_expired_or_not_yet_valid")

    if revocation_checker is not None:
        for c in certs:
            if revocation_checker(c):
                raise AndroidAttestationVerificationError("certificate_revoked")

    for i in range(len(certs) - 1):
        if not _verify_cert_signed_by(certs[i], certs[i + 1].public_key()):
            raise AndroidAttestationVerificationError("chain_signature_invalid")

    roots = trusted_roots if trusted_roots is not None else _trusted_roots()
    if not any(_verify_cert_signed_by(certs[-1], root.public_key()) for root in roots):
        raise AndroidAttestationVerificationError("chain_does_not_terminate_at_google_root")

    return certs[0]  # leaf


@dataclass
class VerifiedKeyAttestation:
    public_key_der: bytes
    security_level: str  # "hardware" | "strongbox"


def verify_key_attestation(
    *,
    certificate_chain: list[bytes],
    expected_challenge: bytes,
    expected_package_name: bytes,
    expected_signing_cert_digest: bytes,
    trusted_roots: list[x509.Certificate] | None = None,
    revocation_checker: RevocationChecker | None = None,
) -> VerifiedKeyAttestation:
    """산티아고 §7.4 Android 등록 검증 — 실패 시 AndroidAttestationVerificationError.

    호출부(C4)가 이 함수 전에 마쳐야 하는 것: 서버 challenge 발급(§7.2 Android 특수 순서 —
    challenge 먼저 발급 후 그 해시를 `setAttestationChallenge`로 키 생성에 사용, 키 생성
    후에는 challenge 교체 불가), Play Integrity Standard token 검증(별도 모듈)."""
    leaf = _verify_chain_to_google_root(certificate_chain, trusted_roots=trusted_roots, revocation_checker=revocation_checker)

    try:
        ext = leaf.extensions.get_extension_for_oid(KEY_DESCRIPTION_OID)
    except x509.ExtensionNotFound as exc:
        raise AndroidAttestationVerificationError("key_description_extension_missing") from exc
    raw = ext.value.value if hasattr(ext.value, "value") else bytes(ext.value)
    parsed = parse_key_description(raw)

    if parsed.attestation_challenge != expected_challenge:
        raise AndroidAttestationVerificationError("attestation_challenge_mismatch")

    if parsed.attestation_security_level == SECURITY_LEVEL_SOFTWARE:
        raise AndroidAttestationVerificationError("not_hardware_backed")
    if parsed.attestation_security_level not in (SECURITY_LEVEL_TRUSTED_ENVIRONMENT, SECURITY_LEVEL_STRONGBOX):
        raise AndroidAttestationVerificationError("unknown_security_level")

    if parsed.origin != ORIGIN_GENERATED:
        raise AndroidAttestationVerificationError("key_origin_not_generated")
    if KM_PURPOSE_SIGN not in parsed.purposes:
        raise AndroidAttestationVerificationError("purpose_sign_not_present")
    if KM_DIGEST_SHA_2_256 not in parsed.digests:
        raise AndroidAttestationVerificationError("digest_sha256_not_present")

    if parsed.root_of_trust is None:
        raise AndroidAttestationVerificationError("root_of_trust_missing")
    if parsed.root_of_trust.verified_boot_state != VERIFIED_BOOT_STATE_VERIFIED:
        raise AndroidAttestationVerificationError("verified_boot_state_not_verified")
    if not parsed.root_of_trust.device_locked:
        raise AndroidAttestationVerificationError("device_not_locked")

    if parsed.attestation_application_id is None:
        raise AndroidAttestationVerificationError("attestation_application_id_missing")
    if expected_package_name not in parsed.attestation_application_id.package_names:
        raise AndroidAttestationVerificationError("package_name_mismatch")
    if expected_signing_cert_digest not in parsed.attestation_application_id.signature_digests:
        raise AndroidAttestationVerificationError("signing_cert_digest_mismatch")

    leaf_public_key = leaf.public_key()
    if not isinstance(leaf_public_key, ec.EllipticCurvePublicKey) or leaf_public_key.curve.name != "secp256r1":
        raise AndroidAttestationVerificationError("leaf_key_not_p256")

    public_key_der = leaf_public_key.public_bytes(
        encoding=serialization.Encoding.DER, format=serialization.PublicFormat.SubjectPublicKeyInfo
    )
    security_level = "strongbox" if parsed.attestation_security_level == SECURITY_LEVEL_STRONGBOX else "hardware"
    return VerifiedKeyAttestation(public_key_der=public_key_der, security_level=security_level)


# ─── 부트스트랩 서명 검증(server_seq 챌린지 응답) ────────────────────────────

@dataclass
class VerifiedBootstrapSignature:
    verified: bool = True


def verify_bootstrap_signature(
    *, signed_bytes: bytes, signature: bytes, stored_public_key_der: bytes
) -> VerifiedBootstrapSignature:
    """Android엔 signCount가 없다 — 매 요청 Keystore private key로 canonical bytes(서버가
    구성한 challenge transcript)에 ECDSA-SHA256 서명한 것을 등록된 공개키로 검증만 한다.
    `server_seq`+challenge 원자성(재사용 방지)은 DB 트랜잭션(C4) 책임 — 이 함수 자체는
    같은 (signed_bytes, signature) 쌍의 replay를 못 막는다(순수 서명 유효성만 판단)."""
    try:
        public_key = serialization.load_der_public_key(stored_public_key_der)
    except Exception as exc:
        raise AndroidAttestationVerificationError("stored_public_key_malformed") from exc
    if not isinstance(public_key, ec.EllipticCurvePublicKey):
        raise AndroidAttestationVerificationError("stored_public_key_not_ec")

    try:
        public_key.verify(signature, signed_bytes, ec.ECDSA(hashes.SHA256()))
    except InvalidSignature as exc:
        raise AndroidAttestationVerificationError("bootstrap_signature_invalid") from exc

    return VerifiedBootstrapSignature()
