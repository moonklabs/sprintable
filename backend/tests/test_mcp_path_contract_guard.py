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
          mismatches=None, indirect=None, permanent_indirect=None, today="2026-07-28", fresh=True):
    monkeypatch.setattr(mod, "check_ref_freshness", lambda: None if fresh else "테스트로 심은 stale")
    monkeypatch.setattr(mod, "load_route_table", lambda: route_table or {mod.POSITIVE_CONTROL})
    monkeypatch.setattr(mod, "load_mcp_declared", lambda: (calls or [], unreadable or []))
    monkeypatch.setattr(
        mod, "_load_allowlist",
        lambda: (mismatches or {}, indirect or {}, permanent_indirect or {}),
    )
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


def test_permanent_indirect_helper_passes_without_until(monkeypatch, capsys):
    """story #3168(2026-08-28) — declared_permanent_indirect는 until 없이도(reason/
    declared_by만으로) 통과해야 한다(구조적으로 영구한 간접경로는 시한을 요구 안 함)."""
    mod = _load()
    key = ("chat", "_resolve_mention_content")
    entry = {"reason": "동적 dispatch, 구조적으로 영구", "declared_by": "디디"}
    _stub(monkeypatch, mod,
          unreadable=[("chat", "_resolve_mention_content", "GET endpoint")],
          permanent_indirect={key: entry})
    assert mod.main() == 0
    out = capsys.readouterr().out
    assert "M(1개)" in out and "영구선언" in out


def test_permanent_indirect_without_reason_fails(monkeypatch, capsys):
    """reason 없는 영구선언은 until 면제와 무관하게 여전히 FAIL — «사유 없이 영구 예외»는
    이 카테고리 신설의 취지(사유는 남기되 시한만 면제) 자체를 무력화한다."""
    mod = _load()
    key = ("attachments", "upload_attachments")
    entry = {"declared_by": "까심"}  # reason 누락
    _stub(monkeypatch, mod,
          unreadable=[("attachments", "upload_attachments", "POST upload_path")],
          permanent_indirect={key: entry})
    assert mod.main() == 1
    assert "reason" in capsys.readouterr().out


def test_permanent_indirect_without_declared_by_fails(monkeypatch, capsys):
    mod = _load()
    key = ("attachments", "upload_attachments")
    entry = {"reason": "동적 dispatch"}  # declared_by 누락
    _stub(monkeypatch, mod,
          unreadable=[("attachments", "upload_attachments", "POST upload_path")],
          permanent_indirect={key: entry})
    assert mod.main() == 1
    assert "declared_by" in capsys.readouterr().out


def test_unknown_permanent_indirect_key_fails(monkeypatch, capsys):
    """permanent_indirect에도 declared_indirect에도 없는 새 M은 여전히 하드fail — 새 카테고리
    신설이 «허용목록에 없어도 통과» 구멍을 만들지 않았는지 확認."""
    mod = _load()
    _stub(monkeypatch, mod,
          unreadable=[("payments", "charge_card", "POST some_var")],
          permanent_indirect={("unrelated", "func"): {"reason": "r", "declared_by": "PO"}})
    assert mod.main() == 1
    out = capsys.readouterr().out
    assert "신규" in out and "payments" in out


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
    """저장소에 실제로 커밋된 선언(infra/mcp-path-contract-allowlist.yml)이 형식을 지키는지 —
    가드 자신의 `_today()`(실시간)로 재야 «지금 이 레포 상태가 유효한가»라는 이 테스트의
    본뜻과 맞는다(실사고, 2026-08-28 — 구 코드는 `date(2026, 7, 28)`을 얼어붙은 기준일로
    하드코딩해서, 30일 상한을 그 frozen 날짜 기준으로 재는 바람에 이후 어떤 정당한 `until`
    연장도 영원히 이 테스트를 못 지나갔다 — until 갱신 자체가 불가능해지는 자기모순)."""
    mod = _load()
    today = mod._today()
    mismatches, indirect, permanent_indirect = mod._load_allowlist()
    for kind, entries in (("declared_mismatches", mismatches), ("declared_indirect", indirect)):
        for key, entry in entries.items():
            problem = mod._expired(entry, today)
            assert problem is None, f"{kind}/{key}: {problem}"
    # story #3168 — declared_permanent_indirect는 until 없이도 정상이어야 한다(별도 검사).
    for key, entry in permanent_indirect.items():
        problem = mod._permanent_entry_problem(entry)
        assert problem is None, f"declared_permanent_indirect/{key}: {problem}"
        assert "until" not in entry, (
            f"declared_permanent_indirect/{key}: until이 있으면 안 됨(구조적으로 영구한 "
            "간접경로엔 시한 개념 자체가 안 맞음 — 시한부면 declared_indirect로 내려갈 것)"
        )


def test_repo_allowlist_wellformed_check_still_enforces_horizon_cap():
    """양성대조(페드루 지시, 2026-08-28) — 바로 위 테스트를 frozen date(2026,7,28) 대신
    `mod._today()`(실시간)로 바꾼 뒤에도 30일 상한 집행 자체가 죽지 않았는지 값으로
    고정한다: 상한을 넘는(45일 뒤) until을 넣으면 실시간 기준으로도 여전히 FAIL이어야
    한다(날짜 기준을 동적으로 바꾸면서 상한 집행이 조용히 무력화되는 회귀를 막는다)."""
    from datetime import timedelta
    mod = _load()
    today = mod._today()
    over_cap = _entry(until=(today + timedelta(days=45)).isoformat())
    problem = mod._expired(over_cap, today)
    assert problem is not None and "너무 멀다" in problem


def test_repo_allowlist_wellformed_check_still_enforces_horizon_cap():
    """양성대조(페드루 지시, 2026-08-28) — 바로 위 테스트를 frozen date(2026,7,28) 대신
    `mod._today()`(실시간)로 바꾼 뒤에도 30일 상한 집행 자체가 죽지 않았는지 값으로
    고정한다: 상한을 넘는(45일 뒤) until을 넣으면 실시간 기준으로도 여전히 FAIL이어야
    한다(날짜 기준을 동적으로 바꾸면서 상한 집행이 조용히 무력화되는 회귀를 막는다)."""
    from datetime import timedelta
    mod = _load()
    today = mod._today()
    over_cap = _entry(until=(today + timedelta(days=45)).isoformat())
    problem = mod._expired(over_cap, today)
    assert problem is not None and "너무 멀다" in problem


def test_repo_current_state_is_green():
    """⭐리포에 실제로 커밋된 코드+허용목록으로 가드를 그대로 돌려서 통과하는지 — 이게 CI에서
    도는 그 실행과 동일하다(가짜 없음, ref 신선도만 이 테스트 환경에선 git 명령이 있어야 함)."""
    mod = _load()
    assert mod.main() == 0
