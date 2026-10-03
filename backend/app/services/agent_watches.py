"""story #4536 (E-DESKTOP-2 C-2) — watches an agent sets that live on the server, past its session.

A watch waits for one thing and fires once, as a `watch.fired` Event on that agent's stream (an agent whose session was off
gets it first when it comes back — the stream's own order). What fires them, with no GitHub API polling:
- the GitHub webhooks the server already takes (signature checked · one row per delivery id, so a redelivery never fires twice):
  a PR merged · a PR's check suite completed. The same handler records every PR it hears of (`github_pull_requests`).
- a backend revision reporting the commit it serves, on its first outside request (`deploy_servings`). «Serving» a PR's merge
  means: the served commit is a recorded merge into the same repo and base, merged at or after the PR (develop is one line of
  squash merges — PO 06:00Z); a served commit not on record matches its own commit only (`line: unknown`).

At set time (PO 06:01Z · 06:02Z): a PR the server has never heard of is refused (PR_NOT_SEEN — one push or CI run makes it
known), a PR closed without merging too (PR_CLOSED_UNMERGED); a watch whose event already happened fires at once.
"""
from __future__ import annotations

import logging
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator
from sqlalchemy import and_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agent_watch import AgentWatch, DeployServing, GithubPullRequest
from app.models.event import Event

logger = logging.getLogger(__name__)

DEFAULT_TTL = timedelta(days=7)
MAX_TTL_HOURS = 720  # 30 days
_REPO = r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$"
_SHA = r"^[0-9a-fA-F]{7,40}$"


class WatchError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ── targets ──────────────────────────────────────────────────────────────────────────────────────────────────────────────


class PrTarget(BaseModel):
    model_config = ConfigDict(extra="forbid")

    repo: str = Field(pattern=_REPO, max_length=200)
    pr: int = Field(ge=1)


class ServingTarget(BaseModel):
    """`{service, repo, pr}` — «tell me when my PR is served» — or `{service, commit}`."""

    model_config = ConfigDict(extra="forbid")

    service: Literal["backend"]
    repo: str | None = Field(default=None, pattern=_REPO, max_length=200)
    pr: int | None = Field(default=None, ge=1)
    commit: str | None = Field(default=None, pattern=_SHA)

    @model_validator(mode="after")
    def _one_way(self):
        by_pr = self.repo is not None and self.pr is not None
        if by_pr == (self.commit is not None) or (self.repo is None) != (self.pr is None):
            raise ValueError("either repo + pr, or commit")
        return self


class WatchCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    condition: Literal["github.pr_merged", "github.pr_checks_completed", "deploy.serving"]
    target: dict
    expires_in_hours: int | None = Field(default=None, ge=1, le=MAX_TTL_HOURS)


def _parse_target(condition: str, target: dict) -> PrTarget | ServingTarget:
    schema = ServingTarget if condition == "deploy.serving" else PrTarget
    try:
        parsed = schema.model_validate(target)
    except ValidationError as exc:
        raise WatchError(422, "invalid_target", exc.errors(include_url=False, include_input=False)[0]["msg"]) from exc
    if getattr(parsed, "repo", None):
        parsed.repo = parsed.repo.lower()
    if getattr(parsed, "commit", None):
        parsed.commit = parsed.commit.lower()
    return parsed


# ── the server's own record of PRs and servings ──────────────────────────────────────────────────────────────────────────


async def _pr(db: AsyncSession, repo: str, number: int) -> GithubPullRequest | None:
    return (await db.execute(
        select(GithubPullRequest).where(GithubPullRequest.repo == repo, GithubPullRequest.number == number)
    )).scalar_one_or_none()


async def _merge_of_commit(db: AsyncSession, sha: str) -> GithubPullRequest | None:
    """The recorded merge whose merge commit is `sha` (a 7–40 hex prefix of it)."""
    sha = sha.lower()
    rows = (await db.execute(
        select(GithubPullRequest).where(GithubPullRequest.merge_commit_sha.like(f"{sha}%")).limit(2)
    )).scalars().all()
    return rows[0] if len(rows) == 1 else None


async def _latest_serving(db: AsyncSession, service: str) -> DeployServing | None:
    return (await db.execute(
        select(DeployServing).where(DeployServing.service == service).order_by(DeployServing.first_request_at.desc()).limit(1)
    )).scalar_one_or_none()


async def _serving_fact(db: AsyncSession, target: ServingTarget, serving: DeployServing) -> dict | None:
    """The fact when `serving` serves the target, else None (PO 06:00Z rule)."""
    served = serving.commit_sha.lower()
    line = await _merge_of_commit(db, served)
    base = {"service": serving.service, "revision": serving.revision, "commit": served,
            "served_since": serving.first_request_at.isoformat() if serving.first_request_at else None}
    if target.pr is not None:
        mine = await _pr(db, target.repo, target.pr)
        if mine is None or mine.merged_at is None or not mine.merge_commit_sha:
            return None
        if mine.merge_commit_sha.lower() == served:
            return {**base, "line": "known" if line else "unknown", "pr": target.pr}
        if line and line.repo == mine.repo and line.base_ref == mine.base_ref and mine.merged_at <= line.merged_at:
            return {**base, "line": "known", "pr": target.pr, "served_merge_pr": line.number}
        return None
    if served.startswith(target.commit) or target.commit.startswith(served):
        return {**base, "line": "known" if line else "unknown"}
    mine = await _merge_of_commit(db, target.commit)
    if mine and line and line.repo == mine.repo and line.base_ref == mine.base_ref and mine.merged_at <= line.merged_at:
        return {**base, "line": "known", "served_merge_pr": line.number}
    return None


# ── firing ───────────────────────────────────────────────────────────────────────────────────────────────────────────────


def _describe(watch: AgentWatch, fact: dict) -> str:
    t = watch.target
    what = f"{t.get('repo')}#{t.get('pr')}" if t.get("pr") else f"commit {t.get('commit')}"
    if watch.condition == "github.pr_merged":
        return f"[watch] {what} was merged"
    if watch.condition == "github.pr_checks_completed":
        return f"[watch] {what}: a check suite completed ({fact.get('conclusion')})"
    return f"[watch] {what} is served by {fact.get('service')} revision {fact.get('revision')} (commit {str(fact.get('commit'))[:9]})"


async def _fire(db: AsyncSession, watch: AgentWatch, fact: dict) -> None:
    """Fired once: the watch ends and its agent gets a `watch.fired` Event (numbered · woken after the commit)."""
    from app.services.event_seq import assign_recipient_seq

    watch.status, watch.fired_at, watch.fired_fact = "fired", _now(), fact
    event = Event(
        project_id=watch.project_id, org_id=watch.org_id, event_type="watch.fired",
        source_entity_type="agent_watch", source_entity_id=watch.id,
        recipient_id=watch.agent_member_id, recipient_type="agent",
        payload={"event_type": "watch.fired", "watch_id": str(watch.id), "condition": watch.condition,
                 "target": watch.target, "fact": fact, "content": _describe(watch, fact)},
        status="pending",
    )
    db.add(event)
    await db.flush()
    await assign_recipient_seq(db, event)


def _live():
    return and_(AgentWatch.status == "active", AgentWatch.expires_at > _now())


async def _waiting(db: AsyncSession, condition: str, *, repo: str | None = None, pr: int | None = None) -> list[AgentWatch]:
    q = select(AgentWatch).where(AgentWatch.condition == condition, _live())
    if repo is not None:
        q = q.where(AgentWatch.target["repo"].astext == repo, AgentWatch.target["pr"].astext == str(pr))
    return list((await db.execute(q.with_for_update(skip_locked=True))).scalars().all())


# ── set · clear · list (an agent's own) ──────────────────────────────────────────────────────────────────────────────────


async def create_watch(
    db: AsyncSession, *, org_id: uuid.UUID, project_id: uuid.UUID, agent_member_id: uuid.UUID, body: WatchCreate,
) -> AgentWatch:
    target = _parse_target(body.condition, body.target)
    fire_now: dict | None = None
    if isinstance(target, PrTarget) or target.pr is not None:
        pr = await _pr(db, target.repo, target.pr)
        if pr is None:
            raise WatchError(422, "PR_NOT_SEEN", "the server has not seen this PR yet — try again after a push or a CI run")
        if pr.state == "closed" and pr.merged_at is None:
            raise WatchError(422, "PR_CLOSED_UNMERGED", "this PR was closed without merging — reopen it to watch it")
        if body.condition == "github.pr_checks_completed" and pr.state != "open":
            raise WatchError(422, "PR_NOT_OPEN", "checks are watched on an open PR")
        if body.condition == "github.pr_merged" and pr.merged_at is not None:
            fire_now = {"merged_at": pr.merged_at.isoformat(), "merge_commit": pr.merge_commit_sha, "base": pr.base_ref,
                        "already": True}
    watch = AgentWatch(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, agent_member_id=agent_member_id, condition=body.condition,
        target=target.model_dump(exclude_none=True), status="active",
        expires_at=_now() + (timedelta(hours=body.expires_in_hours) if body.expires_in_hours else DEFAULT_TTL),
    )
    db.add(watch)
    await db.flush()
    if body.condition == "deploy.serving":
        serving = await _latest_serving(db, target.service)
        if serving is not None:
            fire_now = await _serving_fact(db, target, serving)
            if fire_now:
                fire_now["already"] = True
    if fire_now:
        await _fire(db, watch, fire_now)
    return watch


def watch_view(w: AgentWatch, now: datetime | None = None) -> dict:
    now = now or _now()
    status = "expired" if w.status == "active" and w.expires_at <= now else w.status
    return {"id": str(w.id), "condition": w.condition, "target": w.target, "status": status,
            "expires_at": w.expires_at.isoformat(), "created_at": w.created_at.isoformat() if w.created_at else None,
            "fired_at": w.fired_at.isoformat() if w.fired_at else None, "fired_fact": w.fired_fact}


async def list_watches(db: AsyncSession, agent_member_id: uuid.UUID, *, include_done: bool) -> list[AgentWatch]:
    q = select(AgentWatch).where(AgentWatch.agent_member_id == agent_member_id).order_by(AgentWatch.created_at.desc()).limit(200)
    if not include_done:
        q = q.where(_live())
    return list((await db.execute(q)).scalars().all())


async def cancel_watch(db: AsyncSession, agent_member_id: uuid.UUID, watch_id: uuid.UUID) -> AgentWatch:
    w = (await db.execute(
        select(AgentWatch).where(AgentWatch.id == watch_id, AgentWatch.agent_member_id == agent_member_id).with_for_update()
    )).scalar_one_or_none()
    if w is None:
        raise WatchError(404, "watch_not_found", "no such watch of this agent")
    if w.status == "active":
        w.status, w.cancelled_at = "cancelled", _now()
        await db.flush()
    return w


# ── what fires them ──────────────────────────────────────────────────────────────────────────────────────────────────────


def _repo_of(payload: dict) -> str | None:
    full = ((payload.get("repository") or {}).get("full_name") or "").lower()
    return full if re.match(_REPO, full or "") else None


def _ts(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


async def _upsert_pr(db: AsyncSession, repo: str, number: int, *, state: str | None, base_ref: str | None,
                     merged_at: datetime | None, merge_commit_sha: str | None) -> None:
    now = _now()
    values = {"id": uuid.uuid4(), "repo": repo, "number": number, "state": state or "open", "base_ref": base_ref,
              "merged_at": merged_at, "merge_commit_sha": merge_commit_sha.lower() if merge_commit_sha else None,
              "first_seen_at": now, "last_seen_at": now}
    update = {"last_seen_at": now}
    if state is not None:  # a check suite only says «seen»; a pull_request event says what the PR is
        t = GithubPullRequest.__table__
        update.update({"state": state, "base_ref": base_ref,
                       "merged_at": merged_at if merged_at is not None else t.c.merged_at,
                       "merge_commit_sha": values["merge_commit_sha"] if merged_at is not None else t.c.merge_commit_sha})
    await db.execute(pg_insert(GithubPullRequest).values(**values).on_conflict_do_update(
        constraint="uq_github_pull_requests_repo_number", set_=update,
    ))


async def on_github_event(db: AsyncSession, event: str, payload: dict) -> int:
    """Called at the end of the webhook handler, in its transaction (after the delivery-id dedup). Returns watches fired."""
    repo = _repo_of(payload)
    if repo is None:
        return 0
    fired = 0
    if event == "pull_request" and isinstance(payload.get("pull_request"), dict):
        pr = payload["pull_request"]
        number = int(pr.get("number") or payload.get("number") or 0)
        if number <= 0:
            return 0
        merged_at = _ts(pr.get("merged_at")) if pr.get("merged") else None
        await _upsert_pr(db, repo, number, state=pr.get("state") if pr.get("state") in ("open", "closed") else None,
                         base_ref=(pr.get("base") or {}).get("ref"), merged_at=merged_at,
                         merge_commit_sha=pr.get("merge_commit_sha") if merged_at else None)
        if payload.get("action") == "closed" and merged_at is not None:
            fact = {"merged_at": merged_at.isoformat(), "merge_commit": (pr.get("merge_commit_sha") or "").lower(),
                    "base": (pr.get("base") or {}).get("ref"), "merged_by": ((pr.get("merged_by") or {}).get("login"))}
            for w in await _waiting(db, "github.pr_merged", repo=repo, pr=number):
                await _fire(db, w, fact)
                fired += 1
    elif event == "check_suite" and payload.get("action") == "completed" and isinstance(payload.get("check_suite"), dict):
        suite = payload["check_suite"]
        for ref in suite.get("pull_requests") or []:
            number = int(ref.get("number") or 0)
            if number <= 0:
                continue
            await _upsert_pr(db, repo, number, state=None, base_ref=None, merged_at=None, merge_commit_sha=None)
            fact = {"conclusion": suite.get("conclusion"), "head_sha": (suite.get("head_sha") or "").lower(),
                    "app": ((suite.get("app") or {}).get("slug"))}
            for w in await _waiting(db, "github.pr_checks_completed", repo=repo, pr=number):
                await _fire(db, w, fact)
                fired += 1
    return fired


async def record_serving(db: AsyncSession, *, service: str, revision: str, commit_sha: str) -> int:
    """A revision's first outside request: recorded once per revision (UNIQUE); the watches it serves fire. Returns fired."""
    inserted = (await db.execute(
        pg_insert(DeployServing).values(id=uuid.uuid4(), service=service, revision=revision, commit_sha=commit_sha.lower())
        .on_conflict_do_nothing(constraint="uq_deploy_servings_service_revision").returning(DeployServing.id)
    )).scalar_one_or_none()
    if inserted is None:
        return 0
    serving = await db.get(DeployServing, inserted)
    fired = 0
    for w in await _waiting(db, "deploy.serving"):
        if w.target.get("service") != service:
            continue
        fact = await _serving_fact(db, ServingTarget.model_validate(w.target), serving)
        if fact:
            await _fire(db, w, fact)
            fired += 1
    return fired


# ── the serving report (once per process, on its first outside request) ────────────────────────────────────────────────

_reported = False
_NOT_OUTSIDE = ("/api/v2/health", "/health", "/healthz", "/readyz", "/favicon.ico")


def note_request(path: str) -> None:
    """The first request that is not a health probe: this revision reports the commit it serves, once, in the background.
    A revision that gets no outside traffic (0%) never reports. Nothing to report without both a commit and a revision."""
    global _reported
    if _reported or path.startswith(_NOT_OUTSIDE):
        return
    from app.core.build_info import build_info

    info = build_info()
    if info["commit_sha"] == "unknown" or info["revision"] == "unknown":
        return
    _reported = True
    import asyncio

    asyncio.get_running_loop().create_task(_report(info["revision"], info["commit_sha"]))


async def _report(revision: str, commit_sha: str) -> None:
    global _reported
    from app.core.database import async_session_factory

    try:
        async with async_session_factory() as s:
            fired = await record_serving(s, service="backend", revision=revision, commit_sha=commit_sha)
            await s.commit()
        logger.info("deploy serving reported revision=%s commit=%s watches_fired=%s", revision, commit_sha[:12], fired)
    except Exception:  # noqa: BLE001 — never in a request's way; the next request tries again
        _reported = False
        logger.warning("deploy serving report failed revision=%s", revision, exc_info=True)
