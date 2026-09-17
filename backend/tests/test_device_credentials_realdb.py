"""기기별 자격증명(`dt_live_*`) — 스키마 · 인증 해소 · 등록/폐기 라우터.

검증 축(사용자 지시의 필수 커버리지 그대로):
- 정상 자격증명이 해소된다(AuthContext 형태·claim 포함).
- 서명 불일치 거부 / 미존재 자격증명 거부 / 폐기된 자격증명 거부.
- 낡거나 재사용된 seq 거부(리플레이).
- 허용 윈도우 밖 타임스탬프 거부.
- 주체는 **자기 기기만** 등록·폐기 가능(타인 것은 404, 존재 여부 누설 없음).

⛔이 파일에 없는 것(의도적): 앱 무결성(attestation) — 이 계층은 attestation을 쓰지 않는다.
`device_installations`(App Attest/Play Integrity)와는 별개 프로토콜이고, 그 코드는 손대지 않았다.
"""
from __future__ import annotations

import base64
import hashlib
import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.anyio,
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
]


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
    """alembic-migrated DB를 그대로 쓴다 — agent_device_credentials는 마이그가 만들었고,
    테스트가 스키마를 직접 만들지 않는다(destructive_schema 마커 불요)."""
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    engine = create_async_engine(_async_url())
    return engine, async_sessionmaker(engine, expire_on_commit=False)


# ─── 시드 헬퍼 ────────────────────────────────────────────────────────────────


async def _seed_org_project_human(session, *, slug: str | None = None):
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.user import User

    org_id = uuid.uuid4()
    session.add(Organization(id=org_id, name=f"Org-{org_id.hex[:8]}", slug=slug or f"dc-{org_id.hex[:8]}"))
    await session.commit()
    project_id = uuid.uuid4()
    session.add(Project(id=project_id, org_id=org_id, name="P", slug=f"p-{project_id.hex[:8]}"))
    await session.commit()

    user_id = uuid.uuid4()
    session.add(User(
        id=user_id, email=f"dc-{user_id.hex[:8]}@test.com",
        hashed_password="x", is_active=True, email_verified=True,
    ))
    await session.commit()
    org_member_id = uuid.uuid4()
    session.add(OrgMember(id=org_member_id, org_id=org_id, user_id=user_id, role="owner"))
    await session.commit()
    # 0075 휴먼 불변식: members.id = org_members.id
    session.add(Member(id=org_member_id, org_id=org_id, type="human", user_id=user_id, name="Human"))
    await session.commit()
    return org_id, project_id, user_id, org_member_id


async def _seed_agent(session, org_id, project_id, *, created_by_member_id=None, name="Agent"):
    """에이전트 members + agent_project_profiles placement(접근 프로젝트 1개)."""
    from app.models.member import AgentProjectProfile, Member

    agent_id = uuid.uuid4()
    session.add(Member(
        id=agent_id, org_id=org_id, type="agent", name=name, owner_member_id=created_by_member_id,
    ))
    await session.commit()
    session.add(AgentProjectProfile(id=uuid.uuid4(), member_id=agent_id, project_id=project_id))
    await session.commit()
    return agent_id


def _keypair():
    """EC P-256 키쌍 → (private_key, public_key_der). 개인키는 서버로 가지 않는다."""
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    private_key = ec.generate_private_key(ec.SECP256R1())
    der = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    return private_key, der


def _sign(private_key, signed_bytes: bytes) -> str:
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import ec

    return base64.b64encode(private_key.sign(signed_bytes, ec.ECDSA(hashes.SHA256()))).decode()


def _proof(private_key, *, credential_id, method, route, timestamp, seq, body_sha256=None):
    """서명 증거 — 로컬 프록시가 만드는 것과 **동일한 값**을, `_resolve_device_credential`
    의 kwarg 이름 그대로 돌려준다(테스트는 HTTP를 안 거치고 resolver를 직접 부르므로,
    헤더 이름→kwarg 매핑은 배선 테스트가 따로 잰다)."""
    from app.services.device_credential import build_device_auth_transcript

    transcript = build_device_auth_transcript(
        credential_id=str(credential_id), http_method=method, route=route,
        timestamp=timestamp, server_seq=seq, body_sha256=body_sha256,
    )
    return {
        "timestamp": str(timestamp),
        "server_seq": str(seq),
        "signature_b64": _sign(private_key, transcript),
        "body_sha256": body_sha256,
    }


async def _seed_credential(
    session, *, org_id, human_member_id, agent_member_id, device_label="laptop",
    public_key_der=None, status="active", last_server_seq=None, revoked=False,
):
    from app.models.agent_device_credential import AgentDeviceCredential
    from app.services.device_credential import key_fingerprint

    der = public_key_der if public_key_der is not None else _keypair()[1]
    row = AgentDeviceCredential(
        member_id=human_member_id, agent_member_id=agent_member_id, device_label=device_label,
        public_key_der=der, key_fingerprint=key_fingerprint(der), status=status,
        last_server_seq=last_server_seq,
        revoked_at=datetime.now(timezone.utc) if revoked else None,
    )
    session.add(row)
    await session.commit()
    return row.id


def _now_ts() -> int:
    return int(datetime.now(timezone.utc).timestamp())


# ─── 스키마(마이그 0375) — 모델↔실 DB parity + 제약 실증 ──────────────────────


async def test_schema_matches_model_and_constraints_are_real():
    """alembic 0375가 만든 실 스키마를 SQLAlchemy 모델과 대조하고, 제약이 «실제로» 강제되는지
    실 INSERT로 확인한다(제약이 선언만 되고 안 걸린 상태를 green으로 넘기지 않는다)."""
    from sqlalchemy import create_engine, inspect, text

    import app.models  # noqa: F401 — Base.metadata 등록
    from app.core.database import Base

    table = Base.metadata.tables["agent_device_credentials"]
    sync_url = _async_url().replace("postgresql+asyncpg://", "postgresql+psycopg2://")
    engine_sync = create_engine(sync_url)
    try:
        insp = inspect(engine_sync)
        db_cols = {c["name"]: c["nullable"] for c in insp.get_columns("agent_device_credentials")}
        model_cols = {c.name: c.nullable for c in table.columns}
        assert set(db_cols) == set(model_cols), (set(db_cols) ^ set(model_cols))
        for name, nullable in model_cols.items():
            assert db_cols[name] == nullable, f"{name}: 모델 nullable={nullable} vs DB={db_cols[name]}"

        # 부분 인덱스가 실 DB에 있고, 그 predicate가 active 한정인가.
        idx = {i["name"]: i for i in insp.get_indexes("agent_device_credentials")}
        active_idx = idx["ix_agent_device_credentials_key_fingerprint_active"]
        assert "status = 'active'" in str(active_idx.get("dialect_options", {}).get("postgresql_where", ""))

        # FK 2개(member_id/agent_member_id) — 둘 다 members CASCADE.
        fks = insp.get_foreign_keys("agent_device_credentials")
        assert {(f["referred_table"], f["options"].get("ondelete")) for f in fks} == {("members", "CASCADE")}
        assert {f["constrained_columns"][0] for f in fks} == {"member_id", "agent_member_id"}
    finally:
        engine_sync.dispose()

    # 실 강제 확인 — UNIQUE(member_id, device_label) 위반이 실제로 IntegrityError를 낸다.
    from sqlalchemy.exc import IntegrityError

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id, user_id, human_member_id = await _seed_org_project_human(s)
            agent_id = await _seed_agent(s, org_id, project_id, created_by_member_id=human_member_id)
            await _seed_credential(
                s, org_id=org_id, human_member_id=human_member_id,
                agent_member_id=agent_id, device_label="unique-me",
            )
        with pytest.raises(IntegrityError):
            async with Session() as s:
                await _seed_credential(
                    s, org_id=org_id, human_member_id=human_member_id,
                    agent_member_id=agent_id, device_label="unique-me",
                )
    finally:
        await engine.dispose()


def test_migration_downgrade_drops_the_table():
    """`downgrade()`가 실제로 되돌린다 — alembic op를 직접 부르지 않고, 마이그 모듈이 선언한
    downgrade를 실 DB에 적용해 테이블이 사라지는지 본다(롤백 불가 마이그를 green으로 넘기지
    않는다).

    ⚠️**서브프로세스로 돈다**(in-process `alembic.command` 가 아니라) — `alembic/env.py`가
    `fileConfig(alembic.ini)`를 부르고, 그건 Python logging **전역**을 재설정한다(기본
    `disable_existing_loggers=True`). 이 파일에서 그걸 in-process로 돌리면 *이후* 실행되는
    모든 로그 단언 테스트가 조용히 깨진다(실측: 풀스위트에서 이 파일 뒤 15건이 로그 캡처
    실패로 무너졌고, 이 파일을 단독 실행하면 전부 통과했다 — 그 15건은 이 테스트 하나 때문).
    서브프로세스는 이 프로세스의 logging을 건드릴 수 없다. 부수적으로 실배포 경로
    (`bootstrap.py`의 `alembic upgrade heads`)와도 더 동형이다.

    ⚠️스키마를 되돌린 뒤 **다시 upgrade로 복구**한다 — 실패하면 이 파일의 나머지 테스트가
    연쇄로 깨지므로 finally로 복구를 보장한다(복구 실패는 그대로 터뜨린다)."""
    import subprocess
    import sys

    from sqlalchemy import create_engine, inspect

    sync_url = _async_url().replace("postgresql+asyncpg://", "postgresql+psycopg2://")

    def _alembic(*args: str) -> None:
        proc = subprocess.run(
            [sys.executable, "-m", "alembic", *args],
            capture_output=True, text=True,
            env={**os.environ, "ALEMBIC_DATABASE_URL": sync_url},
        )
        assert proc.returncode == 0, f"alembic {' '.join(args)} 실패:\n{proc.stdout}\n{proc.stderr}"

    engine = create_engine(sync_url)
    try:
        _alembic("downgrade", "0374")
        assert not inspect(engine).has_table("agent_device_credentials")
    finally:
        _alembic("upgrade", "heads")
    try:
        assert inspect(engine).has_table("agent_device_credentials")
    finally:
        engine.dispose()


# ─── 서비스 계층 순수 로직 ────────────────────────────────────────────────────


def test_device_credential_prefix_roundtrip():
    from app.services.device_credential import (
        DEVICE_CREDENTIAL_SCHEME,
        format_device_credential,
        parse_device_credential_id,
    )

    cid = uuid.uuid4()
    formatted = format_device_credential(cid)
    assert formatted.startswith("dt_live_")
    assert DEVICE_CREDENTIAL_SCHEME == "dt_live_"
    assert parse_device_credential_id(formatted) == cid


def test_parse_device_credential_rejects_wrong_prefix_and_bad_uuid():
    from app.services.device_credential import parse_device_credential_id

    with pytest.raises(ValueError):
        parse_device_credential_id("sk_live_abc")
    with pytest.raises(ValueError):
        parse_device_credential_id("dt_live_not-a-uuid")


def test_device_auth_transcript_is_deterministic_and_version_tagged_and_distinct_from_proof():
    """결정적 + 도메인분리. attestation용 `SP_DEVICE_PROOF_V1`와 **절대 겹치면 안 된다** —
    같은 키로 두 프로토콜에 서명해도 서로 검증되지 않아야 한다."""
    from app.services.device_credential import (
        DEVICE_AUTH_TRANSCRIPT_VERSION,
        build_device_auth_transcript,
    )
    from app.services.device_proof import TranscriptContext, build_canonical_transcript

    kwargs = dict(
        credential_id="c1", http_method="POST", route="/api/v2/x",
        timestamp=1000, server_seq=7, body_sha256=None,
    )
    a = build_device_auth_transcript(**kwargs)
    assert a == build_device_auth_transcript(**kwargs)
    assert DEVICE_AUTH_TRANSCRIPT_VERSION.encode() in a
    assert b"SP_DEVICE_PROOF_V1" not in a

    # 필드를 바꾸면 transcript가 달라진다(=그 필드가 서명에 묶인다).
    assert a != build_device_auth_transcript(**{**kwargs, "server_seq": 8})
    assert a != build_device_auth_transcript(**{**kwargs, "route": "/api/v2/y"})
    assert a != build_device_auth_transcript(**{**kwargs, "http_method": "GET"})
    assert a != build_device_auth_transcript(**{**kwargs, "body_sha256": "x"})

    # attestation transcript와도 바이트가 겹치지 않는다.
    proof = build_canonical_transcript(TranscriptContext(
        purpose="register", challenge_id="c1", raw_nonce="n", user_id="u", firebase_uid="f",
        project_id="p", tenant_id=None, environment="production", platform="ios", app_id="a",
        installation_id=None, key_version=None, http_method="POST", route="/api/v2/x",
        web_origin="https://x", body_sha256=None,
    ))
    assert a != proof


def test_verify_device_request_signature_rejects_mismatch_and_malformed_key():
    from app.services.device_credential import DeviceSignatureError, verify_device_request_signature

    priv, der = _keypair()
    other_priv, _ = _keypair()
    payload = b"hello"

    verify_device_request_signature(
        signed_bytes=payload,
        signature=base64.b64decode(_sign(priv, payload)),
        stored_public_key_der=der,
    )  # 정상 — 예외 없음

    with pytest.raises(DeviceSignatureError):
        verify_device_request_signature(
            signed_bytes=payload,
            signature=base64.b64decode(_sign(other_priv, payload)),
            stored_public_key_der=der,
        )
    with pytest.raises(DeviceSignatureError):
        verify_device_request_signature(
            signed_bytes=payload, signature=b"\x00\x01", stored_public_key_der=b"not-a-key",
        )


def test_timestamp_window():
    from app.services.device_credential import (
        DEVICE_REQUEST_MAX_SKEW_SECONDS,
        DeviceTimestampError,
        assert_timestamp_within_window,
    )

    now = datetime.now(timezone.utc)
    assert_timestamp_within_window(int(now.timestamp()), now=now)
    assert_timestamp_within_window(
        int((now - timedelta(seconds=DEVICE_REQUEST_MAX_SKEW_SECONDS - 1)).timestamp()), now=now
    )
    with pytest.raises(DeviceTimestampError):
        assert_timestamp_within_window(
            int((now - timedelta(seconds=DEVICE_REQUEST_MAX_SKEW_SECONDS + 5)).timestamp()), now=now
        )
    with pytest.raises(DeviceTimestampError):
        assert_timestamp_within_window(
            int((now + timedelta(seconds=DEVICE_REQUEST_MAX_SKEW_SECONDS + 5)).timestamp()), now=now
        )


# ─── 인증 해소 (auth._resolve_device_credential) ──────────────────────────────


async def test_valid_device_credential_resolves():
    """정상 자격증명 — AuthContext 형태·claim을 sk_live_ 경로와 동일 모양으로 낸다."""
    from app.dependencies.auth import _resolve_device_credential

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id, user_id, human_member_id = await _seed_org_project_human(s)
            agent_id = await _seed_agent(s, org_id, project_id, created_by_member_id=human_member_id)
            priv, der = _keypair()
            cred_id = await _seed_credential(
                s, org_id=org_id, human_member_id=human_member_id,
                agent_member_id=agent_id, public_key_der=der,
            )
        async with Session() as s:
            ts = _now_ts()
            proof = _proof(priv, credential_id=cred_id, method="POST", route="/api/v2/x",
                           timestamp=ts, seq=1)
            ctx = await _resolve_device_credential(
                f"dt_live_{cred_id}", s, method="POST", route="/api/v2/x", **proof,
            )
            # ⚠️caller 는 커밋하지 않는다 — CAS 는 자기 세션에서 이미 커밋됐다(초판은 여기서
            # `await s.commit()` 으로 테스트가 대신 커밋해줘 결함을 가렸다).
            from app.models.agent_device_credential import AgentDeviceCredential
            row = await s.get(AgentDeviceCredential, cred_id)
            assert row.last_server_seq == 1

        assert ctx.user_id == str(agent_id)
        assert ctx.email is None
        assert ctx.org_id == str(org_id)
        meta = ctx.claims["app_metadata"]
        assert meta["device_credential_id"] == str(cred_id)
        assert meta["actor_type"] == "agent"
        assert meta["org_id"] == str(org_id)
        assert meta["project_id"] == str(project_id)
        assert str(project_id) in meta["project_ids"]
        assert meta["scope"] == ["read", "write"]
        # ⛔api_key_id를 절대 싣지 않는다 — 그 필드는 "ApiKey로 해소된 요청" 판별자다.
        assert "api_key_id" not in meta
    finally:
        await engine.dispose()


async def test_resolved_device_credential_is_au_billable_agent():
    """AU 과금 판별 — `api_key_id`를 안 실으므로 위 판정만으로는 False로 떨어진다.
    `actor_type="agent"` 명시가 그걸 고치는지 실제 AuthContext로 확인."""
    from app.dependencies.auth import AuthContext, is_au_billable_agent

    ctx = AuthContext(
        user_id="u", email=None,
        claims={"app_metadata": {"device_credential_id": "c", "actor_type": "agent", "scope": ["read"]}},
        org_id="o",
    )
    assert is_au_billable_agent(ctx) is True
    # 휴먼 개인키 경로는 여전히 False(회귀 없음).
    human = AuthContext(
        user_id="u", email=None,
        claims={"app_metadata": {"human_api_key_id": "k", "actor_type": "human"}},
        org_id="o",
    )
    assert is_au_billable_agent(human) is False


async def test_signature_mismatch_rejected():
    from fastapi import HTTPException

    from app.dependencies.auth import _resolve_device_credential

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id, user_id, human_member_id = await _seed_org_project_human(s)
            agent_id = await _seed_agent(s, org_id, project_id, created_by_member_id=human_member_id)
            _priv, der = _keypair()
            cred_id = await _seed_credential(
                s, org_id=org_id, human_member_id=human_member_id,
                agent_member_id=agent_id, public_key_der=der,
            )
        async with Session() as s:
            attacker_priv, _ = _keypair()  # 저장된 공개키가 아닌 다른 키로 서명
            ts = _now_ts()
            proof = _proof(attacker_priv, credential_id=cred_id, method="POST",
                           route="/api/v2/x", timestamp=ts, seq=1)
            with pytest.raises(HTTPException) as exc:
                await _resolve_device_credential(
                    f"dt_live_{cred_id}", s, method="POST", route="/api/v2/x", **proof,
                )
            assert exc.value.status_code == 401
    finally:
        await engine.dispose()


async def test_unknown_credential_rejected():
    from fastapi import HTTPException

    from app.dependencies.auth import _resolve_device_credential

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            priv, _der = _keypair()
            unknown = uuid.uuid4()
            ts = _now_ts()
            proof = _proof(priv, credential_id=unknown, method="POST", route="/api/v2/x",
                           timestamp=ts, seq=1)
            with pytest.raises(HTTPException) as exc:
                await _resolve_device_credential(
                    f"dt_live_{unknown}", s, method="POST", route="/api/v2/x", **proof,
                )
            assert exc.value.status_code == 401
    finally:
        await engine.dispose()


async def test_revoked_credential_rejected():
    """status='revoked' 도 revoked_at IS NOT NULL 도 각각 거부(fail-closed — 둘 중 하나만
    세팅된 부분 상태도 통과시키지 않는다)."""
    from fastapi import HTTPException

    from app.dependencies.auth import _resolve_device_credential

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id, user_id, human_member_id = await _seed_org_project_human(s)
            agent_id = await _seed_agent(s, org_id, project_id, created_by_member_id=human_member_id)
            priv, der = _keypair()
            revoked_status = await _seed_credential(
                s, org_id=org_id, human_member_id=human_member_id, agent_member_id=agent_id,
                device_label="d1", public_key_der=der, status="revoked",
            )
            revoked_at_only = await _seed_credential(
                s, org_id=org_id, human_member_id=human_member_id, agent_member_id=agent_id,
                device_label="d2", public_key_der=der, status="active", revoked=True,
            )
        for cid in (revoked_status, revoked_at_only):
            async with Session() as s:
                ts = _now_ts()
                proof = _proof(priv, credential_id=cid, method="POST", route="/api/v2/x",
                               timestamp=ts, seq=1)
                with pytest.raises(HTTPException) as exc:
                    await _resolve_device_credential(
                        f"dt_live_{cid}", s, method="POST", route="/api/v2/x", **proof,
                    )
                assert exc.value.status_code == 401
    finally:
        await engine.dispose()


async def test_stale_and_replayed_seq_rejected():
    """리플레이 방어 — ①이미 쓴 seq 재사용 ②저장값보다 낮은 seq ③같은 seq 반복."""
    from fastapi import HTTPException

    from app.dependencies.auth import _resolve_device_credential

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id, user_id, human_member_id = await _seed_org_project_human(s)
            agent_id = await _seed_agent(s, org_id, project_id, created_by_member_id=human_member_id)
            priv, der = _keypair()
            cred_id = await _seed_credential(
                s, org_id=org_id, human_member_id=human_member_id, agent_member_id=agent_id,
                public_key_der=der, last_server_seq=5,
            )
        ts = _now_ts()
        for stale_seq in (5, 4, 1):
            async with Session() as s:
                proof = _proof(priv, credential_id=cred_id, method="POST", route="/api/v2/x",
                               timestamp=ts, seq=stale_seq)
                with pytest.raises(HTTPException) as exc:
                    await _resolve_device_credential(
                        f"dt_live_{cred_id}", s, method="POST", route="/api/v2/x", **proof,
                    )
                assert exc.value.status_code == 401

        # 더 큰 seq는 통과하고, 그 뒤 같은 seq를 다시 쓰면 거부(재사용).
        async with Session() as s:
            proof = _proof(priv, credential_id=cred_id, method="POST", route="/api/v2/x",
                           timestamp=ts, seq=6)
            await _resolve_device_credential(
                f"dt_live_{cred_id}", s, method="POST", route="/api/v2/x", **proof,
            )
            await s.commit()
        async with Session() as s:
            with pytest.raises(HTTPException) as exc:
                await _resolve_device_credential(
                    f"dt_live_{cred_id}", s, method="POST", route="/api/v2/x", **proof,
                )
            assert exc.value.status_code == 401
    finally:
        await engine.dispose()


async def test_seq_cas_commits_even_when_caller_never_commits():
    """⛔회귀 가드 — CAS 는 **caller 가 커밋하지 않아도** DB 에 남아야 한다.

    초판은 CAS 를 caller 세션(`get_current_user` 의 커밋 없는 ``async with``)에서 돌려
    세션 종료 시 롤백됐다(`Session.close()` = "ends any transaction in progress").
    그 결과 ``last_server_seq`` 가 영구 NULL → ``IS NULL`` 분기가 항상 매칭 →
    캡처한 서명 1개가 창(300초) 동안 무제한 재사용 가능했다(리플레이 방어 = 0).

    이 테스트는 **의도적으로 caller 세션을 커밋하지 않고** 닫은 뒤, 별도 세션에서
    카운터가 남아 있는지 본다. 초판이면 None 이라 실패한다.
    """
    from app.dependencies.auth import _resolve_device_credential

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id, user_id, human_member_id = await _seed_org_project_human(s)
            agent_id = await _seed_agent(s, org_id, project_id, created_by_member_id=human_member_id)
            priv, der = _keypair()
            cred_id = await _seed_credential(
                s, org_id=org_id, human_member_id=human_member_id, agent_member_id=agent_id,
                public_key_der=der,
            )
        async with Session() as s:
            ts = _now_ts()
            proof = _proof(priv, credential_id=cred_id, method="POST", route="/api/v2/x",
                           timestamp=ts, seq=1)
            await _resolve_device_credential(
                f"dt_live_{cred_id}", s, method="POST", route="/api/v2/x", **proof,
            )
            # ⚠️여기서 커밋하지 않는다 — 그래도 CAS 는 자기 세션에서 이미 커밋됐어야 한다.
        async with Session() as s:
            from app.models.agent_device_credential import AgentDeviceCredential
            row = await s.get(AgentDeviceCredential, cred_id)
            assert row.last_server_seq == 1, (
                "CAS 가 caller 롤백에 휩쓸렸다 — 리플레이 방어 무력(초판 결함 재발)"
            )
    finally:
        await engine.dispose()


async def test_replayed_request_rejected_after_caller_never_committed():
    """⛔회귀 가드 — 같은 (자격증명, seq) 서명을 두 번 쓰면 두 번째는 거부돼야 한다.

    위 테스트가 "카운터가 남는가"를 보고, 이건 **실제 리플레이가 막히는가**를 본다 —
    방어의 목적 그 자체다. caller 가 커밋하지 않는 실 요청 경로를 그대로 흉내낸다.
    """
    from fastapi import HTTPException

    from app.dependencies.auth import _resolve_device_credential

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id, user_id, human_member_id = await _seed_org_project_human(s)
            agent_id = await _seed_agent(s, org_id, project_id, created_by_member_id=human_member_id)
            priv, der = _keypair()
            cred_id = await _seed_credential(
                s, org_id=org_id, human_member_id=human_member_id, agent_member_id=agent_id,
                public_key_der=der,
            )
        ts = _now_ts()
        proof = _proof(priv, credential_id=cred_id, method="POST", route="/api/v2/x",
                       timestamp=ts, seq=1)

        # 1회차 — 성공 (caller 는 커밋하지 않는다: 실 요청 경로와 동형)
        async with Session() as s:
            await _resolve_device_credential(
                f"dt_live_{cred_id}", s, method="POST", route="/api/v2/x", **proof,
            )

        # 2회차 — **같은 서명 재사용** → 창 안이어도 거부돼야 한다
        with pytest.raises(HTTPException) as exc:
            async with Session() as s:
                await _resolve_device_credential(
                    f"dt_live_{cred_id}", s, method="POST", route="/api/v2/x", **proof,
                )
        assert exc.value.status_code == 401
    finally:
        await engine.dispose()


async def test_timestamp_outside_window_rejected():
    from fastapi import HTTPException

    from app.dependencies.auth import _resolve_device_credential
    from app.services.device_credential import DEVICE_REQUEST_MAX_SKEW_SECONDS

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id, user_id, human_member_id = await _seed_org_project_human(s)
            agent_id = await _seed_agent(s, org_id, project_id, created_by_member_id=human_member_id)
            priv, der = _keypair()
            cred_id = await _seed_credential(
                s, org_id=org_id, human_member_id=human_member_id, agent_member_id=agent_id,
                public_key_der=der, last_server_seq=100,
            )
        async with Session() as s:
            old_ts = _now_ts() - (DEVICE_REQUEST_MAX_SKEW_SECONDS + 60)
            proof = _proof(priv, credential_id=cred_id, method="POST", route="/api/v2/x",
                           timestamp=old_ts, seq=101)
            with pytest.raises(HTTPException) as exc:
                await _resolve_device_credential(
                    f"dt_live_{cred_id}", s, method="POST", route="/api/v2/x", **proof,
                )
            assert exc.value.status_code == 401
    finally:
        await engine.dispose()


async def test_missing_proof_rejected():
    """서명 증거가 없으면 "무증명 통과" 금지 — 401."""
    from fastapi import HTTPException

    from app.dependencies.auth import _resolve_device_credential

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id, user_id, human_member_id = await _seed_org_project_human(s)
            agent_id = await _seed_agent(s, org_id, project_id, created_by_member_id=human_member_id)
            _priv, der = _keypair()
            cred_id = await _seed_credential(
                s, org_id=org_id, human_member_id=human_member_id, agent_member_id=agent_id,
                public_key_der=der,
            )
        async with Session() as s:
            with pytest.raises(HTTPException) as exc:
                await _resolve_device_credential(
                    f"dt_live_{cred_id}", s, method="POST", route="/api/v2/x",
                    timestamp=None, server_seq=None, signature_b64=None, body_sha256=None,
                )
            assert exc.value.status_code == 401
    finally:
        await engine.dispose()


async def test_body_sha256_is_bound_into_the_signature():
    """transcript가 본문 해시를 묶으므로, 서명 후 body_sha256을 바꿔 보내면 거부된다."""
    from fastapi import HTTPException

    from app.dependencies.auth import _resolve_device_credential

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id, user_id, human_member_id = await _seed_org_project_human(s)
            agent_id = await _seed_agent(s, org_id, project_id, created_by_member_id=human_member_id)
            priv, der = _keypair()
            cred_id = await _seed_credential(
                s, org_id=org_id, human_member_id=human_member_id, agent_member_id=agent_id,
                public_key_der=der, last_server_seq=10,
            )
        body_hash = hashlib.sha256(b"real body").hexdigest()
        ts = _now_ts()
        proof = _proof(priv, credential_id=cred_id, method="POST", route="/api/v2/x",
                       timestamp=ts, seq=11, body_sha256=body_hash)
        async with Session() as s:
            tampered = {**proof, "body_sha256": hashlib.sha256(b"other body").hexdigest()}
            with pytest.raises(HTTPException) as exc:
                await _resolve_device_credential(
                    f"dt_live_{cred_id}", s, method="POST", route="/api/v2/x", **tampered,
                )
            assert exc.value.status_code == 401
    finally:
        await engine.dispose()


async def test_route_and_method_are_bound_into_the_signature():
    """A 경로용 서명을 B 경로에 재사용(교차 사용)하면 거부 — route/method가 transcript에 있다."""
    from fastapi import HTTPException

    from app.dependencies.auth import _resolve_device_credential

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id, user_id, human_member_id = await _seed_org_project_human(s)
            agent_id = await _seed_agent(s, org_id, project_id, created_by_member_id=human_member_id)
            priv, der = _keypair()
            cred_id = await _seed_credential(
                s, org_id=org_id, human_member_id=human_member_id, agent_member_id=agent_id,
                public_key_der=der, last_server_seq=20,
            )
        ts = _now_ts()
        proof = _proof(priv, credential_id=cred_id, method="POST", route="/api/v2/x",
                       timestamp=ts, seq=21)
        async with Session() as s:
            with pytest.raises(HTTPException) as exc:
                await _resolve_device_credential(
                    f"dt_live_{cred_id}", s, method="GET", route="/api/v2/x", **proof,
                )
            assert exc.value.status_code == 401
        async with Session() as s2:
            with pytest.raises(HTTPException) as exc:
                await _resolve_device_credential(
                    f"dt_live_{cred_id}", s2, method="POST", route="/api/v2/other", **proof,
                )
            assert exc.value.status_code == 401
    finally:
        await engine.dispose()


async def test_device_credential_member_not_found_rejected():
    """자격증명은 있으나 agent member가 비활성/삭제 → 401(fail-closed)."""
    from fastapi import HTTPException

    from app.dependencies.auth import _resolve_device_credential

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id, user_id, human_member_id = await _seed_org_project_human(s)
            agent_id = await _seed_agent(s, org_id, project_id, created_by_member_id=human_member_id)
            priv, der = _keypair()
            cred_id = await _seed_credential(
                s, org_id=org_id, human_member_id=human_member_id, agent_member_id=agent_id,
                public_key_der=der,
            )
            from app.models.member import Member
            await s.execute(Member.__table__.update().where(Member.id == agent_id).values(is_active=False))
            await s.commit()
        async with Session() as s2:
            ts = _now_ts()
            proof = _proof(priv, credential_id=cred_id, method="POST", route="/api/v2/x",
                           timestamp=ts, seq=1)
            with pytest.raises(HTTPException) as exc:
                await _resolve_device_credential(
                    f"dt_live_{cred_id}", s2, method="POST", route="/api/v2/x", **proof,
                )
            assert exc.value.status_code == 401
    finally:
        await engine.dispose()


# ─── 라우터 — 등록 / 폐기 / 본인 소유 경계 ────────────────────────────────────


class _FakeRequest:
    base_url = "http://testserver/"
    method = "POST"
    url = type("U", (), {"path": "/api/v2/device-credentials"})()
    headers: dict = {}


def _auth_for(user_id, org_id) -> "object":
    from app.dependencies.auth import AuthContext

    return AuthContext(
        user_id=str(user_id),
        email=None,
        claims={"sub": str(user_id), "app_metadata": {"org_id": str(org_id), "actor_type": "human"}},
        org_id=str(org_id),
    )


async def test_register_issues_credential_and_next_seq():
    from app.routers.device_credentials import RegisterDeviceRequest, register_device_credential

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id, user_id, human_member_id = await _seed_org_project_human(s)
            agent_id = await _seed_agent(s, org_id, project_id, created_by_member_id=human_member_id)
        priv, der = _keypair()
        async with Session() as s:
            out = await register_device_credential(
                _FakeRequest(),
                RegisterDeviceRequest(
                    device_label="macbook-pro", public_key_der_b64=base64.b64encode(der).decode(),
                ),
                auth=_auth_for(user_id, org_id), session=s,
            )
        assert out.device_credential.startswith("dt_live_")
        assert out.next_server_seq == 1
        assert out.status == "active"
        assert out.member_id == human_member_id
        assert out.agent_member_id == agent_id
        assert out.key_fingerprint == hashlib.sha256(der).hexdigest()

        # 발급된 자격증명이 실제로 인증에 쓰인다(등록→인증 왕복).
        from app.dependencies.auth import _resolve_device_credential

        ts = _now_ts()
        proof = _proof(priv, credential_id=out.id, method="POST", route="/api/v2/x",
                       timestamp=ts, seq=out.next_server_seq)
        async with Session() as s2:
            ctx = await _resolve_device_credential(
                out.device_credential, s2, method="POST", route="/api/v2/x", **proof,
            )
            await s2.commit()
        assert ctx.user_id == str(agent_id)
        assert ctx.claims["app_metadata"]["device_credential_id"] == str(out.id)
    finally:
        await engine.dispose()


async def test_register_rejects_duplicate_label_and_bad_key():
    from fastapi import HTTPException

    from app.routers.device_credentials import RegisterDeviceRequest, register_device_credential

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id, user_id, human_member_id = await _seed_org_project_human(s)
            await _seed_agent(s, org_id, project_id, created_by_member_id=human_member_id)
        _priv, der = _keypair()
        body = RegisterDeviceRequest(
            device_label="dup", public_key_der_b64=base64.b64encode(der).decode(),
        )
        async with Session() as s:
            await register_device_credential(_FakeRequest(), body, auth=_auth_for(user_id, org_id), session=s)
        with pytest.raises(HTTPException) as exc:
            async with Session() as s:
                await register_device_credential(_FakeRequest(), body, auth=_auth_for(user_id, org_id), session=s)
        assert exc.value.status_code == 409
        async with Session() as s:
            with pytest.raises(HTTPException) as exc:
                await register_device_credential(
                    _FakeRequest(),
                    RegisterDeviceRequest(device_label="bad-key", public_key_der_b64="not-base64!!"),
                    auth=_auth_for(user_id, org_id), session=s,
                )
            assert exc.value.status_code == 400
        async with Session() as s:
            with pytest.raises(HTTPException) as exc:
                await register_device_credential(
                    _FakeRequest(),
                    RegisterDeviceRequest(
                        device_label="rsa", public_key_der_b64=base64.b64encode(b"\x00\x01\x02").decode(),
                    ),
                    auth=_auth_for(user_id, org_id), session=s,
                )
            assert exc.value.status_code == 400
    finally:
        await engine.dispose()


async def test_register_rejects_non_human_auth():
    """⛔에이전트 자격증명(`sk_live_`/`dt_live_`)과 **휴먼 개인키(`hu_live_`)** 는 이
    라우터를 못 연다(fail-closed) — 기기 등록은 **휴먼 JWT 세션** 셀프서브이고, 자격증명이
    스스로 새 기기를 발급하면 blast radius 축이 무너진다.

    ⚠️`hu_live_*` 케이스가 회귀 가드다 — 초판 가드는 `api_key_id`/`device_credential_id`/
    `actor_type != 'human'` 만 봤는데, 휴먼 개인키는 `human_api_key_id` +
    `actor_type: "human"` 을 실어 **셋 다 통과**했다. 그러면 폐기된 개인키의 소유자가
    계속 새 기기를 발급할 수 있다(개인키를 폐기해도 기기는 살아남는다).
    """
    from fastapi import HTTPException

    from app.dependencies.auth import AuthContext
    from app.routers.device_credentials import RegisterDeviceRequest, register_device_credential

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id, user_id, human_member_id = await _seed_org_project_human(s)
            await _seed_agent(s, org_id, project_id, created_by_member_id=human_member_id)
        _priv, der = _keypair()
        body = RegisterDeviceRequest(
            device_label="sneaky", public_key_der_b64=base64.b64encode(der).decode(),
        )
        for meta in (
            {"org_id": str(org_id), "api_key_id": "k", "actor_type": "agent"},
            {"org_id": str(org_id), "device_credential_id": "c", "actor_type": "agent"},
            # ⭐hu_live_* 실측 형태(auth.py `_resolve_human_api_key`) — actor_type 은 "human"
            # 이지만 개인키다. 초판 가드는 이걸 통과시켰다.
            {"org_id": str(org_id), "human_api_key_id": "hk", "actor_type": "human"},
        ):
            agent_auth = AuthContext(
                user_id=str(human_member_id), email=None,
                claims={"sub": str(human_member_id), "app_metadata": meta}, org_id=str(org_id),
            )
            async with Session() as s:
                with pytest.raises(HTTPException) as exc:
                    await register_device_credential(_FakeRequest(), body, auth=agent_auth, session=s)
                assert exc.value.status_code == 403
    finally:
        await engine.dispose()


async def test_caller_cannot_revoke_another_members_device():
    """⭐소유 경계 — 타인이 남의 기기를 폐기하면 404(존재 여부 누설 없음), 실제로 폐기되지 않는다."""
    from fastapi import HTTPException
    from sqlalchemy import select

    from app.models.agent_device_credential import AgentDeviceCredential
    from app.routers.device_credentials import (
        RegisterDeviceRequest,
        register_device_credential,
        revoke_device_credential,
    )

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_a, project_a, user_a, member_a = await _seed_org_project_human(s)
            org_b, project_b, user_b, member_b = await _seed_org_project_human(s)
            await _seed_agent(s, org_a, project_a, created_by_member_id=member_a)
            agent_b = await _seed_agent(s, org_b, project_b, created_by_member_id=member_b)
        _priv, der = _keypair()

        # A가 자기 기기를 등록.
        async with Session() as s:
            owned = await register_device_credential(
                _FakeRequest(),
                RegisterDeviceRequest(device_label="a-laptop", public_key_der_b64=base64.b64encode(der).decode()),
                auth=_auth_for(user_a, org_a), session=s,
            )
        # B가 A의 기기를 등록하려 하면 자기 에이전트로만 묶이고 A의 기기는 못 만진다.
        # B가 A의 credential_id로 폐기를 시도 → 404, 그리고 A의 기기는 그대로 active.
        async with Session() as s:
            with pytest.raises(HTTPException) as exc:
                await revoke_device_credential(owned.id, auth=_auth_for(user_b, org_b), session=s)
            assert exc.value.status_code == 404
        async with Session() as s:
            row = (await s.execute(
                select(AgentDeviceCredential).where(AgentDeviceCredential.id == owned.id)
            )).scalar_one()
            assert row.status == "active" and row.revoked_at is None

        # B가 A의 agent_id를 자기 기기에 묶으려 해도 404(소유 아님).
        async with Session() as s:
            a_agent = (await s.execute(
                select(AgentDeviceCredential.agent_member_id).where(AgentDeviceCredential.id == owned.id)
            )).scalar_one()
        async with Session() as s:
            with pytest.raises(HTTPException) as exc:
                await register_device_credential(
                    _FakeRequest(),
                    RegisterDeviceRequest(
                        device_label="b-laptop", public_key_der_b64=base64.b64encode(der).decode(),
                        agent_id=a_agent,
                    ),
                    auth=_auth_for(user_b, org_b), session=s,
                )
            assert exc.value.status_code == 404

        # 본인 것은 폐기된다 → 404가 아니라 200, 그리고 status='revoked'.
        async with Session() as s:
            out = await revoke_device_credential(owned.id, auth=_auth_for(user_a, org_a), session=s)
            assert out == {"ok": True}
        async with Session() as s:
            row = (await s.execute(
                select(AgentDeviceCredential).where(AgentDeviceCredential.id == owned.id)
            )).scalar_one()
            assert row.status == "revoked" and row.revoked_at is not None
    finally:
        await engine.dispose()


async def test_revoked_device_cannot_authenticate():
    """폐기의 실효성 — 폐기한 뒤 그 자격증명으로 인증하면 401(폐기 1대 = 그 기기만 끊김)."""
    from fastapi import HTTPException
    from sqlalchemy import select

    from app.dependencies.auth import _resolve_device_credential
    from app.models.agent_device_credential import AgentDeviceCredential
    from app.routers.device_credentials import (
        RegisterDeviceRequest,
        register_device_credential,
        revoke_device_credential,
    )

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id, user_id, human_member_id = await _seed_org_project_human(s)
            await _seed_agent(s, org_id, project_id, created_by_member_id=human_member_id)
        priv, der = _keypair()
        async with Session() as s:
            created = await register_device_credential(
                _FakeRequest(),
                RegisterDeviceRequest(device_label="doomed", public_key_der_b64=base64.b64encode(der).decode()),
                auth=_auth_for(user_id, org_id), session=s,
            )
        # 폐기 전에는 인증된다.
        ts = _now_ts()
        proof = _proof(priv, credential_id=created.id, method="POST", route="/api/v2/x",
                       timestamp=ts, seq=created.next_server_seq)
        async with Session() as s:
            await _resolve_device_credential(
                created.device_credential, s, method="POST", route="/api/v2/x", **proof,
            )
            await s.commit()
        # 다른 기기는 이 폐기의 영향을 받지 않는다(별도 자격증명).
        other_priv, other_der = _keypair()
        async with Session() as s:
            other = await register_device_credential(
                _FakeRequest(),
                RegisterDeviceRequest(device_label="survivor", public_key_der_b64=base64.b64encode(other_der).decode()),
                auth=_auth_for(user_id, org_id), session=s,
            )

        async with Session() as s:
            await revoke_device_credential(created.id, auth=_auth_for(user_id, org_id), session=s)

        async with Session() as s:
            next_proof = _proof(priv, credential_id=created.id, method="POST", route="/api/v2/x",
                                timestamp=_now_ts(), seq=created.next_server_seq + 1)
            with pytest.raises(HTTPException) as exc:
                await _resolve_device_credential(
                    created.device_credential, s, method="POST", route="/api/v2/x", **next_proof,
                )
            assert exc.value.status_code == 401
        async with Session() as s:
            ok_proof = _proof(other_priv, credential_id=other.id, method="POST", route="/api/v2/x",
                              timestamp=_now_ts(), seq=other.next_server_seq)
            ctx = await _resolve_device_credential(
                other.device_credential, s, method="POST", route="/api/v2/x", **ok_proof,
            )
            await s.commit()
        assert ctx.claims["app_metadata"]["device_credential_id"] == str(other.id)
    finally:
        await engine.dispose()


async def test_list_only_returns_own_devices():
    from app.routers.device_credentials import (
        RegisterDeviceRequest,
        list_device_credentials,
        register_device_credential,
    )

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_a, project_a, user_a, member_a = await _seed_org_project_human(s)
            org_b, project_b, user_b, member_b = await _seed_org_project_human(s)
            await _seed_agent(s, org_a, project_a, created_by_member_id=member_a)
            await _seed_agent(s, org_b, project_b, created_by_member_id=member_b)
        _priv_a, der_a = _keypair()
        _priv_b, der_b = _keypair()
        async with Session() as s:
            await register_device_credential(
                _FakeRequest(),
                RegisterDeviceRequest(device_label="only-a", public_key_der_b64=base64.b64encode(der_a).decode()),
                auth=_auth_for(user_a, org_a), session=s,
            )
        async with Session() as s:
            await register_device_credential(
                _FakeRequest(),
                RegisterDeviceRequest(device_label="only-b", public_key_der_b64=base64.b64encode(der_b).decode()),
                auth=_auth_for(user_b, org_b), session=s,
            )
        async with Session() as s:
            rows = await list_device_credentials(auth=_auth_for(user_a, org_a), session=s)
        assert [r.device_label for r in rows] == ["only-a"]
        assert all(r.member_id == member_a for r in rows)
    finally:
        await engine.dispose()


async def test_device_cap_is_abuse_guard_not_product_limit():
    """상한(50)은 flood guard다 — active 기준으로 세고, 폐기하면 자리를 반환한다."""
    from fastapi import HTTPException
    from sqlalchemy import select

    from app.models.agent_device_credential import AgentDeviceCredential
    from app.routers.device_credentials import (
        MAX_DEVICES_PER_MEMBER,
        RegisterDeviceRequest,
        register_device_credential,
    )

    assert MAX_DEVICES_PER_MEMBER == 50

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id, user_id, human_member_id = await _seed_org_project_human(s)
            agent_id = await _seed_agent(s, org_id, project_id, created_by_member_id=human_member_id)
        _priv, der = _keypair()
        key_b64 = base64.b64encode(der).decode()

        # 상한까지는 등록된다(49개를 직접 심고 50번째를 라우터로).
        async with Session() as s:
            for i in range(MAX_DEVICES_PER_MEMBER - 1):
                s.add(AgentDeviceCredential(
                    member_id=human_member_id, agent_member_id=agent_id,
                    device_label=f"seed-{i}", public_key_der=der,
                    key_fingerprint=hashlib.sha256(der).hexdigest(), status="active",
                ))
            await s.commit()
        async with Session() as s:
            last = await register_device_credential(
                _FakeRequest(),
                RegisterDeviceRequest(device_label="the-50th", public_key_der_b64=key_b64),
                auth=_auth_for(user_id, org_id), session=s,
            )
        assert last.device_label == "the-50th"

        # 51번째는 거부(429).
        async with Session() as s:
            with pytest.raises(HTTPException) as exc:
                await register_device_credential(
                    _FakeRequest(),
                    RegisterDeviceRequest(device_label="the-51st", public_key_der_b64=key_b64),
                    auth=_auth_for(user_id, org_id), session=s,
                )
            assert exc.value.status_code == 429

        # 폐기하면 자리가 반환된다(제품 한도가 아니라는 사실의 실증).
        async with Session() as s:
            victim = (await s.execute(
                select(AgentDeviceCredential.id).where(
                    AgentDeviceCredential.member_id == human_member_id,
                    AgentDeviceCredential.device_label == "seed-0",
                )
            )).scalar_one()
        async with Session() as s:
            from app.routers.device_credentials import revoke_device_credential
            await revoke_device_credential(victim, auth=_auth_for(user_id, org_id), session=s)
        async with Session() as s:
            retried = await register_device_credential(
                _FakeRequest(),
                RegisterDeviceRequest(device_label="after-revoke", public_key_der_b64=key_b64),
                auth=_auth_for(user_id, org_id), session=s,
            )
        assert retried.status == "active"
    finally:
        await engine.dispose()


# ─── get_current_user 디스패치 배선 ───────────────────────────────────────────


async def test_get_current_user_dispatches_dt_live_prefix():
    """디스패치 배선만 — `dt_live_` 접두사가 새 resolver로 가는가. 실제 DB 왕복은 위에서
    이미 검증했고, 여기선 라우팅만 잰다(`test_1940_human_api_keys.py` 관례와 동형 —
    get_current_user가 쓰는 모듈 전역 async_session_factory는 테스트별 격리 이벤트루프와
    안 맞아 mock으로 배선만 잰다)."""
    from unittest.mock import AsyncMock, patch

    from fastapi.security import HTTPAuthorizationCredentials

    from app.dependencies import auth
    from app.dependencies.auth import AuthContext, get_current_user

    fake_ctx = AuthContext(
        user_id="a1", email=None,
        claims={"app_metadata": {"device_credential_id": "c1", "actor_type": "agent"}},
        org_id="o1",
    )
    creds = HTTPAuthorizationCredentials(scheme="Bearer", credentials="dt_live_deadbeef")
    with patch.object(auth, "_resolve_device_credential", new=AsyncMock(return_value=fake_ctx)) as mock_resolve:
        ctx = await get_current_user(credentials=creds, x_agent_api_key=None, x_mcp_transport=None)
    mock_resolve.assert_awaited_once()
    assert mock_resolve.await_args.args[0] == "dt_live_deadbeef"
    assert ctx is fake_ctx


async def test_existing_sk_live_branch_untouched():
    """회귀 가드 — `sk_live_` 는 여전히 `_resolve_api_key` 로 간다(`dt_live_` 분기가
    그 경로를 가로채지 않는다)."""
    from unittest.mock import AsyncMock, patch

    from fastapi.security import HTTPAuthorizationCredentials

    from app.dependencies import auth
    from app.dependencies.auth import AuthContext, get_current_user

    fake_ctx = AuthContext(user_id="a1", email=None, claims={"app_metadata": {}}, org_id=None)
    creds = HTTPAuthorizationCredentials(scheme="Bearer", credentials="sk_live_deadbeef")
    with patch.object(auth, "_resolve_api_key", new=AsyncMock(return_value=fake_ctx)) as mock_api_key, \
         patch.object(auth, "_resolve_device_credential", new=AsyncMock()) as mock_device:
        ctx = await get_current_user(credentials=creds, x_agent_api_key=None, x_mcp_transport=None)
    mock_api_key.assert_awaited_once()
    mock_device.assert_not_awaited()
    assert ctx is fake_ctx


def _device_agent_ctx(user_id, org_id):
    """`_resolve_device_credential` 이 내는 claim 형태 그대로(`api_key_id` 없음)."""
    from app.dependencies.auth import AuthContext

    return AuthContext(
        user_id=str(user_id), email=None,
        claims={"sub": str(user_id), "app_metadata": {
            "device_credential_id": "d", "actor_type": "agent", "org_id": str(org_id),
            "project_id": None, "project_ids": [], "scope": ["read", "write"],
        }},
        org_id=str(org_id),
    )


def test_device_credential_is_agent_credential_but_human_key_is_not():
    """⛔판별 축 — `api_key_id` 만 보면 `dt_live_` 가 에이전트로 인식되지 않는다.

    실사고 회귀 가드: `agent_gateway.py` 가 `bool(api_key_id)` 로 403 을 냈고, `dt_live_`
    는 그 필드를 일부러 안 실어(§5.2.1) **인증은 통과하는데 스트림이 안 열렸다** —
    기기 자격증명의 존재 이유인 경로가 막힌 상태였다.
    """
    from app.dependencies.auth import AuthContext, is_agent_credential

    org = str(uuid.uuid4())
    dev = _device_agent_ctx(uuid.uuid4(), org)
    # 기기 자격증명 = 에이전트 (스트림·ACK 를 열 수 있어야 한다)
    assert is_agent_credential(dev) is True, "dt_live_ 가 에이전트로 인식되지 않는다 — 스트림 403 재발"

    # sk_live_ = 에이전트 (기존 경로 무회귀)
    sk = AuthContext(user_id=str(uuid.uuid4()), email=None,
                     claims={"sub": "x", "app_metadata": {"org_id": org, "api_key_id": "k"}}, org_id=org)
    assert is_agent_credential(sk) is True

    # hu_live_ = 사람 — 에이전트가 아니다(actor_type 이 human 이라 api_key_id 유무와 무관)
    hu = AuthContext(user_id=str(uuid.uuid4()), email=None,
                     claims={"sub": "x", "app_metadata": {
                         "org_id": org, "human_api_key_id": "hk", "actor_type": "human"}}, org_id=org)
    assert is_agent_credential(hu) is False, "휴먼 개인키가 에이전트로 오분류된다"

    # JWT(휴먼 세션) = 에이전트 아님
    jwt = AuthContext(user_id=str(uuid.uuid4()), email="a@b.c",
                      claims={"sub": "x", "app_metadata": {"org_id": org, "actor_type": "human"}}, org_id=org)
    assert is_agent_credential(jwt) is False


def test_stream_and_ack_guards_admit_device_credential():
    """⛔실제 목적 경로 — 스트림/ACK 가드가 기기 자격증명을 **막지 않는지** 소스로 고정한다.

    엔드포인트를 실제로 열려면 SSE·DB 왕복이 필요해 별도 하네스가 요구되므로, 여기선
    가드가 `api_key_id` truthiness 로 되돌아가지 않았음을 소스 수준에서 지킨다(회귀 가드).
    """
    import inspect

    from app.routers import agent_gateway as mod

    src = inspect.getsource(mod)
    assert "is_agent_credential(auth)" in src, "agent_gateway 가 공유 판별자를 안 쓴다"
    # 직접 truthiness 판정이 남아 있으면 dt_live_ 를 다시 막는다.
    assert 'get("api_key_id"))' not in src or "is_agent_credential" in src
    for bad in (
        'is_api_key = bool(auth.claims.get("app_metadata", {}).get("api_key_id"))',
    ):
        assert bad not in src, f"api_key_id 직접 판정 잔존 — dt_live_ 403 재발: {bad}"


def test_device_credential_does_not_bypass_write_scope_gate():
    """⛔권한 회귀 가드 — 기기 자격증명이 `enforce_write_scope` 를 우회하면 안 된다.

    `enforce_write_scope` 는 `agent_routing_rules`/`hitl`(admin-adjacent, toolgroup 무대응)
    전용 게이트다. 초판은 `api_key_id` truthiness 로 판정해 `dt_live_` 가 **스킵**됐고,
    그러면 read-only 기기가 그 표면들을 write 검사 없이 통과한다 —
    story d764522c 가 막으려던 우회와 동형이다.
    """
    import inspect

    from app.dependencies import project_scope as ps

    src = inspect.getsource(ps)
    assert "is_agent_credential(auth)" in src, "enforce_write_scope 가 공유 판별자를 안 쓴다"
    assert 'if not auth.claims.get("app_metadata", {}).get("api_key_id"):' not in src, (
        "api_key_id 직접 판정 잔존 — dt_live_ 가 write-scope 게이트를 우회한다"
    )


def test_scope_gates_skip_human_but_not_device_credential():
    """게이트가 «휴먼은 스킵, 자격증명은 검사» 경계를 지키는지 — 양방향."""
    import uuid as _uuid

    from app.dependencies.auth import AuthContext, is_agent_credential

    org = str(_uuid.uuid4())

    def ctx(meta):
        return AuthContext(user_id=str(_uuid.uuid4()), email=None,
                           claims={"sub": "x", "app_metadata": {**meta, "org_id": org}}, org_id=org)

    # 기기 자격증명 = 검사 대상(스킵되면 안 된다)
    assert is_agent_credential(ctx({"device_credential_id": "d", "actor_type": "agent"})) is True
    # 휴먼 JWT = 스킵 대상
    assert is_agent_credential(ctx({"actor_type": "human"})) is False
    # 휴먼 개인키 = 스킵 대상
    assert is_agent_credential(ctx({"human_api_key_id": "hk", "actor_type": "human"})) is False


def test_register_rejects_non_p256_curve():
    """⛔곡선 화이트리스트 — 검증 측이 `ec.ECDSA(SHA256)` 로 고정이라 다른 곡선을 등록하면
    그 기기가 **영구히 인증 불가**가 된다(매 요청 서명 검증 실패). 등록 시점에 거부해야 한다.

    모바일 경로(`apple_app_attest` 의 `leaf_key_not_p256`)와 동일 축 — P-256 전용.
    """
    from fastapi import HTTPException

    from app.routers.device_credentials import _decode_public_key

    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    # P-256 → 수용
    ok = ec.generate_private_key(ec.SECP256R1()).public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    assert _decode_public_key(base64.b64encode(ok).decode()) == ok

    # P-384 / P-521 → 거부 (검증 불가한 키를 등록시키지 않는다)
    for curve in (ec.SECP384R1(), ec.SECP521R1()):
        der = ec.generate_private_key(curve).public_key().public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        with pytest.raises(HTTPException) as exc:
            _decode_public_key(base64.b64encode(der).decode())
        assert exc.value.status_code == 400


# ─────────────────────────────────────────────────────────────────────────────
# G10 — `api_key_id` truthiness 소비처 전수 정합 (2026-09-16)
# ─────────────────────────────────────────────────────────────────────────────
#
# 왜 «파일 전역 소스 스캔»인가: 이 결함은 개별 사이트의 버그가 아니라 **축(axis)의
# 불일치**다. `dt_live_` 는 `api_key_id` 를 일부러 안 싣고(§5.2.1) `actor_type="agent"`
# 를 싣는데, truthiness 소비처는 그 필드 하나로 "ApiKey 로 해소된 요청"을 판정해 왔다.
# 그래서 하나를 고쳐도 다음 소비처가 같은 방식으로 새로 생기면 재발한다 — 사이트별
# 단위 테스트로는 그 재발을 못 막는다. 저장소 전역을 훑어 **잔존 0** 을 고정한다.

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_SCAN_ROOTS = ("backend/app",)
# 판정에 쓰이는 truthiness 형태만 잡는다(값 비교 `== "system-publisher"` 는 정당한 사용).
_TRUTHINESS_PATTERNS = (
    'bool(auth.claims.get("app_metadata", {}).get("api_key_id"))',
    'bool(meta.get("api_key_id"))',
    'if meta.get("api_key_id"):',
    'if not meta.get("api_key_id"):',
)


def _iter_py_files():
    for root in _SCAN_ROOTS:
        for dirpath, _dirnames, filenames in os.walk(os.path.join(_REPO_ROOT, root)):
            if "__pycache__" in dirpath:
                continue
            for name in filenames:
                if name.endswith(".py"):
                    yield os.path.join(dirpath, name)


def test_no_api_key_id_truthiness_left_in_agent_axis():
    """⛔축 정합 회귀 가드 — `api_key_id` truthiness 로 «에이전트인가»를 판정하는 곳 0.

    실사고 3건이 전부 이 축에서 나왔다(모두 이 슬라이스에서 수정):
      · `agent_gateway.py`  — SSE 스트림·ACK 가 403 → **목적 경로 자체가 막힘**
      · `project_scope.py`  — `enforce_write_scope` 스킵 → admin-adjacent 표면 무검사 통과
      · `mcp.py`            — MCP manifest 403 → 기기 자격증명의 MCP 경로 전면 차단
    그 외에도 `get_auth_me`(MCP 컨텍스트 해소) · `member_resolver` 4곳 · `me.py` 2곳 ·
    `conversations` 3곳 · `notifications` · `notification_preferences` · `team_members` ·
    `events` · `gates` · `backlinks` · `stories` 3곳이 human 분기로 떨어져 **하드 실패**했다
    (실 PG 실측: agent member id 를 `TeamMember.user_id`/`OrgMember.user_id` 로 조회 → 0행
    → 400/404, `conversations._effective_role` 은 `or "member"` 폴백으로 조용히 강등).

    판정은 `is_agent_credential`(auth.py) 하나로 수렴한다 — 그 함수가 `is_au_billable_agent`
    와 **같은 축**을 공유하므로 과금과 인가가 갈라질 수 없다.
    """
    offenders: list[str] = []
    for path in _iter_py_files():
        with open(path, encoding="utf-8") as fh:
            src = fh.read()
        for pattern in _TRUTHINESS_PATTERNS:
            if pattern in src:
                offenders.append(f"{os.path.relpath(path, _REPO_ROOT)} :: {pattern}")

    assert not offenders, (
        "api_key_id truthiness 판정이 잔존한다 — dt_live_ 가 human 분기로 떨어진다.\n"
        "`is_agent_credential(auth)` 로 교체할 것:\n  " + "\n  ".join(offenders)
    )


def test_is_agent_credential_is_the_shared_axis():
    """판별자가 `is_au_billable_agent` 와 **같은 축**을 공유하는지 — 과금/인가 분기 방지.

    둘이 갈라지면 「과금은 agent 인데 인가는 human」 같은 상태가 생긴다(또는 그 반대).
    """
    import inspect

    from app.dependencies import auth as auth_mod

    ia = inspect.getsource(auth_mod.is_agent_credential)
    ab = inspect.getsource(auth_mod.is_au_billable_agent)
    # 둘 다 actor_type == "human" 을 먼저 배제하고, 둘 다 api_key_id 를 본다.
    assert 'actor_type") == "human"' in ia, "is_agent_credential 이 휴먼 예외를 안 본다"
    assert 'actor_type") == "human"' in ab, "is_au_billable_agent 가 휴먼 예외를 안 본다"
    assert 'api_key_id' in ia and 'api_key_id' in ab, "두 판별자가 같은 축을 안 공유한다"


def test_mcp_manifest_admits_device_credential_but_not_human():
    """⛔MCP 경로 — manifest·manifest/check 가 `dt_live_` 를 막으면 안 된다.

    MCP 서버도 로컬 프록시를 지난다: 데스크톱 앱이 `SPRINTABLE_API_URL`·`AGENT_API_KEY` 를
    둘 다 대체하므로(docs/desktop-agent-onboarding.md §5.2) 커넥터·MCP 어느 쪽도 수정 없이
    `dt_live_` 를 쓴다. manifest 가 403 이면 MCP 클라이언트는 fail-open(None=전체 허용)으로
    떨어져 **백엔드 toolset 정책이 통째로 무시된다**(게다가 manifest 자체는 못 연다).
    """
    import inspect

    from app.routers import mcp as mcp_mod

    src = inspect.getsource(mcp_mod)
    assert src.count("is_agent_credential(auth)") >= 2, (
        "mcp.py 의 manifest/manifest-check 가 공유 판별자를 안 쓴다 — dt_live_ MCP 403 재발"
    )
    for bad in _TRUTHINESS_PATTERNS:
        assert bad not in src, f"mcp.py 에 api_key_id 직접 판정 잔존: {bad}"


def test_get_auth_me_agent_branch_admits_device_credential():
    """⛔MCP 컨텍스트 해소 — `GET /api/v2/auth/me` 가 `dt_live_` 를 agent 분기로 보내야 한다.

    `sprintable_mcp/api_client.py::ensure_auth_context` 가 이 엔드포인트로
    `resolved_default_project_id` 를 키별 1회 해소·캐시한다. human 분기로 떨어지면 그 값이
    영구히 None → 멀티프로젝트 기기에서 `require_project_id()` 가 매 툴 호출을 422 로 막는다.
    """
    import inspect

    from app.routers import auth as auth_router

    src = inspect.getsource(auth_router.get_auth_me)
    assert "is_agent_credential(auth)" in src, (
        "get_auth_me 가 공유 판별자를 안 쓴다 — dt_live_ 의 MCP 컨텍스트가 None 으로 고정된다"
    )
    for bad in _TRUTHINESS_PATTERNS:
        assert bad not in src, f"get_auth_me 에 api_key_id 직접 판정 잔존: {bad}"


def test_stories_gate_actor_type_uses_shared_axis():
    """⛔감사 정확성 — `stories.py` 의 gate/workflow-line actor_type 이 기기를 agent 로 기록.

    `api_key_id` truthiness 로 판정하면 `dt_live_` 의 write 가 **"human" 으로 감사 기록**된다
    (gate 집행·workflow line 스냅샷 전부). 과금 축(`is_au_billable_agent`)은 기기를 agent 로
    보는데 감사만 human 이면 같은 요청에 두 답이 생긴다.
    """
    import inspect

    from app.routers import stories as stories_mod

    src = inspect.getsource(stories_mod)
    assert "is_agent_credential(auth)" in src, "stories.py 가 공유 판별자를 안 쓴다"
    for bad in _TRUTHINESS_PATTERNS:
        assert bad not in src, f"stories.py 에 api_key_id 직접 판정 잔존: {bad}"


def test_member_resolver_four_sites_use_shared_axis():
    """⛔정체성 해소 — `member_resolver.py` 4곳(216·293·587·639)이 같은 축을 써야 한다.

    human 분기로 떨어지면 `auth.user_id`(= agent member id)를 `OrgMember.user_id` /
    `User.id` 로 조회한다 — **다른 id 공간**이라 0행 → 400, 또는 조용한 오분류.
    """
    import inspect

    from app.services import member_resolver as mr

    src = inspect.getsource(mr)
    assert src.count("is_agent_credential(auth)") >= 4, (
        f"member_resolver 의 4곳 중 {src.count('is_agent_credential(auth)')}곳만 교체됨"
    )
    for bad in _TRUTHINESS_PATTERNS:
        assert bad not in src, f"member_resolver 에 api_key_id 직접 판정 잔존: {bad}"


def test_device_credential_cannot_open_human_only_surfaces():
    """⛔G10.4 «반대 방향» — 기기가 **휴먼 전용 표면을 열지 않음**.

    `_requires_interactive_session`(auth 라우터)은 *"탈취 세션 또는 API키"* 를 대칭 위협으로
    보고 API키를 막는다 — 그 docstring 이 **"한쪽만 막으면 공격자가 그쪽으로 우회"** 라고
    스스로 경고한다. 초판은 `api_key_id`·`human_api_key_id` 두 필드만 봤고 `dt_live_` 는
    그 둘을 **다 일부러 안 실어**(§5.2.1) 정확히 그 우회로가 됐다.

    통과하면 라우터가 `_get_user_by_id(uuid.UUID(auth.user_id))` 로 진행하는데, `dt_live_` 의
    `user_id` 는 **agent member id**(TeamMember.id)라 `users.id` 공간이 아니다 — 즉 이 가드가
    막으려던 "API키가 인증 강도에 기여하지 않는" 상태가 그대로 성립한다.
    """
    from app.dependencies.auth import AuthContext
    from app.routers.auth import _requires_interactive_session

    org = str(uuid.uuid4())

    def ctx(meta, user_id=None):
        return AuthContext(user_id=user_id or str(uuid.uuid4()), email=None,
                           claims={"sub": "x", "app_metadata": {**meta, "org_id": org}}, org_id=org)

    dev = _device_agent_ctx(uuid.uuid4(), org)
    assert _requires_interactive_session(dev) is True, (
        "dt_live_ 가 휴먼 전용 표면(비밀번호 설정 등)을 연다 — 우회로 재발"
    )
    # 기존 두 경로 무회귀
    assert _requires_interactive_session(ctx({"api_key_id": "k"})) is True
    assert _requires_interactive_session(ctx({"human_api_key_id": "hk", "actor_type": "human"})) is True
    # 휴먼 JWT 는 열려 있어야 한다(이 가드의 목적은 «사람이 실시간으로 있는가»).
    assert _requires_interactive_session(ctx({"actor_type": "human"})) is False


def test_human_only_surface_guard_shares_agent_axis():
    """`_requires_interactive_session` 이 공유 판별자를 쓰는지 소스로 고정(재발 방지)."""
    import inspect

    from app.routers import auth as auth_router

    src = inspect.getsource(auth_router._requires_interactive_session)
    assert "is_agent_credential(auth)" in src, (
        "휴먼 전용 표면 가드가 공유 판별자를 안 쓴다 — dt_live_ 우회로 재발"
    )
