"""story #4294(PO 05:01Z 판단 · 422) — 기간 질의의 일시는 시간대(오프셋)가 있어야 받는다.

오프셋 없는 일시는 asyncpg가 **앱 프로세스의 로컬 시간대**로 바꿔 보내(로컬 맥 = KST · Cloud Run = UTC) 같은 요청이 환경마다 다른 창을
본다. 모르는 시간대를 지어내지 않고 422 `DATETIME_OFFSET_REQUIRED`(+ `hint` 예시 · `param`)로 거절한다.

- 판정 한 곳(`app/core/datetime_query.py`) — 표 테스트.
- 구조 가드: 라우터가 datetime 쿼리 파라미터를 날것 `Query`로 받지 않는다(모두 `aware_datetime_query` · 문자열 파싱은 `require_aware`).
- 실 DB: KST 자정 경계(오프셋 있는 창은 정확히 가른다) · naive는 422(활동 로그 · 활동 스트림).
"""
from __future__ import annotations

import ast
import os
import pathlib
import uuid
from datetime import UTC, datetime, timedelta, timezone

import pytest

from tests.test_e_security_sec_s8_ratchet_round7_activity_logs_stream_realdb import (
    _client_for,
    _session_factory,
    _setup_app,
)

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")
_APP = pathlib.Path(__file__).resolve().parents[1] / "app"


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine

    await _global_engine.dispose()


class _Req:
    def __init__(self, lang: str | None):
        self.headers = {"accept-language": lang} if lang else {}


def test_the_judgement_table():
    """naive → 422(코드 · 로케일 문장 · hint · param) · 오프셋 있음 · None → 그대로."""
    from fastapi import HTTPException

    from app.core.datetime_query import (
        DATETIME_OFFSET_REQUIRED,
        OFFSET_HINT,
        require_aware,
    )

    aware = datetime(2026, 9, 18, 0, 0, tzinfo=timezone(timedelta(hours=9)))
    assert require_aware(aware, param="from", request=_Req("ko")) is aware
    assert require_aware(None, param="from", request=_Req("ko")) is None
    for lang, needle in (("ko", "시간대를 붙여 주세요"), ("en", "Add a timezone offset")):
        with pytest.raises(HTTPException) as exc:
            require_aware(datetime(2026, 9, 18, 0, 0), param="from", request=_Req(lang))  # noqa: DTZ001 — naive가 검사 대상
        detail = exc.value.detail
        assert exc.value.status_code == 422
        assert (detail["code"], detail["hint"], detail["param"]) == (DATETIME_OFFSET_REQUIRED, OFFSET_HINT, "from")
        assert needle in detail["message"] and "from" in detail["message"]


def test_no_router_takes_a_naive_datetime_query():
    """구조 가드 — 라우터 파라미터 중 `datetime` 주석 + 날것 `Query(...)` 기본값이 없다(새 기간 파라미터는 `aware_datetime_query`로).
    뮤테이션: 활동 로그 `from`을 예전처럼 `Query(default=None, alias="from")`로 되돌리면 RED."""
    offenders = []
    for path in (_APP / "routers").glob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for fn in ast.walk(tree):
            if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            args = fn.args.args + fn.args.kwonlyargs
            defaults = [None] * (len(fn.args.args) - len(fn.args.defaults)) + list(fn.args.defaults) + list(fn.args.kw_defaults)
            for arg, default in zip(args, defaults):
                ann = ast.unparse(arg.annotation) if arg.annotation is not None else ""
                if "datetime" not in ann or "date |" in ann:
                    continue
                if isinstance(default, ast.Call) and (getattr(default.func, "id", None) or getattr(default.func, "attr", None)) == "Query":
                    offenders.append(f"{path.name}:{fn.name}:{arg.arg}")
    assert not offenders, f"오프셋 확인 없이 datetime을 받는 쿼리 파라미터: {offenders}"


def test_the_string_parsed_agent_runs_window_uses_the_same_judgement():
    """agent_runs는 from/to를 문자열로 받아 직접 파싱한다 — 예전엔 naive를 UTC로 가정했다. 같은 판정(`require_aware`)을 부른다."""
    tree = ast.parse((_APP / "routers" / "agent_runs.py").read_text(encoding="utf-8"))
    fn = next(n for n in ast.walk(tree) if isinstance(n, ast.AsyncFunctionDef) and n.name == "list_agent_runs")
    calls = [
        (getattr(n.func, "id", None) or getattr(n.func, "attr", None)) for n in ast.walk(fn) if isinstance(n, ast.Call)
    ]
    assert calls.count("require_aware") == 2
    assert "replace" not in {c for c in calls if c}, "naive를 UTC로 바꾸는 옛 가정이 남았다"


# ── 실 DB ────────────────────────────────────────────────────────────────────────────────────────────


async def _seed(session):
    """조직 · 프로젝트 · 접근권 있는 사람 · KST 9/18 자정을 사이에 둔 활동 로그 둘(23:30 KST = 14:30Z · 00:30 KST = 15:30Z)."""
    from app.models.activity_log import ActivityLog
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    before = ActivityLog(
        id=uuid.uuid4(), org_id=org.id, project_id=project.id, actor_type="agent", action="before-kst-midnight",
        created_at=datetime(2026, 9, 17, 14, 30, tzinfo=UTC),
    )
    after = ActivityLog(
        id=uuid.uuid4(), org_id=org.id, project_id=project.id, actor_type="agent", action="after-kst-midnight",
        created_at=datetime(2026, 9, 17, 15, 30, tzinfo=UTC),
    )
    session.add_all([before, after])
    user_id = uuid.uuid4()
    session.add(User(id=user_id, email=f"h-{user_id.hex[:8]}@test.com", hashed_password="x"))
    await session.commit()
    om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=user_id, role="member")
    session.add(om)
    await session.commit()
    session.add(ProjectAccess(id=uuid.uuid4(), project_id=project.id, org_member_id=om.id, permission="granted", role="member"))
    await session.commit()
    return {"org_id": org.id, "project_id": project.id, "user_id": user_id}


@pytest.mark.anyio
@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
async def test_the_kst_midnight_window_is_exact_with_an_offset_and_a_naive_value_is_refused():
    """오프셋 있는 `from=2026-09-18T00:00:00+09:00`은 KST 00:30 로그만 · naive `2026-09-18T00:00:00`은 422(DATETIME_OFFSET_REQUIRED ·
    hint · param). 활동 스트림 `since`도 같은 422. 뮤테이션: `require_aware`의 거절을 빼면 naive가 200으로 RED."""
    from urllib.parse import quote

    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            w = await _seed(s)
        await _setup_app(app, Session, w["user_id"], w["org_id"])
        client = _client_for(app)
        try:
            base = f"/api/v2/activity-logs?project_id={w['project_id']}"
            r = await client.get(f"{base}&from={quote('2026-09-18T00:00:00+09:00')}")
            assert r.status_code == 200, r.text
            assert [i["action"] for i in r.json()["items"]] == ["after-kst-midnight"]

            r = await client.get(f"{base}&from=2026-09-18T00:00:00", headers={"Accept-Language": "en"})
            assert r.status_code == 422, r.text
            err = r.json()["error"]
            assert (err["code"], err["param"]) == ("DATETIME_OFFSET_REQUIRED", "from")
            assert "Z" in err["hint"] and "+09:00" in err["hint"]
            assert "Add a timezone offset" in err["message"]

            r = await client.get(f"/api/v2/activity-stream?project_id={w['project_id']}&since=2026-09-18T00:00:00")
            assert r.status_code == 422, r.text
            assert r.json()["error"]["code"] == "DATETIME_OFFSET_REQUIRED"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
