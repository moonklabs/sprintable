"""story #2255(69d7380e) — app/models/*.py에 새 ORM 모델(`__tablename__` 보유 클래스)이
생겼는데 app/models/__init__.py가 그 모듈을 import 안 하면 CI를 빨갛게 한다.

배경: #2201(2026-07-28)이 정확히 이 결함 클래스로 11개 모델이 Base.metadata에 안 잡혀
create_all()이 그 테이블들을 조용히 안 만들었다(프로세스의 «첫» realdb 테스트에서만 터짐 —
파일 순서에 따라 우연히 다른 파일의 import 경로로 sys.modules에 먼저 로드되면 안 드러났다).
그중 10개는 #2255에서 뒤늦게 등재됐다 — 이 가드는 «다음 11번째»가 같은 방식으로 몇 주씩
안 잡히는 것을 막는다.

⛔이 가드가 못 잡는 것(story #2662 진단 가드와 보완 관계, 겹치지 않음):
  ① 이 가드는 **정적**(AST만, import 0회) — "새 파일이 __init__.py에 없다"만 본다.
     #2662 가드는 **런타임**(테스트가 실제로 실패했을 때만) — "이 테스트가 왜 실패했는지"를
     진단한다. 둘 다 있어야 하는 이유: 이 가드는 실패를 애초에 안 나게(선제) 막고, #2662
     가드는 그래도 새는 경우(예: __init__.py는 등재했지만 특정 테스트 파일이 그 시점 이전에
     import를 안 한 다른 이유)를 사후에 설명한다.
  ② mixin/abstract 클래스처럼 `__tablename__`이 없는 모델은 안 본다 — 실제 테이블을 안 만드는
     클래스는 이 가드의 관심사가 아니다(create_all이 만들 테이블만 추적).
  ③ `app/models/__init__.py`가 아닌 다른 경로(예: 특정 라우터가 직접 import)로 어딘가에서
     이미 로드되고 있어도, 이 가드는 그것을 "등재됨"으로 인정하지 않는다 — SSOT를
     `app/models/__init__.py` 하나로 강제한다(다른 경로 의존은 #2201류 재발의 씨앗).
"""
from __future__ import annotations

import ast
import sys
from pathlib import Path

# story #2662 AC2 양성대조 전용 픽스처(app/models/_test_only_unregistered_fixture.py) —
# 의도적으로 영원히 __init__.py에 미등재 상태로 남아야 하는 유일한 예외. 이 파일을 등재하면
# AC2 양성대조의 전제(app.models 벌크 import에 없다)가 깨진다. 새 운영 모델을 여기 추가하지
# 말 것 — 그건 이 가드가 정확히 막으려는 결함이다.
_INTENTIONALLY_UNREGISTERED = {"_test_only_unregistered_fixture"}


def _models_with_tablename(models_dir: Path) -> dict[str, str]:
    """{module_stem: tablename} — app/models/*.py를 AST로 정적 스캔(import 0회)."""
    out: dict[str, str] = {}
    for filepath in sorted(models_dir.glob("*.py")):
        if filepath.name == "__init__.py":
            continue
        try:
            tree = ast.parse(filepath.read_text(encoding="utf-8"))
        except (SyntaxError, OSError, UnicodeDecodeError):
            continue
        for node in ast.walk(tree):
            if not isinstance(node, ast.Assign):
                continue
            if not any(isinstance(t, ast.Name) and t.id == "__tablename__" for t in node.targets):
                continue
            if isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
                out[filepath.stem] = node.value.value
                break
    return out


def _imported_module_stems(init_path: Path) -> set[str]:
    """app/models/__init__.py를 AST로 스캔해 `from app.models.X import ...` 형태의 X 전부를 모은다."""
    tree = ast.parse(init_path.read_text(encoding="utf-8"))
    stems: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module and node.module.startswith("app.models."):
            stems.add(node.module.rsplit(".", 1)[-1])
    return stems


def find_unregistered(models_dir: Path) -> dict[str, str]:
    """{module_stem: tablename} — __tablename__은 있는데 __init__.py에 안 잡힌 모듈만."""
    with_tablename = _models_with_tablename(models_dir)
    imported = _imported_module_stems(models_dir / "__init__.py")
    return {
        stem: table
        for stem, table in with_tablename.items()
        if stem not in imported and stem not in _INTENTIONALLY_UNREGISTERED
    }


def main() -> int:
    models_dir = Path(__file__).resolve().parent.parent / "app" / "models"
    unregistered = find_unregistered(models_dir)
    if unregistered:
        print(
            "FAIL: app/models/*.py에 __tablename__을 선언한 모듈이 app/models/__init__.py에 "
            "import 안 됨 — create_all()이 이 테이블들을 조용히 안 만든다(story #2201/#2255와 "
            "동일 결함 클래스):"
        )
        for stem, table in sorted(unregistered.items()):
            print(f"  app/models/{stem}.py (table={table!r}) — __init__.py에 `from app.models.{stem} import ...` 추가할 것")
        return 1
    print("OK: app/models/*.py의 __tablename__ 보유 모델 전부 __init__.py에 등재됨")
    return 0


if __name__ == "__main__":
    sys.exit(main())
