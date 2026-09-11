"""story #3806(Phase3·3-2 PR5, 페드루 PO 콜 「가드 1개」 2026-09-11 12:14Z) — 정적 가드.
`organic_snapshots_only()`(ads_spend_snapshots.py, PR4가 만든 paid 채널 제외의
**유일한** 자리)는 술어 함수를 만들고도 소비처가 그걸 «안 부를 수 있는» 자리가 남아
있었다 — 실측: 이 가드를 만들기 前, `app/services/insights_board.py`의 d1/d7 배치
조회·status 필터·정렬 스칼라 서브쿼리 3곳과 `app/services/measured_metrics.py`의
분모 조회 1곳, 총 4곳이 `InsightSnapshot`을 조회하면서 이 술어를 안 거치고 있었다
(PR2~PR4가 고친 insight_snapshots.py의 두 곳과 별개로, PR5 자체점검에서 새로 발견).

이 가드는 `app/` 전수에서 `InsightSnapshot`(모델 클래스, 단어경계로 정확히 매칭 —
`InsightSnapshotBucketView` 등 이름이 겹치는 다른 클래스는 제외)을 참조하는 파일마다
`organic_snapshots_only(`을 실제로 호출하는지만 본다(정밀 조회-단위 AST 분석은 안
함 — 파일 단위 「이 술어를 한 번도 안 부르는 파일이 InsightSnapshot을 참조하면
수상하다」는 거친 신호. 페드루 PO 콜의 "가드 1개"가 요구한 비용 대비 방어 수준).
_EXEMPT_FILES에 없는 새 소비처가 이 술어를 안 부르면 이 테스트가 RED — 다섯 번째
소비처가 또 같은 구멍을 내는 것을 막는다."""
from __future__ import annotations

import re
from pathlib import Path

import pytest

_BACKEND_ROOT = Path(__file__).resolve().parent.parent
_APP_DIR = _BACKEND_ROOT / "app"

# ⛔사유 없는 예외 금지(mcp_toolset.py의 _ORG_SCOPED_UNMAPPED_SEGMENTS_WITH_REASON과
# 동일 관례) — 새 파일을 여기 추가할 땐 왜 organic_snapshots_only()가 필요 없는지
# 한 줄로 적을 것.
_EXEMPT_FILES: dict[str, str] = {
    "app/models/insight_snapshot.py": "모델 정의 자체 — 조회부가 아니다.",
    "app/services/ads_spend_snapshots.py": (
        "organic_snapshots_only() 정의처. 이 파일의 paid 캡처 루프(process_due_ads_spend_"
        "snapshots)는 의도적으로 paid 채널만 보는 유일한 정당한 소비처 — 이 술어를 "
        "자기 자신에게 부를 이유가 없다(반대 방향 필터가 필요하면 그건 별개 술어)."
    ),
    "app/models/__init__.py": "모델 클래스 import(SQLAlchemy 등록용)뿐 — 쿼리 0건.",
    "app/routers/measurement_connections.py": "docstring/주석 안 언급뿐 — 실 쿼리 0건(grep 확認).",
    "app/services/channel_adapters.py": "주석 안 언급뿐 — 실 쿼리 0건(grep 확認).",
    "app/services/publication_reconciliation.py": (
        "InsightSnapshot(...) 생성자로 transient 객체를 만들 뿐(db.add() 0회 — 파라미터 "
        "캐리어, 파일 자체 주석 확認) — DB 조회가 아니라 leak 대상이 아니다."
    ),
    "app/services/org_cost_summary.py": (
        "story #3809(Phase3·3-7) — org 비용 원장의 paid 축(광고비 집계·일별 시계열)이 "
        "의도적으로 paid 채널만 보는 정당한 소비처(ads_spend_snapshots.py와 동형 판단) — "
        "실제로 `paid_snapshots_only()`(같은 파일의 반대짝 술어)를 그대로 호출한다(손으로 "
        "채널/소스 필터를 다시 안 적음), organic_snapshots_only()를 자기 자신에게 부를 "
        "이유가 없다."
    ),
}


def _files_referencing_insight_snapshot_model(app_dir: Path = _APP_DIR) -> list[Path]:
    """`InsightSnapshot` 토큰(단어경계)을 참조하는 `app/**/*.py` 전수. import만
    있고 실제 조회가 없는 파일도 걸릴 수 있다(거친 신호 — docstring 참고)."""
    token_re = re.compile(r"\bInsightSnapshot\b")
    hits = []
    for path in sorted(app_dir.rglob("*.py")):
        if "__pycache__" in path.parts:
            continue
        if token_re.search(path.read_text(encoding="utf-8")):
            hits.append(path)
    return hits


def _predicate_violations(app_dir: Path = _APP_DIR, backend_root: Path = _BACKEND_ROOT) -> list[str]:
    violations = []
    for path in _files_referencing_insight_snapshot_model(app_dir):
        rel = str(path.relative_to(backend_root))
        if rel in _EXEMPT_FILES:
            continue
        if "organic_snapshots_only(" not in path.read_text(encoding="utf-8"):
            violations.append(rel)
    return violations


def test_grounding_scan_finds_known_consumers():
    """자가 확認 — 스캐너가 실제로 파일을 읽고 있다는 증거(항진명제 가드 방지).
    현재 알려진 실 소비처 전부가 잡히는지(예외 포함 6개 이상)."""
    hits = {str(p.relative_to(_BACKEND_ROOT)) for p in _files_referencing_insight_snapshot_model()}
    assert "app/services/insight_snapshots.py" in hits
    assert "app/services/insights_board.py" in hits
    assert "app/services/measured_metrics.py" in hits
    assert "app/services/ads_spend_snapshots.py" in hits


def test_mutation_synthetic_leaky_consumer_is_caught(tmp_path):
    """양성대조 — `organic_snapshots_only(`을 안 부르는 합성 파일 하나를 격리
    디렉터리(app_dir 주입, 실 app/ 무접촉)에 두면 스캐너가 그걸 위반으로 잡아야
    한다. 고치기 前엔 이 표본이 못 잡히면(빈 결과) 가드 자체가 항진명제다."""
    (tmp_path / "leaky_consumer.py").write_text(
        "from app.models.insight_snapshot import InsightSnapshot\n"
        "from sqlalchemy import select\n"
        "\n"
        "async def f(db, org_id):\n"
        "    return (await db.execute(\n"
        "        select(InsightSnapshot).where(InsightSnapshot.org_id == org_id)\n"
        "    )).scalars().all()\n",
    )
    violations = _predicate_violations(app_dir=tmp_path, backend_root=tmp_path)
    assert violations == ["leaky_consumer.py"]


def test_mutation_synthetic_consumer_calling_predicate_passes(tmp_path):
    """양성대조 짝 — 같은 모양인데 `organic_snapshots_only(`을 실제로 부르면
    위반 0건이어야 한다(가드가 «InsightSnapshot 언급 자체»가 아니라 «술어 호출
    누락»만 잡는다는 것을 대조로 증명)."""
    (tmp_path / "clean_consumer.py").write_text(
        "from app.models.insight_snapshot import InsightSnapshot\n"
        "from app.services.ads_spend_snapshots import organic_snapshots_only\n"
        "from sqlalchemy import select\n"
        "\n"
        "async def f(db, org_id):\n"
        "    return (await db.execute(\n"
        "        organic_snapshots_only(select(InsightSnapshot).where(InsightSnapshot.org_id == org_id))\n"
        "    )).scalars().all()\n",
    )
    violations = _predicate_violations(app_dir=tmp_path, backend_root=tmp_path)
    assert violations == []


def test_every_insight_snapshot_consumer_calls_organic_predicate_or_is_exempt():
    """가드 본체(페드루 PO 追加 요구, 2026-09-11 12:14Z) — 새 소비처가 organic_
    snapshots_only()를 안 부르고 조용히 들어오면 RED. _EXEMPT_FILES에 없는데
    걸리면, 그 파일이 정말 paid를 봐야 하는지부터 판단하고(대개는 이 술어를
    부르는 것이 정답), 진짜 예외라면 사유와 함께 등재한다."""
    violations = _predicate_violations()
    assert not violations, (
        f"InsightSnapshot을 참조하면서 organic_snapshots_only()를 안 부르는 파일: {sorted(violations)} — "
        "story #3806에서 이 술어 없이 paid(ads_boost) 채널 행이 organic 조회에 섞이는 실 결함이 "
        "insights_board.py 3곳·measured_metrics.py 1곳에서 실제로 났다(테스트로 확認·수정 완료). "
        "새 파일이 정말 paid를 의도적으로 보려는 것이면 이 파일의 _EXEMPT_FILES에 이유와 함께 등재하라."
    )
