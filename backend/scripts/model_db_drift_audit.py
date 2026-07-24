"""story #2181(2026-07-24) — 모델↔실 DB drift 감사 도구.

sqlalchemy.inspect()로 **실 migrated Postgres**를 직접 조회해 SQLAlchemy 모델 메타데이터와
대조한다(baseline schema.sql 텍스트 대조가 아님 — #2161에서 baseline.sql 자체가 일부 테이블에
대해 stale함을 이미 확認했다, 예: a2a_tasks가 통째로 없음). AC1(agent_runs 전수) + AC4(표본
규모 측정) 양쪽에 재사용.

사용: ALEMBIC_DATABASE_URL(psycopg2 URL, 이미 head까지 migrated)로 실행.
    ALEMBIC_DATABASE_URL=postgresql://... uv run python scripts/model_db_drift_audit.py [table1 table2 ...]
인자 없으면 모델에 매핑된 전 테이블을 대상(전수 — AC4 표본 단계에선 명시적으로 테이블명을 넘길 것).
"""
from __future__ import annotations

import os
import sys

import sqlalchemy as sa

import app.models  # noqa: F401 — 전 모델 등록
from app.core.database import Base


def _sync_url() -> str:
    url = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("DATABASE_URL", "")
    for prefix in ("postgresql+asyncpg://",):
        if url.startswith(prefix):
            return "postgresql+psycopg2://" + url[len(prefix):]
    return url


def audit_table(insp: sa.Inspector, table: sa.Table, view_names: set[str]) -> dict:
    name = table.name
    result = {"table": name, "issues": []}
    is_view = name in view_names

    if not is_view and not insp.has_table(name):
        result["issues"].append("MISSING_TABLE — 모델엔 있으나 실 DB에 테이블 자체가 없음")
        return result

    db_cols = {c["name"]: c for c in insp.get_columns(name)}
    model_cols = {c.name: c for c in table.columns}

    # ⓐ 컬럼 존재 여부(양방향)
    for col_name in db_cols:
        if col_name not in model_cols:
            result["issues"].append(f"DB_ONLY_COLUMN: {col_name}(모델 미매핑)")
    for col_name in model_cols:
        if col_name not in db_cols:
            result["issues"].append(f"MODEL_ONLY_COLUMN: {col_name}(DB에 없음 — 마이그 누락 가능성)")

    # ⓑ NOT NULL / DEFAULT 정합(둘 다 있는 컬럼만, 실 테이블만 — VIEW는 Postgres reflection이
    # 원본 테이블의 NOT NULL/DEFAULT를 안 물려준다(모든 결과 컬럼을 nullable=True로 봄)라
    # 대조가 구조적으로 노이즈뿐이라 스킵. team_members 뷰로 확認, story #2181).
    for col_name in ([] if is_view else (set(db_cols) & set(model_cols))):
        db_c, model_c = db_cols[col_name], model_cols[col_name]
        db_nullable = db_c["nullable"]
        model_nullable = model_c.nullable
        if db_nullable != model_nullable:
            result["issues"].append(
                f"NULLABLE_MISMATCH: {col_name} DB={db_nullable} model={model_nullable}"
            )
        db_has_default = db_c.get("default") is not None or bool(db_c.get("identity"))
        # GENERATED ALWAYS(Computed)·IDENTITY 컬럼은 DEFAULT가 아닌 별도 메커니즘 — server_default
        # 대조 대상에서 제외(duration_ms/activity_seq류 오탐 방지, #2161 started_at과는 다른 성질).
        is_computed = model_c.computed is not None
        is_identity = model_c.identity is not None
        model_declares_server_default = (
            model_c.server_default is not None and not is_computed and not is_identity
        )
        # server_default를 모델이 선언했는데 실 DB엔 없는 경우 — #2161 started_at과 동일 패턴
        # ("약속했지만 DB에 없음", INSERT가 컬럼 생략 시 DB가 안 채워줌).
        if model_declares_server_default and not db_has_default:
            result["issues"].append(
                f"SERVER_DEFAULT_NOT_ENFORCED: {col_name} — 모델은 server_default 선언, "
                f"실 DB엔 DEFAULT 없음(약속 미이행 — #2161 started_at과 동일 패턴)"
            )

    # ⓒ CHECK 제약 — 모델 레벨엔 보통 선언 안 하므로 DB에 있는 CHECK 목록을 그대로 정보성 노출
    # (수동 판단 필요 — 새 enum값 추가 시 이 목록 대조해야 하는 [[feedback_baseline_check_ci_sqlite_blindspot]]).
    try:
        checks = insp.get_check_constraints(name)
        if checks:
            result["issues"].append(
                f"DB_CHECK_CONSTRAINTS(정보성, 모델엔 선언 없음): "
                + ", ".join(c["name"] for c in checks)
            )
    except NotImplementedError:
        pass

    return result


def main() -> None:
    engine = sa.create_engine(_sync_url())
    insp = sa.inspect(engine)
    view_names = set(insp.get_view_names())

    target_names = sys.argv[1:]
    tables = (
        [Base.metadata.tables[n] for n in target_names if n in Base.metadata.tables]
        if target_names else list(Base.metadata.tables.values())
    )
    missing = [n for n in target_names if n not in Base.metadata.tables]
    if missing:
        print(f"⚠️ 모델에 없는 테이블명(무시): {missing}")

    total_with_issues = 0
    for table in sorted(tables, key=lambda t: t.name):
        r = audit_table(insp, table, view_names)
        if r["issues"]:
            total_with_issues += 1
            view_tag = " [VIEW]" if table.name in view_names else ""
            print(f"\n=== {r['table']}{view_tag} ({len(r['issues'])}건) ===")
            for issue in r["issues"]:
                print(f"  - {issue}")

    print(f"\n{'='*60}")
    print(f"대상 테이블 {len(tables)}개 중 drift 있는 테이블 {total_with_issues}개")


if __name__ == "__main__":
    main()
