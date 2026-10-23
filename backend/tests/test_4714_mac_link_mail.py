"""story 4714 (AC2) — POST /api/v2/desktop/mac-link-mail: the phone app's «Mac에서 열 링크를 메일로 받기».

Over real HTTP routing (ASGI), with the person and the account row faked — what is pinned is the route's rules, each of which fails if reverted:
  · the receiver is the account's OWN address (the request names none; a body/query with another address changes nothing)
  · a person's session only (an agent key and a person's own API key are 403, nothing sent)
  · an unverified address is 409 and nothing is sent (and uses up no count)
  · 3 an hour and one a minute, per person (not per address of the caller): the 2nd within a minute and the 4th in the hour are 429
  · a counting (storage) problem is a 503 and nothing is sent — it fails closed
  · `delivered` is the truth: the console fallback (False) is reported `false`, never as sent
  · the link in the mail is the plain `{app_url}/desktop` — no query, no token — and the words are Yuna's sheet's
"""
from __future__ import annotations

import re
import uuid
from types import SimpleNamespace

import httpx
import pytest

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.main import app

USER = uuid.UUID("47140000-0000-0000-0000-0000000000a1")
OTHER = uuid.UUID("47140000-0000-0000-0000-0000000000a2")
URL = "/api/v2/desktop/mac-link-mail"


@pytest.fixture
def anyio_backend():
    return "asyncio"


class _Db:
    """get_db stand-in: `select(User)` gives the one account row (or none)."""

    def __init__(self, user):
        self.user = user

    async def execute(self, _stmt):
        return SimpleNamespace(scalar_one_or_none=lambda: self.user)


def _user(uid=USER, email="own@example.test", verified=True, locale="ko"):
    return SimpleNamespace(id=uid, email=email, email_verified=verified, locale=locale, is_active=True, deleted_at=None)


@pytest.fixture
def world(monkeypatch):
    """the person · the account row · a recorded sender · empty counts"""
    from app.core.rate_limit import reset_strict_person_limits

    reset_strict_person_limits()
    sent: list[dict] = []
    state = {"user": _user(), "auth": AuthContext(user_id=str(USER), email="own@example.test", claims={}), "deliver": True}

    def _send(to, subject, html_body):
        sent.append({"to": to, "subject": subject, "html": html_body})
        return state["deliver"]

    monkeypatch.setattr("app.services.email.send_email", _send)
    monkeypatch.setenv("NEXT_PUBLIC_APP_URL", "https://app.test")
    app.dependency_overrides[get_current_user] = lambda: state["auth"]

    async def _db():
        yield _Db(state["user"])

    from tests.conftest import override_db_and_read  # story #2451: the one way a get_db override is hung (get_read_db is covered with it)

    override_db_and_read(app, _db)
    yield SimpleNamespace(sent=sent, state=state)
    app.dependency_overrides.pop(get_current_user, None)
    from app.dependencies.database import get_read_db

    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_read_db, None)
    reset_strict_person_limits()


async def _post(**kw):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
        return await c.post(URL, **kw)


@pytest.mark.anyio
async def test_it_mails_the_accounts_own_address_and_says_which(world):
    r = await _post()
    assert r.status_code == 200, r.text
    assert r.json() == {"delivered": True, "email": "own@example.test"}
    assert len(world.sent) == 1 and world.sent[0]["to"] == "own@example.test"
    assert r.headers["cache-control"] == "no-store"


@pytest.mark.anyio
async def test_no_address_the_caller_sends_is_ever_the_receiver(world):
    r = await _post(json={"email": "victim@example.test", "to": "victim@example.test"}, params={"email": "victim@example.test", "to": "victim@example.test"})
    assert r.status_code == 200
    assert [m["to"] for m in world.sent] == ["own@example.test"]  # the body and the query changed nothing


@pytest.mark.anyio
@pytest.mark.parametrize("claims", [{"app_metadata": {"api_key_id": "k"}}, {"app_metadata": {"human_api_key_id": "h"}}])
async def test_only_a_person_session_an_agent_key_or_a_personal_api_key_is_403(world, claims):
    world.state["auth"] = AuthContext(user_id=str(USER), email="own@example.test", claims=claims)
    r = await _post()
    assert (r.status_code, r.json()["error"]["code"]) == (403, "person_session_required")
    assert world.sent == []


@pytest.mark.anyio
async def test_an_unverified_address_gets_409_and_no_mail_and_uses_no_count(world):
    world.state["user"] = _user(verified=False)
    for _ in range(5):  # more than the hourly 3: if these counted, the verified call below would be 429
        r = await _post()
        assert (r.status_code, r.json()["error"]["code"]) == (409, "email_not_verified")
    assert world.sent == []
    world.state["user"] = _user(verified=True)
    assert (await _post()).status_code == 200


@pytest.mark.anyio
async def test_no_account_row_is_404_and_nothing_is_sent(world):
    world.state["user"] = None
    r = await _post()
    assert (r.status_code, r.json()["error"]["code"]) == (404, "user_not_found")
    assert world.sent == []


@pytest.mark.anyio
async def test_one_a_minute_and_three_an_hour_per_person(world, monkeypatch):
    import limits

    first = await _post()
    assert first.status_code == 200
    again = await _post()  # the 2nd inside the minute
    assert (again.status_code, again.json()["error"]["code"]) == (429, "rate_limited")
    assert int(again.headers["retry-after"]) >= 1
    assert len(world.sent) == 1
    # the three-an-hour window, minute gap taken away: the 4th is refused even when no minute rule stands in the way
    monkeypatch.setattr("app.routers.desktop_mac_link.MAC_LINK_MAIL_LIMITS", ("3/hour",))
    assert (await _post()).status_code == 200
    assert (await _post()).status_code == 200
    r4 = await _post()
    assert (r4.status_code, r4.json()["error"]["code"]) == (429, "rate_limited")
    assert len(world.sent) == 3
    assert limits.parse("3/hour")  # the spec string itself is valid


@pytest.mark.anyio
async def test_the_count_is_the_persons_not_the_addresss(world):
    assert (await _post()).status_code == 200
    assert (await _post()).status_code == 429  # same person
    world.state["user"] = _user(uid=OTHER, email="other@example.test")
    world.state["auth"] = AuthContext(user_id=str(OTHER), email="other@example.test", claims={})
    assert (await _post()).status_code == 200  # another person: its own count
    assert [m["to"] for m in world.sent] == ["own@example.test", "other@example.test"]


@pytest.mark.anyio
async def test_a_counting_problem_fails_closed_503_and_sends_nothing(world, monkeypatch):
    from limits.errors import StorageError

    def _boom(*_a, **_k):
        raise StorageError(Exception("redis down"))

    monkeypatch.setattr("app.routers.desktop_mac_link.hit_person_limits_strict", _boom)
    r = await _post()
    assert r.status_code == 503
    assert world.sent == []


@pytest.mark.anyio
async def test_the_console_fallback_is_reported_not_delivered(world):
    world.state["deliver"] = False
    r = await _post()
    assert r.status_code == 200
    assert r.json() == {"delivered": False, "email": "own@example.test"}  # never «sent» when no mail left


@pytest.mark.anyio
@pytest.mark.parametrize("locale,subject", [("ko", "Mac에서 Sprintable을 시작할 링크예요"), ("en", "Your link to start Sprintable on your Mac")])
async def test_the_mail_is_the_sheets_words_and_the_link_is_the_plain_desktop_page(world, locale, subject):
    world.state["user"] = _user(locale=locale)
    assert (await _post()).status_code == 200
    mail = world.sent[0]
    assert mail["subject"] == subject
    hrefs = re.findall(r"href='([^']+)'", mail["html"])
    assert "https://app.test/desktop" in hrefs
    for href in hrefs:
        if href.startswith("https://app.test/desktop"):
            assert href == "https://app.test/desktop"  # no query · no fragment · no token
    assert "token" not in mail["html"].lower().replace("account information", "")  # nothing token-like rides in the mail


def test_the_mail_words_are_in_the_catalog_in_both_languages_with_the_sheets_keys():
    from app.services.i18n_catalog import MessageCatalog, t

    keys = {f"mac_link_mail.{k}" for k in ("subject", "intro_1", "intro_2", "cta_label", "expiry_note", "security_note", "fallback_label")}
    assert {k for k in MessageCatalog.keys() if k.startswith("mac_link_mail.")} == keys
    for k in keys:
        assert MessageCatalog.locales_for(k) == frozenset({"ko", "en"})
        assert t(k, "ko") and t(k, "en") and t(k, "ko") != t(k, "en")
    # the two lines that promise «no account information» / «no expiry» are true only while the link holds no token (they are the lines to
    # change if one is ever added)
    assert "계정 정보가 들어 있지 않아요" in t("mac_link_mail.security_note", "ko")
    assert "holds no account information" in t("mac_link_mail.security_note", "en")


def test_the_route_is_one_post_and_takes_no_body():
    item = app.openapi()["paths"][URL]  # read from the app's own contract (the route tree differs between FastAPI versions)
    assert list(item) == ["post"]
    assert "requestBody" not in item["post"]  # no body field: no way to name another receiver
    assert not [p for p in item["post"].get("parameters", []) if p.get("in") == "query"]  # and no query one


def test_the_strict_limiter_itself_does_not_swallow_a_storage_error(monkeypatch):
    """the route's 503 rests on THIS: a storage problem inside the limiter raises (the shared in-memory helper would carry on)"""
    from limits.errors import StorageError

    from app.core import rate_limit

    def _down(*_a, **_k):
        raise StorageError(Exception("down"))

    monkeypatch.setattr(rate_limit._strict_person_limiter, "hit", _down)
    with pytest.raises(StorageError):
        rate_limit.hit_person_limits_strict("scope", "person", "3/hour")


def test_the_strict_limiter_counts_and_answers_in_one_step_never_test_then_hit(monkeypatch):
    """two requests that arrive together must not both pass a separate `test()` before either is counted: the only step is `hit()`"""
    from app.core import rate_limit

    def _no_separate_check(*_a, **_k):
        raise AssertionError("a separate test() step lets concurrent requests all pass before any is counted")

    monkeypatch.setattr(rate_limit._strict_person_limiter, "test", _no_separate_check)
    rate_limit.reset_strict_person_limits()
    assert rate_limit.hit_person_limits_strict("atomic", "person", "1/minute", "3/hour") is None
    wait = rate_limit.hit_person_limits_strict("atomic", "person", "1/minute", "3/hour")
    assert wait is not None and wait >= 1  # the second is refused by the minute rule
    rate_limit.reset_strict_person_limits()


def test_a_request_the_minute_rule_refuses_does_not_use_up_the_hour(monkeypatch):
    from app.core import rate_limit

    rate_limit.reset_strict_person_limits()
    assert rate_limit.hit_person_limits_strict("order", "p", "1/minute", "3/hour") is None  # counts: minute 1, hour 1
    for _ in range(5):  # refused by the minute rule: the hour must stay at 1
        assert rate_limit.hit_person_limits_strict("order", "p", "1/minute", "3/hour") is not None
    # only the hour rule is left to judge: it still has 2 free (a refused-by-minute request counted nothing there)
    assert rate_limit.hit_person_limits_strict("order", "p", "3/hour") is None
    assert rate_limit.hit_person_limits_strict("order", "p", "3/hour") is None
    assert rate_limit.hit_person_limits_strict("order", "p", "3/hour") is not None
    rate_limit.reset_strict_person_limits()


def test_retry_after_is_the_longest_reset_of_the_windows_the_request_touched(monkeypatch):
    """a request the looser window refuses has already been counted by the tighter one: a retry sooner than THAT window's reset is refused again"""
    from app.core import rate_limit

    rate_limit.reset_strict_person_limits()
    assert rate_limit.hit_person_limits_strict("longest", "p", "1/second") is None  # the short window is now full for ~1 s
    wait = rate_limit.hit_person_limits_strict("longest", "p", "1/minute", "1/second")  # the minute window lets this one in, the second one refuses
    assert wait is not None and wait >= 55, wait  # not the ~1 s of the refusing window alone: the minute it just counted in
    rate_limit.reset_strict_person_limits()


def test_retry_after_in_the_real_order_when_the_hour_refuses_and_the_minute_lets_by():
    """the order the route really uses (`1/minute`, `3/hour`): the HOUR window refuses, the minute window had let the request in. The longest reset is the
    SECOND window's (~an hour) — a reply built from the first window's reset alone (about a minute) would tell the person to come back an hour too early
    (Kadir 5152 pin: the (minute, second) test above has its longest window first and can not tell the two apart)."""
    from app.core import rate_limit
    from app.routers.desktop_mac_link import MAC_LINK_MAIL_LIMITS

    assert MAC_LINK_MAIL_LIMITS == ("1/minute", "3/hour")
    rate_limit.reset_strict_person_limits()
    for _ in range(3):  # fill the hour window alone (three an hour), without touching the minute window
        assert rate_limit.hit_person_limits_strict("order-real", "p", "3/hour") is None
    wait = rate_limit.hit_person_limits_strict("order-real", "p", *MAC_LINK_MAIL_LIMITS)  # minute: passes · hour: refuses
    assert wait is not None and 3000 < wait <= 3601, wait  # ~ the hour, not the ~60 s of the window that let it in
    rate_limit.reset_strict_person_limits()
