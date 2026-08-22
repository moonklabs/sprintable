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


async def is_repo_check_enforced(
    session: AsyncSession, org_id: uuid.UUID, repo_full_name: str | None,
) -> bool:
    """story #2815(§5-④, 관측모드 판별) — 이 repo가 `sprintable/gate`를 branch protection에
    required로 등록했는지. `github_installation.enforced_check_repos`(수동 플래그, PO 운영
    — 설계 근거는 0263 마이그·모델 주석) 조회. installation 없음/미설정/repo 없음이면 전부
    False(관측모드 아님을 확언하는 게 아니라 "모른다≈아직 강제 아님"의 안전한 기본값).

    카디르 QA(PR#3245) — `enforced_check_repos`는 PO가 손으로 적는 값이라 대소문자 불일치가
    실전에서 가장 먼저 나는 함정이다("Acme/Repo" vs "acme/repo"). 양쪽을 `.lower()`로
    정규화 후 비교 — GitHub의 `owner/repo`는 대소문자 무관 동일 저장소를 가리킨다."""
    if not repo_full_name:
        return False
    row = (
        await session.execute(
            select(GithubInstallation.enforced_check_repos).where(
                GithubInstallation.org_id == org_id,
                GithubInstallation.suspended_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if not row:
        return False
    normalized = {r.lower() for r in row if isinstance(r, str)}
    return repo_full_name.lower() in normalized


ACTION_REQUIRED_SUMMARY = (
    "이 PR엔 연결된 Sprintable story가 없어 merge gate를 만들 수 없습니다.\n\n"
    "다음 중 하나로 연결하면 gate가 자동 생성됩니다:\n"
    "- PR 제목에 `[SID:<story-id>]` 태그 포함\n"
    "- Sprintable의 explicit PR-story link API로 연결\n\n"
    "연결 후 새 커밋을 push하면(또는 PR을 재오픈하면) 이 check가 자동으로 갱신됩니다."
)

# story #2847(AC2) — participation 미등록으로 evaluate_merge_gate가 gate_id=None을 반환하는
# 경로도 #2826과 동일하게 "말하는 부재"로. gate-less라 원장(AC④) 대상 밖인 것도 동형.
PARTICIPATION_REQUIRED_TITLE = "Sprintable Gate — participation 미등록"
PARTICIPATION_REQUIRED_SUMMARY = (
    "이 PR이 연결된 story에 implementation participation이 등록돼 있지 않아 merge gate를 만들 수 "
    "없습니다(누가 이 작업을 구현했는지 알 수 없어 신뢰 판정을 할 수 없음).\n\n"
    "story를 claim하거나 담당자로 지정하면(claim_story/assignee 설정) participation이 자동 "
    "등록됩니다.\n\n"
    "등록 후 새 커밋을 push하면(또는 PR을 재오픈하면) 이 check가 자동으로 갱신됩니다."
)


async def publish_action_required_check(
    installation_id: int,
    repo_full_name: str,
    head_sha: str,
    pr_number: int,
    *,
    title: str = "Sprintable Gate — story 링크 필요",
    summary: str = ACTION_REQUIRED_SUMMARY,
) -> None:
    """story #2826(부 처방, PO 확定 2026-08-20) — story 링크가 없어 gate 자체가 없는 PR에도
    `sprintable/gate`를 발행하되, 침묵 부재(check 자체가 안 뜸) 대신 **말하는 부재**로:
    conclusion=action_required + 다음 행동 안내. gate가 없으니 DB에 남길 게 없다(원장(AC④)은
    gate 존재를 전제 — 이 경로는 gate-less라 대상 밖, GitHub 쪽 UI 안내만).

    story #2847(AC2)부터 title/summary를 매개변수화 — participation 미등록 사유(별도 상수)도
    같은 함수를 재사용(새 규칙 발명 0, #2826과 동일 chokepoint).

    fail-closed(이 모듈 공통 규율): 예외를 삼켜 호출자(웹훅 트랜잭션 뒤 background task)를
    절대 깨뜨리지 않는다 — 실패해도 GitHub 쪽은 그냥 check가 없는 이전 상태 그대로.
    """
    try:
        result = await create_check_run(
            installation_id, repo_full_name, head_sha,
            name=CHECK_NAME, status="completed", conclusion="action_required",
            title=title,
            summary=summary,
        )
        if result is None:
            logger.warning(
                "action_required check 발행 실패(fail-closed, GitHub 쪽 무영향) repo=%s pr=%s",
                repo_full_name, pr_number,
            )
    except Exception:  # noqa: BLE001 — fail-closed 경계: 백그라운드 태스크는 절대 안 죽는다.
        logger.exception(
            "action_required check 발행 중 예외(fail-closed, GitHub 쪽 무영향) repo=%s pr=%s",
            repo_full_name, pr_number,
        )


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

            # story #2826 잔여(카디르 판독·페드루 PO 승인 2026-08-20, #3257 실사고) — link row는
            # "필수 전제"가 아니라 "인자로 못 받은 값의 폴백"이다. docstring은 원래 "인자로 주면
            # 재조회를 생략"이라 약속했는데, 구현은 인자 유무와 무관하게 무조건 link를 조회해
            # 없으면 즉시 return했다 — SID-only로 해소된 PR(merge_link_evidence/upsert_link
            # 둘 다 row를 안 만드는 조건, #3257이 그 표본)은 story_id는 정확히 풀려 gate까지는
            # 서는데 check 발행만 이 자리서 조용히 죽었다. 이제 docstring 그대로: repo_full_name+
            # pr_number가 이미 인자로 왔으면 link 조회 자체를 스킵한다.
            link: PullRequestStoryLink | None = None
            if repo_full_name is None or pr_number is None:
                link = await resolve_pr_link(session, org_id, gate.work_item_id)
                if link is None:
                    logger.info(
                        "gate=%s: repo_full_name/pr_number 인자 없음 + PR 링크도 없음 — "
                        "check 발행 skip(사유: 발행 대상 repo/PR 식별 불가)", gate_id,
                    )
                    return
                repo_full_name = repo_full_name or link.repo_full_name
                pr_number = pr_number if pr_number is not None else link.pr_number

            # ⛔카디르 R2 CRITICAL(2026-08-19, 코드 추적 재확認) — 이전 fix는 anchor 우선을
            # "head_sha 인자가 None일 때만" 적용했다. 그런데 verdict_capture.py 웹훅 경로는
            # **항상 head_sha를 명시 전달**하므로(gate_check_publish outparam) 그 경로에서
            # anchor 검증이 통째로 우회됐다 — 웹훅이 다른 SHA를 넘기면 그대로 그 SHA에
            # success가 발행될 수 있었다(레이스 fix가 막으려던 것과 같은 계열의 구멍).
            #
            # 불변식으로 재정의: **approved/auto_passed 게이트에서 success를 받을 수 있는
            # SHA는 anchor(gate.approved_head_sha) 단 하나** — 인자로 뭐가 왔든 무관하다.
            # ①anchor가 없으면(legacy/이상 상태) skip(QA③-a 그대로) ②인자 head_sha가 anchor와
            # 다르면(=최신 SHA가 승인된 것과 다름) 그 상황은 **재-pending 영역이지 발행 영역이
            # 아니다** — reopen_gate_if_new_sha가 처리할 몫이므로 여기서도 skip. 통과하면
            # head_sha를 anchor로 **강제 고정**(인자 무시).
            if gate.status in ("approved", "auto_passed"):
                if not gate.approved_head_sha:
                    logger.warning(
                        "gate=%s: %s인데 anchor(approved_head_sha) 없음 — success 발행 skip"
                        "(fail-closed, anchor bypass 방지)", gate_id, gate.status,
                    )
                    return
                if head_sha is not None and head_sha != gate.approved_head_sha:
                    logger.warning(
                        "gate=%s: 요청 head_sha(%s)가 anchor(%s)와 불일치 — success 발행 skip"
                        "(재-pending 영역, 발행 영역 아님)", gate_id, head_sha, gate.approved_head_sha,
                    )
                    return
                head_sha = gate.approved_head_sha  # anchor가 절대 기준 — 인자 유무 무관.
            elif head_sha is None:
                # link가 위에서 스킵됐으면(repo_full_name+pr_number 인자로 이미 옴) 여기서만
                # 폴백 조회 — head_sha 인자까지 없는 건 이 함수를 approved/auto_passed 밖에서
                # link 정보 전혀 없이 부르는 드문 경로뿐(주 호출부는 항상 head_sha를 명시 전달).
                if link is None:
                    link = await resolve_pr_link(session, org_id, gate.work_item_id)
                head_sha = (link.evidence or {}).get("head_sha") if link else None
            if not head_sha:
                logger.info("gate=%s: head_sha 미상 — check 발행 skip", gate_id)
                return
            if link is not None and (link.evidence or {}).get("head_sha") != head_sha:
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
                seed_pr_head_watermark(gate)  # story #2932 완주조건 HIGH2(4라운드) — writer 3곳 중 하나.

            event_type = "resolved" if gh_status == "completed" else "published"
            session.add(GateGithubCheckEvent(
                org_id=org_id, gate_id=gate.id, story_id=gate.work_item_id,
                repo_full_name=repo_full_name, pr_number=pr_number, head_sha=head_sha,
                event_type=event_type, check_conclusion=gh_conclusion,
            ))
            await session.commit()
    except Exception:  # noqa: BLE001 — fail-closed 경계: 백그라운드 태스크는 절대 안 죽는다.
        logger.exception("gate=%s: check 발행 처리 중 예외(fail-closed, GitHub 쪽 무영향)", gate_id)


# story #2893(설계안 §3 B2-a) — 재검토를 강제하는 대상 라벨. 「라벨=검증된 SHA에 대한 약속」
# 시맨틱이라 SHA 재-pending 시 이 둘을 뗀다. diff 분류 fast-path(문서만 변경 등)는 설계상
# 스코프 밖(PO 명시 제외, 2026-08-21) — 여기 조건 분기 0.
RECHECK_LABELS = ("qa:pass", "design:pass")


async def publish_label_unlabel(org_id: uuid.UUID, repo_full_name: str, pr_number: int, labels: list[str]) -> None:
    """story #2893(설계안 §3 B2-a) — SHA 재-pending 시 qa:pass/design:pass 라벨을 GitHub에서
    제거한다. `publish_gate_check`와 동일 background-task 패턴(자기 세션 열어 installation_id만
    해소 — gate row 조회는 이 함수 관심사 밖, 호출자(verdict_capture.py)가 재-pending 판단을
    이미 끝내고 넘긴다). 절대 예외를 던지지 않는다 — 실패는 로그만(fail-closed: 라벨이 안
    떨어져도 GitHub 쪽은 이전 상태 그대로일 뿐, DB 트랜잭션은 이미 커밋 완료된 뒤라 무관)."""
    from app.core.database import async_session_factory
    from app.services.github_app import remove_pr_label

    try:
        async with async_session_factory() as session:
            installation_id = await _resolve_installation_id(session, org_id)
        if installation_id is None:
            logger.info("org=%s: GitHub installation 없음 — 라벨 제거 skip", org_id)
            return
        for label in labels:
            ok = await remove_pr_label(installation_id, repo_full_name, pr_number, label)
            if not ok:
                logger.warning(
                    "repo=%s pr=%s label=%s 제거 실패(fail-closed, GitHub 쪽 무영향)",
                    repo_full_name, pr_number, label,
                )
    except Exception:  # noqa: BLE001 — fail-closed 경계: 백그라운드 태스크는 절대 안 죽는다.
        logger.exception("repo=%s pr=%s: 라벨 제거 처리 중 예외(fail-closed)", repo_full_name, pr_number)


def seed_pr_head_watermark(gate: Gate, *, now: datetime | None = None) -> None:
    """story #2932(완주조건 HIGH2, 4라운드 카디르 자기정정+codex 반박) — `approved_head_sha`가
    새로 세워지는 **모든** 자리(사람 UI 승인·AUTO_MERGE 평가·check-run success 발행)는
    `pr_head_observed_at`도 함께 씨드해야 한다. 원래 처방은 `reopen_gate_if_new_sha` 내부
    (재-pending·워터마크-전진 두 분기)에서만 워터마크를 썼는데, 그 함수는 gate.status가
    이미 approved/auto_passed일 때만 도달한다 — 즉 **최초로 그 상태가 되는 순간**(사람이
    막 승인한 직후 등)엔 아무도 워터마크를 안 찍어 None으로 남았다. 그 직후 도착하는
    stale webhook은 워터마크=None이라 staleness guard가 아예 발동을 못 해, 이 story가
    막으려던 spurious 재-pending이 **정상 승인 경로의 기본 상태**로 재발했다(카디르 4라운드
    발견·정정). 전 3개 writer(gates.py `transition_gate_endpoint`·merge_verdict_gate.py
    `evaluate_merge_gate` AUTO_MERGE·gate_github_check.py `publish_gate_check` success)가
    이 헬퍼를 공유 chokepoint로 호출한다(전수 grep으로 확定, approved_head_sha를 새 값으로
    세우는 자리는 이 3곳+reopen_gate_if_new_sha 자신뿐).

    이 세 경로엔 GitHub의 실 `pull_request.updated_at`이 없다(웹훅 payload가 없는 UI/시스템
    평가 경로) — 서버 `now()`를 하한 워터마크로 쓴다: "이 시점 이전에 관측된 배달은 이미 아는
    상태를 설명한다"는 가정이 성립하는 가장 보수적인 근사(신규 GitHub API 재조회 없음, 폴링 0
    원칙 유지)."""
    gate.pr_head_observed_at = now or datetime.now(timezone.utc)


async def reopen_gate_if_new_sha(
    session: AsyncSession,
    org_id: uuid.UUID,
    gate: Gate,
    new_head_sha: str,
    *,
    repo_full_name: str,
    pr_number: int,
    pr_updated_at: datetime | None = None,
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
    발행과 무관 — 재-pending "발생 사실"은 그 즉시, 같은 트랜잭션에 남아야 한다).

    ⛔카디르 R2 CRITICAL(2026-08-19) — `auto_passed`도 `approved`와 동일하게 다룬다. 정책이
    allow_auto로 내린 통과도 "그 SHA에 대한" 승인이라 새 커밋엔 무효 — 자동통과 정책이 새
    증거로 다시 통과시키는 것은 `evaluate_merge_gate`(재평가 시 anchor 재확定)의 몫이지,
    구 anchor를 새 SHA에 그대로 붙여두는 것의 몫이 아니다.

    pr_updated_at: story #2932(완주조건 HIGH2, 0273, codex+카디르 일치판단) — GitHub가 웹훅
    배달 순서를 보장하지 않아, 이미 최신 SHA로 승인된 게이트에 **뒤늦게 도착한 옛 배달**이
    그 옛 SHA와의 불일치만 보고 부당 재-pending시킬 수 있었다("승인은 그때의 커밋에" —
    story #2893 핵심 보증을 이 클래스가 직접 깬다). `pull_request.updated_at`(GitHub가
    실 갱신마다 단조증가시킴)을 `gate.pr_head_observed_at`에 워터마크로 남겨, 새 이벤트의
    `updated_at`이 이미 관측된 값보다 **엄격히 과거면**(`<`) SHA 불일치와 무관하게 stale로
    skip한다. 폴링/GitHub API 재조회 없이(story #2893 §4 C1 원칙과 동형) 페이로드 자체
    신호만 쓴다. None이면(payload에 없거나 파싱 실패 등) 검증을 건너뛰고 기존
    SHA-diff-only 동작 그대로(새로 나빠지지 않음, 다만 이 방지축을 못 얻을 뿐).

    ⛔카디르 4라운드(codex 발견) — 원래 `<=`(동일 timestamp도 stale)는 서로 다른 두 진짜
    배달이 같은 초 단위 timestamp를 우연히 공유하면(연속 push 등, GitHub 해상도 제약) 신규
    SHA를 stale로 오판해 skip할 위험이 있었다. `<`로 완화하면 동일 timestamp는 이 가드를
    안 타고 아래 **기존 SHA-diff 비교**(approved_head_sha == new_head_sha)로 자연히
    넘어간다 — "동일 timestamp면 SHA로 갈라라"는 요구를 새 비교 축을 추가하지 않고 이미 있는
    분기가 그대로 흡수한다(SHA가 같으면 no-op, 다르면 정상 재-pending — 타임스탬프 동률은
    stale 여부 판정에서 아예 빠지고 SHA가 유일한 진실이 된다)."""
    if gate.gate_type != MERGE_GATE_TYPE:
        return False
    if gate.status not in ("approved", "auto_passed"):
        return False
    if (
        pr_updated_at is not None
        and gate.pr_head_observed_at is not None
        and pr_updated_at < gate.pr_head_observed_at
    ):
        logger.info(
            "gate=%s: stale/순서역전 웹훅 무시(pr_updated_at=%s < 이미 관측된 %s) — 재-pending skip",
            gate.id, pr_updated_at, gate.pr_head_observed_at,
        )
        return False
    if gate.approved_head_sha == new_head_sha:
        if pr_updated_at is not None and (
            gate.pr_head_observed_at is None or pr_updated_at > gate.pr_head_observed_at
        ):
            gate.pr_head_observed_at = pr_updated_at  # SHA는 그대로여도 워터마크는 전진.
            await session.flush()
        return False
    logger.info(
        "gate=%s: SHA 불일치(approved=%s new=%s) — 재-pending", gate.id, gate.approved_head_sha, new_head_sha
    )
    prior_sha = gate.approved_head_sha
    set_gate_status(gate, "pending", now=datetime.now(timezone.utc))
    gate.approved_head_sha = None
    gate.github_check_run_id = None  # 새 SHA는 새 check-run(같은 SHA의 pending→success 갱신 축과 분리).
    gate.github_check_run_sha = None
    if pr_updated_at is not None:
        gate.pr_head_observed_at = pr_updated_at
    session.add(GateGithubCheckEvent(
        org_id=org_id, gate_id=gate.id, story_id=gate.work_item_id,
        repo_full_name=repo_full_name, pr_number=pr_number, head_sha=new_head_sha,
        # story #2819 — 이미 계산해 둔 prior_sha를 로그뿐 아니라 원장에도 남긴다(FE가
        # "SHA {prior}에서 SHA {new}로 무효화"를 조회 시점에 만들 수 있게).
        event_type="re_pending", check_conclusion=None, prior_sha=prior_sha,
    ))
    logger.info("gate=%s: re_pending 원장 기록(prior_sha=%s)", gate.id, prior_sha)
    await session.flush()
    return True
