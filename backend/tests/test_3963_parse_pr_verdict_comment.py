"""story #3963 — parse_pr_verdict_comment.py 파서 유닛(HTTP 0, 순수 함수만)."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))
import parse_pr_verdict_comment as mod  # noqa: E402


def test_codex_verdict_approved_pass():
    body = "## QA verdict: approved (qa:pass)\n**Head:** `423947913d0b5fa7cff71ca5108cbf25d6509bdf`\ncodex session: 01a08fc6\n"
    assert mod.parse_verdict_comment(body) == {"role": "qa", "result": "pass"}


def test_codex_verdict_changes_requested_fail():
    body = "## QA verdict: changes requested (qa:changes)\n**Head:** `3b38da32107127e4e443653e517d0542db8575a7`\n\n### CI 실 FAILURE 2건\n"
    assert mod.parse_verdict_comment(body) == {"role": "qa", "result": "fail"}


def test_codex_verdict_with_base_confirm_line_variant():
    """PR#4201류 — "**base=develop 확認**" 줄이 QA verdict 헤더 바로 다음에 오는 변형."""
    body = "## QA verdict: approved (qa:pass)\n**base=develop 확認**\n**Head:** `f28a5ee522e9818322498b95e2c568cffe17d398`\n"
    assert mod.parse_verdict_comment(body) == {"role": "qa", "result": "pass"}


def test_po_review_english_pass():
    body = "## PO review — PASS · head dbe8469c98 · 2026-09-16 15:24Z\n\n확認(diff): ...\n"
    assert mod.parse_verdict_comment(body) == {"role": "po", "result": "pass"}


def test_po_review_korean_changes():
    body = "## PO 리뷰 — CHANGES 3건(소형) (head 9697b0539)\n\n구조 판정 PASS: ...\n"
    assert mod.parse_verdict_comment(body) == {"role": "po", "result": "fail"}


def test_po_review_korean_pass_with_round_suffix():
    body = "## PO 리뷰 — PASS 재앵커 (head 9689cc2c3 · 5회차) — 델타(9a0057850a → 9689cc2c3): ...\n"
    assert mod.parse_verdict_comment(body) == {"role": "po", "result": "pass"}


def test_non_verdict_observation_comment_skipped_even_with_pass_like_wording():
    """실측 함정(PR#4360/#4362) — "읽기 검수 관찰"은 verdict/approve 아님 문구가 있으면
    PASS/approved 낱말이 섞여 있어도 무조건 None."""
    body = (
        "## 읽기 검수 관찰 — codex exec 사용불가 기간 임시(verdict/approve 아님, "
        "페드루 지시 2026-09-16 11:23Z 패턴)\n\n"
        "claim과 일치합니다(PASS 판단에 참고). approved 아님, 그냥 관찰.\n"
    )
    assert mod.parse_verdict_comment(body) is None


def test_unrelated_comment_returns_none():
    assert mod.parse_verdict_comment("그냥 잡담입니다. 고생하셨어요.") is None


def test_parse_story_number_bracket_sid():
    assert mod.parse_story_number("[SID:3963] verdict 원장 배선") == 3963


def test_parse_story_number_fix_hash():
    assert mod.parse_story_number("fix(#2288): 뭔가 고침") == 2288


def test_parse_story_number_none_when_no_marker():
    """음성대조 — 숫자만 있고 마커 없으면 None(app/services/verdict_capture.py::
    parse_story_number와 동일 원칙, "SID처럼 생김"과 "SID 태그"를 구분)."""
    assert mod.parse_story_number("fix: bump timeout to 2288ms") is None


def test_parse_story_number_falls_back_to_body():
    assert mod.parse_story_number("일반 제목", "본문에 [SID:42] 있음") == 42


def test_main_cli_outputs_json_line(capsys, monkeypatch):
    import io

    monkeypatch.setattr(sys, "stdin", io.StringIO("## QA verdict: approved (qa:pass)\n"))
    monkeypatch.setattr(sys, "argv", ["parse_pr_verdict_comment.py", "[SID:3963] title"])
    exit_code = mod.main()
    out = capsys.readouterr().out.strip()
    assert exit_code == 0
    assert out == '{"role": "qa", "result": "pass", "story_number": 3963}'


def test_main_cli_outputs_empty_line_when_no_sid(capsys, monkeypatch):
    import io

    monkeypatch.setattr(sys, "stdin", io.StringIO("## QA verdict: approved (qa:pass)\n"))
    monkeypatch.setattr(sys, "argv", ["parse_pr_verdict_comment.py", "no sid here"])
    exit_code = mod.main()
    out = capsys.readouterr().out.strip()
    assert exit_code == 0
    assert out == ""
