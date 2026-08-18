"""story #f6d1bbaa — 재봉합(down_revision 임시 재봉합) stamp 정합 가드.

## 배경 — 이 가드가 막으려는 정확한 사고 클래스(#70bc4bc3)
마이그 개발 中 "이번 승격에서 일부 리비전을 임시 제외"하려 뒤쪽 리비전의 down_revision을
앞으로 재봉합(예: 0236을 0227에 직결, 0228~0235 건너뜀)하는 경우가 있다. 그 재봉합
이미지로 migrate job이 실행되면 alembic_version이 "0236"으로 stamp된다. 나중에 재봉합이
풀려 정본 체인(0227→0228→…→0235→0236)이 복원되면, `alembic upgrade heads`는 "현재
stamp(0236)가 0228~0235의 하류이니 그것들은 이미 적용됐다"고 **영구히 오판**한다 —
실제로는 그 DDL이 단 한 번도 실행되지 않았는데도.

## 탐지 방법
alembic ScriptDirectory로 "현재 DB stamp → base"까지의 조상 리비전 전체를 얻는다(재봉합이
복원된 **현재** 코드 기준 정본 체인 — 즉 재봉합 당시가 아니라 지금 시점 기준으로 "이
stamp라면 마땅히 거쳤어야 할" 리비전 목록). 그 순서대로 각 리비전 파일의 upgrade()
함수를 AST로 정적 파싱(**실행 안 함**)해 `op.create_table("X", ...)`→테이블 X 추가,
`op.add_column("X", sa.Column("Y", ...))`→컬럼 X.Y 추가, `op.drop_table`/`op.drop_column`
→ 제거로 시뮬레이션해 "지금 head까지 정상 실행됐다면 존재해야 할 테이블/컬럼의 최종
스냅샷"을 조립한다. 이 스냅샷을 live information_schema와 대조 — 하나라도 없으면 FAIL.

## 못 잡는 것(명시, 페드루 요구사항)
- **DROP/RENAME/데이터 백필만 하는 리비전**: create_table/add_column 시그널이 없으면
  판별 근거가 없다 — 그런 리비전 하나만 통째로 스킵돼도 이 가드는 못 잡는다.
- **존재는 하지만 스펙(nullable·타입·CHECK·FK)이 틀린 경우**: 존재 여부만 본다 —
  internal-api의 assert_schema_contract(컬럼 타입까지 대조)보다 얕은 레벨의 가드다.
- **`op.execute("CREATE TABLE ...")`류 raw SQL DDL**: AST가 문자열 리터럴 안의 SQL은
  파싱하지 않는다 — `op.create_table`/`op.add_column`/`op.drop_table`/`op.drop_column`
  함수 호출 패턴만 인식한다.
- **인덱스·제약·시퀀스 이름 자체의 변경**: 추적 대상이 테이블/컬럼 존재뿐이다(이게
  바로 `alembic check`이 이 코드베이스에서 실용성이 없는 이유이기도 함 — 인덱스 명명
  컨벤션 드리프트가 오래 누적돼 노이즈가 압도적이다. 이 가드는 그 노이즈를 피하려
  의도적으로 훨씬 좁은 신호만 본다).
- **매우 이른 시점에 만들어졌다가 이후 drop된 테이블이 raw SQL로 drop된 경우**: 현재
  코드베이스 전수 확認 결과 drop_table/drop_column은 전부 op.* 함수 사용 — 위험 낮음,
  그러나 보장은 아님.

## 실행 위치
`scripts/migrate.sh`에서 다른 precheck(EE-stamp·0183a fork)와 같은 자리 — `alembic
upgrade heads` 직전, prod 실 DB 대상. **self-heal 안 함**(0183a 패턴과 다름) — 이 정합
위반은 원인이 다양할 수 있어 자동 stamp 재조정이 오히려 새 드리프트를 만들 위험이
있다. FAIL 시 migrate job 자체를 죽여 배포를 막는다(사람이 봐야 하는 실패로 남김 —
#70bc4bc3처럼 조용히 넘어가면 다음 크래시까지 아무도 모른다).

## 양성대조
tests/test_f6d1bbaa_stamp_integrity_guard.py — 이 사고의 실제 이상상태를 그대로
재현해 먹이면 이 스크립트가 정확히 FAIL(exit 1)이어야 한다. 정상 dev DB(전체 순차
적용)에서는 PASS.

사용: `ALEMBIC_DATABASE_URL`(psycopg2, migrate.sh 계약과 동일) + alembic.ini가 있는
CWD에서 실행.
"""
from __future__ import annotations

import ast
import os
import sys

from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, inspect, text


def _extract_ddl_ops(upgrade_src: str) -> list[tuple[str, str, str | None]]:
    """upgrade() 함수 소스에서 (op, table, column|None) 튜플 목록을 순서대로 추출.
    op는 'create_table'|'add_column'|'drop_table'|'drop_column'."""
    tree = ast.parse(upgrade_src)
    ops: list[tuple[str, str, str | None]] = []

    class Visitor(ast.NodeVisitor):
        def visit_Call(self, node: ast.Call) -> None:
            self.generic_visit(node)
            func = node.func
            if not (isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name) and func.value.id == "op"):
                return
            fname = func.attr
            args = node.args
            if fname == "create_table" and args and isinstance(args[0], ast.Constant):
                ops.append(("create_table", args[0].value, None))
            elif fname == "add_column" and len(args) >= 2 and isinstance(args[0], ast.Constant):
                table = args[0].value
                col_node = args[1]
                if isinstance(col_node, ast.Call) and col_node.args and isinstance(col_node.args[0], ast.Constant):
                    ops.append(("add_column", table, col_node.args[0].value))
            elif fname == "drop_table" and args and isinstance(args[0], ast.Constant):
                ops.append(("drop_table", args[0].value, None))
            elif fname == "drop_column" and len(args) >= 2 and isinstance(args[0], ast.Constant) and isinstance(args[1], ast.Constant):
                ops.append(("drop_column", args[0].value, args[1].value))

    Visitor().visit(tree)
    return ops


def _get_upgrade_source(filepath: str) -> str:
    tree = ast.parse(open(filepath).read())
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name == "upgrade":
            return ast.unparse(node)
    return ""


def build_expected_snapshot(script: ScriptDirectory, current_stamp_revs: list[str]) -> tuple[set[str], set[tuple[str, str]]]:
    """current_stamp_revs(현재 DB의 alembic_version 값들)의 조상 체인을 base부터
    현재까지 순서대로 walk하며 create/drop을 시뮬레이션 — 최종 기대 스냅샷 반환."""
    tables: set[str] = set()
    columns: set[tuple[str, str]] = set()

    ancestry = list(script.iterate_revisions(current_stamp_revs, "base"))
    ancestry.reverse()  # base(가장 오래됨) → 현재 stamp 순서로.

    for rev in ancestry:
        if rev is None:
            continue
        upgrade_src = _get_upgrade_source(rev.path)
        if not upgrade_src:
            continue
        for op_name, table, col in _extract_ddl_ops(upgrade_src):
            if op_name == "create_table":
                tables.add(table)
            elif op_name == "add_column":
                columns.add((table, col))
            elif op_name == "drop_table":
                tables.discard(table)
                columns = {(t, c) for (t, c) in columns if t != table}
            elif op_name == "drop_column":
                columns.discard((table, col))
    return tables, columns


def main() -> int:
    cfg = Config("alembic.ini")
    script = ScriptDirectory.from_config(cfg)

    # migrate.sh 계약(스크립트 상단 docstring)은 ALEMBIC_DATABASE_URL(psycopg2, sync)만
    # 보장한다 — DATABASE_URL(asyncpg)은 migrate job 환경에 없을 수 있어 KeyError로 죽는다.
    engine = create_engine(os.environ["ALEMBIC_DATABASE_URL"])
    with engine.connect() as conn:
        try:
            current_revs = [row[0] for row in conn.execute(text("SELECT version_num FROM alembic_version"))]
        except Exception:
            print("[stamp-integrity] alembic_version 테이블 없음(최초 배포 등) — no-op.")
            return 0

        if not current_revs:
            print("[stamp-integrity] stamp 없음 — no-op.")
            return 0

        expected_tables, expected_columns = build_expected_snapshot(script, current_revs)

        inspector = inspect(engine)
        live_tables = set(inspector.get_table_names())

        missing_tables = sorted(expected_tables - live_tables)
        missing_columns = []
        for table, col in sorted(expected_columns):
            if table not in live_tables:
                continue  # 테이블 자체 부재는 이미 missing_tables에 잡힘 — 중복 보고 방지.
            live_cols = {c["name"] for c in inspector.get_columns(table)}
            if col not in live_cols:
                missing_columns.append(f"{table}.{col}")

    if missing_tables or missing_columns:
        print("[stamp-integrity] FAIL — 현재 alembic_version이 함의하는 리비전 중 일부의 DDL이 "
              "live 스키마에 없다(재봉합 stamp 정합 위반 클래스 — story #70bc4bc3 참고).", file=sys.stderr)
        if missing_tables:
            print(f"  누락 테이블: {missing_tables}", file=sys.stderr)
        if missing_columns:
            print(f"  누락 컬럼: {missing_columns}", file=sys.stderr)
        print("  이 정합 위반은 self-heal 안 함 — 원인 조사 후 정정 마이그(예: #70bc4bc3의 "
              "0253a 패턴 — 원본 upgrade() 재호출) 작성 필요.", file=sys.stderr)
        return 1

    print("[stamp-integrity] PASS — 조상 리비전 전체의 DDL 산출물이 live 스키마와 일치.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
