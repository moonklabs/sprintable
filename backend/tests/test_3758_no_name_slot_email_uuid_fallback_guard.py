"""story #3758(BE·표시명·결함 클래스 별건④, 페드루 PO 決 2026-09-09) — 재발 방지 정적 가드.

member_resolver.py 5자리(#3755) + 이 스토리 7자리(members.py·org_members.py×2·
project_access.py·agent_message_policy.py·team_member.py·auth.py) + agent_anchor_sync.py
(쓰기 층, #3758 10번째)가 전부 같은 결함 클래스였다 — 휴먼 구성원 표시 이름 슬롯에
display_name이 없으면 email이나 user_id 문자열을 지어내 채운다(PII 노출 또는 신원처럼
보이는 값 조작). `app/` 전체에서 이 두 형태 중 하나라도 새로 생기면 잡는다:

① SQL: `COALESCE(...)`의 내용에 `.email`이 섞인 채 `AS name`으로 별칭되는 형태
   (raw text() SQL — AST로 못 잡음, 정규식 스캔. team_members DML 가드(test_no_team_members_
   view_dml_in_tests.py)·fire-and-forget 가드(test_no_unreferenced_fire_and_forget.py)와
   동형 관례 — app/ 전체 rglob + 허용목록 0건).
② Python: `display_name`(속성 접근 또는 getattr 문자열 인자 둘 다) 뒤 같은 줄에 `or`로
   `.email`(속성 접근 또는 getattr 문자열 인자)이 이어지는 형태 — me.py의 예전 삼항,
   agent_anchor_sync.py의 예전 getattr-or-체인, auth.py의 예전 `.strip() or ....email`
   전부 이 형태였다.

허용목록 0건 설계(PO 요구) — 이 패턴이 정당하게 필요한 자리는 없다(email은 항상 별도
email 필드로만 노출, name 슬롯엔 절대 안 섞는다는게 이 스토리 전체의 결론).
"""
from __future__ import annotations

import re
from pathlib import Path

_APP_DIR = Path(__file__).parent.parent / "app"

_SQL_COALESCE_NAME = re.compile(
    r"COALESCE\((?P<inner>(?:.|\n){0,400}?)\)\s*AS\s+name", re.IGNORECASE
)
_EMAIL_ATTR_OR_STR = r'(?:\.email\b|["\']email["\'])'
_DISPLAY_NAME_ATTR_OR_STR = r'(?:\.display_name\b|["\']display_name["\'])'
_PY_DISPLAY_NAME_OR_EMAIL = re.compile(
    _DISPLAY_NAME_ATTR_OR_STR + r"(?:(?!\n).)*?\bor\b(?:(?!\n).)*?" + _EMAIL_ATTR_OR_STR
)


def _sql_violations(text: str) -> list[str]:
    hits = []
    for m in _SQL_COALESCE_NAME.finditer(text):
        if re.search(r"\.email\b", m.group("inner"), re.IGNORECASE):
            hits.append(m.group(0))
    return hits


def _py_violations(text: str) -> list[str]:
    return [m.group(0) for m in _PY_DISPLAY_NAME_OR_EMAIL.finditer(text)]


def test_no_email_or_uuid_name_slot_fallback_in_app():
    violations: list[str] = []
    for path in _APP_DIR.rglob("*.py"):
        text = path.read_text()
        for hit in _sql_violations(text):
            violations.append(f"{path.relative_to(_APP_DIR)}: SQL COALESCE(...email...) AS name — {hit!r}")
        for hit in _py_violations(text):
            violations.append(f"{path.relative_to(_APP_DIR)}: display_name-or-email 폴백 — {hit!r}")
    assert not violations, (
        "구성원 표시 이름 슬롯에 email/uuid 폴백 발견 — member_resolver.py 5자리(#3755)·"
        "이번 스토리(#3758) 7+1자리와 같은 결함 클래스다. display_name 없으면 None을 "
        "정직하게 두고(멤버 표시는 apps/web/src/lib/member-display.ts의 memberDisplayLabel/"
        "participantDisplayLabel로), email은 항상 별도 email 필드로만 노출할 것:\n"
        + "\n".join(violations)
    )


# ── 스캐너 자신의 검출/미검출 범위 pin(단발 probe가 아니라 CI가 계속 지키게) ──────────


def test_sql_scanner_catches_email_in_coalesce_as_name():
    """⭐양성대조 — 이번 스토리가 실제로 고친 그 정확한 형태(org_members.py 등 6자리)."""
    src = (
        "            SELECT om.id,\n"
        "                   COALESCE(m.name, u.display_name, u.email) AS name\n"
        "            FROM org_members om\n"
    )
    assert len(_sql_violations(src)) == 1


def test_sql_scanner_allows_fixed_coalesce_without_email():
    """음성대조 — 이번 스토리가 고친 뒤의 실제 형태(email 항 제거됨)는 통과해야 한다."""
    src = "COALESCE(NULLIF(m.name, ''), NULLIF(u.display_name, '')) AS name"
    assert _sql_violations(src) == []


def test_sql_scanner_allows_email_as_separate_value_field():
    """음성대조 — email이 name 슬롯이 아니라 자기 필드로 별도 노출되는 정당한 형태
    (org_members.py의 `u.email,` 응답 필드, 페드루 판정 2026-08-30 유지 대상)는
    COALESCE(...) AS name 구문 자체가 없으므로 무관 — 오탐 0 확認."""
    src = (
        "            SELECT om.id, om.org_id, om.user_id, om.role,\n"
        "                   om.created_at, om.deleted_at,\n"
        "                   u.email,\n"
        "                   COALESCE(NULLIF(m.name, ''), NULLIF(u.display_name, '')) AS name\n"
        "            FROM org_members om\n"
    )
    assert _sql_violations(src) == []


def test_sql_scanner_allows_unrelated_coalesce_as_other_alias():
    """음성대조 — email이 섞였어도 별칭이 name이 아니면(예: 무관한 다른 COALESCE) 무관."""
    src = "COALESCE(state, '') AS state, COALESCE(usename, '') AS usename"
    assert _sql_violations(src) == []


def test_py_scanner_catches_display_name_or_email_attribute_form():
    """⭐양성대조 — me.py 예전 형태(user.display_name or user.email)."""
    src = 'name = member_anchor or ((user.display_name or user.email) if user else str(uid))'
    assert len(_py_violations(src)) == 1


def test_py_scanner_catches_getattr_string_form():
    """⭐양성대조 — agent_anchor_sync.py 예전 형태(getattr 문자열 인자, 속성 접근 아님)."""
    src = 'name = (getattr(user, "display_name", None) or getattr(user, "email", None) or str(om.user_id)) if user else str(om.user_id)'
    assert len(_py_violations(src)) == 1


def test_py_scanner_allows_fixed_display_name_only():
    """음성대조 — 이번 스토리가 고친 뒤의 실제 형태(email 폴백 없음)는 통과해야 한다."""
    src = "name = user.display_name if user is not None else None"
    assert _py_violations(src) == []


def test_py_scanner_allows_email_and_display_name_without_or():
    """음성대조 — 같은 줄에 둘 다 등장해도 `or`로 안 엮이면(예: 응답 조립에서 각자 다른
    필드로 병기) 무관 — 문자열이 근접해 있다는 사실만으로 오탐하면 안 된다."""
    src = 'return MeResponse(name=user.display_name, email=user.email)'
    assert _py_violations(src) == []
