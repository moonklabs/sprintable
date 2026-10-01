"""story 4459 — the two guards in conftest.py that stop one test file from changing every later file in the same run
(Didi · Kadir 2026-10-01: three tests failed only in a 115-file batch, on develop too). The guards themselves run on every
collection / every test; these tests pin what they decide, so a guard that can never say «no» turns red here."""
from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

from tests import conftest


def test_tests_dir_entries_finds_the_tests_directory_in_any_spelling(tmp_path):
    tests_dir = Path(conftest.__file__).resolve().parent
    spelled = [str(tests_dir), str(tests_dir) + "/", str(tests_dir / ".." / tests_dir.name)]
    assert conftest._tests_dir_entries(["", str(tmp_path), *spelled], tests_dir) == spelled
    assert conftest._tests_dir_entries(["", str(tmp_path), str(tests_dir.parent)], tests_dir) == []


def test_the_running_session_has_no_tests_dir_on_sys_path():
    # the guard took every leaking module's entry off and stopped the run; a run that got here has none left
    assert conftest._tests_dir_entries(sys.path, Path(conftest.__file__).resolve().parent) == []


def test_sys_path_leak_error_names_every_leaking_module_and_says_how_to_import():
    assert conftest._sys_path_leak_error([]) is None
    msg = conftest._sys_path_leak_error(["tests/test_b.py", "tests/test_a.py", "tests/test_b.py"])
    assert msg is not None
    assert "tests/test_a.py\ntests/test_b.py" in msg  # sorted, once each
    assert "from tests.<module> import" in msg and "mcp" in msg


def test_settings_swap_error_only_when_the_object_or_the_module_changed():
    module = SimpleNamespace(settings=object())
    same = conftest._settings_swap_error(module, module.settings, module, module.settings, "t::same")
    assert same is None
    new_settings = conftest._settings_swap_error(module, module.settings, module, object(), "t::reload")
    assert new_settings is not None and "t::reload" in new_settings and "monkeypatch.setattr(settings" in new_settings
    other_module = SimpleNamespace(settings=module.settings)
    assert conftest._settings_swap_error(module, module.settings, other_module, module.settings, "t::module") is not None


def test_the_settings_object_this_test_sees_is_the_one_the_app_reads():
    # what ② keeps true for every test: one object, the one modules imported at collection hold
    import app.core.config as config_module
    import app.services.youtube_privacy as privacy_module

    assert privacy_module.settings is config_module.settings
