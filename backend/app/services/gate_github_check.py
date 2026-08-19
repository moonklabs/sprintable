"""story #2813([Gate 강제·BE], 설계 카드 doc c1855e0d) — Gate(gate_type="merge") 상태를
GitHub `sprintable/gate` required check로 반영한다.

설계 doc `gate-github-required-check-grounding-design-2813` §2 그대로:
- fail-closed(§2-3): check 최초 발행은 항상 `status=in_progress`(미완료 — required면 머지 차단).
  `conclusion=success`로 넘어가는 유일한 경로는 `publish_gate_check()`가 **Gate DB 상태를 이미
  읽은 후**의 GitHub API 호출뿐 — 이 함수가 예외를 던지면(네트워크/5xx/권한) GitHub 쪽 check는
  그냥 마지막 상태(pending)에 머문다. 이 모듈의 모든 공개 함수는 예외를 삼켜 호출자(웹훅
  트랜잭션·백그라운드 태스크)를 절대 깨뜨리지 않는다 — 이게 fail-closed의 실제 경계다.
- SHA 귀속(§2-2): `gates.approved_head_sha`에 "이 승인이 귀속된 SHA"를 기록. `reopen_gate_if_new_sha`
  가 `resolve_gate_from_verdict`(시스템 자동판정)와 동일한 경량 경로(`set_gate_status` 직접 호출 —
  `transition_gate`의 사람-결재 전용 부작용 체인은 안 탐, gate.py 주석 참고)로 approved→pending을
  되돌린다.
- 원장(AC④): 모든 발행/재-pending/해소를 `GateGithubCheckEvent`에 append-only로 남긴다.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.gate import Gate, set_gate_status
from app.models.gate_github_check_event import GateGithubCheckEvent
from app.models.github_installation import GithubInstallation
from app.models.pull_request_story_link import PullRequestStoryLink
from app.services.github_app import create_check_run, update_check_run
from app.services.merge_verdict_gate import MERGE_GATE_TYPE

logger = logging.getLogger(__name__)

CHECK_NAME = "sprintable/gate"


def _github_state_for_gate_status(status: str) -> tuple[str, str | None]:
    """Gate.status → GitHub Checks API (status, conclusion). completed 상태만 conclusion을 가진다
    (GitHub API 제약) — pending/held는 in_progress(미완료=required check가 머지를 막는 상태)."""
    if status == "approved" or status == "auto_passed":
        return "completed", "success"
    if status in ("rejected", "voided"):
        return "completed", "failure"
    # pending | held — 미완료. voided를 성공으로 착각하면 fail-closed 위반이라 명시 분기.
    return "in_progress", None


async def resolve_pr_link(
    session: AsyncSession, org_id: uuid.UUID, story_id: uuid.UUID
) -> PullRequestStoryLink | None:
    """story에 연결된 PR 링크 — 가장 최근 갱신 1건(⚠️단순화: 한 story에 PR 링크가 여럿이면
    최신 것만 check 발행 대상. 다중-PR 동시추적은 이번 1단계 스코프 밖 — 설계 doc §3 후속 검토)."""
    row = (
        await session.execute(
            select(PullRequestStoryLink)
            .where(
                PullRequestStoryLink.org_id == org_id,
                PullRequestStoryLink.story_id == story_id,
                PullRequestStoryLink.deleted_at.is_(None),
            )
            .order_by(PullRequestStoryLink.updated_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    return row


async def _resolve_installation_id(session: AsyncSession, org_id: uuid.UUID) -> int | None:
    row = (
        await session.execute(
            select(GithubInstallation.installation_id).where(
                GithubInstallation.org_id == org_id,
                GithubInstallation.suspended_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    return row


async def publish_gate_check(
    org_id: uuid.UUID,
    gate_id: uuid.UUID,
    *,
    head_sha: str | None = None,
    repo_full_name: str | None = None,
    pr_number: int | None = None,
) -> None:
    """gate 현재 상태를 GitHub check-run으로 반영 — **자기 세션**을 연다(background task 표준
    패턴, `conversation_webhook.py::deliver_injected_event_webhook` 선례). ``head_sha``/
    ``repo_full_name``/``pr_number``를 인자로 주면(웹훅 직후처럼 이미 알고 있을 때) 재조회를
    생략, 없으면 `PullRequestStoryLink`에서 해소한다. 이 함수는 절대 예외를 던지지 않는다 —
    실패는 로그만(fail-closed: 실패해도 GitHub 쪽 check는 마지막 상태 그대로).
    """
    from app.core.database import async_session_factory

    try:
        async with async_session_factory() as session:
            gate = (
                await session.execute(select(Gate).where(Gate.id == gate_id, Gate.org_id == org_id))
            ).scalar_one_or_none()
            if gate is None or gate.gate_type != MERGE_GATE_TYPE:
                return  # merge 게이트 아니면 이 1단계 스코프 밖(설계 doc §0).

            link = await resolve_pr_link(session, org_id, gate.work_item_id)
            if link is None:
                logger.info("gate=%s: PR 링크 없음 — check 발행 skip", gate_id)
                return
            repo_full_name = repo_full_name or link.repo_full_name
            pr_number = pr_number if pr_number is not None else link.pr_number

            # ⛔카디르 QA(PR#3243, 2026-08-19) 레이스 fix — 여기서 link.evidence.head_sha를
            # "지금 추적 중인 SHA"로 재해소하면, 승인(SHA A) 커밋 後·이 배경 태스크 실행 前에
            # 새 커밋(B)의 synchronize가 먼저 link.evidence를 B로 갱신해버렸을 때 "A 승인이 B를
            # 축복"하는 사고가 난다. approved/auto_passed는 **anchor(gate.approved_head_sha,
            # 승인 트랜잭션에서 이미 확정 기록됨 — gates.py 참고)를 그대로 쓴다** — link.evidence는
            # pending 상태(아직 anchor 없음)에서만 참고한다.
            #
            # ⛔카디르 QA③-a — approved/auto_passed인데 anchor가 없으면(정상 경로라면 gates.py
            # 승인 트랜잭션이 항상 채우므로 legacy/이상 상태뿐) link.evidence로 **폴백하지 않고
            # success 발행 자체를 skip**한다. 폴백을 허용하면 "확인 안 된 SHA에 success"라는
            # anchor bypass 구멍이 그대로 남는다(레이스 fix의 취지와 정면 충돌).
            if head_sha is None:
                if gate.status in ("approved", "auto_passed"):
                    if not gate.approved_head_sha:
                        logger.warning(
                            "gate=%s: %s인데 anchor(approved_head_sha) 없음 — success 발행 skip"
                            "(fail-closed, anchor bypass 방지)", gate_id, gate.status,
                        )
                        return
                    head_sha = gate.approved_head_sha
                else:
                    head_sha = (link.evidence or {}).get("head_sha")
            if not head_sha:
                logger.info("gate=%s: head_sha 미상 — check 발행 skip", gate_id)
                return
            if (link.evidence or {}).get("head_sha") != head_sha:
                link.evidence = {**(link.evidence or {}), "head_sha": head_sha}

            installation_id = await _resolve_installation_id(session, org_id)
            if installation_id is None:
                logger.info("org=%s: GitHub installation 없음 — check 발행 skip", org_id)
                return

            gh_status, gh_conclusion = _github_state_for_gate_status(gate.status)

            # 카디르 QA③-c — check-run은 **SHA당 1개**가 정본. 기존 run이 다른 SHA에 대한
            # 것이면(github_check_run_sha 불일치) PATCH가 아니라 새 run을 만든다 — 안 그러면 새
            # head로는 영원히 check가 안 생겨 required가 영구 미충족되는 데드엔드가 생긴다.
            if gate.github_check_run_id is None or gate.github_check_run_sha != head_sha:
                result = await create_check_run(
                    installation_id, repo_full_name, head_sha,
                    name=CHECK_NAME, status=gh_status, conclusion=gh_conclusion,
                    title="Sprintable Gate",
                    summary=f"게이트 상태: {gate.status}",
                )
                if result is None:
                    logger.warning("gate=%s: check-run 생성 실패(fail-closed, GitHub 쪽 무영향)", gate_id)
                    return
                gate.github_check_run_id = result.get("id")
                gate.github_check_run_sha = head_sha
            else:
                result = await update_check_run(
                    installation_id, repo_full_name, gate.github_check_run_id,
                    status=gh_status, conclusion=gh_conclusion,
                    title="Sprintable Gate",
                    summary=f"게이트 상태: {gate.status}",
                )
                if result is None:
                    logger.warning("gate=%s: check-run 갱신 실패(fail-closed, GitHub 쪽 무영향)", gate_id)
                    return

            if gh_status == "completed" and gh_conclusion == "success":
                gate.approved_head_sha = head_sha

            event_type = "resolved" if gh_status == "completed" else "published"
            session.add(GateGithubCheckEvent(
                org_id=org_id, gate_id=gate.id, story_id=gate.work_item_id,
                repo_full_name=repo_full_name, pr_number=pr_number, head_sha=head_sha,
                event_type=event_type, check_conclusion=gh_conclusion,
            ))
            await session.commit()
    except Exception:  # noqa: BLE001 — fail-closed 경계: 백그라운드 태스크는 절대 안 죽는다.
        logger.exception("gate=%s: check 발행 처리 중 예외(fail-closed, GitHub 쪽 무영향)", gate_id)


async def reopen_gate_if_new_sha(
    session: AsyncSession,
    org_id: uuid.UUID,
    gate: Gate,
    new_head_sha: str,
    *,
    repo_full_name: str,
    pr_number: int,
) -> bool:
    """SHA 귀속(AC②) — 승인된 게이트가 더 이상 최신 커밋과 안 맞으면 pending으로 되돌린다.
    **호출자의 기존 트랜잭션 안에서 동작**(commit 안 함 — verdict_capture.py가 커밋).
    `resolve_gate_from_verdict`(시스템 자동판정)와 동일한 경량 경로(`set_gate_status` 직접 —
    `transition_gate`의 사람-결재 부작용 체인 우회, gate.py 주석 참고). True=재-pending 발생.

    ⛔카디르 QA(PR#3243) fail-closed 보강 — approved인데 `approved_head_sha`가 비어있는 경우
    (정상 경로라면 gates.py 승인 트랜잭션이 항상 채워두므로 legacy/이상 상태뿐)도 **재-pending
    쪽으로** 판정한다. "SHA를 모르는 승인"을 그대로 success로 방치하는 것이 fail-open이다.

    ⛔미르코군 그라운딩(doc gate-github-check-fe-grounding-2814) 적출 — 이 함수가 상태만 리셋
    하고 `GateGithubCheckEvent` 원장에 `re_pending` 행을 전혀 안 남기고 있었다(AC④의 가운데
    조각이 비어 FE가 "재-pending 사유"를 원장만으로 못 만듦). `repo_full_name`/`pr_number`를
    받아 이 트랜잭션 안에서 원장 행도 함께 기록한다(`publish_gate_check`의 별도 background
    발행과 무관 — 재-pending "발생 사실"은 그 즉시, 같은 트랜잭션에 남아야 한다)."""
    if gate.gate_type != MERGE_GATE_TYPE:
        return False
    if gate.status != "approved":
        return False
    if gate.approved_head_sha == new_head_sha:
        return False
    logger.info(
        "gate=%s: SHA 불일치(approved=%s new=%s) — 재-pending", gate.id, gate.approved_head_sha, new_head_sha
    )
    prior_sha = gate.approved_head_sha
    set_gate_status(gate, "pending", now=datetime.now(timezone.utc))
    gate.approved_head_sha = None
    gate.github_check_run_id = None  # 새 SHA는 새 check-run(같은 SHA의 pending→success 갱신 축과 분리).
    gate.github_check_run_sha = None
    session.add(GateGithubCheckEvent(
        org_id=org_id, gate_id=gate.id, story_id=gate.work_item_id,
        repo_full_name=repo_full_name, pr_number=pr_number, head_sha=new_head_sha,
        event_type="re_pending", check_conclusion=None,
    ))
    logger.info("gate=%s: re_pending 원장 기록(prior_sha=%s)", gate.id, prior_sha)
    await session.flush()
    return True
