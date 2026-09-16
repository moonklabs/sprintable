"""story #3963 — app/services/pr_verdict_comment_parser.py 파서 유닛(HTTP·DB 0, 순수 함수만).

CI Action 기반 초안(story_number 파싱 포함 CLI)은 PO CHANGES(2026-09-16 16:34Z — issue_comment
Actions 워크플로는 기본 브랜치 파일만 실행돼 develop PR엔 원천적으로 안 뜬다는 실측)로 GitHub
웹훅 핸들러(_process_webhook_event의 issue_comment 분기) 방식으로 대체됐다 — 이 파일은 그
분기가 쓰는 parse_verdict_comment()만 검증(story_number 파싱은 app.services.verdict_capture.
parse_story_number 기존 테스트가 이미 고정, 이 파일에서 재검증 안 함)."""
from __future__ import annotations

from app.services.pr_verdict_comment_parser import parse_verdict_comment


def test_codex_verdict_approved_pass():
    body = "## QA verdict: approved (qa:pass)\n**Head:** `423947913d0b5fa7cff71ca5108cbf25d6509bdf`\ncodex session: 01a08fc6\n"
    assert parse_verdict_comment(body) == {"role": "qa", "result": "pass"}


def test_codex_verdict_changes_requested_fail():
    body = "## QA verdict: changes requested (qa:changes)\n**Head:** `3b38da32107127e4e443653e517d0542db8575a7`\n\n### CI 실 FAILURE 2건\n"
    assert parse_verdict_comment(body) == {"role": "qa", "result": "fail"}


def test_codex_verdict_with_base_confirm_line_variant():
    """PR#4201류 — "**base=develop 확認**" 줄이 QA verdict 헤더 바로 다음에 오는 변형."""
    body = "## QA verdict: approved (qa:pass)\n**base=develop 확認**\n**Head:** `f28a5ee522e9818322498b95e2c568cffe17d398`\n"
    assert parse_verdict_comment(body) == {"role": "qa", "result": "pass"}


def test_po_review_english_pass():
    body = "## PO review — PASS · head dbe8469c98 · 2026-09-16 15:24Z\n\n확認(diff): ...\n"
    assert parse_verdict_comment(body) == {"role": "po", "result": "pass"}


def test_po_review_korean_changes():
    body = "## PO 리뷰 — CHANGES 3건(소형) (head 9697b0539)\n\n구조 판정 PASS: ...\n"
    assert parse_verdict_comment(body) == {"role": "po", "result": "fail"}


def test_po_review_korean_pass_with_round_suffix():
    body = "## PO 리뷰 — PASS 재앵커 (head 9689cc2c3 · 5회차) — 델타(9a0057850a → 9689cc2c3): ...\n"
    assert parse_verdict_comment(body) == {"role": "po", "result": "pass"}


def test_non_verdict_observation_comment_skipped_even_with_pass_like_wording():
    """실측 함정(PR#4360/#4362) — "읽기 검수 관찰"은 verdict/approve 아님 문구가 있으면
    PASS/approved 낱말이 섞여 있어도 무조건 None."""
    body = (
        "## 읽기 검수 관찰 — codex exec 사용불가 기간 임시(verdict/approve 아님, "
        "페드루 지시 2026-09-16 11:23Z 패턴)\n\n"
        "claim과 일치합니다(PASS 판단에 참고). approved 아님, 그냥 관찰.\n"
    )
    assert parse_verdict_comment(body) is None


def test_unrelated_comment_returns_none():
    assert parse_verdict_comment("그냥 잡담입니다. 고생하셨어요.") is None
