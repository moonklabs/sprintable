"""story #4010 — 「처방 C」: prod의 main 앵커(0354, down_revision을 0295로 재작성한 main
전용 파일)에서 develop 파일셋(down_revision을 0353으로 되돌린 원본 0354)으로 넘어갈 때,
`alembic upgrade heads`가 0296~0351·0353(57개)을 "이미 지난 조상"으로 오판해 조용히
건너뛰는 문제를 migrate.sh 안에서 판별형으로 처방한다.

## 배경 — 왜 조용히 건너뛰는가
main은 마케팅 관련 마이그 0296~0353(58개)을 통째로 건너뛴 뒤 0295 바로 위에 자기
전용 0354(down_revision="0295")를 얹어 재봉합했다 — prod DB의 `alembic_version`은
지금 이 문자열 "0354" 그대로다. 이번 승격은 그 main 전용 0354 파일을 버리고 develop
원본 0354(down_revision="0353")로 교체한다(release/prod-promote-prep 브랜치, doc
a4fe633e) — 그러면 `alembic upgrade heads`가 "현재 stamp(0354)가 0353의 하류이니 그
57개는 이미 적용됐다"고 **영구히 오판**한다(check_stamp_chain_integrity.py가 막는
#70bc4bc3과 같은 클래스의 사고 — 다만 그 가드는 self-heal을 안 하고 배포를 막을 뿐이라,
이 처방 없이 병합하면 「빈 스키마로 뜸」이 아니라 「배포 자체가 멈춤」이 된다).

⛔**결제 축(VAT #3097·AU 집행/경고 #3176·#3190·영수증 #3209) 마이그 3개(0282/0288/
0291)는 REPLAY 대상이 아니다** — 선생님 정책(Toss 결제 승인 前 결제 기능은 prod에
안 올림, 2026-09-18)에 따라 이 승격 브랜치는 그 3개 파일 자체를 갖고 있지 않다
(0283/0289/0292 down_revision이 develop처럼 0282/0288/0291을 가리키지 않고 0281/
0287/0290을 가리키도록 재봉합돼 있다 — main의 08-31 결제 제외 승격(#3640,
`f4b6d846f`)과 동일 패턴). 처방 C는 이 3개를 **모르는 채**로 나머지 57개(비-결제
마케팅/인프라 스키마)만 prod에 따라잡힌다 — REPLAY_SET에 결제 마이그를 절대
추가하지 말 것(추가하는 순간 prod DB에 결제 스키마가 생겨 되돌림이 무력화된다).

## 처방
1. 판별: 현재 `alembic_version`이 정확히 ANCHOR_VERSION("0354")이고, 이 파일셋(develop
   그래프)에 STAMP_TARGET("0353")이 실재하고, **물리 신호(PHYSICAL_SIGNAL_TABLE.
   PHYSICAL_SIGNAL_COLUMN)가 아직 없으면** → REPLAY_SET 57개를 Operations API로
   직접 invoke(alembic 엔진을 거치지 않는 물리 재생, 선형 재생 우회)한 뒤
   `alembic_version`을 STAMP_TARGET으로 stamp한다. 버전 문자열 "0354"만으로는 main
   앵커와 "develop 계보로 0353까지 정상 적용된 뒤 우연히 0354에 멈춘 DB"를 구분할 수
   없어(페드루 PO 검토, 2026-09-17 12:33Z) 물리 신호로 소거한다 — 없으면 이미 57개가
   물리 적용된 정상 DB이니 no-op. 물리 신호는 REPLAY_SET의 첫 항목(0296)이 만드는
   `org_domain_label.canonical_slug`(결제와 무관한 비-결제 구간의 시작점 — 되돌린
   3개 중 하나였던 vat_rate_bp는 이 브랜치엔 애초에 존재하지 않아 신호로 못 쓴다).
2. **fail-closed**(페드루 PO 검토①, 2026-09-17): 위 조건이 아닌데 현재 stamp가 이
   파일셋(develop 그래프)에 아예 등록되지 않은 리비전이면 — "main에 이 잡 코드가
   모르는 리비전이 더 붙었다"는 뜻이라 no-op이 안전하지 않다(그대로 두면
   `upgrade heads`가 그 미지의 지점부터 무슨 짓을 할지 이 스크립트가 보장할 수
   없다) — 잡을 실패시켜 사람이 보게 한다. no-op는 오직 "현재 stamp가 develop
   그래프에 실재하는 리비전"일 때만이다(이미 STAMP_TARGET을 지났거나 애초에
   ANCHOR_VERSION이 아닌 정상 develop 계보 DB 전부 포함 — fresh DB·이 게이트를
   이미 통과한 DB 등).
3. REPLAY_SET 57개는 전부 트랜잭션 DDL이다(`CONCURRENTLY`·명시적 커밋·isolation
   변경 0건 — grep 확認, 아래 test_4010_prescription_c_migrate_gate.py가 고정)
   — 하나의 DB 트랜잭션으로 묶어 부분 적용을 원천 차단한다(전부 성공하거나 전부
   롤백, stamp도 성공 시에만).

## 실행 위치
`scripts/migrate.sh`에서 0183a fork precheck **뒤**·`check_stamp_chain_integrity.py`
(정합 가드) **앞** — 처방 C가 먼저 스키마를 따라잡아야 정합 가드가 사후 조건으로
의미가 있다(처방 C 전에 정합 가드를 돌리면 57개 누락 그대로 걸려 FAIL한다).

## REPLAY_SET의 구성 근거 — 57개가 왜 이 목록인가
develop 그래프에서 STAMP_TARGET(0353)의 조상을 CONTIGUOUS_LOWER_BOUND(0295, main이
실제로 도달해 있던 마지막 지점) 미포함으로 walk하면 정확히 57개(0296~0351·0353,
0352는 애초에 존재하지 않는 리비전 번호)가 나온다 — 이 57개는 **연속 구간**이라
main이 한 번에 건너뛴 부분과 정확히 대응하고, 전부 비-결제 마케팅/인프라 스키마다.
test_4010_prescription_c_migrate_gate.py가 이 57개를 그래프에서 직접 재계산해
대조한다.
"""
from __future__ import annotations

import os
import sys

from alembic.config import Config as AlembicConfig
from alembic.operations import Operations
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from alembic.util.exc import CommandError
from sqlalchemy import create_engine, text

ANCHOR_VERSION = "0354"
STAMP_TARGET = "0353"
CONTIGUOUS_LOWER_BOUND = "0295"

REPLAY_SET = [f"{i:04d}" for i in range(296, 352)] + [STAMP_TARGET]
assert len(REPLAY_SET) == 57, f"REPLAY_SET must be 57, got {len(REPLAY_SET)}"

# 페드루 PO 검토(2026-09-17 12:33Z, 09-18 결제 축 제외로 갱신) — "alembic_version ==
# '0354'" 문자열만으로는 main 앵커(0295에서 재봉합)와 "develop 계보로 0353까지 정상
# 적용된 뒤 우연히 0354에 멈춘 DB"를 구분 못 한다(둘 다 문자열은 똑같이 "0354") —
# 후자에 재생을 걸면 0296의 org_domain_label 테이블이 이미 있어 DuplicateTable로
# 죽는다(데이터는 안전하지만 정상 DB의 배포가 막히는 오판). migrate.sh의 기존 EE-stamp
# precheck(uq_org_subscriptions_org_id 존재 여부)와 동일 관례 — 버전 문자열이 아니라
# **물리 신호**로 판별한다. org_domain_label.canonical_slug는 REPLAY_SET의 첫 항목
# (0296)이 만드는 컬럼이라 "이미 있으면 57개가 이미 물리 적용됐다"는 뜻
# (test_4010_prescription_c_migrate_gate.py가 0296 ∈ REPLAY_SET을 별도로 고정).
# ⛔결제 되돌림 정책상 vat_rate_bp는 이 브랜치에 존재하지 않아 신호로 쓸 수 없다.
PHYSICAL_SIGNAL_TABLE = "org_domain_label"
PHYSICAL_SIGNAL_COLUMN = "canonical_slug"


def _physical_signal_already_applied(conn) -> bool:
    # 페드루 PO 비차단 제안(2026-09-17 12:39Z) — table_schema 조건 없이는 다른 스키마의
    # 동명 테이블/컬럼에도 오탐할 수 있다. current_schema()로 좁힌다(search_path가
    # 가리키는 실제 스키마 — migrate.sh/alembic이 붙는 그 스키마 그대로).
    result = conn.execute(
        text(
            "SELECT 1 FROM information_schema.columns "
            "WHERE table_schema = current_schema() "
            "AND table_name = :table_name AND column_name = :column_name"
        ),
        {"table_name": PHYSICAL_SIGNAL_TABLE, "column_name": PHYSICAL_SIGNAL_COLUMN},
    ).scalar()
    return result is not None


def _load_script_directory() -> ScriptDirectory:
    cfg = AlembicConfig("alembic.ini")
    return ScriptDirectory.from_config(cfg)


def _is_known_revision(script: ScriptDirectory, rev_id: str) -> bool:
    try:
        return script.get_revision(rev_id) is not None
    except CommandError:
        return False


def _replay(script: ScriptDirectory, conn) -> None:
    """호출부(main)가 이미 연 트랜잭션(autobegin) 안에서 실행 — 여기서 새로 begin()하지
    않는다(SQLAlchemy 2.x는 conn.execute() 시점에 이미 암묵 트랜잭션을 연다, 이중
    begin()은 InvalidRequestError). 실패 시 호출부가 rollback, 성공 시 호출부가 commit
    — 부분 적용 0건을 이 한 트랜잭션 경계로 보장한다."""
    ctx = MigrationContext.configure(conn)
    print(f"[prescription-c] REPLAY 개시 — {len(REPLAY_SET)}개 revision 직접 invoke 순서: "
          f"{REPLAY_SET[:3]}...{REPLAY_SET[-3:]}")
    with Operations.context(ctx):
        for i, rev_id in enumerate(REPLAY_SET, 1):
            rev_script = script.get_revision(rev_id)
            if rev_script is None:
                raise RuntimeError(f"revision {rev_id!r} not found in script directory")
            module = rev_script.module
            print(f"[prescription-c] ({i}/{len(REPLAY_SET)}) invoking {rev_id} upgrade() — "
                  f"{os.path.basename(module.__file__)}")
            module.upgrade()
    conn.execute(text("UPDATE alembic_version SET version_num = :v"), {"v": STAMP_TARGET})
    print(f"[prescription-c] REPLAY 완료 — {len(REPLAY_SET)}/{len(REPLAY_SET)} 성공, "
          f"alembic_version -> {STAMP_TARGET!r} (stamp 済)")


def main() -> int:
    script = _load_script_directory()
    # migrate.sh 계약(check_stamp_chain_integrity.py 상단 docstring과 동일)은
    # ALEMBIC_DATABASE_URL(psycopg2, sync)만 보장한다 — 이 스크립트는 migrate.sh에서만
    # 호출되므로(다른 Cloud Run Job에서 독립 실행되지 않음) scripts/jobs/_db_env.py의
    # ALEMBIC_URL→DATABASE_URL(async) 폴백은 대상 밖이다(story #2386 lint는 app.core.
    # database를 import하는 스크립트만 문다 — 이 스크립트는 raw SQLAlchemy만 써서
    # 애초에 그 스코프 밖). 출력에 URL 자체를 담지 않는다(AC5).
    engine = create_engine(os.environ["ALEMBIC_DATABASE_URL"])

    with engine.connect() as conn:
        try:
            current_revs = [row[0] for row in conn.execute(text("SELECT version_num FROM alembic_version"))]
        except Exception:
            print("[prescription-c] alembic_version 테이블 없음(최초 배포 등) — no-op.")
            return 0

        if not current_revs:
            print("[prescription-c] stamp 없음 — no-op.")
            return 0

        has_stamp_target = _is_known_revision(script, STAMP_TARGET)
        replay_targets = [rev for rev in current_revs if rev == ANCHOR_VERSION and has_stamp_target]

        if replay_targets:
            if len(current_revs) != 1:
                # ANCHOR_VERSION은 main의 단일-head 재봉합 지점이라 다중 head와 동시에
                # 나타날 수 없다 — 나타나면 이 스크립트가 모르는 상태이니 fail-closed.
                print(f"[prescription-c] FAIL — ANCHOR_VERSION({ANCHOR_VERSION!r})이 다중 "
                      f"head({current_revs})와 함께 있다 — 예상 밖 상태, 판별 불가.", file=sys.stderr)
                return 1
            if _physical_signal_already_applied(conn):
                print(
                    f"[prescription-c] no-op — alembic_version={current_revs}이지만 물리 신호"
                    f"({PHYSICAL_SIGNAL_TABLE}.{PHYSICAL_SIGNAL_COLUMN})가 이미 있다 — develop "
                    "계보로 정상 진행돼 우연히 0354에 멈춘 DB(main 앵커 아님), 처방 C 불필요."
                )
                return 0
            try:
                _replay(script, conn)
            except Exception:
                conn.rollback()
                print("[prescription-c] REPLAY 실패 — 트랜잭션 전체 롤백(부분 적용 0건 보장)",
                      file=sys.stderr)
                raise
            conn.commit()
            return 0

        unknown_revs = [rev for rev in current_revs if not _is_known_revision(script, rev)]
        if unknown_revs:
            print(
                "[prescription-c] FAIL-CLOSED — 현재 alembic_version"
                f"({current_revs})에 이 파일셋(develop 그래프)이 모르는 리비전"
                f"({unknown_revs})이 있다. ANCHOR_VERSION({ANCHOR_VERSION!r})도 아니라 "
                "처방 C 대상도 아니고, 알려진 develop 계보도 아니다 — main에 이 스크립트가 "
                "모르는 리비전이 더 붙었을 가능성이 있어 no-op이 안전하지 않다. 사람이 "
                "판단할 것(처방 C 재검토 또는 REPLAY_SET/ANCHOR_VERSION 갱신 필요).",
                file=sys.stderr,
            )
            return 1

        print(f"[prescription-c] no-op — 현재 alembic_version({current_revs})이 이미 develop "
              "그래프 계보(처방 C 불필요 또는 이미 처리됨).")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
