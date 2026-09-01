"""story #2255(69d7380e) — lint_model_registration_completeness.py의 정탐/오탐 회귀 가드.
합성 fixture로 짓는다(실물이 고쳐져도 이 테스트는 안 사라진다, story #2335/#2342/#2476 lint와
동형)."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))
from lint_model_registration_completeness import (  # noqa: E402
    _imported_module_stems,
    _models_with_tablename,
    find_unregistered,
)


def _write(tmp_path: Path, name: str, source: str) -> Path:
    p = tmp_path / name
    p.write_text(source)
    return p


def test_detects_unregistered_model(tmp_path):
    _write(
        tmp_path,
        "widget.py",
        'class Widget(Base):\n    __tablename__ = "widgets"\n',
    )
    _write(tmp_path, "__init__.py", "# no imports\n")
    unregistered = find_unregistered(tmp_path)
    assert unregistered == {"widget": "widgets"}


def test_registered_model_not_flagged(tmp_path):
    _write(
        tmp_path,
        "widget.py",
        'class Widget(Base):\n    __tablename__ = "widgets"\n',
    )
    _write(tmp_path, "__init__.py", "from app.models.widget import Widget\n")
    assert find_unregistered(tmp_path) == {}


def test_model_without_tablename_not_flagged(tmp_path):
    """mixin/abstract 클래스(__tablename__ 없음)는 실 테이블을 안 만드니 이 가드 관심사 밖."""
    _write(tmp_path, "mixin.py", "class TimestampMixin:\n    pass\n")
    _write(tmp_path, "__init__.py", "# no imports\n")
    assert find_unregistered(tmp_path) == {}


def test_import_from_unrelated_module_does_not_count_as_registration(tmp_path):
    """__init__.py가 다른 패키지를 import해도 app.models.X 형태가 아니면 등재로 안 친다."""
    _write(
        tmp_path,
        "widget.py",
        'class Widget(Base):\n    __tablename__ = "widgets"\n',
    )
    _write(tmp_path, "__init__.py", "from sqlalchemy import Column\n")
    assert find_unregistered(tmp_path) == {"widget": "widgets"}


def test_mutation_blank_registry_causes_zero_detections(tmp_path):
    """뮤테이션: _models_with_tablename이 늘 빈 dict를 반환하게 하면 양성 테스트가 깨져야
    한다 — 이 lint의 핵심 로직이 실제로 테스트에 의존함을 자가 검증(story #2342 lint와 동일
    관례)."""
    import lint_model_registration_completeness as mod

    original = mod._models_with_tablename
    try:
        mod._models_with_tablename = lambda models_dir: {}
        _write(
            tmp_path,
            "widget.py",
            'class Widget(Base):\n    __tablename__ = "widgets"\n',
        )
        _write(tmp_path, "__init__.py", "# no imports\n")
        assert mod.find_unregistered(tmp_path) == {}, "뮤테이션 후에는 탐지가 0이어야 정상"
    finally:
        mod._models_with_tablename = original


def test_current_repo_has_zero_unregistered_models():
    """실물 app/models/ 전수 스캔 — story #2255 완주 시점(2026-09-02) 확認한 등재 0갭이
    유지되는지 CI가 도는 그 검사 자체를 pytest로도 한 번 더 고정한다."""
    models_dir = Path(__file__).parent.parent / "app" / "models"
    assert find_unregistered(models_dir) == {}
