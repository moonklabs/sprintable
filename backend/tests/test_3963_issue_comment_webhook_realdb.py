"""story #3963(적어둠 — verdict 원장 배선, PO 확定 2026-09-16) — `_process_webhook_event`의
`issue_comment` 분기 실PG 검증. test_2327_webhook_skipped_reason_realdb.py와 동일 HTTP·HMAC
헬퍼 관례(cross-import) — app installation 경로로 org 해소(legacy repo-owner 매치보다 결정론적).

핵심 검증축:
①codex QA verdict 코멘트 → capture_review_verdict(role="qa", source="github_comment") 실제
  기록(participation.member_id = _get_or_create_system_publisher 앵커).
②PO review 코멘트인데 org에 "po" ParticipationRole이 아직 없으면 skipped_reason=no_po_role
  (역할 시딩은 이 카드 스코프 밖 — PO가 참여 역할 관리 화면에서 별도 생성).
③action≠created·PR 아닌 issue 코멘트·untrusted author_association·비-verdict 코멘트·SID
  없음·story_number 미해소 6가지 skip 사유 각각 정확히 남는다.
④중복 delivery(dedup)는 이 분기에도 동일 적용(webhook ingress 공통 로직, 회귀 아님 — 간단히
  1건만 재확認)."""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import uuid
from unittest.mock import patch

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
    pytest.mark.destructive_schema,
]

APP_SECRET = "app-secret-3963"
INSTALLATION_ID = 555001


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
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
    """test_2327_webhook_skipped_reason_realdb.py와 동일 관례 — `Base.metadata.create_all()`
    (ORM 선언 스키마만)이 아니라 **이미 alembic로 전체 마이그레이션된** 실 DB에 직접 연결한다.
    이 분기가 부르는 `_get_or_create_system_publisher`(events.py)는 raw 마이그레이션(0258)
    으로만 존재하는 부분 유니크 인덱스(`uq_members_org_system_publisher`, ORM
    `Member.__table_args__`엔 선언 안 됨)에 `ON CONFLICT ... WHERE`로 의존한다 — create_all()
    기반 디스포저블 스키마로는 이 인덱스가 안 생겨(로컬 실측, InvalidColumnReferenceError)
    이 테스트가 못 돈다. CI의 destructive-schema 잡은 이미 `alembic upgrade head`를 거친
    DB를 쓰므로 이 방식이 정본과 일치한다."""
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    engine = create_async_engine(_async_url())
    return engine, async_sessionmaker(engine, expire_on_commit=False)


def _sign(body: bytes, secret: str) -> str:
    return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


async def _post_issue_comment(payload, Session, *, delivery_id):
    from app.main import app as fastapi_app
    from app.routers import verdict_capture as mod
    from tests.conftest import override_db_and_read

    async def override_db():
        async with Session() as s:
            yield s

    # story #2451 가드 — get_db만 걸고 get_read_db를 빠뜨리는 재발 클래스, 이 헬퍼 하나로만.
    override_db_and_read(fastapi_app, override_db)
    body = json.dumps(payload).encode()
    headers = {
        "X-GitHub-Event": "issue_comment", "X-GitHub-Delivery": delivery_id,
        "X-Hub-Signature-256": _sign(body, APP_SECRET),
    }
    try:
        async with AsyncClient(transport=ASGITransport(app=fastapi_app), base_url="http://test") as c:
            with patch.object(mod.settings, "github_app_webhook_secret", APP_SECRET):
                return await c.post(
                    "/api/v2/internal/verdict/github-webhook", content=body, headers=headers,
                )
    finally:
        fastapi_app.dependency_overrides.clear()


async def _delivery_row(Session, delivery_id):
    from app.models.github_installation import GithubWebhookDelivery
    async with Session() as s:
        return (
            await s.execute(
                select(GithubWebhookDelivery).where(GithubWebhookDelivery.delivery_id == delivery_id)
            )
        ).scalar_one_or_none()


def _issue_comment_payload(
    *, body: str, story_number: int | None, action="created",
    is_pr=True, author_association="MEMBER",
):
    issue: dict = {"title": f"[SID:{story_number}] work" if story_number else "chore: work", "body": ""}
    if is_pr:
        issue["pull_request"] = {"url": "https://api.github.com/repos/moonklabs/sprintable/pulls/1"}
    return {
        "action": action,
        "repository": {"full_name": "moonklabs/sprintable"},
        "installation": {"id": INSTALLATION_ID},
        "issue": issue,
        "comment": {"body": body, "author_association": author_association},
    }


async def _seed_org_project_story(Session, *, story_number: int, seed_po_role: bool = False):
    from app.models.github_installation import GithubInstallation
    from app.models.organization import Organization
    from app.models.participation import ParticipationRole
    from app.models.pm import Story
    from app.models.project import Project

    async with Session() as s:
        org = Organization(id=uuid.uuid4(), name="Org3963", slug=f"org3963-{uuid.uuid4().hex[:8]}")
        s.add(org)
        await s.flush()
        project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
        s.add(project)
        await s.flush()
        story = Story(
            id=uuid.uuid4(), org_id=org.id, project_id=project.id, story_number=story_number,
            title="S", status="in-review",
        )
        s.add(story)
        s.add(GithubInstallation(
            id=uuid.uuid4(), org_id=org.id, installation_id=INSTALLATION_ID,
            account_login="moonklabs",
        ))
        # story #3963 AC — "qa" role은 이미 org에 있다는 실측 전제(기존 chat 트리거 경로가
        # 써 온 role) 재현. "po"는 의도적으로 seed_po_role=True일 때만.
        s.add(ParticipationRole(id=uuid.uuid4(), org_id=org.id, key="qa", label="QA"))
        if seed_po_role:
            s.add(ParticipationRole(id=uuid.uuid4(), org_id=org.id, key="po", label="PO"))
        await s.commit()
        return org.id, story.id


@pytest.mark.anyio
async def test_codex_qa_verdict_comment_records_verdict_realdb():
    """AC① — 실제 codex QA verdict 코멘트가 verdict 테이블에 기록되고 member_id는
    시스템 발행 앵커(_get_or_create_system_publisher)."""
    engine, Session = await _session_factory()
    try:
        org_id, story_id = await _seed_org_project_story(Session, story_number=1001)

        payload = _issue_comment_payload(
            body="## QA verdict: approved (qa:pass)\n**Head:** `abc123`\n", story_number=1001,
        )
        resp = await _post_issue_comment(payload, Session, delivery_id=f"dlv-{uuid.uuid4().hex[:8]}")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["data"]["recorded"] is True
        assert body["data"]["source"] == "github_comment"

        from app.models.participation import Participation
        from app.models.verdict import Verdict

        async with Session() as s:
            participations = (await s.execute(
                select(Participation).where(Participation.story_id == story_id)
            )).scalars().all()
            assert len(participations) == 1
            verdicts = (await s.execute(
                select(Verdict).where(Verdict.participation_id == participations[0].id)
            )).scalars().all()
            assert len(verdicts) == 1
            assert verdicts[0].source == "github_comment"
            assert verdicts[0].result == "pass"

            from app.routers.events import _get_or_create_system_publisher

            system_member = await _get_or_create_system_publisher(s, org_id)
            assert participations[0].member_id == system_member.id
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_po_review_comment_skips_when_po_role_not_seeded_realdb():
    """AC② — "po" 참여 역할이 org에 아직 없으면 no_po_role로 정직하게 skip(거짓기록 금지)."""
    engine, Session = await _session_factory()
    try:
        await _seed_org_project_story(Session, story_number=1002, seed_po_role=False)

        payload = _issue_comment_payload(
            body="## PO review — PASS · head abc123\n", story_number=1002,
        )
        resp = await _post_issue_comment(payload, Session, delivery_id=f"dlv-{uuid.uuid4().hex[:8]}")
        assert resp.status_code == 200, resp.text
        assert resp.json()["data"]["skipped_reason"] == "no_po_role"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_po_review_comment_records_when_po_role_seeded_realdb():
    """AC② 반대편 — "po" role이 있으면 정상 기록."""
    engine, Session = await _session_factory()
    try:
        await _seed_org_project_story(Session, story_number=1003, seed_po_role=True)

        payload = _issue_comment_payload(
            body="## PO 리뷰 — CHANGES 3건(소형) (head abc123)\n", story_number=1003,
        )
        resp = await _post_issue_comment(payload, Session, delivery_id=f"dlv-{uuid.uuid4().hex[:8]}")
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert data["recorded"] is True
        assert data["result"] == "fail"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_skip_reasons_realdb():
    """AC③ — 6가지 skip 사유가 각각 정확히 delivery.skipped_reason에 남는다."""
    engine, Session = await _session_factory()
    try:
        org_id, story_id = await _seed_org_project_story(Session, story_number=2001, seed_po_role=True)
        verdict_body = "## QA verdict: approved (qa:pass)\n"

        cases = [
            ("edited", _issue_comment_payload(body=verdict_body, story_number=2001, action="edited"), "not_created_action"),
            ("not_pr", _issue_comment_payload(body=verdict_body, story_number=2001, is_pr=False), "not_a_pull_request_comment"),
            ("untrusted", _issue_comment_payload(body=verdict_body, story_number=2001, author_association="NONE"), "untrusted_author_association"),
            ("not_verdict", _issue_comment_payload(body="그냥 잡담", story_number=2001), "not_a_verdict_comment"),
            ("no_sid", _issue_comment_payload(body=verdict_body, story_number=None), "no_sid_tag"),
            ("story_missing", _issue_comment_payload(body=verdict_body, story_number=999999), "story_not_found"),
        ]
        for label, payload, expected_reason in cases:
            delivery_id = f"dlv-{label}-{uuid.uuid4().hex[:8]}"
            resp = await _post_issue_comment(payload, Session, delivery_id=delivery_id)
            assert resp.status_code == 200, f"{label}: {resp.text}"
            assert resp.json()["data"]["skipped_reason"] == expected_reason, label

            row = await _delivery_row(Session, delivery_id)
            assert row is not None, label
            assert row.status == "ignored", label
            assert row.skipped_reason == expected_reason, label
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_duplicate_delivery_is_noop_realdb():
    """AC④ — 같은 delivery_id 재전송은 dedup(uq)로 2xx no-op(webhook ingress 공통 로직 재확認)."""
    engine, Session = await _session_factory()
    try:
        await _seed_org_project_story(Session, story_number=3001, seed_po_role=False)
        delivery_id = f"dlv-dup-{uuid.uuid4().hex[:8]}"
        payload = _issue_comment_payload(
            body="## QA verdict: approved (qa:pass)\n", story_number=3001,
        )
        resp1 = await _post_issue_comment(payload, Session, delivery_id=delivery_id)
        assert resp1.status_code == 200, resp1.text

        resp2 = await _post_issue_comment(payload, Session, delivery_id=delivery_id)
        assert resp2.status_code == 200, resp2.text
        assert resp2.json()["data"]["skipped_reason"] == "duplicate_delivery"
    finally:
        await engine.dispose()
