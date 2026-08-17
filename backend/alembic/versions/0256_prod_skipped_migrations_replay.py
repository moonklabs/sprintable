"""story #70bc4bc3(P0·prod) — 0228~0235·0237~0239·0242가 prod에서 통째로 미실행이었던
사태의 멱등 정정(총 3개 구간·12개 리비전).

## 근본원인(git 이력+로그 포렌식으로 확定, 2026-08-18 카디르 조사)
`sprintable-migrate-prod` job의 30일 전체 로그에서 "Running upgrade X -> Y" 라인을 전수
추출해 대조한 결과, 단일 스텝이어야 할 전이가 **3곳에서 여러 리비전을 건너뛰었다**:

1. `2026-08-08 13:54` — **0227 -> 0236**(0228~0235, 8개 건너뜀). 원인: 같은 날 21:57
   커밋(a367fc66, "0236 down_revision 0235→0227 재봉합 — 결제② migration 제외 반영")이
   결제②(0228~0233)+0234+0235를 그 시점 prod 승격에서 임시 제외하려 0236의
   down_revision을 일시적으로 "0227"로 재봉합했다. 이 재봉합 이미지로 prod가 실행됨.
2. `2026-08-13 00:30` — **0236 -> 0240**(0237~0239, 3개 건너뜀). 같은 클래스의 별도
   재봉합(구체 커밋은 미특定 — 0240 자체 이력은 단일 커밋으로 클린해, 0237~0239 쪽의
   임시 재봉합이 나중에 정리된 것으로 추정).
3. `2026-08-13 14:55` — **0241 -> 0243**(0242, 1개 건너뜀). #2606(legal_document_
   versions)가 #2603(0241 선점)과 충돌해 0242로 리넘버된 그 사이 창에서 같은 클래스
   재봉합.

세 경우 모두 나중에 develop/main의 down_revision 체인은 정본(선형, 스킵 없음)으로
복원됐다 — 하지만 prod의 alembic_version 마커는 이미 재봉합 시점 값으로 stamp돼
있어, 복원된 정본 체인 기준 `alembic upgrade heads`는 "이미 지났다"고 오판한다.

**실측 확認(2026-08-18, prod 직접 조회)**: 12개 리비전의 대표 산출물이 전부 부재 —
`offering_versions`/`grandfather_policies` 테이블 없음, `pricing_versions`가 pre-0228
형상, `hypotheses.superseded_by_hypothesis_id` 없음(500 현재진행형 확認), `unattached_
story_snapshots` 없음, `docs.is_folder`가 여전히 존재(0239가 은퇴시켰어야 함),
`legal_document_versions` 없음.

## 처방 — 원본 파일 재사용(복제 아님), 구간별 독립 게이트
12개 파일의 `upgrade()`를 **파일 경로 기반 동적 import로 그대로 재호출**한다(DDL을
이 파일에 복사-붙여넣기하지 않음 — SSOT는 원본 파일 그대로 유지). 3구간을 **각자
독립적으로** 판별해 재생한다(한 구간만 어긋난 가상의 미래 상태에도 안전하도록 — 지금
prod는 셋 다 동시에 어긋나 있지만 설계는 구간별로 분리).

- 구간①(0228~0235): `offering_versions` 부재 시에만 재생.
- 구간②(0237~0239): `hypotheses.superseded_by_hypothesis_id` 부재 시에만 재생(0239는
  자체 멱등 가드 보유 — 이중 안전).
- 구간③(0242): `legal_document_versions` 부재 시에만 재생.

dev 등 정상 환경에서는 3개 게이트 전부 "이미 존재"로 판별돼 완전 no-op.

Revision ID: 0256
Revises: 0255
Create Date: 2026-08-18
"""
from __future__ import annotations

import importlib.util
import os

import sqlalchemy as sa
from alembic import op

revision = "0256"
down_revision = "0255"
branch_labels = None
depends_on = None

_SEGMENT_1_FILES = [
    "0228_billing_v2_3_tier_model_offering_catalog.py",
    "0229_billing_ledger_entries.py",
    "0230_org_billing_keys.py",
    "0231_billing_orders.py",
    "0232_billing_orders_downgraded_status.py",
    "0233_org_billing_keys_customer_key_placeholder.py",
    "0234_org_subscriptions_checkout_claimed_at.py",
    "0235_deletion_audit_logs_note.py",
]
_SEGMENT_2_FILES = [
    "0237_hypothesis_superseded_by.py",
    "0238_unattached_story_snapshots.py",
    "0239_docs_doc_type_folder.py",
]
_SEGMENT_3_FILES = [
    "0242_legal_document_versions.py",
]


def _load_upgrade_fn(filename: str):
    """versions/ 는 패키지가 아니라(__init__.py 없음) 파일 경로 기반으로 직접 로드한다
    — alembic 자신의 ScriptDirectory가 쓰는 것과 동일한 방식(importlib.util)."""
    path = os.path.join(os.path.dirname(__file__), filename)
    spec = importlib.util.spec_from_file_location(filename[:-3], path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.upgrade


def _replay(filenames: list[str]) -> None:
    for filename in filenames:
        _load_upgrade_fn(filename)()


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = inspector.get_table_names()

    if "offering_versions" not in tables:
        _replay(_SEGMENT_1_FILES)

    # 구간②는 0238(unattached_story_snapshots)이 테이블을 만들지만, 0237(hypotheses
    # 컬럼)이 더 이른 신호라 그걸로 판별 — inspector를 매 세그먼트 재조회(0228 replay가
    # 방금 만든 테이블들을 포함해 최신 상태로).
    inspector = sa.inspect(bind)
    h_cols = {c["name"] for c in inspector.get_columns("hypotheses")}
    if "superseded_by_hypothesis_id" not in h_cols:
        _replay(_SEGMENT_2_FILES)

    inspector = sa.inspect(bind)
    if "legal_document_versions" not in inspector.get_table_names():
        _replay(_SEGMENT_3_FILES)


def downgrade() -> None:
    # story #70bc4bc3 처방 자체가 "복구"이지 새 기능이 아니다 — downgrade는 0228~0235
    # 각자의 downgrade()에 위임하지 않는다(그 8개는 여전히 자기 자리에서 정상적인
    # 정본 체인의 일부이므로, 이 마이그를 downgrade해도 그것들을 되돌리면 안 된다 —
    # "이 정정 자체를 취소"할 방법이 없다는 뜻이 아니라, 되돌릴 대상이 "이 마이그가
    # 직접 만든 것"이 없다는 뜻: 실제 DDL은 0228~0235 소유다). no-op.
    pass
