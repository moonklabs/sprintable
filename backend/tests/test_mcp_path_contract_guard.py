"""story #2280 — infra/mcp_path_contract_guard.py(MCP 경로 계약 가드) 회귀가드.

`infra/test_check_serving_reality.py`(story #2174)와 동형 구조 — 라이브 아무것도 안 건드리고
판정 로직만 고정한다. `load_route_table`/`load_mcp_declared`/`_load_allowlist`/
`check_ref_freshness`를 가짜로 갈아끼워 실제로 겪은 모양(2026-07-28 #2271/#2280 발견분) 그대로
넣고, 가드가 그걸 잡는지/허용목록으로 눈감는지/만료되면 다시 잡는지를 본다.
"""
from __future__ import annotations

import importlib.util
from datetime import date
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[2]
_INFRA_DIR = _REPO_ROOT / "infra"


def _load():
    spec = importlib.util.spec_from_file_location(
        "mcp_path_contract_guard", _INFRA_DIR / "mcp_path_contract_guard.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _stub(monkeypatch, mod, *, calls=None, unreadable=None, route_table=None,
          mismatches=None, indirect=None, today="2026-07-28", fresh=True):
    monkeypatch.setattr(mod, "check_ref_freshness", lambda: None if fresh else "테스트로 심은 stale")
    monkeypatch.setattr(mod, "load_route_table", lambda: route_table or {mod.POSITIVE_CONTROL})
    monkeypatch.setattr(mod, "load_mcp_declared", lambda: (calls or [], unreadable or []))
    monkeypatch.setattr(mod, "_load_allowlist", lambda: (mismatches or {}, indirect or {}))
    monkeypatch.setattr(mod, "_today", lambda: date.fromisoformat(today))


def _entry(reason="r", declared_by="PO", until="2026-08-27"):
    return {"reason": reason, "declared_by": declared_by, "until": until}


def test_all_matching_passes(monkeypatch):
    """모든 호출이 실제 라우트와 일치하면(불일치 0·M 0) 그린."""
    mod = _load()
    _stub(monkeypatch, mod,
          route_table={mod.POSITIVE_CONTROL, ("GET", "/api/v2/epics")},
          calls=[("epics", "GET", "/api/v2/epics")])
    assert mod.main() == 0


def test_positive_control_missing_fails_hard(monkeypatch):
    """⭐양성대조 자체가 route_table에 없으면 대조법이 고장난 것 — 다른 결과를 신뢰 말고 즉시 2."""
    mod = _load()
    _stub(monkeypatch, mod, route_table={("GET", "/api/v2/something-else")})
    assert mod.main() == 2


def test_unknown_mismatch_fails(monkeypatch, capsys):
    """허용목록에 없는 새 불일치는 그대로 FAIL — 2026-07-28 실제 발견 4건과 동형 모양."""
    mod = _load()
    _stub(monkeypatch, mod,
          calls=[("notifications", "PATCH", "/api/v2/notifications")])
    assert mod.main() == 1
    out = capsys.readouterr().out
    assert "신규" in out and "notifications" in out


def test_baselined_mismatch_within_expiry_passes(monkeypatch, capsys):
    """허용목록에 사유·선언자·미래 만료일과 함께 등재돼 있으면 통과(AC8 — 알려진 4건이 상시
    빨강을 만들지 않게)."""
    mod = _load()
    key = ("notifications", "PATCH", "/api/v2/notifications")
    _stub(monkeypatch, mod,
          calls=[key],
          mismatches={key: _entry()})
    assert mod.main() == 0
    assert "알려짐" in capsys.readouterr().out


def test_baselined_mismatch_expired_fails(monkeypatch, capsys):
    """⭐등재는 돼 있지만 until이 지났으면 다시 FAIL — 선언이 스스로 만료된다(story #2174와
    동일 원칙: "끝났다는 통지가 사라지면 시스템이 그 상태를 영영 놓지 못한다")."""
    mod = _load()
    key = ("notifications", "PATCH", "/api/v2/notifications")
    _stub(monkeypatch, mod,
          calls=[key],
          mismatches={key: _entry(until="2026-07-01")},
          today="2026-07-28")
    assert mod.main() == 1
    assert "만료" in capsys.readouterr().out


def test_baselined_mismatch_until_too_far_fails(monkeypatch, capsys):
    """⭐`until: 2099-12-31`류 사실상 영구 예외 우회를 막는다(check_serving_reality.py와 동일
    교훈 — 상한 없는 선언은 이 가드가 막으려는 바로 그것을 재현한다)."""
    mod = _load()
    key = ("notifications", "PATCH", "/api/v2/notifications")
    _stub(monkeypatch, mod,
          calls=[key],
          mismatches={key: _entry(until="2099-12-31")})
    assert mod.main() == 1
    assert "너무 멀다" in capsys.readouterr().out


def test_baselined_mismatch_without_reason_fails(monkeypatch, capsys):
    mod = _load()
    key = ("notifications", "PATCH", "/api/v2/notifications")
    entry = _entry()
    del entry["reason"]
    _stub(monkeypatch, mod, calls=[key], mismatches={key: entry})
    assert mod.main() == 1
    assert "reason" in capsys.readouterr().out


def test_unknown_indirect_helper_fails(monkeypatch, capsys):
    """⭐M(리터럴 아닌 경로 호출)이 baseline에 없으면 하드fail — 2026-07-28에 실제로 겪은
    "조용히 빠지는" 실패를 막는 그 조항(⑤⑥)."""
    mod = _load()
    _stub(monkeypatch, mod,
          unreadable=[("payments", "charge_card", "POST some_var")])
    assert mod.main() == 1
    out = capsys.readouterr().out
    assert "신규" in out and "payments" in out and "charge_card" in out


def test_baselined_indirect_helper_passes(monkeypatch, capsys):
    """실제 사례 — attachments.py:upload_attachments()가 baseline에 있으면 M으로는 찍히되(이름
    노출) 그린을 막지 않는다."""
    mod = _load()
    key = ("attachments", "upload_attachments")
    _stub(monkeypatch, mod,
          unreadable=[("attachments", "upload_attachments", "POST upload_path")],
          indirect={key: _entry()})
    assert mod.main() == 0
    out = capsys.readouterr().out
    assert "M(1개)" in out and "수기검증됨" in out


def test_stale_checkout_fails(monkeypatch, capsys):
    """⭐ref 신선도 자체 실패(develop과 다름)면 그 자체로 FAIL — 2026-07-28 오보 재발방지 조항."""
    mod = _load()
    _stub(monkeypatch, mod, fresh=False)
    assert mod.main() == 1
    assert "ref 신선도" in capsys.readouterr().err


def test_norm_ignores_path_param_names():
    mod = _load()
    assert mod.norm("/api/v2/epics/{epic_id}") == mod.norm("/api/v2/epics/{id}")


def test_repo_allowlist_entries_are_wellformed():
    """저장소에 실제로 커밋된 선언(infra/mcp-path-contract-allowlist.yml)이 형식을 지키는지."""
    mod = _load()
    mismatches, indirect = mod._load_allowlist()
    for kind, entries in (("declared_mismatches", mismatches), ("declared_indirect", indirect)):
        for key, entry in entries.items():
            problem = mod._expired(entry, date(2026, 7, 28))
            assert problem is None, f"{kind}/{key}: {problem}"


def test_repo_current_state_is_green():
    """⭐리포에 실제로 커밋된 코드+허용목록으로 가드를 그대로 돌려서 통과하는지 — 이게 CI에서
    도는 그 실행과 동일하다(가짜 없음, ref 신선도만 이 테스트 환경에선 git 명령이 있어야 함)."""
    mod = _load()
    assert mod.main() == 0
