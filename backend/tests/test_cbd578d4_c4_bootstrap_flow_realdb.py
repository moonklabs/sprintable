"""story cbd578d4(E-AUTH-REBUILD 활성화게이트][C4]·산티아고 §7.5 SSOT) 게이트: native-bootstrap
issue+consume 2단계 원자 트랜잭션 — 6조건부 mutation 각각 개별 실패·counter CAS 레이스·
N-way 동시성·orphan-finding(revoke race) 회귀.

여기선 DeviceInstallation을 직접 시드(알려진 P-256 키페어로) — attestation chain 자체의
정확성은 C2/C3 자체 테스트가 이미 커버하므로, 이 파일은 **issue/consume 트랜잭션 로직**에
집중한다(등록된 설치의 실 서명으로 challenge-assertion 흐름만 실증)."""
from __future__ import annotations

import asyncio
import base64
import hashlib
import os
import uuid
from datetime import datetime, timezone

import cbor2
import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi import HTTPException

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
]

PROJECT_ID = "test-project"
BUNDLE_ID = "com.sprintable.app"


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_after():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    engine = create_async_engine(_async_url())
    return engine, async_sessionmaker(engine, expire_on_commit=False)


def _setup_common(monkeypatch):
    from app.core.config import settings
    monkeypatch.setattr(settings, "firebase_auth_mobile_issue", True)
    monkeypatch.setattr(settings, "firebase_project_id", PROJECT_ID)
    monkeypatch.setattr(settings, "firebase_bff_internal_secret", "")
    monkeypatch.setattr(settings, "app_env", "development")
    monkeypatch.setattr(settings, "ios_team_id", "ABCDE12345")


def _b64url_decode(s: str) -> bytes:
    padded = s + "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(padded.encode())


class _FakeRequest:
    base_url = "http://testserver/"


async def _seed_eligible_user_and_installation(session, *, platform="ios"):
    from app.core.security import hash_password
    from app.models.auth_identity import AuthIdentity, AuthMigration
    from app.models.device_installation import DeviceInstallation
    from app.models.user import User

    user_id = uuid.uuid4()
    firebase_uid = f"fb-uid-{user_id.hex[:8]}"
    session.add(User(
        id=user_id, email=f"c4-bootstrap-{user_id.hex[:8]}@test.com",
        hashed_password=hash_password("x"), is_active=True, email_verified=True,
    ))
    await session.commit()
    session.add(AuthMigration(user_id=user_id, state="firebase"))
    session.add(AuthIdentity(
        id=uuid.uuid4(), user_id=user_id,
        issuer=f"https://securetoken.google.com/{PROJECT_ID}", subject=firebase_uid, provider_id="password",
    ))
    await session.commit()

    key = ec.generate_private_key(ec.SECP256R1())
    public_key_der = key.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    installation = DeviceInstallation(
        id=uuid.uuid4(), user_id=user_id, firebase_uid=firebase_uid, project_id=PROJECT_ID,
        environment="production", platform=platform, app_id=BUNDLE_ID, key_version=1,
        public_key_fingerprint=f"fp-{uuid.uuid4().hex[:12]}", public_key_der=public_key_der,
        attestation_type="app_attest" if platform == "ios" else "key_attestation",
        status="active", attested_at=datetime.now(timezone.utc), created_at=datetime.now(timezone.utc),
    )
    session.add(installation)
    await session.commit()
    return user_id, firebase_uid, installation.id, key


async def _issue_bootstrap_issue_challenge(db, *, user_id, firebase_uid, installation_id, platform="ios"):
    from app.models.device_installation import DeviceInstallation
    from app.services.device_proof import PURPOSE_BOOTSTRAP_ISSUE, TTL_BOOTSTRAP_ISSUE_SECONDS, issue_challenge

    installation = await db.get(DeviceInstallation, installation_id)
    server_seq = (installation.last_server_seq or 0) + 1 if platform == "android" else None
    return await issue_challenge(
        db, purpose=PURPOSE_BOOTSTRAP_ISSUE, user_id=user_id, firebase_uid=firebase_uid, project_id=PROJECT_ID,
        tenant_id=None, environment="production", platform=platform, app_id=BUNDLE_ID,
        http_method="POST", route="/api/v2/auth/native-bootstrap", web_origin="https://sprintable.app",
        ttl_seconds=TTL_BOOTSTRAP_ISSUE_SECONDS, installation_id=installation_id, key_version=1,
        server_seq=server_seq,
    )


def _sign_ios_assertion(key, transcript_bytes: bytes, client_data_hash: bytes, counter: int) -> bytes:
    """C2 verify_assertion 계약에 맞는 CBOR {signature, authenticatorData} 구성."""
    rp_id_hash = hashlib.sha256(f"ABCDE12345.{BUNDLE_ID}".encode()).digest()
    auth_data = rp_id_hash + bytes([0x00]) + counter.to_bytes(4, "big")
    nonce = hashlib.sha256(auth_data + client_data_hash).digest()
    signature = key.sign(nonce, ec.ECDSA(hashes.SHA256()))
    return cbor2.dumps({"signature": signature, "authenticatorData": auth_data})


def _sign_android_bytes(key, transcript_bytes: bytes) -> bytes:
    return key.sign(transcript_bytes, ec.ECDSA(hashes.SHA256()))


async def _mock_native_request_preamble(monkeypatch, *, user_id, firebase_uid):
    """auth_native_bootstrap.py의 verify_native_request 전처리(exact Bearer+App Check+
    migration+cutover)는 C1/Story A 자체 테스트가 이미 커버 — 이 파일은 issue/consume
    트랜잭션 로직에 집중하려 verify_native_request 자체를 우회한다."""
    import app.routers.auth_native_bootstrap as router_mod
    from app.services.native_request_auth import VerifiedNativeRequest

    async def fake_verify(*, authorization, app_check_token, db, log_prefix):
        return VerifiedNativeRequest(user_id=user_id, firebase_uid=firebase_uid, app_check_app_id="1:123:ios:abc")

    monkeypatch.setattr(router_mod, "verify_native_request", fake_verify)


# ─── native_bootstrap (issue) ────────────────────────────────────────────────

@pytest.mark.anyio
async def test_ios_bootstrap_issue_success(monkeypatch):
    from app.routers.auth_native_bootstrap import NativeBootstrapRequest, native_bootstrap

    _setup_common(monkeypatch)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id, firebase_uid, installation_id, key = await _seed_eligible_user_and_installation(s)
            issued = await _issue_bootstrap_issue_challenge(
                s, user_id=user_id, firebase_uid=firebase_uid, installation_id=installation_id
            )
        await _mock_native_request_preamble(monkeypatch, user_id=user_id, firebase_uid=firebase_uid)

        transcript_bytes = _b64url_decode(issued.client_data_b64url)
        client_data_hash = hashlib.sha256(transcript_bytes).digest()
        assertion = _sign_ios_assertion(key, transcript_bytes, client_data_hash, counter=1)

        async with Session() as s:
            result = await native_bootstrap(
                request=_FakeRequest(),
                body=NativeBootstrapRequest(
                    installation_id=str(installation_id), challenge_id=issued.challenge_id,
                    client_data_b64url=issued.client_data_b64url, assertion_b64=base64.b64encode(assertion).decode(),
                ),
                response=__import__("fastapi").Response(), authorization="Bearer x", x_firebase_appcheck=None, db=s,
            )
        assert result.code
        assert result.redeem_challenge_id
        assert result.redeem_client_data_b64url
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_bootstrap_issue_key_version_mismatch_rejected(monkeypatch):
    from app.routers.auth_native_bootstrap import NativeBootstrapRequest, native_bootstrap
    from sqlalchemy import update
    from app.models.device_installation import DeviceInstallation

    _setup_common(monkeypatch)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id, firebase_uid, installation_id, key = await _seed_eligible_user_and_installation(s)
            issued = await _issue_bootstrap_issue_challenge(
                s, user_id=user_id, firebase_uid=firebase_uid, installation_id=installation_id
            )
            # 챌린지 발급 이후 installation의 key_version이 갱신(예: 재등록)됐다고 가정.
            await s.execute(update(DeviceInstallation).where(DeviceInstallation.id == installation_id).values(key_version=2))
            await s.commit()
        await _mock_native_request_preamble(monkeypatch, user_id=user_id, firebase_uid=firebase_uid)

        transcript_bytes = _b64url_decode(issued.client_data_b64url)
        client_data_hash = hashlib.sha256(transcript_bytes).digest()
        assertion = _sign_ios_assertion(key, transcript_bytes, client_data_hash, counter=1)

        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await native_bootstrap(
                    request=_FakeRequest(),
                    body=NativeBootstrapRequest(
                        installation_id=str(installation_id), challenge_id=issued.challenge_id,
                        client_data_b64url=issued.client_data_b64url,
                        assertion_b64=base64.b64encode(assertion).decode(),
                    ),
                    response=__import__("fastapi").Response(), authorization="Bearer x", x_firebase_appcheck=None, db=s,
                )
            assert exc_info.value.status_code == 401
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_bootstrap_issue_wrong_signing_key_rejected(monkeypatch):
    from app.routers.auth_native_bootstrap import NativeBootstrapRequest, native_bootstrap

    _setup_common(monkeypatch)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id, firebase_uid, installation_id, key = await _seed_eligible_user_and_installation(s)
            issued = await _issue_bootstrap_issue_challenge(
                s, user_id=user_id, firebase_uid=firebase_uid, installation_id=installation_id
            )
        await _mock_native_request_preamble(monkeypatch, user_id=user_id, firebase_uid=firebase_uid)

        transcript_bytes = _b64url_decode(issued.client_data_b64url)
        client_data_hash = hashlib.sha256(transcript_bytes).digest()
        imposter_key = ec.generate_private_key(ec.SECP256R1())
        assertion = _sign_ios_assertion(imposter_key, transcript_bytes, client_data_hash, counter=1)

        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await native_bootstrap(
                    request=_FakeRequest(),
                    body=NativeBootstrapRequest(
                        installation_id=str(installation_id), challenge_id=issued.challenge_id,
                        client_data_b64url=issued.client_data_b64url,
                        assertion_b64=base64.b64encode(assertion).decode(),
                    ),
                    response=__import__("fastapi").Response(), authorization="Bearer x", x_firebase_appcheck=None, db=s,
                )
            assert exc_info.value.status_code == 401
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_android_bootstrap_issue_success(monkeypatch):
    from app.routers.auth_native_bootstrap import NativeBootstrapRequest, native_bootstrap

    _setup_common(monkeypatch)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id, firebase_uid, installation_id, key = await _seed_eligible_user_and_installation(s, platform="android")
            issued = await _issue_bootstrap_issue_challenge(
                s, user_id=user_id, firebase_uid=firebase_uid, installation_id=installation_id, platform="android",
            )
        await _mock_native_request_preamble(monkeypatch, user_id=user_id, firebase_uid=firebase_uid)

        transcript_bytes = _b64url_decode(issued.client_data_b64url)
        signature = _sign_android_bytes(key, transcript_bytes)

        async with Session() as s:
            result = await native_bootstrap(
                request=_FakeRequest(),
                body=NativeBootstrapRequest(
                    installation_id=str(installation_id), challenge_id=issued.challenge_id,
                    client_data_b64url=issued.client_data_b64url, signature_b64=base64.b64encode(signature).decode(),
                ),
                response=__import__("fastapi").Response(), authorization="Bearer x", x_firebase_appcheck=None, db=s,
            )
        assert result.code
    finally:
        await engine.dispose()


# ─── consume (6조건 원자 트랜잭션) ────────────────────────────────────────────

async def _full_issue_flow(session_factory, monkeypatch, *, platform="ios"):
    """issue까지 마쳐 raw code+redeem challenge 정보를 반환 — consume 테스트들의 공통 준비."""
    from app.routers.auth_native_bootstrap import NativeBootstrapRequest, native_bootstrap
    from fastapi import Response

    async with session_factory() as s:
        user_id, firebase_uid, installation_id, key = await _seed_eligible_user_and_installation(s, platform=platform)
        issued = await _issue_bootstrap_issue_challenge(
            s, user_id=user_id, firebase_uid=firebase_uid, installation_id=installation_id, platform=platform,
        )
    await _mock_native_request_preamble(monkeypatch, user_id=user_id, firebase_uid=firebase_uid)

    transcript_bytes = _b64url_decode(issued.client_data_b64url)
    if platform == "ios":
        client_data_hash = hashlib.sha256(transcript_bytes).digest()
        proof = _sign_ios_assertion(key, transcript_bytes, client_data_hash, counter=1)
        body = NativeBootstrapRequest(
            installation_id=str(installation_id), challenge_id=issued.challenge_id,
            client_data_b64url=issued.client_data_b64url, assertion_b64=base64.b64encode(proof).decode(),
        )
    else:
        proof = _sign_android_bytes(key, transcript_bytes)
        body = NativeBootstrapRequest(
            installation_id=str(installation_id), challenge_id=issued.challenge_id,
            client_data_b64url=issued.client_data_b64url, signature_b64=base64.b64encode(proof).decode(),
        )

    async with session_factory() as s:
        issue_result = await native_bootstrap(
            request=_FakeRequest(), body=body, response=Response(), authorization="Bearer x", x_firebase_appcheck=None, db=s,
        )
    return user_id, firebase_uid, installation_id, key, issue_result


def _consume_proof(platform, key, redeem_transcript_bytes: bytes):
    if platform == "ios":
        client_data_hash = hashlib.sha256(redeem_transcript_bytes).digest()
        return _sign_ios_assertion(key, redeem_transcript_bytes, client_data_hash, counter=2), "assertion_b64"
    return _sign_android_bytes(key, redeem_transcript_bytes), "signature_b64"


@pytest.mark.anyio
async def test_ios_full_round_trip_success(monkeypatch):
    from app.routers.auth_firebase_internal import NativeBootstrapConsumeRequest, consume_native_bootstrap

    _setup_common(monkeypatch)
    engine, Session = await _session_factory()
    try:
        user_id, firebase_uid, installation_id, key, issue_result = await _full_issue_flow(Session, monkeypatch)

        redeem_transcript = _b64url_decode(issue_result.redeem_client_data_b64url)
        proof, field = _consume_proof("ios", key, redeem_transcript)

        async def fake_mint(firebase_uid, project_id, web_api_key, valid_duration_seconds):
            return "minted-cookie"
        import app.routers.auth_firebase_internal as internal_mod
        monkeypatch.setattr(internal_mod, "mint_session_cookie_for_uid", fake_mint)

        async with Session() as s:
            result = await consume_native_bootstrap(
                NativeBootstrapConsumeRequest(
                    code=issue_result.code, installation_id=str(installation_id),
                    challenge_id=issue_result.redeem_challenge_id,
                    client_data_b64url=issue_result.redeem_client_data_b64url, key_version=1,
                    **{field: base64.b64encode(proof).decode()},
                ),
                authorization=None, db=s,
            )
        assert result.session_cookie == "minted-cookie"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_consume_wrong_code_rejected(monkeypatch):
    from app.routers.auth_firebase_internal import NativeBootstrapConsumeRequest, consume_native_bootstrap

    _setup_common(monkeypatch)
    engine, Session = await _session_factory()
    try:
        user_id, firebase_uid, installation_id, key, issue_result = await _full_issue_flow(Session, monkeypatch)
        redeem_transcript = _b64url_decode(issue_result.redeem_client_data_b64url)
        proof, field = _consume_proof("ios", key, redeem_transcript)

        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await consume_native_bootstrap(
                    NativeBootstrapConsumeRequest(
                        code="wrong-code-entirely", installation_id=str(installation_id),
                        challenge_id=issue_result.redeem_challenge_id,
                        client_data_b64url=issue_result.redeem_client_data_b64url, key_version=1,
                        **{field: base64.b64encode(proof).decode()},
                    ),
                    authorization=None, db=s,
                )
            assert exc_info.value.status_code == 401
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_consume_replay_after_success_rejected(monkeypatch):
    from app.routers.auth_firebase_internal import NativeBootstrapConsumeRequest, consume_native_bootstrap
    import app.routers.auth_firebase_internal as internal_mod

    _setup_common(monkeypatch)
    engine, Session = await _session_factory()
    try:
        user_id, firebase_uid, installation_id, key, issue_result = await _full_issue_flow(Session, monkeypatch)
        redeem_transcript = _b64url_decode(issue_result.redeem_client_data_b64url)
        proof, field = _consume_proof("ios", key, redeem_transcript)

        async def fake_mint(*a, **kw):
            return "minted-cookie"
        monkeypatch.setattr(internal_mod, "mint_session_cookie_for_uid", fake_mint)

        req = NativeBootstrapConsumeRequest(
            code=issue_result.code, installation_id=str(installation_id),
            challenge_id=issue_result.redeem_challenge_id,
            client_data_b64url=issue_result.redeem_client_data_b64url, key_version=1,
            **{field: base64.b64encode(proof).decode()},
        )
        async with Session() as s:
            first = await consume_native_bootstrap(req, authorization=None, db=s)
        assert first.session_cookie == "minted-cookie"

        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await consume_native_bootstrap(req, authorization=None, db=s)
            assert exc_info.value.status_code == 401
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_consume_mismatched_code_and_redeem_challenge_rejected_without_burning_code(monkeypatch):
    """§7.5 code-binding 방어(뒤섞기 공격 전수): 같은 사용자의 서로 다른 두 installation에서
    각각 독립적으로 유효한 (code, redeem challenge) 쌍을 뒤섞어 제출(codeA + installationB의
    challengeB 진짜 transcript)하면 거부돼야 하고, codeA가 이 실패한 시도로 "소모"되지
    않고 여전히 정상 소비 가능해야 한다. ⚠️뮤테이션 self-check로 확인: 이 정확한 시나리오는
    `consume_bootstrap_code()`의 installation_id 필터(codeA≠installation B)가 먼저
    걸러 조기 `bootstrap_code_sha256` 검사 없이도 거부된다 — 그 검사는 "같은 installation
    안에서 code/challenge를 뒤섞는" 시나리오(installation당 active redeem challenge 1개
    제약 때문에 외부 API로는 재현 불가) 전용 belt-and-suspenders 방어로 남긴다. 이 테스트가
    실제로 실증하는 것은 최종 계약(뒤섞기=거부+정상 code 안 소모)이지, 특정 한 줄이 아니다."""
    from app.routers.auth_firebase_internal import NativeBootstrapConsumeRequest, consume_native_bootstrap
    import app.routers.auth_firebase_internal as internal_mod

    _setup_common(monkeypatch)
    engine, Session = await _session_factory()
    try:
        user_id, firebase_uid, installation_id, key, issue_a = await _full_issue_flow(Session, monkeypatch)

        # 같은 사용자의 두 번째(독립) installation — 별도 challenge 슬롯이라 uniqueness
        # 충돌 없이 두 번째 issue 흐름을 병행할 수 있다.
        async with Session() as s:
            from app.models.device_installation import DeviceInstallation
            key_b = ec.generate_private_key(ec.SECP256R1())
            public_key_der_b = key_b.public_key().public_bytes(
                serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
            )
            installation_b = DeviceInstallation(
                id=uuid.uuid4(), user_id=user_id, firebase_uid=firebase_uid, project_id=PROJECT_ID,
                environment="production", platform="ios", app_id=BUNDLE_ID, key_version=1,
                public_key_fingerprint=f"fp-{uuid.uuid4().hex[:12]}", public_key_der=public_key_der_b,
                attestation_type="app_attest", status="active", attested_at=datetime.now(timezone.utc),
                created_at=datetime.now(timezone.utc),
            )
            s.add(installation_b)
            await s.commit()
            installation_id_b = installation_b.id
            issued_b_challenge = await _issue_bootstrap_issue_challenge(
                s, user_id=user_id, firebase_uid=firebase_uid, installation_id=installation_id_b
            )
        transcript_b = _b64url_decode(issued_b_challenge.client_data_b64url)
        client_data_hash_b = hashlib.sha256(transcript_b).digest()
        assertion_b = _sign_ios_assertion(key_b, transcript_b, client_data_hash_b, counter=1)
        from app.routers.auth_native_bootstrap import NativeBootstrapRequest, native_bootstrap
        async with Session() as s:
            issue_b = await native_bootstrap(
                request=_FakeRequest(),
                body=NativeBootstrapRequest(
                    installation_id=str(installation_id_b), challenge_id=issued_b_challenge.challenge_id,
                    client_data_b64url=issued_b_challenge.client_data_b64url,
                    assertion_b64=base64.b64encode(assertion_b).decode(),
                ),
                response=__import__("fastapi").Response(), authorization="Bearer x", x_firebase_appcheck=None, db=s,
            )

        # codeA(installation A 소유) + installation B의 challengeB 진짜 redeem transcript를
        # 뒤섞기 — installation_id는 B로 제출(그래야 challengeB의 installation_id 바인딩과
        # 정합해 그 단계는 통과하고, 정확히 code-binding 검사에서만 걸리는지 실증).
        redeem_transcript_b = _b64url_decode(issue_b.redeem_client_data_b64url)
        proof_b, field_b = _consume_proof("ios", key_b, redeem_transcript_b)

        async def fake_mint(*a, **kw):
            return "should-never-be-returned"
        monkeypatch.setattr(internal_mod, "mint_session_cookie_for_uid", fake_mint)

        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await consume_native_bootstrap(
                    NativeBootstrapConsumeRequest(
                        code=issue_a.code,  # codeA(installation A 소유)
                        installation_id=str(installation_id_b),  # installation B로 제출
                        challenge_id=issue_b.redeem_challenge_id,  # challengeB(installation B 소유, 진짜)
                        client_data_b64url=issue_b.redeem_client_data_b64url,  # challengeB의 진짜 transcript
                        key_version=1,
                        **{field_b: base64.b64encode(proof_b).decode()},
                    ),
                    authorization=None, db=s,
                )
            assert exc_info.value.status_code == 401

        # codeA는 이 실패한 뒤섞기 시도로 소모되지 않았어야 한다 — codeA 자신의 진짜
        # redeem challenge로는 여전히 정상 소비 가능.
        redeem_transcript_a = _b64url_decode(issue_a.redeem_client_data_b64url)
        proof_a, field_a = _consume_proof("ios", key, redeem_transcript_a)

        async def fake_mint_ok(*a, **kw):
            return "minted-cookie-codeA"
        monkeypatch.setattr(internal_mod, "mint_session_cookie_for_uid", fake_mint_ok)

        async with Session() as s:
            result = await consume_native_bootstrap(
                NativeBootstrapConsumeRequest(
                    code=issue_a.code, installation_id=str(installation_id),
                    challenge_id=issue_a.redeem_challenge_id,
                    client_data_b64url=issue_a.redeem_client_data_b64url, key_version=1,
                    **{field_a: base64.b64encode(proof_a).decode()},
                ),
                authorization=None, db=s,
            )
        assert result.session_cookie == "minted-cookie-codeA"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_consume_wrong_installation_rejected(monkeypatch):
    """다른(공격자) installation_id로 소비 시도 — code binding 불일치로 거부."""
    from app.routers.auth_firebase_internal import NativeBootstrapConsumeRequest, consume_native_bootstrap

    _setup_common(monkeypatch)
    engine, Session = await _session_factory()
    try:
        user_id, firebase_uid, installation_id, key, issue_result = await _full_issue_flow(Session, monkeypatch)
        async with Session() as s:
            _, _, other_installation_id, other_key = await _seed_eligible_user_and_installation(s)

        redeem_transcript = _b64url_decode(issue_result.redeem_client_data_b64url)
        proof, field = _consume_proof("ios", key, redeem_transcript)

        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await consume_native_bootstrap(
                    NativeBootstrapConsumeRequest(
                        code=issue_result.code, installation_id=str(other_installation_id),
                        challenge_id=issue_result.redeem_challenge_id,
                        client_data_b64url=issue_result.redeem_client_data_b64url, key_version=1,
                        **{field: base64.b64encode(proof).decode()},
                    ),
                    authorization=None, db=s,
                )
            assert exc_info.value.status_code == 401
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_consume_revoked_installation_rejected(monkeypatch):
    from app.routers.auth_firebase_internal import NativeBootstrapConsumeRequest, consume_native_bootstrap
    from sqlalchemy import update
    from app.models.device_installation import DeviceInstallation

    _setup_common(monkeypatch)
    engine, Session = await _session_factory()
    try:
        user_id, firebase_uid, installation_id, key, issue_result = await _full_issue_flow(Session, monkeypatch)

        async with Session() as s:
            await s.execute(update(DeviceInstallation).where(DeviceInstallation.id == installation_id).values(status="revoked"))
            await s.commit()

        redeem_transcript = _b64url_decode(issue_result.redeem_client_data_b64url)
        proof, field = _consume_proof("ios", key, redeem_transcript)

        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await consume_native_bootstrap(
                    NativeBootstrapConsumeRequest(
                        code=issue_result.code, installation_id=str(installation_id),
                        challenge_id=issue_result.redeem_challenge_id,
                        client_data_b64url=issue_result.redeem_client_data_b64url, key_version=1,
                        **{field: base64.b64encode(proof).decode()},
                    ),
                    authorization=None, db=s,
                )
            assert exc_info.value.status_code == 401
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_concurrent_consume_exactly_one_succeeds(monkeypatch):
    """산티아고 게이트 명시 요구: 병렬 N-way 동시성 — 같은 code/assertion 병렬 소비 시
    정확히 1회만 mint 진행."""
    from app.routers.auth_firebase_internal import NativeBootstrapConsumeRequest, consume_native_bootstrap
    import app.routers.auth_firebase_internal as internal_mod

    _setup_common(monkeypatch)
    engine, Session = await _session_factory()
    try:
        user_id, firebase_uid, installation_id, key, issue_result = await _full_issue_flow(Session, monkeypatch)
        redeem_transcript = _b64url_decode(issue_result.redeem_client_data_b64url)
        proof, field = _consume_proof("ios", key, redeem_transcript)

        mint_call_count = {"n": 0}

        async def fake_mint(*a, **kw):
            mint_call_count["n"] += 1
            return "minted-cookie"
        monkeypatch.setattr(internal_mod, "mint_session_cookie_for_uid", fake_mint)

        req = NativeBootstrapConsumeRequest(
            code=issue_result.code, installation_id=str(installation_id),
            challenge_id=issue_result.redeem_challenge_id,
            client_data_b64url=issue_result.redeem_client_data_b64url, key_version=1,
            **{field: base64.b64encode(proof).decode()},
        )

        async def _attempt():
            async with Session() as s:
                try:
                    return await consume_native_bootstrap(req, authorization=None, db=s)
                except HTTPException:
                    return None

        results = await asyncio.gather(*[_attempt() for _ in range(5)])
        successes = [r for r in results if r is not None]
        assert len(successes) == 1
        assert mint_call_count["n"] == 1
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_orphan_finding_revoke_between_issue_and_consume_rejected(monkeypatch):
    """Story A(bea25062) orphan-finding 회귀 — C4 설치-바인딩 흐름으로 재실증: 코드 발급
    후 revoke가 발생하면(45초 내 아직 미만료) consume이 cutover 재검증에서 거부돼야 한다."""
    from app.routers.auth_firebase_internal import NativeBootstrapConsumeRequest, consume_native_bootstrap
    import app.routers.auth_firebase_internal as internal_mod
    from app.services.auth_cutover import revoke_user_sessions

    _setup_common(monkeypatch)
    engine, Session = await _session_factory()
    try:
        user_id, firebase_uid, installation_id, key, issue_result = await _full_issue_flow(Session, monkeypatch)

        async with Session() as s:
            await revoke_user_sessions(s, user_id, firebase_uid=None)

        redeem_transcript = _b64url_decode(issue_result.redeem_client_data_b64url)
        proof, field = _consume_proof("ios", key, redeem_transcript)

        async def fake_mint(*a, **kw):
            return "should-never-be-returned"
        monkeypatch.setattr(internal_mod, "mint_session_cookie_for_uid", fake_mint)

        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await consume_native_bootstrap(
                    NativeBootstrapConsumeRequest(
                        code=issue_result.code, installation_id=str(installation_id),
                        challenge_id=issue_result.redeem_challenge_id,
                        client_data_b64url=issue_result.redeem_client_data_b64url, key_version=1,
                        **{field: base64.b64encode(proof).decode()},
                    ),
                    authorization=None, db=s,
                )
            assert exc_info.value.status_code == 401
    finally:
        await engine.dispose()
