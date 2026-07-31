"""story #2311 — `backend/app/services/mcp_toolset.py`(원본) ↔ `backend/sprintable_mcp/toolset.py`
(vendored 사본) 대응 상수 대조 가드.

배경: `sprintable_mcp`는 PyPI에 독립 배포되는 패키지라 `backend/app`을 import할 수 없다(양방향
import 0건, 디커플링이 설계 의도 — doc `duplicate-registry-census-20260728` 부록에서 확認됨).
그래서 toolset 규칙(`_GROUP_KEYWORDS`·`_ALWAYS_ALLOWED` 등)을 두 파일에 **각자** 유지한다.
전례가 둘이다 — P1-S12(lock_files·standup 누락)·2026-07-29(delete_sprint 잔존) 둘 다 「누가
우연히 볼 때까지」 드리프트가 안 잡혔다.

방법: 두 파일을 **실제로 import해서 실행**한다(정적 텍스트/AST 블록 추출이 아니다 — PO가 이 건을
처음 잴 때 블록 추출 파서가 "완전일치"라는 거짓 답을 낸 전례가 있다). 둘 다 `from __future__
import annotations` 외에 의존성이 0이라 실행이 안전하고 빠르다(`test_e_mcp_s4_standalone.py`가
이미 같은 방식으로 두 모듈을 직접 import하는 것과 동형). 양쪽 모듈의 최상위 이름공간에서
**같은 이름으로 존재하는 데이터 상수 전부**를 자동으로 찾아 값 동일성을 비교한다 — 대조 대상을
손으로 나열하지 않는다(새 상수가 생겨도 따라온다).
"""
from __future__ import annotations

import importlib.util
import inspect
import sys
from pathlib import Path


def _find_repo_root(start: Path) -> Path:
    """'../' 개수를 세지 않고 .git 표식을 찾아 올라간다 — 못 찾으면 즉시 실패한다
    (story #2305와 동일 원칙: 재료 못 찾은 가드가 skip으로 통과하면 안 된다)."""
    cur = start.resolve()
    for _ in range(20):
        if (cur / ".git").exists():
            return cur
        if cur.parent == cur:
            break
        cur = cur.parent
    raise RuntimeError(f"repo root(.git 표식)를 {start} 위로 못 찾음")


_REPO_ROOT = _find_repo_root(Path(__file__).resolve().parent)
_ORIGINAL_PATH = _REPO_ROOT / "backend" / "app" / "services" / "mcp_toolset.py"
_VENDORED_PATH = _REPO_ROOT / "backend" / "sprintable_mcp" / "toolset.py"


def _load_module(path: Path, name: str):
    if not path.exists():
        raise RuntimeError(f"대조 대상 파일을 못 찾음(AC4 — skip 대신 실패): {path}")
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _module_level_constants(module) -> dict[str, object]:
    """모듈 최상위 이름공간에서 함수·클래스·서브모듈·`__future__` 기능 객체·dunder를 뺀
    나머지 — 즉 데이터 상수만."""
    result: dict[str, object] = {}
    for name, value in vars(module).items():
        if name.startswith("__"):
            continue
        if inspect.isfunction(value) or inspect.isclass(value) or inspect.ismodule(value):
            continue
        if type(value).__module__ == "__future__":  # `from __future__ import annotations` 자체
            continue
        result[name] = value
    return result


def find_matching_constants() -> dict[str, tuple[object, object]]:
    """양쪽에 같은 이름으로 존재하는 상수만 {name: (원본값, vendored값)}로 반환.
    ⛔AC4 — 공통 이름이 0건이면(파싱이 깨졌거나 재료가 없는 것) skip하지 않고 실패한다."""
    original = _module_level_constants(_load_module(_ORIGINAL_PATH, "mcp_toolset_original"))
    vendored = _module_level_constants(_load_module(_VENDORED_PATH, "mcp_toolset_vendored"))
    common_names = sorted(set(original) & set(vendored))
    if not common_names:
        raise RuntimeError(
            "원본↔vendored 공통 상수 이름 0건 — 모듈 로드가 깨졌거나 두 파일이 완전히 달라졌다"
        )
    return {name: (original[name], vendored[name]) for name in common_names}


def _is_pair_list(value: object) -> bool:
    """`_GROUP_KEYWORDS`류 — `[(key, values), ...]` 형태(list/tuple of 2-tuples, key는 str)."""
    if not isinstance(value, (list, tuple)):
        return False
    return all(
        isinstance(item, tuple) and len(item) == 2 and isinstance(item[0], str)
        for item in value
    )


def mismatches() -> list[str]:
    """값이 다른 공통 상수를 상세 사유와 함께 낸다 — 집합류는 대칭차, `_GROUP_KEYWORDS`류
    (key→values 쌍 목록)는 키 단위 대칭차, 그 외는 원본/vendored 값 자체를 보인다."""
    violations: list[str] = []
    for name, (orig_val, vend_val) in find_matching_constants().items():
        if orig_val == vend_val:
            continue
        if isinstance(orig_val, (set, frozenset)) and isinstance(vend_val, (set, frozenset)):
            only_orig = sorted(orig_val - vend_val)
            only_vend = sorted(vend_val - orig_val)
            violations.append(
                f"{name}: 원본에만 {only_orig} · vendored에만 {only_vend}"
            )
        elif _is_pair_list(orig_val) and _is_pair_list(vend_val):
            orig_map, vend_map = dict(orig_val), dict(vend_val)
            for key in sorted(set(orig_map) | set(vend_map)):
                o_vals, v_vals = set(orig_map.get(key, ())), set(vend_map.get(key, ()))
                if o_vals != v_vals:
                    violations.append(
                        f"{name}[{key!r}]: 원본에만 {sorted(o_vals - v_vals)} "
                        f"· vendored에만 {sorted(v_vals - o_vals)}"
                    )
        else:
            violations.append(f"{name}: 값 불일치 — 원본={orig_val!r} · vendored={vend_val!r}")
    return violations


def main() -> int:
    common = find_matching_constants()
    print(f"공통 상수 {len(common)}개 대조: {', '.join(sorted(common))}")
    problems = mismatches()
    if problems:
        print("❌ 원본↔vendored 드리프트 발견:")
        for line in problems:
            print(f"  - {line}")
        return 1
    print("✅ 드리프트 없음 — 원본↔vendored 공통 상수 전부 값 동일.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
