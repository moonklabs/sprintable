"""story #3931(2층) — BE 사용자 도달 문장 해요체 전환 + 2층 톤 가드(scripts/
verify_user_facing_tone.py) 자체를 검증한다. 실PG 불요(순수 AST/정규식 정적분석,
story #3779 1층 테스트 파일과 동일 관례).

AC1 明示(페드루 PO 2026-09-15) — 양성대조 2 + 음성대조 1:
  - 양성대조① — 표면① approval_delivery.py:1298 title이 전환 前 가졌던 정확한 원문
    ("draft 문서가 채팅에서 논의됐습니다")을 그대로 needle에 통과시키면 RED가 나와야
    한다(needle 자체가 죽지 않았다는 증거).
  - 양성대조② — 표면② i18n_catalog.py의 한 ko 값이 전환 前 가졌던 정확한 원문
    ("게이트 승인/거부는 휴먼 멤버만 가능합니다 (에이전트 승인 불가)." —
    gates.approve_human_only)을 되돌리면 RED.
  - 음성대조 — 허용목록 밖 코드로 raise되는 human_error()의 message에 합니다체
    한글을 주입해도(표면③ 추출 자체가 안 되므로) GREEN — "닿지 않는 표면은 안 본다"의
    증거(실 파일을 건드리지 않고 in-memory 소스 fixture로, story #3280류 fork mutation
    사고를 피한다 — 합성 source 문자열만 씀).
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from verify_user_facing_tone import (  # noqa: E402
    APP_ROOT,
    EMAIL_COPY_PATH,
    I18N_CATALOG_PATH,
    ExtractedString,
    discover_surface4_dict_const_names,
    extract_surface1_from_source,
    extract_surface1_notification_kwargs,
    extract_surface2_from_catalog,
    extract_surface2_i18n_catalog,
    extract_surface3_from_source,
    extract_surface3_human_error_sites,
    extract_surface4_email_copy,
    extract_surface4_from_module_dicts,
    find_tone_issues,
    matches_formal_register,
    parse_human_safe_error_codes,
)


# ---------------------------------------------------------------------------
# needle — FE verify-scoped-i18n-honorific-tone.ts::matchesFormalRegister 포팅 검증.
# ---------------------------------------------------------------------------
def test_needle_catches_sup_nida_literal():
    assert matches_formal_register("안 보낸 초안이 이미 있습니다.") == ["습니다"]


def test_needle_catches_vowel_stem_b_nida_via_nfd():
    # 「합니다」는 NFC에 독립된 ㅂ 문자가 없다 — NFD 정규화로만 잡힌다(FE 쪽 정의 그대로).
    assert matches_formal_register("이 액션은 org owner 만 가능합니다.") == ["ㅂ니다"]


def test_needle_catches_question_form():
    assert "습니까" in matches_formal_register("계속하시겠습니까?")


def test_needle_does_not_flag_haeyo_tone():
    assert matches_formal_register("이 액션은 org owner 만 가능해요.") == []


def test_find_tone_issues_catches_hanja():
    assert "한자" in find_tone_issues("결과는 원문 상세에서 확認해요")


def test_find_tone_issues_catches_dangsin():
    assert "당신" in find_tone_issues("관리자가 당신을 새 결재자로 지정했어요.")


def test_find_tone_issues_catches_persona_adnominal_terminal():
    assert "페르소나 관형형 종결" in find_tone_issues("결과를 원본으로 되돌리는.")


def test_find_tone_issues_is_empty_for_clean_haeyo_string():
    assert find_tone_issues("이 액션은 org owner 만 가능해요.") == []


# ---------------------------------------------------------------------------
# AC1 양성대조① — 표면① dispatch_notification title.
# ---------------------------------------------------------------------------
def test_ac1_positive_control_1_reverted_notification_title_is_red():
    """approval_delivery.py:1298 title이 이 스토리 前 가졌던 정확한 원문 — 전환이
    없었다면(또는 되돌리면) 표면① 추출 파이프라인이 그대로 RED를 낸다."""
    source = '''
async def _notify(db, org_id, doc_author_id, doc_title, doc_id, project_id):
    from app.services.notification_dispatch import dispatch_notification
    await dispatch_notification(
        db, org_id=org_id, event_type="doc_draft_discussed_in_chat",
        target_member_ids=[doc_author_id],
        title="draft 문서가 채팅에서 논의됐습니다",
        body=f"'{doc_title}' — 검토 요청 여부를 확인해 주세요.",
        reference_type="doc", reference_id=doc_id,
        source_project_id=project_id, via_outbox=True,
    )
'''
    extracted = extract_surface1_from_source(source, "app/services/fixture.py")
    title_items = [e for e in extracted if e.label == "title"]
    assert len(title_items) == 1
    assert find_tone_issues(title_items[0].text) == ["습니다"]


def test_ac1_positive_control_1_converted_title_is_green():
    """같은 자리, 전환 後 실제 텍스트 — RED가 사라진다(needle이 과잉진단하지 않는다는
    대조쌍)."""
    source = '''
async def _notify(db, org_id, doc_author_id, doc_title, doc_id, project_id):
    from app.services.notification_dispatch import dispatch_notification
    await dispatch_notification(
        db, org_id=org_id, event_type="doc_draft_discussed_in_chat",
        target_member_ids=[doc_author_id],
        title="draft 문서가 채팅에서 논의됐어요",
        body=f"'{doc_title}' — 검토 요청 여부를 확인해 주세요.",
        reference_type="doc", reference_id=doc_id,
        source_project_id=project_id, via_outbox=True,
    )
'''
    extracted = extract_surface1_from_source(source, "app/services/fixture.py")
    title_items = [e for e in extracted if e.label == "title"]
    assert find_tone_issues(title_items[0].text) == []


# ---------------------------------------------------------------------------
# AC1 양성대조② — 표면② i18n_catalog ko 값.
# ---------------------------------------------------------------------------
def test_ac1_positive_control_2_reverted_catalog_entry_is_red():
    """i18n_catalog.py::gates.approve_human_only가 이 스토리 前 가졌던 정확한 원문."""
    catalog = {
        "gates.approve_human_only": {
            "ko": "게이트 승인/거부는 휴먼 멤버만 가능합니다 (에이전트 승인 불가).",
            "en": "Only human members can approve or reject a gate — agents cannot approve",
        },
    }
    extracted = extract_surface2_from_catalog(catalog, "backend/app/services/i18n_catalog.py")
    assert len(extracted) == 1
    assert find_tone_issues(extracted[0].text) == ["ㅂ니다"]


def test_ac1_positive_control_2_converted_catalog_entry_is_green():
    catalog = {
        "gates.approve_human_only": {
            "ko": "게이트 승인/거부는 휴먼 멤버만 가능해요 (에이전트 승인 불가).",
            "en": "Only human members can approve or reject a gate — agents cannot approve",
        },
    }
    extracted = extract_surface2_from_catalog(catalog, "backend/app/services/i18n_catalog.py")
    assert find_tone_issues(extracted[0].text) == []


# ---------------------------------------------------------------------------
# AC1 음성대조 — 허용목록 밖 코드는 표면③에서 아예 추출되지 않는다(합니다체를 그대로
# 심어도 GREEN — "닿지 않는 표면은 안 본다"의 증거).
# ---------------------------------------------------------------------------
def test_ac1_negative_control_non_allowlisted_code_is_not_extracted():
    source = '''
from fastapi import HTTPException
from app.core.error_envelope import human_error


def _require_something():
    raise HTTPException(
        status_code=409,
        detail=human_error(
            "SOME_OTHER_CODE_NOT_IN_ALLOWLIST",
            "이 상태에서는 처리할 수 없습니다 — 합니다체가 그대로 남아있습니다.",
            user_message="이 상태에서는 처리할 수 없습니다 — 합니다체가 그대로 남아있습니다.",
        ),
    )
'''
    # fixture 허용목록(실 파일을 안 읽는다 — 이 테스트 자체가 «허용목록 밖»을 증명하는
    # 자리라 실 코드 집합과 무관해야 한다).
    fixture_allowed_codes = frozenset({"COMMENT_REFRESH_HUMAN_ONLY"})
    extracted = extract_surface3_from_source(source, "app/routers/fixture.py", fixture_allowed_codes)
    assert extracted == [], (
        "허용목록 밖 코드의 human_error() 자리는 표면③ 추출 자체가 없어야 한다 — "
        "추출되면(설령 톤이 formal이어도 find_tone_issues가 못 보게 하는 이 축이 무너진 것)."
    )


def test_ac1_negative_control_allowlisted_code_is_extracted_and_red_if_formal():
    """대조군 — 같은 fixture에서 코드만 허용목록 «안»으로 바꾸면 추출되고, formal이면 RED
    (음성대조가 "허용목록 로직 자체가 죽어서 아무것도 안 잡는" 게 아니라는 걸 증명)."""
    source = '''
from fastapi import HTTPException
from app.core.error_envelope import human_error


def _require_something():
    raise HTTPException(
        status_code=409,
        detail=human_error(
            "COMMENT_REFRESH_HUMAN_ONLY",
            "이 상태에서는 처리할 수 없습니다.",
            user_message="이 상태에서는 처리할 수 없습니다.",
        ),
    )
'''
    fixture_allowed_codes = frozenset({"COMMENT_REFRESH_HUMAN_ONLY"})
    extracted = extract_surface3_from_source(source, "app/routers/fixture.py", fixture_allowed_codes)
    assert len(extracted) == 1
    assert find_tone_issues(extracted[0].text) == ["습니다"]


# ---------------------------------------------------------------------------
# 표면④ email_copy — ko 필드 추출(리스트 원소 포함) + 자기검증.
# ---------------------------------------------------------------------------
def test_surface4_walks_intro_lines_list_and_ko_only():
    module_dicts = {
        "FIXTURE_COPY": {
            "ko": {
                "subject": "제목입니다.",
                "intro_lines": ["첫째 줄입니다.", "둘째 줄이에요."],
            },
            "en": {
                "subject": "Subject.",
                "intro_lines": ["First line.", "Second line."],
            },
        }
    }
    extracted = extract_surface4_from_module_dicts(module_dicts, "backend/app/services/fixture.py")
    labels = {e.label: e.text for e in extracted}
    assert labels == {
        "FIXTURE_COPY.subject": "제목입니다.",
        "FIXTURE_COPY.intro_lines[0]": "첫째 줄입니다.",
        "FIXTURE_COPY.intro_lines[1]": "둘째 줄이에요.",
    }
    formal = [(e.label, find_tone_issues(e.text)) for e in extracted]
    assert dict(formal)["FIXTURE_COPY.subject"] == ["ㅂ니다"]
    assert dict(formal)["FIXTURE_COPY.intro_lines[0]"] == ["ㅂ니다"]
    assert dict(formal)["FIXTURE_COPY.intro_lines[1]"] == []


def test_discover_surface4_dict_const_names_matches_annotated_and_plain_assign():
    source = (
        "TRANSACTIONAL_COPY: dict[str, dict[str, dict]] = {\n"
        '    "a": {"ko": "x", "en": "y"},\n'
        "}\n"
        "_PRIVATE_COPY = {\n"
        '    "ko": "z",\n'
        "}\n"
    )
    assert discover_surface4_dict_const_names(source) == frozenset({"TRANSACTIONAL_COPY", "_PRIVATE_COPY"})


# ---------------------------------------------------------------------------
# 허용목록 fail-closed(표면③) — 파싱 실패 시 빈 집합으로 조용히 넘기지 않는다.
# ---------------------------------------------------------------------------
def test_parse_human_safe_error_codes_fail_closed_on_missing_marker(tmp_path):
    ts_file = tmp_path / "api-error-message.ts"
    ts_file.write_text("export const SOME_OTHER_CONST = 1;\n", encoding="utf-8")
    try:
        parse_human_safe_error_codes(ts_file)
        raise AssertionError("마커를 못 찾으면 RuntimeError로 죽어야 한다(fail-closed)")
    except RuntimeError as exc:
        assert "fail-closed" in str(exc)


def test_parse_human_safe_error_codes_parses_real_file():
    codes = parse_human_safe_error_codes(
        Path(__file__).resolve().parent.parent.parent / "apps" / "web" / "src" / "lib" / "api-error-message.ts"
    )
    assert "COMMENT_REFRESH_HUMAN_ONLY" in codes
    assert "CHANNEL_POST_PUBLISH_HUMAN_ONLY" in codes
    assert len(codes) == 7


# ---------------------------------------------------------------------------
# 실 저장소 전수 — 전환이 실제로 끝났고(0건), 4표면 자기검증도 어긋나지 않는다는 회귀가드.
# ---------------------------------------------------------------------------
def test_real_repo_all_four_surfaces_are_clean():
    allowed_codes = parse_human_safe_error_codes(
        Path(__file__).resolve().parent.parent.parent / "apps" / "web" / "src" / "lib" / "api-error-message.ts"
    )
    surface1, call_sites = extract_surface1_notification_kwargs(APP_ROOT)
    surface2, raw_key_count = extract_surface2_i18n_catalog(I18N_CATALOG_PATH)
    surface3, regex_count = extract_surface3_human_error_sites(APP_ROOT, allowed_codes)
    surface4, ast_names, regex_names = extract_surface4_email_copy(EMAIL_COPY_PATH)

    assert call_sites * 2 == len(surface1)
    assert raw_key_count == len(surface2)
    assert regex_count == len(surface3)
    assert ast_names == regex_names

    all_extracted: list[ExtractedString] = surface1 + surface2 + surface3 + surface4
    violations = [(e.surface, e.file, e.line, e.label, find_tone_issues(e.text)) for e in all_extracted]
    violations = [v for v in violations if v[-1]]
    assert violations == [], f"표면 4종 톤 위반 잔존: {violations}"
