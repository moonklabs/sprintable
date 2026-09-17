"""story #3963 — app/services/pr_verdict_comment_parser.py 파서 유닛(HTTP·DB 0, 순수 함수만).

CI Action 기반 초안(story_number 파싱 포함 CLI)은 PO CHANGES(2026-09-16 16:34Z — issue_comment
Actions 워크플로는 기본 브랜치 파일만 실행돼 develop PR엔 원천적으로 안 뜬다는 실측)로 GitHub
웹훅 핸들러(_process_webhook_event의 issue_comment 분기) 방식으로 대체됐다 — 이 파일은 그
분기가 쓰는 parse_verdict_comment()만 검증(story_number 파싱은 app.services.verdict_capture.
parse_story_number 기존 테스트가 이미 고정, 이 파일에서 재검증 안 함).

2026-09-17 페드루 PO 구조 CHANGES(4366 두 번째) — 한글 헤더("PO 리뷰")·비-verdict 마커
("verdict/approve 아님") 리터럴을 코드에서 완전히 제거하고 ①첫 줄만 헤더로 인정 ②PO
헤더는 영문(``## PO review — PASS|CHANGES``)만 인정하는 구조로 바뀌었다 — 그 두 항목의
테스트도 "지원" → "미지원(None)"으로 갱신, 새 방어(첫 줄 아닌 곳의 헤더 무시) 테스트 추가."""
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


def test_po_review_english_changes():
    body = "## PO review — CHANGES 1(구조) · head 84484157f6\n\n핵심: ...\n"
    assert parse_verdict_comment(body) == {"role": "po", "result": "fail"}


def test_po_review_korean_header_no_longer_supported():
    """2026-09-17 페드루 구조 CHANGES — 한글 「PO 리뷰」 헤더는 더 이상 인정하지 않는다
    (한글 리터럴을 코드에서 없애는 처방, 페드루 자신의 헤더 규율 고정 2026-09-16 16:33Z
    이후로 이 경로에 실제로 도달할 일도 없다 — webhook은 action=created 새 코멘트만
    본다)."""
    body = "## PO 리뷰 — CHANGES 3건(소형) (head 9697b0539)\n\n구조 판정 PASS: ...\n"
    assert parse_verdict_comment(body) is None


def test_non_verdict_observation_comment_skipped_via_first_line_mismatch():
    """실측 함정(PR#4360/#4362) — 카디르의 codex 대체 관찰 코멘트("## 읽기 검수 관찰")는
    첫 줄이 QA/PO 헤더 패턴과 안 맞아 자동 None(옛 별도 마커 없이도 동일 결과,
    2026-09-17 구조 CHANGES로 마커 제거됨)."""
    body = (
        "## 읽기 검수 관찰 — codex exec 사용불가 기간 임시(verdict/approve 아님, "
        "페드루 지시 2026-09-16 11:23Z 패턴)\n\n"
        "claim과 일치합니다(PASS 판단에 참고). approved 아님, 그냥 관찰.\n"
    )
    assert parse_verdict_comment(body) is None


def test_verdict_header_not_on_first_line_is_ignored():
    """2026-09-17 구조 CHANGES 핵심 방어 — 본문 인용문 등에 헤더 문구가 우연히 섞여
    있어도 첫 줄이 아니면 무시(MULTILINE 서치였던 옛 구현의 오탐 구멍이 닫혔는지 pin)."""
    body = "리뷰어가 남긴 이전 코멘트를 인용합니다:\n## QA verdict: approved (qa:pass)\n"
    assert parse_verdict_comment(body) is None


def test_unrelated_comment_returns_none():
    assert parse_verdict_comment("그냥 잡담입니다. 고생하셨어요.") is None
