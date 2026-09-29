"""story #4407 AC5 — the `:name::type` guard catches the real shape and lets the harmless ones through."""
import importlib.util
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    "lint_no_bind_param_cast", Path(__file__).resolve().parent.parent / "scripts" / "lint_no_bind_param_cast.py",
)
lint = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(lint)


def test_the_real_shapes_are_caught():
    # the two sites this class came from (account/delete before #4400, seed_builtin_personas before AC5)
    src = (
        'text("UPDATE org_members SET deleted_at = :now WHERE user_id = :uid::uuid")\n'
        'text("SELECT seed_builtin_personas(:org_id::uuid, :project_id::uuid, :agent_id::uuid)")\n'
    )
    hits = lint.find_bind_casts(src)
    assert [piece for _line, piece in hits] == [":uid::u", ":org_id::u", ":project_id::u", ":agent_id::u"]
    assert [line for line, _piece in hits] == [1, 2, 2, 2]


def test_harmless_shapes_pass():
    src = (
        'text("SELECT CAST(:org_id AS uuid)")\n'           # the fix
        'text("SELECT \'x\'::text, now()::date")\n'       # casts on literals / expressions
        'print("::error::something")\n'                   # GitHub annotations
        'x = "a::b"\n'
        '# a comment with :uid::uuid is not a string\n'
    )
    assert lint.find_bind_casts(src) == []


def test_docstrings_are_not_sql():
    src = 'def f():\n    """Do not write `:uid::uuid` here."""\n    return 1\n'
    assert lint.find_bind_casts(src) == []


def test_the_repository_is_clean():
    assert lint.main() == 0
