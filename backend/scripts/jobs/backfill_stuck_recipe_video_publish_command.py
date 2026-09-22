"""story #4142 AC5(critical·[E-RECIPE-1], 페드루 PO 처방 2026-09-22) — 이 스토리의
근본원인 수정(`publish_recipe_approved_draft`가 이제 비동기 컨테이너 결과에
`PublicationCommand`를 pending으로 남긴다, channel_posts.py:2442~)이 착지하기 前에
이미 멈춰버린 2호 실사고 표본(초안 9e879c8a — REELS 컨테이너만 생성된 채 아무 command
없이 영원히 방치)을 화면 클릭 0으로 완주시키는 1회성 백필.

이 스크립트가 하는 일은 딱 하나다 — 이미 만들어진 컨테이너(`ChannelPublication.status
== "container_created"`)에, 정상 경로(즉시-발행 라우터·AC1 수정 둘 다)가 쓰는 것과
동일한 헬퍼(`create_or_get_publication_command`)로 pending command를 뒤늦게 하나
심는다(멱등 — 이미 있으면 그대로 반환, 새로 안 만듦). 그 command가 심어지면 기존
cron 워커가 다음 tick에 자연스럽게 이어 폴링·완결한다 — 이 스크립트 자신은 Threads/
Instagram 등 어떤 provider도 직접 호출하지 않는다(새 로직 0).

부수: 레시피 게이트(`gate.publish_outcome`)가 이 버그로 "published"(거짓)를 들고
있으면 "publishing"(정직한 비최종값)으로 고쳐, 화면이 즉시 정정된 상태를 보이게 한다
(레시피 문맥을 못 찾으면 — 예: 레시피 무관 수동 채널 포스트 — 이 부수 효과는 조용히
스킵, 지어내지 않는다).

대상은 `--draft-id`로 명시한 1건만(광범위 스캔 0) — 이 버그 자체는 이 PR로 막혔으니
앞으로 재발할 신규 표본이 없다, 순수 과거 잔존분 구제.

env: DATABASE_URL이 있으면 그것을 쓴다. 없으면 ALEMBIC_URL로 폴백(scripts/jobs/_db_env.py).
실행:
  cd backend && DATABASE_URL=... python -m scripts.jobs.backfill_stuck_recipe_video_publish_command --draft-id <uuid>            # dry-run
  cd backend && DATABASE_URL=... python -m scripts.jobs.backfill_stuck_recipe_video_publish_command --draft-id <uuid> --apply     # 실제 command 생성
"""
from __future__ import annotations

import argparse
import asyncio
import sys
import uuid

from sqlalchemy import select

from scripts.jobs._db_env import resolve_database_url

_db_url_summary = resolve_database_url()

from app.core.database import async_session_factory  # noqa: E402 — 위 폴백이 먼저 돌아야 한다
from app.models.channel_post_draft import ChannelPostDraft  # noqa: E402
from app.models.channel_post_version import ChannelPostVersion  # noqa: E402
from app.models.channel_publication import ChannelPublication  # noqa: E402
from app.models.gate import Gate  # noqa: E402
from app.models.publication_command import PublicationCommand  # noqa: E402


async def main() -> int:
    if _db_url_summary is None:
        print("DATABASE_URL·ALEMBIC_URL 둘 다 미설정", file=sys.stderr)
        return 2
    print(f"[db] {_db_url_summary}", file=sys.stderr)

    parser = argparse.ArgumentParser(
        description="비동기 컨테이너에서 멈춘 레시피 자동발행 1건에 pending PublicationCommand를 백필(idempotent)"
    )
    parser.add_argument("--draft-id", type=str, required=True, help="멈춘 ChannelPostDraft.id (2호: 9e879c8a)")
    parser.add_argument("--apply", action="store_true", help="실제 command 생성 커밋 (미지정 시 dry-run)")
    args = parser.parse_args()
    draft_id = uuid.UUID(args.draft_id)

    async with async_session_factory() as db:
        draft = await db.get(ChannelPostDraft, draft_id)
        if draft is None:
            print(f"draft {draft_id}를 찾을 수 없다", file=sys.stderr)
            return 1
        org_id = draft.org_id
        print(f"draft={draft_id} org={org_id} work_item_id={draft.work_item_id} connection_id={draft.connection_id}")

        # resolve_command_target()과 동일 축(scope_key=connection_id) — 새 조회 로직 0.
        scoped_gate = (await db.execute(
            select(Gate).where(
                Gate.org_id == org_id, Gate.work_item_id == draft.work_item_id,
                Gate.gate_type == "external_publish", Gate.scope_key == str(draft.connection_id),
            )
        )).scalar_one_or_none()
        if scoped_gate is None or scoped_gate.status != "approved":
            print(
                f"scoped external_publish 게이트가 없거나 approved가 아니다(status={scoped_gate.status if scoped_gate else None!r}) "
                "— 아직 승인 안 된 초안엔 이 백필이 안 맞는다",
                file=sys.stderr,
            )
            return 1

        latest = (await db.execute(
            select(ChannelPostVersion)
            .where(ChannelPostVersion.draft_id == draft_id)
            .order_by(ChannelPostVersion.version.desc()).limit(1)
        )).scalar_one_or_none()
        if latest is None:
            print("이 draft에 버전이 없다", file=sys.stderr)
            return 1

        publication = (await db.execute(
            select(ChannelPublication).where(
                ChannelPublication.gate_id == scoped_gate.id, ChannelPublication.version_id == latest.id,
            )
        )).scalar_one_or_none()
        if publication is None:
            print("이 (gate, version)에 ChannelPublication이 아예 없다 — 컨테이너 생성 자체가 안 됨, 백필 대상 아님", file=sys.stderr)
            return 1
        if publication.status != "container_created":
            print(
                f"publication.status={publication.status!r} — container_created가 아니면 이 백필 대상이 아니다"
                "(이미 published거나 failed일 수 있다, 조용히 종료)",
            )
            return 0
        print(f"publication={publication.id} status={publication.status} external_container_id={publication.external_container_id}")

        existing_command = (await db.execute(
            select(PublicationCommand).where(
                PublicationCommand.org_id == org_id, PublicationCommand.destination == draft.connection_id,
                PublicationCommand.approved_version == latest.id, PublicationCommand.operation == "publish",
                PublicationCommand.toggle_seq == 0,
            )
        )).scalar_one_or_none()
        if existing_command is not None:
            print(f"이미 command {existing_command.id}(status={existing_command.status})가 있다 — 백필 불요, 다음 워커 tick을 기다리면 된다")
            return 0

        from app.services.channel_posts import resolve_recipe_context_for_scheduled_publication

        recipe_ctx = await resolve_recipe_context_for_scheduled_publication(
            db, org_id=org_id, work_item_id=draft.work_item_id, connection_id=draft.connection_id,
        )
        recipe_gate_outcome_fix = None
        if recipe_ctx is not None:
            recipe_gate, _definition_key, _next_stage = recipe_ctx
            recipe_gate_outcome_fix = (recipe_gate.id, recipe_gate.publish_outcome)
            print(f"연결된 레시피 게이트={recipe_gate.id} 현재 publish_outcome={recipe_gate.publish_outcome!r}")

        if not args.apply:
            print(
                "[dry-run] 실행 시 PublicationCommand(org_id, gate_id="
                f"{scoped_gate.id}, destination={draft.connection_id}, approved_version={latest.id})를 "
                "pending으로 생성한다"
                + (f" + 레시피 게이트 {recipe_gate_outcome_fix[0]}.publish_outcome을 'publishing'으로 정정한다"
                   if recipe_gate_outcome_fix and recipe_gate_outcome_fix[1] == "published" else "")
                + " — no changes."
            )
            return 0

        from app.services.publication_command import create_or_get_publication_command

        command, created = await create_or_get_publication_command(
            db, org_id=org_id, gate_id=scoped_gate.id, destination=draft.connection_id,
            approved_version=latest.id, requested_by_member_id=scoped_gate.resolver_id,
            scheduled_at=None,
        )
        if recipe_ctx is not None and recipe_gate_outcome_fix[1] == "published":
            recipe_ctx[0].publish_outcome = "publishing"
        await db.commit()
        print(f"command={command.id} created={created} status={command.status} — 다음 워커 tick이 이어 폴링합니다.")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
