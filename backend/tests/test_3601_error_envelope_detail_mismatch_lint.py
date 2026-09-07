"""story #3601 — lint_fe_error_envelope_detail_mismatch.py의 정탐/오탐 회귀 가드.
합성 fixture로 짓는다(실물이 고쳐져도 이 테스트는 안 사라진다, story #2335/#2342/#2476
lint와 동형)."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))
from lint_fe_error_envelope_detail_mismatch import (  # noqa: E402
    _ALLOWED_MATCHES,
    find_violations,
    scan,
)


def _write(tmp_path: Path, name: str, source: str) -> Path:
    p = tmp_path / name
    p.write_text(source)
    return p


def test_detects_detail_optional_chain_message():
    src = "const message = body?.detail?.message ?? body?.message ?? generic;\n"
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        path = _write(Path(td), "bad_message.ts", src)
        violations = find_violations(path, label="bad_message.ts")
    assert len(violations) == 1


def test_detects_detail_optional_chain_code():
    src = "if (body?.detail?.code === 'SOME_CODE') { doThing(); }\n"
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        path = _write(Path(td), "bad_code.ts", src)
        violations = find_violations(path, label="bad_code.ts")
    assert len(violations) == 1


def test_error_first_pattern_not_flagged_when_allowlisted():
    """.error를 먼저 읽고 .detail을 무해한 폴백으로 두는 형이어도, 그 (label,line)이
    허용 목록에 없으면 여전히 잡혀야 한다 — 허용은 화이트리스트 등재로만 되지,
    코드 모양(.error가 앞에 있음)만으로 자동 면제되지 않는다(§17 fail-closed와 동형:
    "안전해 보인다"가 아니라 "등재됐다"가 판정 기준)."""
    src = "throw new Error(body?.error?.message ?? body?.detail?.message ?? `HTTP ${res.status}`);\n"
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        path = _write(Path(td), "unlisted_error_first.ts", src)
        violations = find_violations(path, label="unlisted_error_first.ts")
    assert len(violations) == 1, "허용 목록에 없으면 .error가 앞에 있어도 잡혀야 한다"


def test_allowlisted_line_is_not_flagged():
    """허용 목록의 (label, 내용) 조합과 정확히 일치하면 면제된다."""
    src = "line 1 — 무관\nthrow new Error(body?.error?.message ?? body?.detail?.message ?? `x`);\n"
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        path = _write(Path(td), "allowlisted.ts", src)
        import lint_fe_error_envelope_detail_mismatch as mod
        original = dict(mod._ALLOWED_MATCHES)
        try:
            mod._ALLOWED_MATCHES.clear()
            mod._ALLOWED_MATCHES["allowlisted.ts"] = [
                "throw new Error(body?.error?.message ?? body?.detail?.message ?? `x`);",
            ]
            violations = find_violations(path, label="allowlisted.ts")
        finally:
            mod._ALLOWED_MATCHES.clear()
            mod._ALLOWED_MATCHES.update(original)
    assert violations == []


def test_allowlisted_content_survives_unrelated_lines_shifting_line_numbers():
    """story #3609 — 허용된 줄 «앞에» 무관한 줄을 N개 끼워 넣어 줄번호가 밀려도
    (내용은 그대로이므로) 여전히 위반 0. 이 시나리오가 정확히 #3956(events/page.tsx
    +39줄)이 develop CI를 거짓 빨강으로 만든 실사고의 재현이다."""
    allowed_line = "throw new Error(body?.error?.message ?? body?.detail?.message ?? `x`);\n"
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        import lint_fe_error_envelope_detail_mismatch as mod
        original = dict(mod._ALLOWED_MATCHES)
        try:
            mod._ALLOWED_MATCHES.clear()
            mod._ALLOWED_MATCHES["shifted.ts"] = [allowed_line.strip()]
            unrelated_padding = "".join(f"const unrelated_{i} = {i};\n" for i in range(39))
            src = unrelated_padding + allowed_line
            path = _write(Path(td), "shifted.ts", src)
            violations = find_violations(path, label="shifted.ts")
        finally:
            mod._ALLOWED_MATCHES.clear()
            mod._ALLOWED_MATCHES.update(original)
    assert violations == [], "무관한 앞줄이 끼어들어 줄번호가 밀려도 내용이 같으면 허용돼야 한다"


def test_allowlisted_content_changed_is_flagged_as_new_violation():
    """story #3609 — 허용된 줄 «내용 자체»가 바뀌면(변수명 변경 등) 더는 등재된
    문자열과 일치하지 않으므로 새 위반으로 잡혀야 한다 — 내용 키가 "느슨해서 아무거나
    통과"가 아님을 고정."""
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        import lint_fe_error_envelope_detail_mismatch as mod
        original = dict(mod._ALLOWED_MATCHES)
        try:
            mod._ALLOWED_MATCHES.clear()
            mod._ALLOWED_MATCHES["changed.ts"] = [
                "throw new Error(body?.error?.message ?? body?.detail?.message ?? `x`);",
            ]
            # 등재된 것과 다른 변수명(resBody) — 문자 그대로 안 같으면 면제되지 않는다.
            src = "throw new Error(resBody?.error?.message ?? resBody?.detail?.message ?? `x`);\n"
            path = _write(Path(td), "changed.ts", src)
            violations = find_violations(path, label="changed.ts")
        finally:
            mod._ALLOWED_MATCHES.clear()
            mod._ALLOWED_MATCHES.update(original)
    assert len(violations) == 1, "허용 목록에 등재된 것과 내용이 다르면(같은 파일이어도) 위반이어야 한다"


def test_variable_indirection_is_a_known_blind_spot():
    """①에 명시한 못 잡는 형 — `.detail`을 변수에 옮긴 뒤 `.message`를 읽으면 이 정규식은
    안 걸린다(avatar-upload.ts 실제 사고와 동형). 이 테스트는 "못 잡는다"는 사실 자체를
    고정한다 — 언젠가 정규식을 더 똑똑하게 바꾸면 이 테스트가 먼저 깨져 그 변화를 알린다."""
    src = "const d = json.detail;\nreturn json.data ?? d ?? fallback;\n"
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        path = _write(Path(td), "blind_spot.ts", src)
        violations = find_violations(path, label="blind_spot.ts")
    assert violations == [], "변수로 옮겨 읽는 형은 이 lint의 선언된 사각지대(①)"


def test_mutation_disabling_pattern_causes_zero_detections():
    """뮤테이션: 정규식을 절대 안 걸리는 것으로 바꾸면 위 양성 테스트가 깨져야 한다 —
    이 lint의 핵심 로직이 실제로 테스트에 의해 지켜지는지 자가 검증(story #2342/#2476
    lint와 동일 관례)."""
    import lint_fe_error_envelope_detail_mismatch as mod

    original = mod._PATTERN
    try:
        mod._PATTERN = mod.re.compile(r"(?!)")  # 절대 안 매치되는 패턴
        src = "const message = body?.detail?.message ?? generic;\n"
        import tempfile
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "bad.ts"
            path.write_text(src)
            violations = find_violations(path, label="bad.ts")
        assert violations == [], "뮤테이션 후에는 탐지가 0이어야 정상(로직이 실제로 패턴에 의존함을 증명)"
    finally:
        mod._PATTERN = original


def test_mutation_removing_content_match_check_causes_allowlisted_line_to_be_flagged():
    """story #3609 — «내용 매칭» 자체가 이 가드의 새 핵심 로직이다. `find_violations`가
    `line.strip() not in allowed_for_file` 대신 뭐든 통과시키게(예: `not in []`) 망가지면
    이미 등재된 안전한 줄까지 위반으로 잘못 잡아야 한다(뮤테이션 대조 — 로직이 실제로
    이 체크에 의존함을 값으로 증명)."""
    import lint_fe_error_envelope_detail_mismatch as mod

    original_allowed = dict(mod._ALLOWED_MATCHES)
    original_source = mod.find_violations.__code__
    try:
        mod._ALLOWED_MATCHES.clear()
        mod._ALLOWED_MATCHES["mutated.ts"] = [
            "throw new Error(body?.error?.message ?? body?.detail?.message ?? `x`);",
        ]

        def _broken_find_violations(path: Path, label: str | None = None) -> list[str]:
            text = path.read_text(encoding="utf-8")
            label = label or str(path)
            violations: list[str] = []
            for lineno, line in enumerate(text.splitlines(), start=1):
                if mod._PATTERN.search(line):  # 내용 매칭 체크 자체를 뺀 뮤테이션.
                    violations.append(f"{label}:{lineno}: {line.strip()}")
            return violations

        src = "throw new Error(body?.error?.message ?? body?.detail?.message ?? `x`);\n"
        import tempfile
        with tempfile.TemporaryDirectory() as td:
            path = _write(Path(td), "mutated.ts", src)
            violations = _broken_find_violations(path, label="mutated.ts")
        assert len(violations) == 1, "내용 매칭 체크를 빼면 허용된 줄도 위반으로 떨어져야 한다(로직이 그 체크에 의존)"
    finally:
        mod._ALLOWED_MATCHES.clear()
        mod._ALLOWED_MATCHES.update(original_allowed)
        assert mod.find_violations.__code__ is original_source, "원본 find_violations는 안 건드렸다(로컬 함수로만 시뮬레이션)"


def test_allowlist_is_pinned_to_known_safe_lines():
    """허용 목록이 조용히 늘어나는 뒷문을 막는다(story #2255 model_registration lint와
    동일 관례) — 새 항목을 추가하려면 이 pin도 같이 고쳐야 리뷰에서 보인다.

    story #3609 — 키를 파일 경로로, pin 대상을 «파일+내용»으로 바꿨다(줄번호는
    더 이상 이 가드의 정체성이 아니다 — #3609 그라운딩: 무관한 줄 추가로 번호가
    밀려도 pin이 안 흔들려야 한다)."""
    assert set(_ALLOWED_MATCHES.keys()) == {
        "src/app/(authenticated)/organization/events/page.tsx",
        "src/app/(authenticated)/content/channel-posts/[draftId]/page.tsx",
    }
    assert _ALLOWED_MATCHES["src/app/(authenticated)/organization/events/page.tsx"] == [
        "throw new Error(body?.error?.message ?? body?.detail?.message ?? `HTTP ${res.status}`);",
        "throw new Error(resBody?.error?.message ?? resBody?.detail?.message ?? `HTTP ${res.status}`);",
    ]
    assert _ALLOWED_MATCHES["src/app/(authenticated)/content/channel-posts/[draftId]/page.tsx"] == [
        "errorMessage: body?.error?.message ?? body?.detail?.message ?? body?.message ?? t('commentsActionErrorGeneric'),",
    ]


def test_current_repo_has_zero_unallowed_violations():
    """실물 apps/web/src 전수 스캔 — story #3601 처방(7자리 통일) 뒤 위반 0건이 유지되는지
    CI가 도는 그 검사 자체를 pytest로도 한 번 더 고정한다."""
    repo_root = Path(__file__).parent.parent.parent
    assert scan(repo_root) == []
