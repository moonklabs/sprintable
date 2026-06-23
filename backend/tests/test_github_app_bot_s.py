"""E-GHAPP Bot-S: GitHub App 보안모델 단위 (산티아고 lock 게이트 기준).

커버: App JWT(iss=client ID·RS256·exp≤10m) · installation token(인메모리 캐시·재mint·DB영속0·미발급 graceful)
· 설치 state(CSRF서명+org바인딩+nonce+TTL·위조/만료/replay 거부) · anti-IDOR(state→org 바인딩).
GitHub App API 호출은 mock(실서버 0). 라이브(실 설치)는 App 등록 後 별도.
"""
from __future__ import annotations

import time
import uuid
from unittest.mock import AsyncMock, patch

import pytest
from jose import jwt

from app.services import github_app as ga


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
def _reset_caches():
    ga._private_key_cache = None
    ga._token_cache.clear()
    yield
    ga._private_key_cache = None
    ga._token_cache.clear()


# RS256 테스트용 키쌍(cryptography — python-jose[cryptography] 동봉).
def _rsa_keypair():
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    priv = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()
    pub = key.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
    ).decode()
    return priv, pub


# ── App JWT ───────────────────────────────────────────────────────────────────
def test_app_jwt_claims_and_alg():
    priv, pub = _rsa_keypair()
    with patch.object(ga.settings, "github_app_private_key", priv), \
         patch.object(ga.settings, "github_app_private_key_secret", ""), \
         patch.object(ga.settings, "github_app_client_id", "Iv1.testclient"):
        token = ga.build_app_jwt()
    assert token
    hdr = jwt.get_unverified_header(token)
    assert hdr["alg"] == "RS256"                       # 게이트: RS256.
    claims = jwt.decode(token, pub, algorithms=["RS256"], options={"verify_aud": False})
    assert claims["iss"] == "Iv1.testclient"           # 게이트: iss=client ID.
    assert claims["exp"] - claims["iat"] <= 600        # 게이트: exp≤10분.
    assert claims["iat"] <= int(time.time())           # iat=now−60(clock drift).


def test_app_jwt_none_without_key_or_clientid():
    with patch.object(ga.settings, "github_app_private_key", ""), \
         patch.object(ga.settings, "github_app_private_key_secret", ""):
        assert ga.build_app_jwt() is None              # 키 없음 → inert.


# ── installation token (캐시·미영속·graceful) ────────────────────────────────────
@pytest.mark.anyio
async def test_installation_token_cache_hit_no_mint():
    ga._token_cache[123] = ("cached-tok", time.time() + 3600)  # 만료 여유.
    with patch.object(ga, "build_app_jwt", return_value="appjwt") as bj, \
         patch("httpx.AsyncClient.post", new=AsyncMock()) as post:
        tok = await ga.get_installation_token(123)
    assert tok == "cached-tok"
    bj.assert_not_called(); post.assert_not_called()   # 캐시 히트 → mint 안 함.


@pytest.mark.anyio
async def test_installation_token_mint_and_cache():
    resp = AsyncMock()
    r = type("R", (), {"status_code": 201, "json": lambda self: {"token": "ghs_minted", "expires_at": "2099-01-01T00:00:00Z"}})()
    with patch.object(ga, "build_app_jwt", return_value="appjwt"), \
         patch("httpx.AsyncClient.post", new=AsyncMock(return_value=r)):
        tok = await ga.get_installation_token(456)
    assert tok == "ghs_minted"
    assert 456 in ga._token_cache and ga._token_cache[456][0] == "ghs_minted"  # 인메모리 캐시(DB 아님).


@pytest.mark.anyio
async def test_installation_token_none_without_app_jwt():
    with patch.object(ga, "build_app_jwt", return_value=None):
        assert await ga.get_installation_token(789) is None   # App JWT 없음 → graceful None.


# ── 설치 state (CSRF + org binding + nonce + TTL) ────────────────────────────────
_SECRET = "test-state-secret-key"


def test_state_roundtrip_org_binding():
    org = uuid.uuid4()
    with patch.object(ga.settings, "github_app_state_secret", _SECRET):
        state = ga.sign_install_state(org)
        result = ga.verify_install_state(state)
        assert result is not None and result[0] == org and result[1]  # (org, jti) 왕복.


def test_state_tampered_rejected():
    org = uuid.uuid4()
    with patch.object(ga.settings, "github_app_state_secret", _SECRET):
        state = ga.sign_install_state(org)
        assert ga.verify_install_state(state[:-3] + "xxx") is None   # 변조 거부.
        # 다른 시크릿 서명 → 거부.
        forged = jwt.encode({"org_id": str(org), "aud": "github-app-install", "exp": int(time.time()) + 600}, "WRONG", algorithm="HS256")
        assert ga.verify_install_state(forged) is None


def test_state_expired_rejected():
    org = uuid.uuid4()
    with patch.object(ga.settings, "github_app_state_secret", _SECRET):
        expired = jwt.encode(
            {"org_id": str(org), "aud": "github-app-install", "iat": int(time.time()) - 1200, "exp": int(time.time()) - 600, "jti": uuid.uuid4().hex},
            _SECRET, algorithm="HS256",
        )
        assert ga.verify_install_state(expired) is None     # TTL 만료 거부.


def test_state_wrong_audience_rejected():
    org = uuid.uuid4()
    with patch.object(ga.settings, "github_app_state_secret", _SECRET):
        wrong = jwt.encode(
            {"org_id": str(org), "aud": "something-else", "exp": int(time.time()) + 600},
            _SECRET, algorithm="HS256",
        )
        assert ga.verify_install_state(wrong) is None       # aud 불일치 거부.


def test_state_unique_nonce_replay_marker():
    org = uuid.uuid4()
    with patch.object(ga.settings, "github_app_state_secret", _SECRET):
        s1 = jwt.get_unverified_claims(ga.sign_install_state(org))
        s2 = jwt.get_unverified_claims(ga.sign_install_state(org))
    assert s1["jti"] != s2["jti"]                           # nonce 매 발급 고유(replay 방어 토대).


def test_state_anti_idor_returns_bound_org_only():
    """anti-IDOR 토대: state는 서명 시점 org에만 바인딩 — org A state 검증은 항상 A 반환(B로 위장 불가)."""
    org_a, org_b = uuid.uuid4(), uuid.uuid4()
    with patch.object(ga.settings, "github_app_state_secret", _SECRET):
        state_a = ga.sign_install_state(org_a)
        resolved = ga.verify_install_state(state_a)
    assert resolved is not None and resolved[0] == org_a and resolved[0] != org_b  # A의 state로 B 못 씀.


# ── Santiago hold fixes: prod-env-refuse · no-jti · ownership · FK · replay ──────
def test_prod_refuses_env_private_key():
    """hold#2: prod(app_env=production)에선 env private key 무시(Secret Manager strict)."""
    priv, _ = _rsa_keypair()
    with patch.object(ga.settings, "app_env", "production"), \
         patch.object(ga.settings, "github_app_private_key", priv), \
         patch.object(ga.settings, "github_app_private_key_secret", ""):
        assert ga._load_private_key() is None          # prod env fallback 차단.
    # dev 는 env fallback 허용.
    ga._private_key_cache = None
    with patch.object(ga.settings, "app_env", "development"), \
         patch.object(ga.settings, "github_app_private_key", priv), \
         patch.object(ga.settings, "github_app_private_key_secret", ""):
        assert ga._load_private_key() == priv


def test_state_without_jti_rejected():
    """hold#1: jti 없는 state 거부(서버측 consume 키 부재)."""
    org = uuid.uuid4()
    with patch.object(ga.settings, "github_app_state_secret", _SECRET):
        no_jti = jwt.encode(
            {"org_id": str(org), "aud": "github-app-install", "exp": int(time.time()) + 600},
            _SECRET, algorithm="HS256",
        )
        assert ga.verify_install_state(no_jti) is None


@pytest.mark.anyio
async def test_installation_ownership_verify():
    """hold#3: code→user token→/user/installations 에 installation_id 포함 시만 True(소속 검증)."""
    class _Resp:
        def __init__(self, status, payload):
            self.status_code = status
            self._p = payload
        def json(self):
            return self._p

    async def _post_ok(url, **kw):
        return _Resp(200, {"access_token": "user-tok"})

    with patch.object(ga.settings, "github_app_client_id", "cid"), \
         patch.object(ga.settings, "github_app_client_secret", "csec"):
        # 포함 → True.
        async def _get_match(url, **kw):
            return _Resp(200, {"installations": [{"id": 555}, {"id": 999}]})
        with patch("httpx.AsyncClient.post", new=AsyncMock(side_effect=_post_ok)), \
             patch("httpx.AsyncClient.get", new=AsyncMock(side_effect=_get_match)):
            assert await ga.verify_installation_owned("code", 555) is True
        # 미포함 → False(IDOR 차단).
        async def _get_nomatch(url, **kw):
            return _Resp(200, {"installations": [{"id": 999}]})
        with patch("httpx.AsyncClient.post", new=AsyncMock(side_effect=_post_ok)), \
             patch("httpx.AsyncClient.get", new=AsyncMock(side_effect=_get_nomatch)):
            assert await ga.verify_installation_owned("code", 555) is False
    # code 없음 → False.
    assert await ga.verify_installation_owned("", 555) is False


def test_org_id_has_fk_to_organizations():
    """hold#5: github_installation.org_id → organizations.id FK."""
    from app.models.github_installation import GithubInstallation
    targets = {str(fk.column) for fk in GithubInstallation.__table__.foreign_keys}
    assert "organizations.id" in targets


@pytest.mark.anyio
async def test_callback_replay_rejected_when_nonce_already_consumed():
    """hold#1(라우터): nonce 이미 소비(rowcount 0)면 callback 거부(replay_or_expired)."""
    from unittest.mock import MagicMock
    from app.routers.github_integration import install_callback

    org = uuid.uuid4()
    session = AsyncMock()
    delete_result = MagicMock(); delete_result.rowcount = 0  # 이미 소비/만료.
    session.execute = AsyncMock(return_value=delete_result)
    session.commit = AsyncMock()

    with patch.object(ga.settings, "github_app_state_secret", _SECRET), \
         patch("app.services.github_app.settings.github_app_state_secret", _SECRET):
        state = ga.sign_install_state(org)
        # verify_installation_owned 는 호출 전에 거부돼야(consume 0).
        with patch("app.routers.github_integration.verify_installation_owned", new=AsyncMock(return_value=True)) as owned:
            resp = await install_callback(installation_id=1, state=state, code="x", setup_action="install", session=session)
    assert resp.status_code == 302 and "replay_or_expired" in resp.headers["location"]
    # ⭐redirect 는 **프론트 절대주소**여야(상대경로면 GitHub 가 백엔드 host 로 해소→404 회귀). app_url 기준.
    loc = resp.headers["location"]
    assert loc.startswith(ga.settings.app_url.rstrip("/") + "/settings/integrations"), loc
    owned.assert_not_awaited()  # consume 실패 시 ownership 검증조차 안 감.
