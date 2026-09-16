"""story #3804(BE·prod 승격 재료) — main 체인이 develop과 4곳에서 갈려(0283←0281·0289←0287·
0292←0290·0354←0295) prod 승격 시 60개 리비전(0282·0288·0291·0296~0351·0353)이 "이미
적용됨"으로 유령 스킵된다.

## 근거(2026-09-11 리허설 doc 9ac934b5, 디디·fresh PG 4개 실측·PO git 재확認, 2026-09-16
착수 시 재측·재확認 — develop/main 양쪽 파일셋 grep으로 4곳 전부 재검증, 신규 발생 0)
main은 아래 4곳에서 develop과 다른 down_revision을 가진 **같은 revision id**의 파일을
갖는다(0253a 선례와 동일 클래스 — 과거 어느 시점 prod 긴급 승격에서 재봉합됐던 흔적):

1. `0283`(add_apple_id_to_users) — main: down_revision=0281(0282 스킵). develop: down_
   revision=0282.
2. `0289`(agent_project_profiles_first_connected) — main: down_revision=0287(0288 스킵).
   develop: down_revision=0288.
3. `0292`(users_signup_attribution) — main: down_revision=0290(0291 스킵). develop: down_
   revision=0291.
4. `0354`(member_anchor_backfill_root_fix) — main: down_revision=0295(0296~0351·0353의
   57개 스킵). develop: down_revision=0353.

prod가 main 파일셋으로 승격되면 alembic_version이 "0354"로 stamp되지만, 그 경로로는
0282·0288·0291·0296~0351·0353(총 60개)의 DDL이 실제로 실행된 적이 없다 — develop
파일셋으로 이어서 `upgrade head`를 돌려도 이 60개는 "이미 그 지점을 지났다"고 오판돼
유령 스킵된다.

## 처방 — 0253a(94ef196c5, 2026-08-18) 동형, 4구간으로 확장
12개→60개·3구간→4구간이 다를 뿐 설계는 동일: 원본 파일의 `upgrade()`를 파일 경로 기반
동적 import로 그대로 재호출한다(DDL을 이 파일에 복사-붙여넣기하지 않음, SSOT는 원본
파일 유지). 4구간을 **각자 독립적으로** 존재-체크해 재생 — dev/fresh 등 정상 환경(이미
60개 전부 발생 순서대로 적용된 상태)에서는 4 게이트 전부 "이미 존재"로 판별돼 완전
no-op이다.

- 구간①(0282): `platform_settings.vat_rate_bp` 부재 시에만 재생.
- 구간②(0288): `org_subscriptions.au_warn_80_notified_at` 부재 시에만 재생(0288이 실제로
  더하는 5컬럼 중 첫 신호 — 0253a의 구간②가 hypotheses.superseded_by_hypothesis_id
  하나로 판별한 것과 동형).
- 구간③(0291): `billing_orders.receipt_url` 부재 시에만 재생.
- 구간④(0296~0351·0353, 57개 — 0352는 존재한 적 없는 번호, git 이력에 실체 없음):
  `channel_connections` 테이블(0312가 생성) 부재 시에만 재생.

트랜잭션: env.py의 `transaction_per_migration=False`(기본값, 미변경)에 의존한다 — 이
파일이 명시적으로 커밋하지 않는 한 상위 마이그레이션 트랜잭션 하나에 60개 replay가
전부 들어가, 구간 어디서든 실패하면 전부 자동 롤백된다(추가 코드 불요). 60개 전수(디디
재확認) `CREATE INDEX CONCURRENTLY`/`autocommit_block()` 0건 — env.py 제약(위 주석
참고)과 무충돌.

## dry-run
환경변수 `ALEMBIC_0354A_DRY_RUN=1`이면: SAVEPOINT(`bind.begin_nested()`) 안에서 4구간을
그대로 재생 판정·실행한 뒤 **SAVEPOINT를 롤백**하고 구간별 판정 요약을 stdout에 찍은
다음, 의도된 예외(`_DryRunAbort`)를 던져 alembic의 상위 트랜잭션까지 롤백시킨다 —
alembic_version도 전진하지 않아(이 리비전 자체가 "적용되지 않은" 상태로 남음) 스키마가
완전히 무변인 채로 무엇이 재생될지만 확認할 수 있다.

## single head(develop 0355 재부모화)
착수 시점(2026-09-11) 이후 develop head가 0354 → 0378까지 전진했다 — 이 리비전을 0354
바로 뒤에 선형으로 끼우려면 0355(down_revision="0354"였던 파일)를 "0354a"로 재부모화
해야 한다(그렇지 않으면 0354에서 0354a/0355 두 갈래로 갈라져 multiple heads가 된다).
이 커밋에 0355 파일의 `down_revision` 한 줄도 같이 바뀐다 — 그 외 0354a는 develop
현재 head(0378) 뒤가 아니라 **0354 바로 뒤**(즉 체인의 과거 지점)에 선형으로 끼운다
(0253a가 자기 시점의 head 뒤가 아니라 재배선된 자리에 끼운 것과 동형 — "이 리비전이
논리적으로 속하는 자리"가 승격 재료의 특성상 head가 아니다).

## 범위 — 이 PR은 develop 착지용 "재료"다
dev/CI 등 정상 환경에서는 4 게이트 전부 no-op(스키마 무변). **prod 적용(=실제로 60개가
재생되는 순간)은 선생님 승격 결재 뒤**다 — 이 리비전 자체는 지금 develop에 착지해도
아무 실제 효과가 없다.

## PO CHANGES 1회차(2026-09-16 11:24Z) — 사후 존재-체크
사전 게이트("아직 없으면 재생")만으로는 원본 `upgrade()` 하나가 조용히 no-op이 되는
클래스(파일 안 조건 분기·이름 바뀐 테이블 등)를 못 잡는다 — 카드 確定 절의 「마이그
자신은 60개 대표 산출물 존재-체크(inspector)까지」를 `_require_exists()`로 구현: 구간별
분기(재생/skip) 직후 대표 산출물이 실제로 있는지 다시 확認하고, 없으면 `RuntimeError`로
올려 단일 트랜잭션 전체를 롤백시킨다. 구간④는 초입 산출물(`channel_connections`, 0312)
뿐 아니라 구간 마지막 파일(`channel_post_versions.hook_key`, 0353)까지 같이 확認 — 57개
중 앞부분만 성공하고 뒤가 조용히 no-op이어도 초입 산출물만으로는 못 잡기 때문.

Revision ID: 0354a
Revises: 0354
Create Date: 2026-09-16
"""
from __future__ import annotations

import importlib.util
import os

import sqlalchemy as sa

from alembic import op

revision = "0354a"
down_revision = "0354"
branch_labels = None
depends_on = None

_SEGMENT_1_FILES = ["0282_platform_settings_vat_rate_bp.py"]
_SEGMENT_2_FILES = ["0288_org_subscriptions_au_enforcement.py"]
_SEGMENT_3_FILES = ["0291_billing_orders_receipt_url.py"]
_SEGMENT_4_FILES = [
    "0296_org_domain_label.py",
    "0297_recipe_role_bindings.py",
    "0298_legacy_subscriptions_dead_comment.py",
    "0299_org_connector_registry.py",
    "0300_org_connector_registry_kinds.py",
    "0301_preset_gate_verdict_ref_work_item.py",
    "0302_org_gate_policy_merge_default_approver.py",
    "0303_preset_gate_verdict_requester_field.py",
    "0304_recipe_repeat_schedules.py",
    "0305_recipe_repeat_schedule_pause_reason.py",
    "0306_pageview_counter.py",
    "0307_site_posts.py",
    "0308_site_post_drafts.py",
    "0309_preset_gate_verdict_draft_author_field.py",
    "0310_gate_site_post_seal.py",
    "0311_activity_logs_actor_type_platform.py",
    "0312_channel_connections.py",
    "0313_platform_settings_threads_app_credentials.py",
    "0314_channel_post_drafts_versions.py",
    "0315_site_posts_created_by_member_id_nullable.py",
    "0316_channel_publications.py",
    "0317_gate_sealed_scheduled_at.py",
    "0318_publication_commands.py",
    "0319_channel_post_images.py",
    "0320_organizations_timezone.py",
    "0321_content_ledger_projection.py",
    "0322_site_post_draft_destination.py",
    "0323_publication_command_content_kind.py",
    "0324_webhook_delivery_nonces.py",
    "0325_channel_post_source_version.py",
    "0326_org_content_rules.py",
    "0327_publication_attempts.py",
    "0328_gate_scope_key.py",
    "0329_platform_settings_on_time_tolerance.py",
    "0330_preset_gate_verdict_gate_id_field.py",
    "0331_channel_connection_secret_hint.py",
    "0332_insight_snapshots.py",
    "0333_gate_sealed_estimated_cost_minor.py",
    "0334_insights_board_indexes.py",
    "0335_backfill_member_org_role_drift.py",
    "0336_org_pageview_utm_daily.py",
    "0337_backfill_story_number_gap.py",
    "0338_channel_post_comments.py",
    "0339_comment_reply_gate_id_nullable.py",
    "0340_publication_command_content_kind_comment_reply.py",
    "0341_comment_collection_schedule_next_attempt_at.py",
    "0342_channel_oauth_pending_selections.py",
    "0343_channel_post_images_carousel_position.py",
    "0344_channel_post_videos.py",
    "0345_gate_sealed_doc_concept_approval.py",
    "0346_ga4_connections.py",
    "0347_channel_connection_last_error_code_at.py",
    "0348_comment_collection_channel_reported_count.py",
    "0349_channel_publication_reconciliations.py",
    "0350_role_templates_content_group.py",
    "0351_channel_publication_sandbox_expired_once.py",
    "0353_channel_post_versions_hook_key.py",
]

_DRY_RUN_ENV_VAR = "ALEMBIC_0354A_DRY_RUN"


class _DryRunAbort(Exception):
    """dry-run 신호 전용 — SAVEPOINT는 이미 롤백했지만, 이 예외를 던져 alembic의 상위
    트랜잭션(env.py `context.begin_transaction()`)까지 롤백시켜야 alembic_version도
    전진하지 않는다(스키마+북키핑 둘 다 완전 무변 보장)."""


def _load_upgrade_fn(filename: str):
    """versions/ 는 패키지가 아니다(__init__.py 없음) — 파일 경로 기반 동적 import로
    직접 로드한다(alembic 자신의 ScriptDirectory와 동일 방식, 0253a와 동형)."""
    path = os.path.join(os.path.dirname(__file__), filename)
    spec = importlib.util.spec_from_file_location(filename[:-3], path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.upgrade


def _replay(filenames: list[str]) -> None:
    for filename in filenames:
        _load_upgrade_fn(filename)()


def _require_exists(bind: sa.engine.Connection, table: str, column: str | None = None) -> None:
    """PO CHANGES 1회차(2026-09-16 11:24Z) C1 — "재생을 했다"는 사실을 마이그 자신이
    사후에 확認한다. 사전 게이트만으로는 원본 upgrade() 하나가 조용히 no-op이 되는
    클래스(파일 안 조건 분기·이름 바뀐 테이블 등)를 못 잡는다 — 재생 뒤(또는 skip
    직후, 어느 경로든) 대표 산출물이 실제로 있는지 inspector로 단언하고, 없으면
    RuntimeError로 올려 트랜잭션 전체를 롤백시킨다."""
    inspector = sa.inspect(bind)
    if not inspector.has_table(table):
        raise RuntimeError(
            f"0354a 사후 존재-체크 실패 — 테이블 '{table}' 부재(재생이 조용히 no-op됐을 가능성)",
        )
    if column is not None:
        cols = {c["name"] for c in inspector.get_columns(table)}
        if column not in cols:
            raise RuntimeError(
                f"0354a 사후 존재-체크 실패 — '{table}.{column}' 부재(재생이 조용히 no-op됐을 가능성)",
            )


def _replay_segments(bind: sa.engine.Connection) -> list[str]:
    summary: list[str] = []

    inspector = sa.inspect(bind)
    ps_cols = {c["name"] for c in inspector.get_columns("platform_settings")}
    if "vat_rate_bp" not in ps_cols:
        _replay(_SEGMENT_1_FILES)
        summary.append("구간① 0282(platform_settings.vat_rate_bp): 재생함")
    else:
        summary.append("구간① 0282(platform_settings.vat_rate_bp): skip(이미 존재)")
    _require_exists(bind, "platform_settings", "vat_rate_bp")

    inspector = sa.inspect(bind)
    os_cols = {c["name"] for c in inspector.get_columns("org_subscriptions")}
    if "au_warn_80_notified_at" not in os_cols:
        _replay(_SEGMENT_2_FILES)
        summary.append("구간② 0288(org_subscriptions.au_warn_80_notified_at): 재생함")
    else:
        summary.append("구간② 0288(org_subscriptions.au_warn_80_notified_at): skip(이미 존재)")
    _require_exists(bind, "org_subscriptions", "au_warn_80_notified_at")

    inspector = sa.inspect(bind)
    bo_cols = {c["name"] for c in inspector.get_columns("billing_orders")}
    if "receipt_url" not in bo_cols:
        _replay(_SEGMENT_3_FILES)
        summary.append("구간③ 0291(billing_orders.receipt_url): 재생함")
    else:
        summary.append("구간③ 0291(billing_orders.receipt_url): skip(이미 존재)")
    _require_exists(bind, "billing_orders", "receipt_url")

    inspector = sa.inspect(bind)
    if "channel_connections" not in inspector.get_table_names():
        _replay(_SEGMENT_4_FILES)
        summary.append(f"구간④ 0296~0353({len(_SEGMENT_4_FILES)}개, channel_connections): 재생함")
    else:
        summary.append(f"구간④ 0296~0353({len(_SEGMENT_4_FILES)}개, channel_connections): skip(이미 존재)")
    # 구간④는 57개 중 마지막 0353의 산출물까지 같이 단언 — channel_connections 하나만
    # 보면 구간 초입(0312)만 성공하고 나머지가 조용히 no-op이어도 통과해버린다.
    _require_exists(bind, "channel_connections")
    _require_exists(bind, "channel_post_versions", "hook_key")

    return summary


def upgrade() -> None:
    bind = op.get_bind()
    dry_run = os.environ.get(_DRY_RUN_ENV_VAR) == "1"

    if dry_run:
        savepoint = bind.begin_nested()
        summary = _replay_segments(bind)
        savepoint.rollback()
        print(f"[0354a dry-run] SAVEPOINT 롤백 — 스키마 무변. 세그먼트별 판정({len(summary)}개):")
        for line in summary:
            print(f"  - {line}")
        raise _DryRunAbort(
            "0354a dry-run 완료 — 상위 트랜잭션도 롤백해 alembic_version 무변 보장(정상 종료 신호)",
        )

    # AC2 — 정상 경로(dry-run 아님)도 구간별 판정을 그대로 찍는다. dev/fresh 등 정상
    # 환경에서는 4줄 전부 "skip(이미 존재)"라 이 자체가 "no-op이 실제로 확認됐다"는
    # 관측 가능한 증거가 된다(조용히 아무것도 안 하는 것과 "확認하고 아무것도 안 하는
    # 것"은 다르다).
    summary = _replay_segments(bind)
    print(f"[0354a] 세그먼트별 판정({len(summary)}개):")
    for line in summary:
        print(f"  - {line}")


def downgrade() -> None:
    # 0253a와 동형 — 이 리비전 자체가 소유한 DDL이 없다(전부 0282/0288/0291/0296~0353
    # 원본 소유). "이 정정을 취소"할 방법이 없다는 뜻이 아니라, downgrade가 되돌릴
    # 대상이 이 파일 소유가 아니라는 뜻 — no-op.
    pass
