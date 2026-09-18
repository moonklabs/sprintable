"""story 23bf1913 — lint_destructive_schema_weights_registered.py의 정탐/오탐 회귀 가드.
`unweighted_files_in()`/`average_weight()` 자체의 정확성은 이미
tests/test_shard_destructive_tests.py가 고정한다(재검증 안 함, 신규 로직 발명 0인
스크립트라 그쪽 커버리지를 그대로 물려받는다) — 여기서는 이 스크립트 고유의 glue
(exit code·JSON 조각 출력)만 검증한다. `discover_files()`(실제 `uv run pytest
--collect-only` 서브프로세스)는 매번 몇 초가 걸려 monkeypatch로 대체한다(합성 fixture,
story #2786/#2335 lint 테스트와 동형 관례).

story #3465(2026-09-04) — 두 번째 축(`entries_missing_source()`/`load_raw_entries()`,
files[] 항목마다 필수가 된 `source` provenance 필드) 정탐/오탐도 이 파일에 추가."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))
import lint_destructive_schema_weights_registered as lint_mod  # noqa: E402


def test_positive_control_missing_file_returns_1_and_prints_pasteable_json(monkeypatch, capsys):
    """story 23bf1913 원 사고(오늘 4 PR) 재현 — discover된 파일 중 하나가 weights.json에
    없으면 exit 1 + 그 파일명이 붙여넣기 가능한 JSON 조각으로 나온다."""
    monkeypatch.setattr(
        lint_mod, "discover_files", lambda: ["tests/test_a.py", "tests/test_new_3900.py"]
    )
    monkeypatch.setattr(lint_mod, "load_weights", lambda: {"tests/test_a.py": 10.0})

    exit_code = lint_mod.main()
    out = capsys.readouterr().out

    assert exit_code == 1
    assert "test_new_3900.py" in out
    assert '"file": "tests/test_new_3900.py"' in out
    assert '"sec": 10.0' in out  # 평균 가중치(등재 1건뿐이라 그 값 그대로)로 채워짐
    assert "::error::" in out


def test_negative_control_all_registered_returns_0(monkeypatch, capsys):
    """음성대조 — discover된 파일이 전부 weights.json에 있으면 통과(story 23bf1913)."""
    monkeypatch.setattr(lint_mod, "discover_files", lambda: ["tests/test_a.py", "tests/test_b.py"])
    monkeypatch.setattr(
        lint_mod, "load_weights", lambda: {"tests/test_a.py": 10.0, "tests/test_b.py": 5.0}
    )

    exit_code = lint_mod.main()
    out = capsys.readouterr().out

    assert exit_code == 0
    assert "OK" in out
    assert "0건" in out


def test_multiple_missing_files_all_listed_in_output(monkeypatch, capsys):
    """여러 건이 동시에 미등재면 전부 각자 한 줄씩(누락 없이) 나온다."""
    monkeypatch.setattr(
        lint_mod, "discover_files",
        lambda: ["tests/test_a.py", "tests/test_new1.py", "tests/test_new2.py"],
    )
    monkeypatch.setattr(lint_mod, "load_weights", lambda: {"tests/test_a.py": 20.0})

    exit_code = lint_mod.main()
    out = capsys.readouterr().out

    assert exit_code == 1
    assert "2개" in out
    assert "test_new1.py" in out
    assert "test_new2.py" in out


def test_empty_weights_json_still_averages_to_fallback_one(monkeypatch, capsys):
    """weights.json이 텅 비어 있으면(신규 레포·최초 세팅류) average_weight()의 1.0 폴백
    (shard_destructive_tests.py 기존 계약, 재검증 안 함)이 그대로 JSON 조각에 실린다 —
    이 스크립트가 그 폴백을 자기 나름대로 다시 계산하지 않는지 확인."""
    monkeypatch.setattr(lint_mod, "discover_files", lambda: ["tests/test_only.py"])
    monkeypatch.setattr(lint_mod, "load_weights", lambda: {})

    exit_code = lint_mod.main()
    out = capsys.readouterr().out

    assert exit_code == 1
    assert '"sec": 1.0' in out


def test_source_missing_returns_1_and_prints_error(monkeypatch, capsys):
    """story #3465 — files[] 항목에 source가 없으면(키 자체 부재) exit 1 + 그 파일명이
    ::error:: 줄에 나온다. 양성대조: unweighted 축은 green(discover=등재)이라 이 신호가
    오직 source 축에서만 왔음을 증명한다."""
    monkeypatch.setattr(lint_mod, "discover_files", lambda: ["tests/test_a.py"])
    monkeypatch.setattr(lint_mod, "load_weights", lambda: {"tests/test_a.py": 10.0})
    monkeypatch.setattr(lint_mod, "load_raw_entries", lambda: [{"file": "tests/test_a.py", "sec": 10.0}])

    exit_code = lint_mod.main()
    out = capsys.readouterr().out

    assert exit_code == 1
    assert "source 필드가 비었거나 없는" in out
    assert "1개" in out
    assert "::error::files[] 항목에 source가 없습니다(story #3465): tests/test_a.py" in out


def test_source_empty_string_also_flagged(monkeypatch, capsys):
    """빈 문자열도 「없음」과 동일 취급(공백만 있는 값으로 몰래 통과하는 길을 안 둔다)."""
    monkeypatch.setattr(lint_mod, "discover_files", lambda: ["tests/test_a.py"])
    monkeypatch.setattr(lint_mod, "load_weights", lambda: {"tests/test_a.py": 10.0})
    monkeypatch.setattr(
        lint_mod, "load_raw_entries",
        lambda: [{"file": "tests/test_a.py", "sec": 10.0, "source": "   "}],
    )

    exit_code = lint_mod.main()
    out = capsys.readouterr().out

    assert exit_code == 1
    assert "tests/test_a.py" in out


def test_source_present_negative_control_returns_0(monkeypatch, capsys):
    """음성대조 — 모든 항목에 source가 있으면 통과(story #3465)."""
    monkeypatch.setattr(lint_mod, "discover_files", lambda: ["tests/test_a.py"])
    monkeypatch.setattr(lint_mod, "load_weights", lambda: {"tests/test_a.py": 10.0})
    monkeypatch.setattr(
        lint_mod, "load_raw_entries",
        lambda: [{"file": "tests/test_a.py", "sec": 10.0, "source": "story-9999-example(...)"}],
    )

    exit_code = lint_mod.main()
    out = capsys.readouterr().out

    assert exit_code == 0
    assert "source 누락 0건" in out


def test_unweighted_and_missing_source_both_reported_together(monkeypatch, capsys):
    """두 축이 동시에 걸리면(신규 미등재 파일 + 기존 항목 source 누락) 한 번의 실행에
    둘 다 출력된다 — 재커밋 왕복을 두 번이 아니라 한 번으로 줄이는 게 이 스크립트
    존재 이유(unweighted 축의 원 사고와 같은 사상)."""
    monkeypatch.setattr(
        lint_mod, "discover_files", lambda: ["tests/test_a.py", "tests/test_new.py"]
    )
    monkeypatch.setattr(lint_mod, "load_weights", lambda: {"tests/test_a.py": 10.0})
    monkeypatch.setattr(
        lint_mod, "load_raw_entries", lambda: [{"file": "tests/test_a.py", "sec": 10.0}],
    )

    exit_code = lint_mod.main()
    out = capsys.readouterr().out

    assert exit_code == 1
    assert "test_new.py" in out  # unweighted 축
    assert "source 필드가 비었거나 없는" in out  # source 축
    assert "tests/test_a.py" in out.split("source 필드가")[1]  # source 누락 대상이 정확히 이 파일


def test_real_repo_state_smoke(capsys):
    """합성 fixture가 아니라 실물 repo 상태로 한 번 — discover_files()가 실제
    subprocess를 태워 217개(2026-09-04 실측)를 찾고, 그 시점 weights.json이 전부
    등재돼 있으면 0을 반환한다(story 23bf1913 PR 스스로가 이 가드를 통과해야 하므로
    이 테스트 자체가 「가드가 자기 재료를 못 찾으면 빨강」 원칙의 실물 확認)."""
    exit_code = lint_mod.main()
    out = capsys.readouterr().out
    assert exit_code == 0, out
    assert "OK" in out
