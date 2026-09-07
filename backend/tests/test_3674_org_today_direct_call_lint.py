"""story #3674(BE 確定) — lint_org_today_direct_call.py의 정탐/오탐/허용목록 회귀
가드. 합성 fixture로 짓는다(실물 site가 전부 org_time.py로 옮겨가도 이 테스트는
안 사라진다, story #2335/#2342/#2476/#2476 lint와 동형 관례)."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from lint_org_today_direct_call import (  # noqa: E402
    AllowlistEntry,
    _is_allowed,
    find_violations,
)


def _write(tmp_path: Path, name: str, source: str) -> Path:
    p = tmp_path / name
    p.write_text(source)
    return p


# ─── ⭐정탐(각 패턴 1개씩) ──────────────────────────────────────────────────

def test_flags_date_today(tmp_path):
    p = _write(tmp_path, "site_a.py", "today = date.today()\n")
    violations = find_violations(p, label="site_a.py")
    assert len(violations) == 1
    assert "date.today()" in violations[0]


def test_flags_utcnow_date(tmp_path):
    p = _write(tmp_path, "site_b.py", "today = datetime.utcnow().date()\n")
    violations = find_violations(p, label="site_b.py")
    assert len(violations) == 1


def test_flags_now_timezone_utc_date(tmp_path):
    """3665(#4020)가 만든 UTC 고정 패턴 그 자체 — 이 lint의 존재 이유(org tz 인지 前)."""
    p = _write(tmp_path, "site_c.py", "today = datetime.now(timezone.utc).date()\n")
    violations = find_violations(p, label="site_c.py")
    assert len(violations) == 1


# ─── ⭐음성대조 — org_time.py 헬퍼로 고친 뒤엔 오탐 없음 ───────────────────

def test_org_today_helper_call_not_flagged(tmp_path):
    p = _write(
        tmp_path, "site_a_fixed.py",
        "from app.services.org_time import org_today\ntoday = org_today(org_timezone)\n",
    )
    assert find_violations(p, label="site_a_fixed.py") == []


def test_astimezone_chain_not_flagged(tmp_path):
    """org_time.py 내부 구현 자체(datetime.now(timezone.utc).astimezone(tz).date())는
    now(timezone.utc) 바로 뒤에 .date()가 오지 않아(사이에 .astimezone(...)) 이 lint의
    3개 패턴 중 어느 것과도 정확히 일치하지 않는다 — 정본 구현이 스스로를 오탐하지
    않는다는 것을 고정."""
    p = _write(
        tmp_path, "org_time_like.py",
        "return datetime.now(timezone.utc).astimezone(org_tz(org_timezone)).date()\n",
    )
    assert find_violations(p, label="org_time_like.py") == []


# ─── ⭐허용목록 — file+내용 완전 일치(줄번호 무관) ─────────────────────────

def test_allowlisted_file_and_content_is_skipped(monkeypatch):
    import lint_org_today_direct_call as mod

    monkeypatch.setattr(
        mod, "ALLOWLIST",
        [AllowlistEntry(file="app/legacy_report.py", line_content="d = date.today()", reason="테스트", added_by="story #3674")],
    )
    assert _is_allowed("app/legacy_report.py", "    d = date.today()\n") is True
    # story #3609/#3611 처방 재현 — 줄번호가 몇 번이든(들여쓰기가 달라도) 내용만 맞으면
    # 여전히 허용된다(strip() 비교라 앞 공백 무관).
    assert _is_allowed("app/legacy_report.py", "        d = date.today()") is True


def test_allowlist_is_file_scoped_not_content_only(monkeypatch):
    """같은 내용이라도 등재된 파일이 아니면 여전히 잡힌다 — 허용목록이 «내용만»으로
    전역 면제를 주지 않는다는 것을 고정(file+내용 둘 다 일치해야 함)."""
    import lint_org_today_direct_call as mod

    monkeypatch.setattr(
        mod, "ALLOWLIST",
        [AllowlistEntry(file="app/legacy_report.py", line_content="d = date.today()", reason="테스트", added_by="story #3674")],
    )
    assert _is_allowed("app/other_file.py", "d = date.today()") is False
