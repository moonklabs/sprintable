"""story #4742 — what a test puts into `app.dependency_overrides` is gone when the test ends, whatever the test did about it.

The tests below are meant to run in this order (definition order; each leaves its mess on purpose): the first three set overrides and end without taking them away, the
fourth looks at what is left. Without the autouse fixture `_restore_app_dependency_overrides` (tests/conftest.py) the last two fail — the same way `test_3997` →
`test_4299` did (a leftover `get_current_user` made the next test ask as another organization's owner).
"""
from __future__ import annotations

import pytest

from app.dependencies.auth import get_current_user
from app.dependencies.database import get_db, get_read_db
from app.main import app
from tests.conftest import override_db_and_read


async def _stranger():
    raise AssertionError("a leftover override was called")


@pytest.fixture(scope="module")
def _overrides_set_before_the_tests():
    """what a module-scoped fixture sets stays for the whole module (it is not the test's to take away)."""
    saved = dict(app.dependency_overrides)
    app.dependency_overrides[get_read_db] = _stranger
    yield _stranger
    app.dependency_overrides.clear()
    app.dependency_overrides.update(saved)


def test_01_a_test_that_sets_overrides_and_never_clears_them(_overrides_set_before_the_tests):
    assert app.dependency_overrides.get(get_read_db) is _stranger
    app.dependency_overrides[get_current_user] = _stranger
    override_db_and_read(app, _stranger)  # the one way a test may set get_db (story #2451 lint): sets get_read_db too
    app.dependency_overrides[get_read_db] = lambda: None  # a key the module fixture had set, replaced


def test_02_the_next_test_starts_without_them_and_keeps_what_the_module_set(_overrides_set_before_the_tests):
    assert get_current_user not in app.dependency_overrides
    assert get_db not in app.dependency_overrides
    assert app.dependency_overrides.get(get_read_db) is _stranger  # restored to the value it had when the test began, not cleared


def test_03_a_test_that_clears_everything_does_not_take_the_modules_setting_with_it(_overrides_set_before_the_tests):
    app.dependency_overrides.clear()


def test_04_and_the_module_setting_is_back_after_that(_overrides_set_before_the_tests):
    assert app.dependency_overrides == {get_read_db: _stranger}


async def test_05_an_async_test_is_covered_too(_overrides_set_before_the_tests):
    app.dependency_overrides[get_current_user] = _stranger
    with pytest.raises(RuntimeError):
        raise RuntimeError("boom")


def test_06_and_what_it_set_is_gone_too(_overrides_set_before_the_tests):
    assert get_current_user not in app.dependency_overrides
