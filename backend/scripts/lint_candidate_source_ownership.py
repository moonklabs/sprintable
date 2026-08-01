"""story #2363([보안·CRITICAL] AC6) — reference_semantic_candidates.py의 `candidate_id`
조회 함수가 소유(`source_id`) 대조 없이 새로 생기는 것을 CI에서 막는다.

배경: `declare_candidate`/`set_candidate_relation_kind`/`undeclare_candidate`/
`reject_candidate` 넷 다 원래 `org_id + candidate_id`로만 조회했다 — 라우터가 URL의
`{id}` story에는 project 접근권을 검사하지만, 실제로 만지는 candidate가 «그 story의
것»인지는 아무도 대조하지 않아 다른 project의 candidate를 만지고 지울 수 있었다(IDOR).

⛔기존 `lint_project_access_403.py`가 이 결함을 못 잡은 이유(오르테가 가설, 디디 실측으로
확認): 그 lint의 축은 「무권한 응답이 403이 아니라 404인가」— 즉 「검사를 «불렀는가»」다.
이 결함은 검사를 부르긴 불렀다(`_assert_story_project_access`가 URL의 `{id}`에 대해
정상 호출된다) — 다만 **검사한 대상과 실제로 만지는 대상이 달랐다.** 「불렀는가」 축은
이 클래스를 원리적으로 못 본다. 그래서 이 lint는 다른 축을 본다: 「`candidate_id`로
조회하는 함수가 그 조회 조건에 `source_id`도 같이 거는가」.

⛔이 lint가 잡는 패턴: 이 파일(`reference_semantic_candidates.py`) 안의 `async def` 함수가
파라미터로 `candidate_id`를 받으면서, ①파라미터 목록에 `source_id`가 없거나 ②함수 본문의
`.where(...)` 안에서 `<Model>.source_id ==` 형태의 비교를 쓰지 않으면 위반이다.

⛔이 lint가 못 잡는 것(정직하게 적는다, story #2342/#2335와 동일 정신):
  - 이 파일 «밖»의 다른 서비스 모듈이 같은 문제 모양(검사한 것≠만지는 것)을 갖는 경우 —
    정적으로 일반화하지 않는다(AC7이 이번 사고 범위를 stories.py 하나로 실측 확認했다).
  - `source_id` 파라미터가 있고 `.where()`에도 등장하지만 라우터가 «잘못된» 값(권한 없는
    id)을 넘기는 경우 — 이 lint는 함수 «내부 계약»만 본다, 호출부 검증은 못 본다.
  - 1-hop 이상 간접 호출(다른 함수를 통해 이 select를 감싸는 경우) — 정적 단일 함수
    스캔이라(project_access_403 lint와 동일 한계) 그 안까지는 못 본다.

베이스라인 없음 — 이 lint를 켠 시점(2026-07-31) 코드베이스는 이미 4곳 다 준수 상태로
고쳐졌다(story #2363 자신이 그 수정). 그래서 grandfather 메커니즘이 필요 없다 — 새 위반이든
기존 위반이든 하나라도 있으면 즉시 CI가 빨개진다(project_access_403 lint의 baseline=0과
동일 계약).
"""
from __future__ import annotations

import ast
import sys
from pathlib import Path

TARGET_FILE = Path(__file__).parent.parent / "app" / "services" / "reference_semantic_candidates.py"


def _param_names(func: ast.AsyncFunctionDef) -> set[str]:
    args = func.args
    names = {a.arg for a in args.args}
    names |= {a.arg for a in args.kwonlyargs}
    if args.vararg:
        names.add(args.vararg.arg)
    return names


def _has_source_id_where_clause(func: ast.AsyncFunctionDef) -> bool:
    """함수 본문 어딘가에 `<Model>.source_id == <무언가>` 비교가 있는가(where절 안인지는
    안 가린다 — Compare 자체가 select().where(...) 호출 인자 안에서만 의미가 있으므로
    「그런 Compare가 존재한다」는 「filter에 안 걸었다」를 배제하기에 충분히 보수적이다)."""
    for node in ast.walk(func):
        if not isinstance(node, ast.Compare):
            continue
        left = node.left
        if (
            isinstance(left, ast.Attribute)
            and left.attr == "source_id"
            and any(isinstance(op, ast.Eq) for op in node.ops)
        ):
            return True
    return False


def find_violations(tree: ast.Module) -> list[str]:
    violations: list[str] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.AsyncFunctionDef):
            continue
        params = _param_names(node)
        if "candidate_id" not in params:
            continue
        if "source_id" not in params:
            violations.append(
                f"{node.name}:{node.lineno} — candidate_id는 받지만 source_id 파라미터가 없다"
            )
            continue
        if not _has_source_id_where_clause(node):
            violations.append(
                f"{node.name}:{node.lineno} — source_id 파라미터는 있으나 조회 조건에 "
                f"쓰이지 않는다(<Model>.source_id == ... 비교가 함수 본문에 없다)"
            )
    return violations


def main() -> int:
    tree = ast.parse(TARGET_FILE.read_text())
    violations = find_violations(tree)
    if violations:
        print(f"candidate_id 소유 대조 lint 위반 {len(violations)}건 — story #2363 회귀:")
        for v in violations:
            print(f"  {TARGET_FILE.relative_to(TARGET_FILE.parent.parent.parent)}:{v}")
        return 1
    print("OK: candidate_id를 받는 함수 전부 source_id로 소유 대조한다(새 위반 0건)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
