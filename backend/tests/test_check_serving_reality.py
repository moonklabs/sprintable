"""story #2174 — infra/check_serving_reality.py(배포 실효 가드) 회귀가드.

라이브 gcloud 접근 없이 판정 로직만 고정한다 — `_list_live_services`/`_serving_status` 를
가짜로 갈아끼워 **실제로 겪은 두 표본의 모양 그대로** 넣고, 가드가 그걸 잡는지 본다.

```
표본 A  frontend-prod 가 traffic 을 특정 리비전에 고정 → 22시간 옛 코드 서빙 (2026-07-23~24)
표본 B  internal-api-dev-00015 가 Ready=False → 5일간 옛 리비전 서빙 (2026-07-20~)
```
⭐**표본을 그대로 넣는 것이 이 테스트의 값**이다 — 가드가 "잡을 수 있게 생겼다"가 아니라
"우리가 실제로 놓쳤던 그 모양을 잡는다"를 고정한다.
"""
from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[2]
_INFRA_DIR = _REPO_ROOT / "infra"

# 표본 A 실측 모양 — 고정되면 latestRevision 항목이 사라지고 revisionName 만 남는다.
_PINNED_TRAFFIC = [{"revisionName": "sprintable-frontend-prod-00212-7x9", "percent": 100}]
# 정상 모양 — 자동 최신 추적.
_LATEST_TRAFFIC = [
    {"revisionName": "sprintable-frontend-prod-00216-5j6", "percent": 100, "latestRevision": True}
]


def _load():
    spec = importlib.util.spec_from_file_location(
        "check_serving_reality", _INFRA_DIR / "check_serving_reality.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _stub(monkeypatch, mod, statuses: dict[str, dict], pins=None, stalls=None):
    monkeypatch.setattr(mod, "_list_live_services", lambda: list(statuses))
    monkeypatch.setattr(mod, "_serving_status", lambda s: statuses[s])
    monkeypatch.setattr(mod, "_load_allowlist", lambda: (pins or {}, stalls or {}))
    monkeypatch.setenv("SERVING_REALITY_TODAY", "2026-07-25")


def _healthy(rev: str = "svc-00010-aaa") -> dict:
    return {
        "traffic": [{"revisionName": rev, "percent": 100, "latestRevision": True}],
        "latest_ready": rev,
        "latest_created": rev,
    }


def test_all_healthy_passes(monkeypatch):
    mod = _load()
    _stub(monkeypatch, mod, {"svc-a": _healthy(), "svc-b": _healthy("svc-00003-bbb")})
    assert mod.main() == 0


def test_sample_a_undeclared_pin_is_caught(monkeypatch, capsys):
    """표본 A — traffic 고정으로 새 리비전이 사용자에 안 닿는 상태."""
    mod = _load()
    _stub(monkeypatch, mod, {
        "sprintable-frontend-prod": {
            "traffic": _PINNED_TRAFFIC,
            "latest_ready": "sprintable-frontend-prod-00216-5j6",
            "latest_created": "sprintable-frontend-prod-00216-5j6",
        },
    })
    assert mod.main() == 1
    out = capsys.readouterr().out
    assert "축A" in out and "sprintable-frontend-prod" in out


def test_sample_b_undeclared_stall_is_caught(monkeypatch, capsys):
    """표본 B — 최신 리비전이 Ready 실패해 옛 리비전이 계속 서빙되는 상태."""
    mod = _load()
    _stub(monkeypatch, mod, {
        "sprintable-internal-api-dev": {
            "traffic": [{
                "revisionName": "sprintable-internal-api-dev-00014-bwq",
                "percent": 100, "latestRevision": True,
            }],
            "latest_ready": "sprintable-internal-api-dev-00014-bwq",
            "latest_created": "sprintable-internal-api-dev-00015-bn6",
        },
    })
    assert mod.main() == 1
    out = capsys.readouterr().out
    assert "축B" in out and "00015-bn6" in out


def test_declared_stall_within_expiry_passes(monkeypatch):
    """의도적/추적 중 선언은 통과시킨다 — 가드가 노이즈가 되면 아무도 안 본다(AC3)."""
    mod = _load()
    _stub(
        monkeypatch, mod,
        {"sprintable-internal-api-dev": {
            "traffic": [{"revisionName": "x-00014", "percent": 100, "latestRevision": True}],
            "latest_ready": "x-00014", "latest_created": "x-00015",
        }},
        stalls={"sprintable-internal-api-dev": {
            "reason": "story #2184 로 추적 중", "declared_by": "PO", "until": "2026-08-08",
        }},
    )
    assert mod.main() == 0


def test_expired_declaration_fails(monkeypatch, capsys):
    """⭐선언 자체가 스스로 만료된다 — 이 가드가 감시하는 원칙(상태 자가회수)을 가드 자신이
    지킨다. 만료된 선언은 "영원히 사는 예외"가 되어 가드를 조용히 무력화한다."""
    mod = _load()
    _stub(
        monkeypatch, mod,
        {"svc-x": {
            "traffic": [{"revisionName": "x-1", "percent": 100, "latestRevision": True}],
            "latest_ready": "x-1", "latest_created": "x-2",
        }},
        stalls={"svc-x": {"reason": "r", "declared_by": "PO", "until": "2026-07-24"}},
    )
    assert mod.main() == 1
    assert "만료" in capsys.readouterr().out


def test_declaration_without_until_fails(monkeypatch, capsys):
    """`until` 없는 선언 = 영원히 사는 선언 — 허용하지 않는다."""
    mod = _load()
    _stub(
        monkeypatch, mod,
        {"svc-x": {
            "traffic": [{"revisionName": "x-1", "percent": 100, "latestRevision": True}],
            "latest_ready": "x-1", "latest_created": "x-2",
        }},
        stalls={"svc-x": {"reason": "r", "declared_by": "PO"}},
    )
    assert mod.main() == 1
    assert "until" in capsys.readouterr().out


def test_stale_declaration_fails(monkeypatch, capsys):
    """등재돼 있는데 라이브가 이미 정상이면 그것도 잡는다 — 사실보다 오래 사는 선언은
    다음에 생길 진짜 건을 "등재된 거야"로 가려버린다."""
    mod = _load()
    _stub(
        monkeypatch, mod, {"svc-x": _healthy("x-1")},
        stalls={"svc-x": {"reason": "r", "declared_by": "PO", "until": "2026-12-31"}},
    )
    assert mod.main() == 1
    assert "이미 정상" in capsys.readouterr().out


def test_empty_traffic_is_treated_as_pinned(monkeypatch, capsys):
    """판정 불가를 조용히 통과시키지 않는다 — 가장 이상한 상태를 못 보게 되기 때문."""
    mod = _load()
    _stub(monkeypatch, mod, {"svc-x": {
        "traffic": [], "latest_ready": "x-1", "latest_created": "x-1",
    }})
    assert mod.main() == 1
    assert "축A" in capsys.readouterr().out


def test_guard_asks_gcloud_for_status_not_spec():
    """⛔`spec.template...image` 로 판정하면 표본 A 를 통째로 놓친다 — 그 필드는 "다음에 쓸
    템플릿"이지 "지금 트래픽 받는 리비전"이 아니다(PO 가 실제로 이 필드만 보고 "배포 실효"를
    선언할 뻔했다).

    ⚠️소스 전체 문자열 검색으로 잡으면 **설명용 docstring 의 언급까지 걸려** 판별력이
    엉뚱해진다(처음에 그렇게 썼다가 걸렸다). gcloud 에 실제로 넘어가는 `--format` 인자만
    본다 — 검사 대상은 "무엇을 설명했나"가 아니라 "무엇을 물어봤나"다."""
    import ast

    tree = ast.parse((_INFRA_DIR / "check_serving_reality.py").read_text())
    format_args = [
        node.value for node in ast.walk(tree)
        if isinstance(node, ast.Constant) and isinstance(node.value, str)
        and node.value.startswith("--format=")
    ]
    assert format_args, "gcloud --format 인자를 하나도 못 찾았다 — 이 테스트가 무효화됐다"
    for arg in format_args:
        assert "spec" not in arg, f"gcloud 에 spec 을 물었다: {arg}"
    assert any("status" in arg for arg in format_args), "status 를 묻는 호출이 없다"


def test_repo_allowlist_entries_are_wellformed():
    """저장소에 실제로 커밋된 선언들이 형식을 지키는지 — 사람이 손으로 쓰는 파일이라
    reason·declared_by·until 누락이 나기 쉽다."""
    mod = _load()
    pins, stalls = mod._load_allowlist()
    from datetime import date
    for kind, entries in (("declared_pins", pins), ("declared_stalls", stalls)):
        for service, entry in entries.items():
            problem = mod._expired(entry, date(2026, 7, 25))
            assert problem is None, f"{kind}/{service}: {problem}"
            assert entry.get("declared_by"), f"{kind}/{service}: declared_by 누락"


@pytest.mark.parametrize("traffic,expected", [
    ([{"revisionName": "r", "percent": 100, "latestRevision": True}], False),
    ([{"revisionName": "r", "percent": 100}], True),
    ([], True),
    # ⭐까심군 적대적 리뷰 ① — 99% 고정 + 1% 자동최신 카나리. 예전 구현은 "latestRevision
    # 항목이 하나라도 있으면 통과"라 이걸 놓쳤다. 사용자의 99% 가 옛 코드를 받는 상태이므로
    # 표본 A 와 사실상 동급이다.
    ([{"revisionName": "old", "percent": 99},
      {"revisionName": "new", "percent": 1, "latestRevision": True}], True),
    # 정상 100% 자동최신은 통과해야 한다(오탐 0).
    ([{"revisionName": "new", "percent": 100, "latestRevision": True}], False),
])
def test_is_pinned_shapes(traffic, expected):
    assert _load()._is_pinned(traffic) is expected


# ── 까심군 적대적 리뷰(2026-07-25)에서 나온 구멍들의 회귀가드 ─────────────────

def test_canary_split_is_caught_live_shape(monkeypatch, capsys):
    """리뷰 ① — 99%/1% 분할이 축A 로 잡히는지 end-to-end 로."""
    mod = _load()
    _stub(monkeypatch, mod, {"svc-canary": {
        "traffic": [
            {"revisionName": "svc-00010-old", "percent": 99},
            {"revisionName": "svc-00011-new", "percent": 1, "latestRevision": True},
        ],
        "latest_ready": "svc-00011-new", "latest_created": "svc-00011-new",
    }})
    assert mod.main() == 1
    out = capsys.readouterr().out
    assert "축A" in out and "1%" in out


def test_until_far_in_future_is_rejected(monkeypatch, capsys):
    """⭐리뷰 ③ — `until: 2099-12-31` 로 사실상 영구 예외를 만드는 우회로가 실제로
    열려 있었다. 상한을 두지 않으면 허용목록이 이 가드가 막으려던 것을 그대로 재현한다."""
    mod = _load()
    _stub(
        monkeypatch, mod,
        {"svc-x": {
            "traffic": [{"revisionName": "x-1", "percent": 100, "latestRevision": True}],
            "latest_ready": "x-1", "latest_created": "x-2",
        }},
        stalls={"svc-x": {"reason": "r", "declared_by": "PO", "until": "2099-12-31"}},
    )
    assert mod.main() == 1
    assert "너무 멀다" in capsys.readouterr().out


def test_one_unreadable_service_does_not_stop_the_batch(monkeypatch, capsys):
    """⭐리뷰 ② — 실전 영향이 가장 컸던 구멍. 서비스 하나의 조회 실패가 배치를 죽이면
    나머지는 그 사이클에 **아예 안 보이고**(6시간 무방비), 게다가 실패가 스택트레이스로만
    나가 "배포 실효 FAIL" 로도 안 읽힌다.

    ⛔"읽기 실패 → 조용히 스킵"도 아니어야 한다 — 그러면 감시가 꺼졌는데 초록으로 보인다.
    못 읽은 것은 **못 읽었다고 실패로 보고**되어야 한다."""
    mod = _load()
    statuses = {
        "svc-ok": _healthy("ok-1"),
        "svc-broken": None,   # 조회 시 예외
        "svc-stalled": {
            "traffic": [{"revisionName": "s-1", "percent": 100, "latestRevision": True}],
            "latest_ready": "s-1", "latest_created": "s-2",
        },
    }

    def _status(name):
        if statuses[name] is None:
            raise RuntimeError("gcloud rate limit")
        return statuses[name]

    monkeypatch.setattr(mod, "_list_live_services", lambda: list(statuses))
    monkeypatch.setattr(mod, "_serving_status", _status)
    monkeypatch.setattr(mod, "_load_allowlist", lambda: ({}, {}))
    monkeypatch.setenv("SERVING_REALITY_TODAY", "2026-07-25")

    assert mod.main() == 1
    out = capsys.readouterr().out
    # 못 읽은 것은 실패로 보고된다
    assert "svc-broken" in out and "못 읽었다" in out
    # ⭐그리고 나머지 서비스 판정은 **계속 돌았다** — 이게 이 테스트의 본체다
    assert "svc-stalled" in out and "축B" in out
    assert "2/3" in out  # 검사한 서비스 수를 정직하게 밝힌다


def test_declared_pins_expiry_and_staleness_are_checked_too(monkeypatch, capsys):
    """⭐리뷰 ① 부수 — 만료/낡음 테스트가 전부 축B(`declared_stalls`)로만 돌아서, 축A
    (`declared_pins`) 쪽에만 있는 비대칭 버그가 있어도 유닛이 못 잡았다. 대칭으로 고정한다."""
    mod = _load()
    # (a) 만료된 pin 선언
    _stub(
        monkeypatch, mod,
        {"svc-p": {
            "traffic": [{"revisionName": "p-1", "percent": 100}],  # 고정 상태
            "latest_ready": "p-2", "latest_created": "p-2",
        }},
        pins={"svc-p": {"reason": "r", "declared_by": "PO", "until": "2026-07-24"}},
    )
    assert mod.main() == 1
    assert "만료" in capsys.readouterr().out

    # (b) 라이브는 이미 정상인데 pin 선언이 남아 있음
    _stub(
        monkeypatch, mod, {"svc-p": _healthy("p-1")},
        pins={"svc-p": {"reason": "r", "declared_by": "PO", "until": "2026-08-01"}},
    )
    assert mod.main() == 1
    assert "이미 정상" in capsys.readouterr().out
