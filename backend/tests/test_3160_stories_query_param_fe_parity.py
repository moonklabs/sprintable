"""story #3160(PO #3148 라이브 대조 중 발견, PO 재발봉인 지시) — «경계 넘는 이름이 양쪽 다르면
조용히 버려진다» 클래스 재발 봉인. `GET /api/v2/stories`(list_stories)의 Query 파라미터명
전수를, FE 3중 화이트리스트 체인(route.ts·IStoryRepository.ts·ApiStoryRepository.ts) 소스
텍스트와 대조한다.

이 파일에서만 이미 5번 재발했다(주석에 흔적 남음): q(083176e8)·unattached·story_number·
boost_candidates_from·epic_ids/include_unassigned/done_within_days — 전부 "BE엔 있는데 FE
어디에도 문자열로 안 나타남"이 원인이었다. 이 가드는 그 필요조건(FE 3파일 어딘가에 그
파라미터명이 리터럴로 등장하는지)만 본다 — «올바르게 배선됐는지»(값이 실제로 쓰이는지)는
검증 못 한다(그건 route.test.ts/ApiStoryRepository.test.ts류 왕복 테스트의 몫).

⛔KNOWN_INTENTIONALLY_UNEXPOSED — "안 잊었다, 일부러 안 낸다" 파라미터. story #3160
판정(no_sprint): BE에서 이 값이 true면 cursor 페이지네이션이 완전히 다른(비cursor·
X-Total-Count) 분기로 빠져 일반 list() 계약과 안 맞는다 — route.ts의 조기 raw-proxy
분기(`no_sprint`문자열 리터럴 자체는 route.ts에 있음)에서만 다루고 IStoryRepository/
ApiStoryRepository 레이어에는 의도적으로 안 올린다. 이 세트에 새 이름을 추가할 땐 반드시
이 파일에도 판정 근거를 남긴다(조용히 빼지 않는다, cloudbuild_secret_refs.py
_DECLARED_UNCOVERED_SCRIPTS와 동일 원칙).
"""
from __future__ import annotations

import ast
from pathlib import Path


def _find_repo_root(start: Path) -> Path:
    cur = start.resolve()
    for _ in range(20):
        if (cur / ".git").exists():
            return cur
        if cur.parent == cur:
            break
        cur = cur.parent
    raise RuntimeError(f"repo root(.git 표식)를 {start} 위로 못 찾음")


_REPO_ROOT = _find_repo_root(Path(__file__).resolve().parent)
_STORIES_ROUTER = _REPO_ROOT / "backend" / "app" / "routers" / "stories.py"
_FE_FILES = [
    _REPO_ROOT / "apps" / "web" / "src" / "app" / "api" / "stories" / "route.ts",
    _REPO_ROOT / "packages" / "core-storage" / "src" / "interfaces" / "IStoryRepository.ts",
    _REPO_ROOT / "packages" / "storage-api" / "src" / "ApiStoryRepository.ts",
]

# story #3160 — «가입」이 아니라 「접근권 부여」류로 다른 축인 것들, 또는 이 함수의 실제
# 쿼리 파라미터가 아닌 것(FastAPI 특수 주입)은 대상에서 제외한다.
_NOT_QUERY_PARAMS = {"response", "repo", "auth"}

# story #3160 판정 — 의도적으로 FE 3파일 «전부»에 안 올리는 이름(적어도 하나엔 등장해야
# 하므로 여기 있어도 완전 무시는 아니다 — _FE_FILES 어디서도 안 보이면 여전히 이 가드가
# 문다. 이 세트는 "몇 개 파일에 있어야 하는지 완화"가 아니라 향후 진짜 예외가 생기면 쓸
# 자리로 비워 둔다).
_KNOWN_INTENTIONALLY_UNEXPOSED: set[str] = set()


def _extract_query_param_names(router_source: str, func_name: str) -> set[str]:
    """AST로 `func_name` 함수의 `Query(...)` 기본값 파라미터명(alias 있으면 alias)을 뽑는다.
    scripts/lint_query_sentinel_direct_calls.py의 find_router_functions와 동형 기법
    (재구현 아님 — 이 파일 전용으로 좁혀 alias까지 뽑는 점만 다름)."""
    tree = ast.parse(router_source)
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == func_name:
            args = node.args
            all_positional = list(args.posonlyargs) + list(args.args)
            defaults = list(args.defaults)
            pad = len(all_positional) - len(defaults)
            names: set[str] = set()
            for i, a in enumerate(all_positional):
                if i < pad or a.arg in _NOT_QUERY_PARAMS:
                    continue
                default = defaults[i - pad]
                if not (isinstance(default, ast.Call) and isinstance(default.func, ast.Name) and default.func.id == "Query"):
                    continue
                alias = None
                for kw in default.keywords:
                    if kw.arg == "alias" and isinstance(kw.value, ast.Constant):
                        alias = kw.value.value
                names.add(alias or a.arg)
            return names
    raise AssertionError(f"{func_name}() 함수를 {_STORIES_ROUTER}에서 못 찾음 — 파일이 리네임/이동됐을 가능성")


def test_list_stories_query_params_all_appear_somewhere_in_fe_whitelist_chain():
    be_params = _extract_query_param_names(_STORIES_ROUTER.read_text(encoding="utf-8"), "list_stories")
    assert be_params, "BE에서 파라미터를 0개 추출 — 추출기 자체가 깨졌을 가능성(우연한 그린 방지)"

    fe_combined_text = "\n".join(f.read_text(encoding="utf-8") for f in _FE_FILES)

    missing = sorted(
        name for name in be_params
        if name not in fe_combined_text and name not in _KNOWN_INTENTIONALLY_UNEXPOSED
    )
    assert not missing, (
        f"BE list_stories()가 받는 Query 파라미터 {missing}가 FE 화이트리스트 3파일"
        f"({', '.join(str(f.relative_to(_REPO_ROOT)) for f in _FE_FILES)}) 어디에도 안 보임 — "
        "«경계 넘는 이름이 양쪽 다르면 조용히 버려진다» 클래스 재발(q/unattached/story_number/"
        "boost_candidates_from/epic_ids류와 동형). 신규면 3파일에 배선하고, 의도적 미노출이면 "
        "_KNOWN_INTENTIONALLY_UNEXPOSED에 판정 근거와 함께 등재할 것."
    )


def test_known_intentionally_unexposed_params_still_exist_on_be():
    """선언(_KNOWN_INTENTIONALLY_UNEXPOSED)이 낡지 않았는지 — 가리키는 파라미터가 BE에서
    사라졌으면(리네임 등) 이 예외 등재 자체가 유령이 된다(cloudbuild_secret_refs.py
    _DECLARED_UNCOVERED_SCRIPTS 존재검증과 동일 원칙)."""
    be_params = _extract_query_param_names(_STORIES_ROUTER.read_text(encoding="utf-8"), "list_stories")
    for name in _KNOWN_INTENTIONALLY_UNEXPOSED:
        assert name in be_params, f"{name}이 BE list_stories()에 더는 없음 — 예외 등재가 낡음, 제거할 것"
