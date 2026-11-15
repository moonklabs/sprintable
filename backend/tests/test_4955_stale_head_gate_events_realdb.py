"""story 4955 — a late CI-completed webhook of an OLD commit must not turn a pending merge gate back to that commit.

Real incident shape: the PR gets a new push (head B) while the CI of the previous head A is still running. The gate is rebound to B by the `synchronize` webhook; then A's CI finishes and
its `check_suite` / `workflow_run` / `status` webhook arrives. Before the fix that event re-evaluated the gate with head A (setting the approval anchor / the CI result of A on B's gate) and
the background publish rebound the gate's check-run to A — the real head B was left without its `sprintable/gate` check and the PR froze.

The fix: `gate.pr_head_observed_sha` (written atomically with the watermark `pr_head_observed_at` by the lifecycle webhooks) is the PR's current head; a CI event whose commit differs
from it is ignored by the reconcile (existing gate and sha-fallback siblings) and by `publish_gate_check`. NULL (no lifecycle webhook seen) = the old behaviour.
"""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy import select, text

from tests.test_3039_merge_gate_ci_reeval_webhook_realdb import (
    _REAL_DB_URL,
    _check_suite_completed_payload,
    _dispose_global_engine_after_test,  # noqa: F401 — autouse fixture
    _get_gate,
    _post_app,
    _seed_installation,
    _seed_org_project_story,
    _session_factory,
    anyio_backend,  # noqa: F401 — fixture
)

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.destructive_schema,
]

SHA_A = "a" * 40
SHA_B = "b" * 40
T1 = "2026-11-15T10:00:00Z"
T2 = "2026-11-15T10:05:00Z"


def _lifecycle(action, *, pr_number, installation_id, head_sha, updated_at, title):
    return {
        "action": action,
        "repository": {"full_name": "moonklabs/sprintable"},
        "installation": {"id": installation_id},
        "pull_request": {
            "number": pr_number, "title": title, "body": "", "merged": False, "updated_at": updated_at,
            "head": {"sha": head_sha, "ref": f"feat-branch-{pr_number}"},
        },
    }


class _Recorder:
    """create_check_run stand-in that remembers which commits got a check-run."""

    def __init__(self):
        self.shas: list[str] = []

    async def __call__(self, installation_id, repo, head_sha, **kwargs):
        self.shas.append(head_sha)
        return {"id": 9000 + len(self.shas)}


async def _open_then_push(Session, *, pr_number, installation_id, with_story_tag=True):
    """PR opened on head A, then pushed to head B (synchronize). Returns (story_id, rec)."""
    async with Session() as s:
        org, _p, story = await _seed_org_project_story(s, with_participation=True)
        await _seed_installation(s, org, installation_id=installation_id)
        story_id = story.id
    rec = _Recorder()
    with patch("app.services.gate_github_check.create_check_run", rec), \
         patch("app.services.gate_github_check.list_check_runs_for_ref", AsyncMock(return_value=[])), \
         patch("app.core.database.async_session_factory", Session):
        for action, sha, ts in (("opened", SHA_A, T1), ("synchronize", SHA_B, T2)):
            resp = await _post_app(
                _lifecycle(action, pr_number=pr_number, installation_id=installation_id, head_sha=sha,
                           updated_at=ts, title=f"[SID:{story_id}] stale head {pr_number}"),
                Session, delivery_id=f"dlv-{uuid.uuid4().hex[:8]}",
            )
            assert resp.status_code == 200, resp.text
    return story_id, rec


def _github_head(real_head, updated_at=None):
    """GitHub's own answer for «the PR's current head» (the stale-head rule asks it, once, when a CI event's commit differs from the recorded head). None = the lookup fails."""
    return AsyncMock(return_value=({"head": {"sha": real_head}, "updated_at": updated_at} if real_head else None))


async def _ci_completed(Session, *, pr_number, installation_id, head_sha, conclusion="success", rec=None, real_head=SHA_B, real_updated_at=None):
    rec = rec or _Recorder()
    with patch("app.services.gate_github_check.create_check_run", rec), \
         patch("app.services.gate_github_check.list_check_runs_for_ref", AsyncMock(return_value=[])), \
         patch("app.services.github_app.get_pull_request", _github_head(real_head, real_updated_at)), \
         patch("app.core.database.async_session_factory", Session):
        resp = await _post_app(
            _check_suite_completed_payload(
                pr_number=pr_number, installation_id=installation_id, head_sha=head_sha, conclusion=conclusion,
            ),
            Session, delivery_id=f"dlv-{uuid.uuid4().hex[:8]}", event="check_suite",
        )
        assert resp.status_code == 200, resp.text
    return rec


@pytest.mark.anyio
async def test_ac1_late_ci_of_the_old_head_does_not_turn_the_gate_back_to_it():
    engine, Session = await _session_factory()
    try:
        story_id, rec = await _open_then_push(Session, pr_number=4955, installation_id=695501)
        async with Session() as s:
            gate = await _get_gate(s, story_id, 4955)
            assert gate.pr_head_observed_sha == SHA_B, "the lifecycle webhooks must record the current head"
            assert gate.github_check_run_sha == SHA_B, "precondition: the gate is bound to the new head B"
            ci_before = (gate.neutral_facts or {}).get("ci_result")

        # A's CI finishes AFTER the push to B
        late = await _ci_completed(Session, pr_number=4955, installation_id=695501, head_sha=SHA_A, conclusion="failure")

        async with Session() as s:
            gate = await _get_gate(s, story_id, 4955)
            assert gate.github_check_run_sha == SHA_B, "a late CI event of the old commit rebound the gate to A"
            assert gate.pr_head_observed_sha == SHA_B
            assert (gate.neutral_facts or {}).get("ci_result") == ci_before, "the old commit's CI result leaked onto B's gate"
            assert gate.approved_head_sha in (None, SHA_B), f"approval anchor set to the old commit: {gate.approved_head_sha}"
        assert SHA_A not in late.shas, "a check-run was published for the old commit"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_ac2_ci_of_the_current_head_still_updates_the_gate():
    engine, Session = await _session_factory()
    try:
        story_id, _rec = await _open_then_push(Session, pr_number=4956, installation_id=695502)
        await _ci_completed(Session, pr_number=4956, installation_id=695502, head_sha=SHA_B, conclusion="success")
        async with Session() as s:
            gate = await _get_gate(s, story_id, 4956)
            assert (gate.neutral_facts or {}).get("ci_result") == "pass", f"B's own CI no longer updates its gate: {gate.neutral_facts}"
            assert gate.github_check_run_sha == SHA_B
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_unknown_head_keeps_the_old_behaviour():
    """NULL pr_head_observed_sha (no lifecycle webhook seen on this gate yet) → the rule is silent: the event is processed as before."""
    engine, Session = await _session_factory()
    try:
        story_id, _rec = await _open_then_push(Session, pr_number=4957, installation_id=695503)
        async with Session() as s:
            await s.execute(text("UPDATE gate SET pr_head_observed_sha = NULL WHERE pr_number = 4957"))
            await s.commit()
        await _ci_completed(Session, pr_number=4957, installation_id=695503, head_sha=SHA_A, conclusion="success")
        async with Session() as s:
            gate = await _get_gate(s, story_id, 4957)
            assert (gate.neutral_facts or {}).get("ci_result") == "pass", "with no observed head the event must still be processed"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_a_late_old_lifecycle_webhook_does_not_turn_the_observed_head_back():
    engine, Session = await _session_factory()
    try:
        story_id, _rec = await _open_then_push(Session, pr_number=4958, installation_id=695504)
        # GitHub does not promise delivery order: the synchronize of A (updated_at T1) arrives again after B's (T2)
        with patch("app.services.gate_github_check.create_check_run", _Recorder()), \
             patch("app.services.gate_github_check.list_check_runs_for_ref", AsyncMock(return_value=[])), \
             patch("app.core.database.async_session_factory", Session):
            resp = await _post_app(
                _lifecycle("synchronize", pr_number=4958, installation_id=695504, head_sha=SHA_A, updated_at=T1,
                           title=f"[SID:{story_id}] stale head 4958"),
                Session, delivery_id=f"dlv-{uuid.uuid4().hex[:8]}",
            )
            assert resp.status_code == 200, resp.text
        async with Session() as s:
            gate = await _get_gate(s, story_id, 4958)
            assert gate.pr_head_observed_sha == SHA_B, "an older lifecycle delivery overwrote the observed head"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_publish_gate_check_ignores_a_commit_that_is_not_the_current_head():
    from app.services.gate_github_check import publish_gate_check

    engine, Session = await _session_factory()
    try:
        story_id, _rec = await _open_then_push(Session, pr_number=4959, installation_id=695505)
        async with Session() as s:
            gate = await _get_gate(s, story_id, 4959)
            gate_id, org_id = gate.id, gate.org_id
        rec = _Recorder()
        with patch("app.services.gate_github_check.create_check_run", rec), \
             patch("app.services.gate_github_check.update_check_run", AsyncMock(return_value={"id": 1})), \
             patch("app.services.gate_github_check.list_check_runs_for_ref", AsyncMock(return_value=[])), \
             patch("app.core.database.async_session_factory", Session):
            await publish_gate_check(org_id, gate_id, head_sha=SHA_A, repo_full_name="moonklabs/sprintable", pr_number=4959)
        assert rec.shas == [], "publish rebound the check-run to the old commit"
        async with Session() as s:
            gate = await _get_gate(s, story_id, 4959)
            assert gate.github_check_run_sha == SHA_B
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_sha_fallback_siblings_of_a_moved_on_pr_are_skipped():
    """The sha fallback (a CI event whose pr_number matches no gate) must not re-evaluate a gate still bound to the old commit whose PR has moved on."""
    from app.services.merge_verdict_gate import reconcile_merge_gate_with_real_evidence

    engine, Session = await _session_factory()
    try:
        story_id, _rec = await _open_then_push(Session, pr_number=4960, installation_id=695506)
        async with Session() as s:
            gate = await _get_gate(s, story_id, 4960)
            gate_id, org_id = gate.id, gate.org_id
            await s.execute(text("UPDATE gate SET github_check_run_sha = :a WHERE id = CAST(:i AS uuid)"), {"a": SHA_A, "i": gate_id})
            await s.commit()
        # an unrelated story id + pr_number 0: only the sha fallback can reach the gate
        async with Session() as s:
            with patch("app.services.github_app.get_pull_request", _github_head(SHA_B)):
                await reconcile_merge_gate_with_real_evidence(
                    s, org_id, uuid.uuid4(), pr_number=0, repo="moonklabs/sprintable", ci_result="fail", merged=False, head_sha=SHA_A,
                )
            await s.commit()
        async with Session() as s:
            gate = (await s.execute(select(type(gate)).where(type(gate).id == gate_id))).scalar_one()
            assert (gate.neutral_facts or {}).get("ci_result") != "fail", "the sibling fallback re-evaluated a gate whose PR moved on"
        # control: with no observed head the same call does reach the gate
        async with Session() as s:
            await s.execute(text("UPDATE gate SET pr_head_observed_sha = NULL WHERE id = CAST(:i AS uuid)"), {"i": gate_id})
            await s.commit()
        async with Session() as s:
            with patch("app.services.github_app.get_pull_request", _github_head(SHA_B)):
                await reconcile_merge_gate_with_real_evidence(
                    s, org_id, uuid.uuid4(), pr_number=0, repo="moonklabs/sprintable", ci_result="fail", merged=False, head_sha=SHA_A,
                )
            await s.commit()
        async with Session() as s:
            gate = (await s.execute(select(type(gate)).where(type(gate).id == gate_id))).scalar_one()
            assert (gate.neutral_facts or {}).get("ci_result") == "fail", "control failed: the fallback must reach the gate when the head is unknown"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_a_gate_created_by_the_opened_webhook_already_knows_the_current_head():
    """The gate is auto-created on `opened` (no push yet): it must learn the head right there — not only from a later synchronize."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, _p, story = await _seed_org_project_story(s, with_participation=True)
            await _seed_installation(s, org, installation_id=695507)
            story_id = story.id
        with patch("app.services.gate_github_check.create_check_run", _Recorder()), \
             patch("app.services.gate_github_check.list_check_runs_for_ref", AsyncMock(return_value=[])), \
             patch("app.core.database.async_session_factory", Session):
            resp = await _post_app(
                _lifecycle("opened", pr_number=4961, installation_id=695507, head_sha=SHA_A, updated_at=T1,
                           title=f"[SID:{story_id}] stale head 4961"),
                Session, delivery_id=f"dlv-{uuid.uuid4().hex[:8]}",
            )
            assert resp.status_code == 200, resp.text
        async with Session() as s:
            gate = await _get_gate(s, story_id, 4961)
            assert gate.pr_head_observed_sha == SHA_A
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_a_merge_event_is_never_dropped_by_the_stale_head_rule():
    """A merge is a fact about the PR, not about a commit's CI: reconcile with merged=True is processed even when its head is not the observed one."""
    from app.services.merge_verdict_gate import reconcile_merge_gate_with_real_evidence

    engine, Session = await _session_factory()
    try:
        story_id, _rec = await _open_then_push(Session, pr_number=4962, installation_id=695508)
        async with Session() as s:
            gate = await _get_gate(s, story_id, 4962)
            org_id = gate.org_id
        async with Session() as s:
            await reconcile_merge_gate_with_real_evidence(
                s, org_id, story_id, pr_number=4962, repo="moonklabs/sprintable", ci_result="pass", merged=True, head_sha=SHA_A,
            )
            await s.commit()
        async with Session() as s:
            gate = await _get_gate(s, story_id, 4962)
            assert (gate.neutral_facts or {}).get("ci_result") == "pass", "the merge event was dropped by the stale-head rule"
    finally:
        await engine.dispose()


async def _set(Session, sql, **params):
    async with Session() as s:
        await s.execute(text(sql), params)
        await s.commit()


@pytest.mark.anyio
async def test_a_lost_lifecycle_webhook_heals_through_githubs_own_answer():
    """The recorded head only comes from lifecycle webhooks: if the synchronize of B was lost, the gate still records A while the PR is at B. B's CI must NOT be dropped forever — GitHub is asked
    once for the real head: B == the event's commit → the record is corrected and the event is processed."""
    engine, Session = await _session_factory()
    try:
        story_id, _rec = await _open_then_push(Session, pr_number=4963, installation_id=695509)
        await _set(Session, "UPDATE gate SET pr_head_observed_sha = :a WHERE pr_number = 4963", a=SHA_A)  # the lost delivery: the record is behind
        await _ci_completed(Session, pr_number=4963, installation_id=695509, head_sha=SHA_B, conclusion="success", real_head=SHA_B)
        async with Session() as s:
            gate = await _get_gate(s, story_id, 4963)
            assert (gate.neutral_facts or {}).get("ci_result") == "pass", "B's CI was dropped although GitHub says B is the PR's head"
            assert gate.pr_head_observed_sha == SHA_B, "the recorded head was not corrected to GitHub's answer"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_an_old_commit_event_is_dropped_and_the_record_is_corrected_to_githubs_head():
    engine, Session = await _session_factory()
    try:
        story_id, _rec = await _open_then_push(Session, pr_number=4964, installation_id=695510)
        await _set(Session, "UPDATE gate SET pr_head_observed_sha = :c WHERE pr_number = 4964", c="c" * 40)  # the record is behind (a third commit), the event is for A, the real head is B
        await _ci_completed(Session, pr_number=4964, installation_id=695510, head_sha=SHA_A, conclusion="failure", real_head=SHA_B)
        async with Session() as s:
            gate = await _get_gate(s, story_id, 4964)
            assert (gate.neutral_facts or {}).get("ci_result") != "fail", "an old commit's CI result reached the gate"
            assert gate.pr_head_observed_sha == SHA_B
    finally:
        await engine.dispose()


SHA_C = "c" * 40


async def _lifecycle_post(Session, rec, *, pr_number, installation_id, story_id, head_sha, updated_at, action="synchronize", real_head=SHA_B):
    with patch("app.services.gate_github_check.create_check_run", rec), \
         patch("app.services.gate_github_check.list_check_runs_for_ref", AsyncMock(return_value=[])), \
         patch("app.services.github_app.get_pull_request", _github_head(real_head, "2026-11-15T10:20:00Z")), \
         patch("app.core.database.async_session_factory", Session):
        resp = await _post_app(
            _lifecycle(action, pr_number=pr_number, installation_id=installation_id, head_sha=head_sha, updated_at=updated_at,
                       title=f"[SID:{story_id}] stale head {pr_number}"),
            Session, delivery_id=f"dlv-{uuid.uuid4().hex[:8]}",
        )
        assert resp.status_code == 200, resp.text


@pytest.mark.anyio
async def test_when_githubs_head_cannot_be_confirmed_the_ci_delivery_fails_visibly_and_changes_nothing():
    """The lookup failing (twice) is never «process it» (a wrong anchor / rebind is the incident) and never a silent drop either: the CI delivery is rolled back and answered 500 — visible in GitHub's
    delivery log and re-sendable — and nothing of it is kept."""
    from app.services.gate_service import HeadUnconfirmedError

    engine, Session = await _session_factory()
    try:
        story_id, _rec = await _open_then_push(Session, pr_number=4965, installation_id=695511)
        failed_loudly = False
        try:
            with patch("app.services.gate_github_check.create_check_run", _Recorder()), \
                 patch("app.services.gate_github_check.list_check_runs_for_ref", AsyncMock(return_value=[])), \
                 patch("app.services.github_app.get_pull_request", _github_head(None)), \
                 patch("app.core.database.async_session_factory", Session):
                resp = await _post_app(
                    _check_suite_completed_payload(pr_number=4965, installation_id=695511, head_sha=SHA_A, conclusion="failure"),
                    Session, delivery_id=f"dlv-{uuid.uuid4().hex[:8]}", event="check_suite",
                )
            failed_loudly = resp.status_code >= 500
        except HeadUnconfirmedError:
            failed_loudly = True
        assert failed_loudly, "an unconfirmable CI delivery was accepted (silently dropped or processed)"
        async with Session() as s:
            gate = await _get_gate(s, story_id, 4965)
            assert (gate.neutral_facts or {}).get("ci_result") != "fail"
            assert gate.github_check_run_sha == SHA_B
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_an_unorderable_lifecycle_delivery_fails_visibly_when_githubs_head_cannot_be_confirmed():
    """Like the CI path: a lifecycle delivery that cannot be ordered and whose head GitHub cannot confirm is neither processed nor silently dropped — it is rolled back and answered 500 (re-sendable)."""
    from app.services.gate_service import HeadUnconfirmedError

    engine, Session = await _session_factory()
    try:
        story_id, _rec = await _open_then_push(Session, pr_number=4981, installation_id=695527)
        await _set(Session, "UPDATE gate SET status = 'approved', approved_head_sha = :b WHERE pr_number = 4981", b=SHA_B)
        failed_loudly = False
        try:
            with patch("app.services.gate_github_check.create_check_run", _Recorder()), \
                 patch("app.services.gate_github_check.list_check_runs_for_ref", AsyncMock(return_value=[])), \
                 patch("app.services.github_app.get_pull_request", _github_head(None)), \
                 patch("app.core.database.async_session_factory", Session):
                resp = await _post_app(
                    _lifecycle("reopened", pr_number=4981, installation_id=695527, head_sha=SHA_A, updated_at=T2, title=f"[SID:{story_id}] stale head 4981"),
                    Session, delivery_id=f"dlv-{uuid.uuid4().hex[:8]}",
                )
            failed_loudly = resp.status_code >= 500
        except HeadUnconfirmedError:
            failed_loudly = True
        assert failed_loudly, "an unorderable lifecycle delivery with an unconfirmable head was accepted"
        async with Session() as s:
            gate = await _get_gate(s, story_id, 4981)
            assert gate.status == "approved" and gate.pr_head_observed_sha == SHA_B
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_a_force_push_cycle_in_one_second_cannot_make_a_delayed_old_push_the_head():
    """A → B → back to A inside one second: the A delivery arrived first (the record is A); the delayed B delivery announces B as the head, but GitHub says A — B is not the head and its CI is not mistaken for the head's."""
    engine, Session = await _session_factory()
    try:
        story_id, _rec = await _open_then_push(Session, pr_number=4982, installation_id=695528)
        await _set(Session, "UPDATE gate SET pr_head_observed_sha = :a WHERE pr_number = 4982", a=SHA_A)  # watermark stays T2
        await _lifecycle_post(Session, _Recorder(), pr_number=4982, installation_id=695528, story_id=story_id, head_sha=SHA_B, updated_at=T2, real_head=SHA_A)
        async with Session() as s:
            assert (await _get_gate(s, story_id, 4982)).pr_head_observed_sha == SHA_A, "a delayed old push became the head"
        await _ci_completed(Session, pr_number=4982, installation_id=695528, head_sha=SHA_B, conclusion="failure", real_head=SHA_A)
        async with Session() as s:
            assert (await _get_gate(s, story_id, 4982)).neutral_facts.get("ci_result") != "fail"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_a_lifecycle_delivery_in_the_same_second_is_recorded_and_its_check_is_published():
    """One-second resolution: two pushes in the same second cannot be ordered by time — GitHub settles which one is the head (otherwise the publish rejects the real new head and the gate freezes)."""
    engine, Session = await _session_factory()
    try:
        story_id, _rec = await _open_then_push(Session, pr_number=4966, installation_id=695512)
        rec = _Recorder()
        await _lifecycle_post(Session, rec, pr_number=4966, installation_id=695512, story_id=story_id, head_sha=SHA_C, updated_at=T2, real_head=SHA_C)  # same second as B's; GitHub says C is the head
        async with Session() as s:
            gate = await _get_gate(s, story_id, 4966)
            assert gate.pr_head_observed_sha == SHA_C
            assert gate.github_check_run_sha == SHA_C, "the gate's check was not bound to the head the last webhook announced"
        assert SHA_C in rec.shas
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_a_lifecycle_delivery_without_updated_at_is_recorded_and_its_check_is_published():
    engine, Session = await _session_factory()
    try:
        story_id, _rec = await _open_then_push(Session, pr_number=4967, installation_id=695513)
        rec = _Recorder()
        await _lifecycle_post(Session, rec, pr_number=4967, installation_id=695513, story_id=story_id, head_sha=SHA_C, updated_at=None, real_head=SHA_C)
        async with Session() as s:
            gate = await _get_gate(s, story_id, 4967)
            assert gate.pr_head_observed_sha == SHA_C
            assert gate.github_check_run_sha == SHA_C
        assert SHA_C in rec.shas
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_an_older_lifecycle_delivery_cannot_seed_a_missing_head_past_a_newer_watermark():
    """A gate that has a watermark (T2) but no recorded head yet (it predates the column): a late A at T1 is older than the watermark — it must not become the head."""
    engine, Session = await _session_factory()
    try:
        story_id, _rec = await _open_then_push(Session, pr_number=4970, installation_id=695516)
        await _set(Session, "UPDATE gate SET pr_head_observed_sha = NULL WHERE pr_number = 4970")
        await _lifecycle_post(Session, _Recorder(), pr_number=4970, installation_id=695516, story_id=story_id, head_sha=SHA_A, updated_at=T1)
        async with Session() as s:
            gate = await _get_gate(s, story_id, 4970)
            assert gate.pr_head_observed_sha is None, f"an older delivery seeded the head: {gate.pr_head_observed_sha}"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_the_heal_moves_the_watermark_so_a_delayed_older_lifecycle_webhook_cannot_turn_it_back():
    from datetime import datetime, timezone

    engine, Session = await _session_factory()
    try:
        story_id, _rec = await _open_then_push(Session, pr_number=4971, installation_id=695517)
        # the synchronize of B was lost: the record is behind (A at T1) …
        await _set(Session, "UPDATE gate SET pr_head_observed_sha = :a, pr_head_observed_at = :t1 WHERE pr_number = 4971", a=SHA_A, t1=datetime(2026, 11, 15, 10, 0, tzinfo=timezone.utc))
        # … B's CI arrives; GitHub says the head is B (PR updated at 10:10)
        await _ci_completed(Session, pr_number=4971, installation_id=695517, head_sha=SHA_B, real_head=SHA_B, real_updated_at="2026-11-15T10:10:00Z")
        async with Session() as s:
            assert (await _get_gate(s, story_id, 4971)).pr_head_observed_sha == SHA_B
        # a delayed lifecycle webhook of A (10:02 — newer than the old watermark 10:00, older than GitHub's 10:10) arrives
        await _lifecycle_post(Session, _Recorder(), pr_number=4971, installation_id=695517, story_id=story_id, head_sha=SHA_A, updated_at="2026-11-15T10:02:00Z")
        async with Session() as s:
            gate = await _get_gate(s, story_id, 4971)
            assert gate.pr_head_observed_sha == SHA_B, "a delayed older lifecycle webhook turned the healed head back"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_the_heal_is_a_compare_and_set_a_newer_lifecycle_head_is_never_overwritten():
    from app.services.gate_service import set_observed_head

    engine, Session = await _session_factory()
    try:
        story_id, _rec = await _open_then_push(Session, pr_number=4972, installation_id=695518)
        async with Session() as s:
            gate_id = (await _get_gate(s, story_id, 4972)).id
        await _set(Session, "UPDATE gate SET pr_head_observed_sha = :c WHERE id = CAST(:i AS uuid)", c=SHA_C, i=gate_id)  # a lifecycle webhook committed C meanwhile
        async with Session() as s:
            applied = await set_observed_head(s, gate_id, SHA_B, expected=SHA_A)  # the caller judged against A
            await s.commit()
        assert applied is False
        async with Session() as s:
            assert (await _get_gate(s, story_id, 4972)).pr_head_observed_sha == SHA_C, "the heal overwrote a newer lifecycle head"
        async with Session() as s:
            assert await set_observed_head(s, gate_id, SHA_B, expected=SHA_C) is True
            await s.commit()
        async with Session() as s:
            assert (await _get_gate(s, story_id, 4972)).pr_head_observed_sha == SHA_B
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_an_approved_gate_still_publishes_its_check_from_the_anchor_even_when_the_record_is_behind():
    """A human approval records the anchor (B) and publishes without a head: the stale-head rule must never suppress that (the required success check would stay missing)."""
    from app.services.gate_github_check import publish_gate_check

    engine, Session = await _session_factory()
    try:
        story_id, _rec = await _open_then_push(Session, pr_number=4968, installation_id=695514)
        async with Session() as s:
            gate = await _get_gate(s, story_id, 4968)
            gate_id, org_id = gate.id, gate.org_id
        await _set(Session, "UPDATE gate SET status = 'approved', approved_head_sha = :b, pr_head_observed_sha = :a, github_check_run_id = NULL, github_check_run_sha = NULL WHERE id = CAST(:i AS uuid)",
                   a=SHA_A, b=SHA_B, i=gate_id)
        rec = _Recorder()
        with patch("app.services.gate_github_check.create_check_run", rec), \
             patch("app.services.gate_github_check.list_check_runs_for_ref", AsyncMock(return_value=[])), \
             patch("app.core.database.async_session_factory", Session):
            await publish_gate_check(org_id, gate_id, repo_full_name="moonklabs/sprintable", pr_number=4968)
        assert rec.shas == [SHA_B], f"the approved gate's check was suppressed or published for another commit: {rec.shas}"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_a_manual_reevaluation_corrects_the_recorded_head_to_the_one_it_just_read():
    from app.services.merge_verdict_gate import reconcile_merge_gate_with_real_evidence

    engine, Session = await _session_factory()
    try:
        story_id, _rec = await _open_then_push(Session, pr_number=4969, installation_id=695515)
        async with Session() as s:
            gate = await _get_gate(s, story_id, 4969)
            org_id = gate.org_id
        await _set(Session, "UPDATE gate SET pr_head_observed_sha = :a WHERE pr_number = 4969", a=SHA_A)  # the record is behind
        async with Session() as s:
            await reconcile_merge_gate_with_real_evidence(
                s, org_id, story_id, pr_number=4969, repo="moonklabs/sprintable", ci_result="pass", merged=False, head_sha=SHA_B, head_is_current=True,
            )
            await s.commit()
        async with Session() as s:
            gate = await _get_gate(s, story_id, 4969)
            assert gate.pr_head_observed_sha == SHA_B
            assert (gate.neutral_facts or {}).get("ci_result") == "pass"
    finally:
        await engine.dispose()


def test_the_manual_reevaluation_endpoint_tells_reconcile_that_the_head_it_read_is_current():
    """Source check (the endpoint itself is exercised by the 2893 pr3 tests, which do not cover the head record): `_reevaluate_gate_endpoint` just read the PR's real head from GitHub, so it must
    pass `head_is_current=True` — otherwise the manual escape hatch for a gate with a stale recorded head would judge GitHub's own answer against the stale record."""
    from pathlib import Path

    src = Path(__file__).resolve().parents[1].joinpath("app/routers/gates.py").read_text()
    body = src[src.index("async def _reevaluate_gate_endpoint"):]
    body = body[: body.index("class GateVoidRequest")]
    assert "head_is_current=True" in body


@pytest.mark.anyio
async def test_the_heal_moves_the_watermark_even_when_githubs_head_equals_the_record():
    """B → C → B with the last lifecycle webhook lost: the record says B (watermark T0). C's late CI asks GitHub: the head is B (PR updated at 10:10) — the event is ignored AND the watermark moves, so a delayed
    lifecycle webhook of C (10:05, newer than T0, older than GitHub's 10:10) cannot record C and publish the check on the old commit."""
    from datetime import datetime, timezone

    engine, Session = await _session_factory()
    try:
        story_id, _rec = await _open_then_push(Session, pr_number=4973, installation_id=695519)
        await _set(Session, "UPDATE gate SET pr_head_observed_sha = :b, pr_head_observed_at = :t0 WHERE pr_number = 4973", b=SHA_B, t0=datetime(2026, 11, 15, 10, 0, tzinfo=timezone.utc))
        await _ci_completed(Session, pr_number=4973, installation_id=695519, head_sha=SHA_C, conclusion="failure", real_head=SHA_B, real_updated_at="2026-11-15T10:10:00Z")
        await _lifecycle_post(Session, _Recorder(), pr_number=4973, installation_id=695519, story_id=story_id, head_sha=SHA_C, updated_at="2026-11-15T10:05:00Z")
        async with Session() as s:
            gate = await _get_gate(s, story_id, 4973)
            assert gate.pr_head_observed_sha == SHA_B, "a delayed older lifecycle webhook recorded the old commit as the head"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_a_merge_events_publish_is_never_judged_stale():
    """A merge announces the PR's final head: the queued publication must not be rejected because the record is behind."""
    from app.services.gate_github_check import publish_gate_check

    engine, Session = await _session_factory()
    try:
        story_id, _rec = await _open_then_push(Session, pr_number=4974, installation_id=695520)
        async with Session() as s:
            gate = await _get_gate(s, story_id, 4974)
            gate_id, org_id = gate.id, gate.org_id
        await _set(Session, "UPDATE gate SET pr_head_observed_sha = :a, github_check_run_id = NULL, github_check_run_sha = NULL WHERE id = CAST(:i AS uuid)", a=SHA_A, i=gate_id)
        rec = _Recorder()
        with patch("app.services.gate_github_check.create_check_run", rec), \
             patch("app.services.gate_github_check.list_check_runs_for_ref", AsyncMock(return_value=[])), \
             patch("app.core.database.async_session_factory", Session):
            await publish_gate_check(org_id, gate_id, head_sha=SHA_B, repo_full_name="moonklabs/sprintable", pr_number=4974, head_is_final=True)
        assert rec.shas == [SHA_B], f"the merge event's publication was judged stale: {rec.shas}"
    finally:
        await engine.dispose()


def test_the_ci_reconcile_queues_the_merge_flag_for_a_merge_event():
    """Source check: verdict_capture's reconcile publication entry carries `head_is_final` for a merge event (the end-to-end merge path needs a signed closed webhook; the publish side is tested above)."""
    from pathlib import Path

    src = Path(__file__).resolve().parents[1].joinpath("app/routers/verdict_capture.py").read_text()
    assert '**({"head_is_final": True} if merged else {})' in src


@pytest.mark.anyio
async def test_a_manual_reevaluation_does_not_evaluate_a_head_a_lifecycle_webhook_has_already_passed():
    """The head the caller read from GitHub is older than a lifecycle head that committed meanwhile (C): the compare-and-set fails and the re-evaluation must not set the anchor / bind the check on B."""
    from app.services import merge_verdict_gate as mvg
    from app.services.gate_service import set_observed_head as real_set

    engine, Session = await _session_factory()
    try:
        story_id, _rec = await _open_then_push(Session, pr_number=4975, installation_id=695521)
        async with Session() as s:
            gate_id, org_id = (await _get_gate(s, story_id, 4975)).id, (await _get_gate(s, story_id, 4975)).org_id

        async def racing_set(session, gid, sha, **kw):
            await _set(Session, "UPDATE gate SET pr_head_observed_sha = :c WHERE id = CAST(:i AS uuid)", c=SHA_C, i=gid)  # the lifecycle webhook commits C between the read and the CAS
            return await real_set(session, gid, sha, **kw)

        async with Session() as s:
            with patch.object(mvg, "set_observed_head", racing_set):
                result = await mvg.reconcile_merge_gate_with_real_evidence(
                    s, org_id, story_id, pr_number=4975, repo="moonklabs/sprintable", ci_result="pass", merged=False, head_sha=SHA_B, head_is_current=True,
                )
            await s.commit()
        assert result is None, "the re-evaluation went ahead on an older head"
        async with Session() as s:
            gate = await _get_gate(s, story_id, 4975)
            assert gate.pr_head_observed_sha == SHA_C
            assert (gate.neutral_facts or {}).get("ci_result") != "pass"
            assert gate.approved_head_sha is None, "the anchor was set from an older head"
    finally:
        await engine.dispose()


SHA_Z = "d" * 40


@pytest.mark.anyio
async def test_a_late_old_lifecycle_delivery_in_the_same_second_cannot_pass_for_the_head_and_its_old_ci_is_still_ignored():
    """A and B pushed in the same second, delivered B then A: A is not B's successor — the record stays B, so A's late CI is not mistaken for the head's."""
    engine, Session = await _session_factory()
    try:
        story_id, _rec = await _open_then_push(Session, pr_number=4976, installation_id=695522)
        await _lifecycle_post(Session, _Recorder(), pr_number=4976, installation_id=695522, story_id=story_id, head_sha=SHA_A, updated_at=T2)
        async with Session() as s:
            assert (await _get_gate(s, story_id, 4976)).pr_head_observed_sha == SHA_B, "a late older delivery in the same second became the head"
        await _ci_completed(Session, pr_number=4976, installation_id=695522, head_sha=SHA_A, conclusion="failure", real_head=SHA_B)
        async with Session() as s:
            gate = await _get_gate(s, story_id, 4976)
            assert (gate.neutral_facts or {}).get("ci_result") != "fail"
            assert gate.github_check_run_sha == SHA_B
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_a_late_old_lifecycle_delivery_without_updated_at_cannot_pass_for_the_head():
    engine, Session = await _session_factory()
    try:
        story_id, _rec = await _open_then_push(Session, pr_number=4977, installation_id=695523)
        await _lifecycle_post(Session, _Recorder(), pr_number=4977, installation_id=695523, story_id=story_id, head_sha=SHA_A, updated_at=None)
        async with Session() as s:
            assert (await _get_gate(s, story_id, 4977)).pr_head_observed_sha == SHA_B
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_one_failed_github_lookup_does_not_drop_a_legitimate_ci_event():
    """The webhook is answered 200 either way and GitHub does not redeliver: one transient lookup failure is retried once before the event is ignored."""
    engine, Session = await _session_factory()
    try:
        story_id, _rec = await _open_then_push(Session, pr_number=4978, installation_id=695524)
        await _set(Session, "UPDATE gate SET pr_head_observed_sha = :a WHERE pr_number = 4978", a=SHA_A)  # the record is behind: B's CI needs GitHub's answer
        flaky = AsyncMock(side_effect=[None, {"head": {"sha": SHA_B}, "updated_at": "2026-11-15T10:10:00Z"}])
        rec = _Recorder()
        with patch("app.services.gate_github_check.create_check_run", rec), \
             patch("app.services.gate_github_check.list_check_runs_for_ref", AsyncMock(return_value=[])), \
             patch("app.services.github_app.get_pull_request", flaky), \
             patch("app.core.database.async_session_factory", Session):
            resp = await _post_app(
                _check_suite_completed_payload(pr_number=4978, installation_id=695524, head_sha=SHA_B, conclusion="success"),
                Session, delivery_id=f"dlv-{uuid.uuid4().hex[:8]}", event="check_suite",
            )
            assert resp.status_code == 200, resp.text
        async with Session() as s:
            assert (await _get_gate(s, story_id, 4978)).neutral_facts.get("ci_result") == "pass", "a transient lookup failure dropped the legitimate CI event"
        assert flaky.await_count == 2
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_a_lifecycle_delivery_that_cannot_be_ordered_and_is_the_real_head_is_recorded_and_published():
    """ready_for_review · label alignment · base retarget carry no ordering evidence: a delivery in the same second as the record that announces ANOTHER head cannot be told from a late old one — GitHub is asked once;
    when it says the delivery's commit IS the head, the record is corrected and the gate's check is published for it (otherwise the publish rejects it and, with the CI already done, the gate freezes)."""
    engine, Session = await _session_factory()
    try:
        story_id, _rec = await _open_then_push(Session, pr_number=4979, installation_id=695525)
        rec = _Recorder()
        await _lifecycle_post(Session, rec, pr_number=4979, installation_id=695525, story_id=story_id, head_sha=SHA_C, updated_at=T2, action="ready_for_review", real_head=SHA_C)
        async with Session() as s:
            gate = await _get_gate(s, story_id, 4979)
            assert gate.pr_head_observed_sha == SHA_C, "the real head was not recorded"
            assert gate.github_check_run_sha == SHA_C, "the gate's check was not bound to the real head"
        assert SHA_C in rec.shas
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_a_late_old_lifecycle_delivery_does_not_re_pend_an_approved_gate():
    """An approved gate on B; a late old delivery for A (same second, not B's successor): GitHub says B — the delivery is old: the gate stays approved (no re-pending for A)."""
    engine, Session = await _session_factory()
    try:
        story_id, _rec = await _open_then_push(Session, pr_number=4980, installation_id=695526)
        await _set(Session, "UPDATE gate SET status = 'approved', approved_head_sha = :b WHERE pr_number = 4980", b=SHA_B)
        await _lifecycle_post(Session, _Recorder(), pr_number=4980, installation_id=695526, story_id=story_id, head_sha=SHA_A, updated_at=T2, action="reopened", real_head=SHA_B)
        async with Session() as s:
            gate = await _get_gate(s, story_id, 4980)
            assert gate.status == "approved", f"a late old delivery re-pended the approved gate: {gate.status}"
            assert gate.approved_head_sha == SHA_B
            assert gate.pr_head_observed_sha == SHA_B
    finally:
        await engine.dispose()


def test_an_offset_less_github_time_is_read_as_utc_not_in_the_database_zone():
    from datetime import datetime, timezone

    from app.routers.verdict_capture import parse_pr_updated_at

    assert parse_pr_updated_at("2026-11-15T10:20:00") == datetime(2026, 11, 15, 10, 20, tzinfo=timezone.utc)
    assert parse_pr_updated_at("2026-11-15T10:20:00Z") == datetime(2026, 11, 15, 10, 20, tzinfo=timezone.utc)
    assert parse_pr_updated_at("2026-11-15T19:20:00+09:00") == datetime(2026, 11, 15, 10, 20, tzinfo=timezone.utc)
    assert parse_pr_updated_at(None) is None and parse_pr_updated_at("not a time") is None


@pytest.mark.anyio
async def test_a_legacy_gate_with_a_watermark_but_no_head_is_not_seeded_by_an_unordered_delivery():
    """A gate older than migration 0478 has a watermark (T2) and no recorded head. A delivery WITHOUT `updated_at` has no order: it must not become the head just by arriving (here it is a LATE OLD
    one, A, while the PR is at B) — GitHub is asked and the record becomes the real head B."""
    engine, Session = await _session_factory()
    try:
        story_id, _rec = await _open_then_push(Session, pr_number=4983, installation_id=695529)
        await _set(Session, "UPDATE gate SET pr_head_observed_sha = NULL WHERE pr_number = 4983")  # watermark T2 stays
        await _lifecycle_post(Session, _Recorder(), pr_number=4983, installation_id=695529, story_id=story_id, head_sha=SHA_A, updated_at=None, real_head=SHA_B)
        async with Session() as s:
            gate = await _get_gate(s, story_id, 4983)
            assert gate.pr_head_observed_sha == SHA_B, f"an unordered delivery seeded the head (or it was left unknown): {gate.pr_head_observed_sha}"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_a_legacy_gate_learns_its_head_from_an_unordered_delivery_so_the_late_old_ci_that_follows_is_judged():
    """Legacy gate (watermark, no head) · an unordered lifecycle delivery of the real head B · then A's CI finishes late: the record must have become B (through GitHub), so A's event is the old
    commit's and does not rebind the gate (with the head left unknown, the rule «never stops a gate it cannot judge» let A through)."""
    engine, Session = await _session_factory()
    try:
        story_id, _rec = await _open_then_push(Session, pr_number=4985, installation_id=695531)
        await _set(Session, "UPDATE gate SET pr_head_observed_sha = NULL WHERE pr_number = 4985")
        await _lifecycle_post(Session, _Recorder(), pr_number=4985, installation_id=695531, story_id=story_id, head_sha=SHA_B, updated_at=None, real_head=SHA_B)
        late = await _ci_completed(Session, pr_number=4985, installation_id=695531, head_sha=SHA_A, conclusion="failure")
        async with Session() as s:
            gate = await _get_gate(s, story_id, 4985)
            assert gate.pr_head_observed_sha == SHA_B
            assert gate.github_check_run_sha == SHA_B, "the old commit's late CI rebound a legacy gate to it"
            assert gate.approved_head_sha in (None, SHA_B)
        assert SHA_A not in late.shas, "a check-run was published for the old commit"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_a_merge_event_of_one_pr_does_not_rebind_a_sibling_prs_gate_through_the_sha_fallback():
    """Two PRs share a commit (a stack): the sibling's gate is still bound to it (`github_check_run_sha` = A) but its PR has moved on (recorded head B). A merge event of the other PR at A reaches the
    sibling only through the sha fallback — the merge is no evidence for it and must not set its anchor or publish A as its head."""
    from app.services.merge_verdict_gate import reconcile_merge_gate_with_real_evidence

    engine, Session = await _session_factory()
    try:
        story_id, _rec = await _open_then_push(Session, pr_number=4984, installation_id=695530)
        async with Session() as s:
            gate = await _get_gate(s, story_id, 4984)
            org_id = gate.org_id
        await _set(Session, "UPDATE gate SET github_check_run_sha = :a WHERE pr_number = 4984", a=SHA_A)  # bound to the shared commit A; the recorded head is B
        queued: list[dict] = []
        async with Session() as s:
            with patch("app.services.github_app.get_pull_request", _github_head(SHA_B)):
                await reconcile_merge_gate_with_real_evidence(
                    s, org_id, uuid.uuid4(), pr_number=0, repo="moonklabs/sprintable", ci_result="pass", merged=True, head_sha=SHA_A, gate_check_publish=queued,
                )
            await s.commit()
        assert queued == [], f"the merge of another PR was queued for the sibling's gate: {queued}"
        async with Session() as s:
            gate = await _get_gate(s, story_id, 4984)
            assert (gate.neutral_facts or {}).get("ci_result") != "pass"
            assert gate.approved_head_sha is None
    finally:
        await engine.dispose()
