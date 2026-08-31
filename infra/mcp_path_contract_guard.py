"""story #2280 — MCP 도구 선언 경로 vs FastAPI 실제 라우트 정적 대조 가드.

호출 없음(서버 기동 불필요) — `backend/sprintable_mcp/tools/*.py`가 부르는 경로 문자열과
`backend/app/routers/*.py`(+`backend/app/main.py`의 include_router)가 실제로 여는 경로를
소스에서 직독해 대조한다. #2271 AC3·AC4의 산출물.

⭐이 파일은 `infra/check_serving_reality.py`(story #2174)와 같은 자리에 있다 — 같은 이유:
"정상"과 "알고 있다"를 분리하고(허용목록), 대부분의 허용목록은 스스로 만료된다(`until`
필수+상한). ⚠️story #3168(2026-08-28) 후속 — 구조적으로 영구한 간접경로(코드 패턴 자체가
항상 M으로 잡히는 것, 호출부가 사라지면 이 실행에서 그 항목 자체가 다시 안 잡히므로
«기계 재검증»이 매 실행 이미 일어난다)는 예외: `declared_permanent_indirect`는 until을
요구하지 않는다(reason/declared_by는 여전히 필수). 자세한 배경은
`infra/mcp-path-contract-allowlist.yml` 머리말 참조.

⚠️오늘(2026-07-28) 이 축 자체에서 겪은 실패: 최초 수기 audit가 develop보다 뒤처진 로컬
체크아웃으로 실행돼, 2026-07-15에 이미 fix된 retro.py 7건+list_backlog 1건(총 8건)을
"신규 발견"으로 오보했다. `check_ref_freshness()`는 그 재발을 막기 위한 것이다 — 결과가
아니라 "지금 무엇을 읽고 있는가" 자체를 매 실행 검증한다.
"""
from __future__ import annotations

import re
import subprocess
import sys
from datetime import date, datetime, timezone
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[1]
_ROUTERS_DIR = _REPO_ROOT / "backend" / "app" / "routers"
_TOOLS_DIR = _REPO_ROOT / "backend" / "sprintable_mcp" / "tools"
_MAIN_PY = _REPO_ROOT / "backend" / "app" / "main.py"
_ALLOWLIST_PATH = _REPO_ROOT / "infra" / "mcp-path-contract-allowlist.yml"

_MAX_DECLARATION_HORIZON_DAYS = 30  # infra/check_serving_reality.py와 동일 상한(까심군 리뷰③ 교훈).

POSITIVE_CONTROL = ("GET", "/api/v2/docs")  # list_docs — 2026-07-28 read-sweep으로 정상 작동 재확認.


def _today() -> date:
    env = __import__("os").environ.get("MCP_PATH_GUARD_TODAY")
    if env:
        return date.fromisoformat(env)
    return datetime.now(timezone.utc).date()


def norm(path: str) -> str:
    return re.sub(r"\{[^}]+\}", "{*}", path)


def _load_allowlist() -> tuple[
    dict[tuple[str, str, str], dict], dict[tuple[str, str], dict], dict[tuple[str, str], dict]
]:
    """반환: ({(module, method, norm_path): entry} 경로 불일치 선언, {(module, function): entry}
    시한부 간접경로 선언, {(module, function): entry} 영구 간접경로 선언).

    파일이 없으면 빈 선언으로 취급한다 — ⛔"선언 파일이 없으니 검사 생략"은 하지 않는다."""
    if not _ALLOWLIST_PATH.exists():
        return {}, {}, {}
    import yaml

    data = yaml.safe_load(_ALLOWLIST_PATH.read_text()) or {}
    mismatches = {}
    for e in data.get("declared_mismatches") or []:
        key = (e["module"], e["method"].upper(), norm(e["path"]))
        mismatches[key] = e
    indirect = {}
    for e in data.get("declared_indirect") or []:
        key = (e["module"], e["function"])
        indirect[key] = e
    permanent_indirect = {}
    for e in data.get("declared_permanent_indirect") or []:
        key = (e["module"], e["function"])
        permanent_indirect[key] = e
    return mismatches, indirect, permanent_indirect


def _permanent_entry_problem(entry: dict) -> str | None:
    """story #3168(2026-08-28, 페드루 PO 판정) — declared_permanent_indirect 전용 검사.
    구조적으로 영구한 간접경로(동적 dispatch가 코드 패턴 자체에 내재)는 `until`을 요구하지
    않는다 — 이 진입점이 여전히 실재하는지는 매 실행마다 `unreadable` 재스캔이 기계적으로
    검증하므로(코드가 바뀌어 그 호출부가 사라지면 이 declared 항목 자체가 조회 대상에서
    빠진다), `until` 시한은 «주기 재검증»에 아무 것도 더하지 못하고 순수 재확認 노동만
    반복시킨다(declared_indirect의 두 기존 항목이 실제로 겪은 패턴). reason/declared_by는
    여전히 필수 — «왜 영구히 간접인지»는 사람이 남겨야 한다."""
    if not entry.get("reason"):
        return "`reason`(사유)이 없다"
    if not entry.get("declared_by"):
        return "`declared_by`(선언자)가 없다"
    return None


def _expired(entry: dict, today: date) -> str | None:
    """만료·형식 위반이면 사유 문자열, 아니면 None. infra/check_serving_reality.py와 동형."""
    until_raw = entry.get("until")
    if not until_raw:
        return "`until`(만료일)이 없다 — 영원히 사는 선언은 허용하지 않는다"
    try:
        until = date.fromisoformat(str(until_raw))
    except ValueError:
        return f"`until` 형식이 YYYY-MM-DD가 아니다: {until_raw!r}"
    if until < today:
        return f"선언이 만료됐다(until={until}) — 재확認 후 갱신하거나 실제로 고칠 것"
    horizon = (until - today).days
    if horizon > _MAX_DECLARATION_HORIZON_DAYS:
        return (
            f"`until`이 너무 멀다({until} · {horizon}일 뒤) — 최대 {_MAX_DECLARATION_HORIZON_DAYS}일"
        )
    if not entry.get("reason"):
        return "`reason`(사유)이 없다"
    if not entry.get("declared_by"):
        return "`declared_by`(선언자)가 없다"
    return None


def check_ref_freshness(repo_root: Path = _REPO_ROOT) -> str | None:
    """지금 읽는 체크아웃이 origin/develop과 관련 경로에서 같은지 확認. 다르면 경고 문자열,
    같으면 None. (git 명령 실패 시에도 문자열 반환 — 신뢰 여부를 호출부가 판단.)

    ⚠️CI 안에서는 스킵한다 — actions/checkout이 매번 정확히 그 PR의 커밋만 체크아웃하므로
    "로컬 클론이 develop보다 뒤처졌다"는 애초에 성립하지 않는 문제다(그리고 기본 checkout은
    fetch-depth=1이라 origin/develop 자체가 로컬에 없어 이 git 명령이 항상 실패한다). 이 체크는
    세션이 긴 인터랙티브 작업에서 공유 클론을 재사용할 때만 의미가 있다(2026-07-28 실제로
    겪은 문제)."""
    import os
    if os.environ.get("CI"):
        return None
    try:
        diff = subprocess.run(
            ["git", "diff", "--quiet", "origin/develop", "HEAD", "--",
             "backend/sprintable_mcp/tools/", "backend/app/routers/", "backend/app/main.py"],
            cwd=repo_root,
        )
        if diff.returncode not in (0, 1):
            return f"git diff 명령이 비정상 종료(returncode={diff.returncode})"
        if diff.returncode == 1:
            return "HEAD가 origin/develop과 관련 경로에서 다름 — `git fetch origin develop` 후 재확認 요망"
        return None
    except Exception as exc:  # pragma: no cover - 환경 문제
        return f"ref 신선도 체크 실패(git 명령 오류): {exc}"


def load_route_table(routers_dir: Path = _ROUTERS_DIR, main_py: Path = _MAIN_PY) -> set[tuple[str, str]]:
    """FastAPI 실제 라우트. prefix가 있는/없는 라우터, include_router(prefix=...) 마운트 시점
    prefix 세 가지 경우를 모두 읽는다."""
    routes = set()
    mounted = set()
    mount_prefixes: dict[str, set] = {}
    main_src = main_py.read_text()
    for m in re.finditer(r'app\.include_router\((\w+)\.router(?:,\s*prefix="([^"]*)")?', main_src):
        module, mount_prefix = m.group(1), m.group(2)
        mounted.add(module)
        mount_prefixes.setdefault(module, set()).add(mount_prefix or "")

    for fpath in sorted(routers_dir.glob("*.py")):
        module = fpath.stem
        src = fpath.read_text()
        if "router = APIRouter(" not in src:
            continue
        pm = re.search(r'APIRouter\(prefix="([^"]*)"', src)
        decorator_prefix = pm.group(1) if pm else None

        candidate_prefixes = set()
        for mp in mount_prefixes.get(module, {None}):
            if mp:
                candidate_prefixes.add(mp)
            elif decorator_prefix is not None:
                candidate_prefixes.add(decorator_prefix)
            else:
                candidate_prefixes.add("")
        if module not in mount_prefixes and decorator_prefix is not None:
            candidate_prefixes.add(decorator_prefix)

        for method, path in re.findall(r'@router\.(get|post|patch|put|delete)\("([^"]*)"', src):
            for prefix in candidate_prefixes:
                full = (prefix.rstrip("/") + path) if prefix else path
                routes.add((method.upper(), norm(full)))
        if module not in mounted:
            print(f"⚠️  {module}.py: router 정의는 있으나 main.py에 include_router 안 됨(미탑재 의심)", file=sys.stderr)
    return routes


def _enclosing_function(src: str, pos: int) -> str:
    fns = re.findall(r"^async def (\w+)", src[:pos], re.MULTILINE)
    return fns[-1] if fns else "?"


def load_mcp_declared(tools_dir: Path = _TOOLS_DIR):
    """MCP 도구가 부르는 경로. 반환: (calls, unreadable) — unreadable은 (module, function, raw) 리스트로
    첫 인자가 리터럴이 아니었던(변수 등) 호출. 셋 다 이름까지 남는다(자동으로 못 읽었다고 조용히
    빠지지 않는다 — 2026-07-28 attachments.py:upload_attachments 발견 이후 필수 요건)."""
    calls = []
    unreadable = []
    # ⛔story #2294 ③ 후속(2026-07-29): `post_full`은 `post`와 «같은 HTTP verb·같은 경로
    # 추적 대상»이다 — {data: T} 자동 언래핑을 끄는 것뿐(unwrap=False), 검증해야 할 경로
    # 자체는 post()와 동일 축이라 verb=POST로 매칭한다(가드를 느슨하게 하는 게 아니라
    # 어휘를 넓히는 것 — 위 모듈 docstring의 "자동으로 못 읽었다고 조용히 빠지지 않는다"
    # 원칙 그대로 여기도 적용).
    method_re = re.compile(r"client\.(get|post_full|post|patch|put|delete)\(")
    request_re = re.compile(r'client\.request\(\s*\n?\s*"(GET|POST|PATCH|PUT|DELETE)",\s*\n?\s*')

    for fpath in sorted(tools_dir.glob("*.py")):
        module = fpath.stem
        src = fpath.read_text()

        for m in method_re.finditer(src):
            # post_full은 언래핑만 끄는 post의 변형 — 검증 축은 여전히 실제 HTTP verb(POST).
            method = "POST" if m.group(1) == "post_full" else m.group(1).upper()
            after = src[m.end():]
            lit = re.match(r'\s*f?"([^"]*)"', after)
            if lit:
                calls.append((module, method, lit.group(1)))
            else:
                raw = after[:60].split(",")[0].split(")")[0].strip().replace("\n", " ")
                unreadable.append((module, _enclosing_function(src, m.start()), f"{method} {raw}"))

        for m in request_re.finditer(src):
            method = m.group(1)
            after = src[m.end():]
            lit = re.match(r'f?"([^"]*)"', after)
            if lit:
                calls.append((module, method, lit.group(1)))
            else:
                raw = after[:60].split(",")[0].split(")")[0].strip().replace("\n", " ")
                unreadable.append((module, _enclosing_function(src, m.start()), f"{method} {raw}"))

    return calls, unreadable


def main() -> int:
    today = _today()
    ok = True

    import os
    freshness_problem = check_ref_freshness()
    if freshness_problem:
        print(f"🔴 ref 신선도: {freshness_problem}", file=sys.stderr)
        ok = False
    elif os.environ.get("CI"):
        print("ref 신선도: CI 환경 — actions/checkout이 이미 정확한 커밋이라 스킵")
    else:
        print("ref 신선도 OK: HEAD == origin/develop(관련 경로 기준)")

    route_table = load_route_table()
    if POSITIVE_CONTROL not in route_table:
        print(f"🔴 가드 자체 이상 — 양성대조 {POSITIVE_CONTROL}가 route_table에 없다. "
              "대조법이 고장났을 가능성 → 이 가드의 다른 결과를 신뢰하지 말 것.")
        return 2
    print(f"양성대조 OK: {POSITIVE_CONTROL} 확認됨 — 대조법 정상\n")

    mcp_calls, unreadable = load_mcp_declared()
    declared_mismatches, declared_indirect, declared_permanent_indirect = _load_allowlist()

    mismatches = []
    for module, method, path in mcp_calls:
        key = (module, method, norm(path))
        if (method, norm(path)) in route_table:
            continue
        mismatches.append((module, method, path))

    print(f"대조한 {len(mcp_calls)}개 / 읽지 못한 {len(unreadable)}개(M)\n")

    new_mismatches = []
    print(f"불일치 {len(mismatches)}건")
    for module, method, path in mismatches:
        key = (module, method, norm(path))
        entry = declared_mismatches.get(key)
        if entry is None:
            print(f"  🔴 {module}: {method} {path} — 허용목록에 없는 신규")
            new_mismatches.append((module, method, path))
            continue
        problem = _expired(entry, today)
        if problem:
            print(f"  🔴 {module}: {method} {path} — 등재는 돼 있으나 {problem}")
            new_mismatches.append((module, method, path))
        else:
            print(f"  ⚪ {module}: {method} {path} — 알려짐(until={entry['until']}, {entry['reason']})")

    new_indirect = []
    if unreadable:
        print(f"\nM({len(unreadable)}개) — 이름 명시:")
        for module, func, raw in unreadable:
            key = (module, func)
            # story #3168(2026-08-28, 페드루 PO 판정) — 영구선언 축을 먼저 본다. 구조적으로
            # 항상 간접인 dispatch 패턴(호출부가 사라지면 애초에 이 unreadable 자체가 이번
            # 실행에서 다시 안 잡힌다 — 그게 "기계 재검증"의 정체)엔 until을 요구하지 않는다.
            permanent_entry = declared_permanent_indirect.get(key)
            if permanent_entry is not None:
                problem = _permanent_entry_problem(permanent_entry)
                if problem:
                    print(f"  🔴 {module}.py:{func}() — {raw} — 영구선언은 돼 있으나 {problem}")
                    new_indirect.append((module, func, raw))
                else:
                    print(f"  ⚪ {module}.py:{func}() — {raw} — 영구선언(permanent, {permanent_entry['reason']})")
                continue

            entry = declared_indirect.get(key)
            if entry is None:
                print(f"  🔴 {module}.py:{func}() — {raw} — 허용목록에 없는 신규")
                new_indirect.append((module, func, raw))
                continue
            problem = _expired(entry, today)
            if problem:
                print(f"  🔴 {module}.py:{func}() — {raw} — 등재는 돼 있으나 {problem}")
                new_indirect.append((module, func, raw))
            else:
                print(f"  ⚪ {module}.py:{func}() — {raw} — 수기검증됨(until={entry['until']})")

    if new_mismatches or new_indirect:
        print(f"\n🔴 신규(또는 만료된) 항목 {len(new_mismatches) + len(new_indirect)}건 — "
              f"실제 버그면 고치고, 알고 있는 상태로 계속 두려면 "
              f"infra/mcp-path-contract-allowlist.yml의 declared_mismatches/declared_indirect에 "
              f"reason/declared_by/until과 함께 등재하거나(시한부), 구조적으로 영구 간접이면 "
              f"declared_permanent_indirect에 reason/declared_by만으로(until 불요, story #3168) 등재할 것.")
        ok = False

    print(
        "\n이 가드가 구조적으로 못 잡는 것(자인):\n"
        " 1. 경로가 변수 조립인데 그 값을 이 스크립트가 못 읽는 경우(M으로 이름은 찍되 내용까진 못 봄).\n"
        " 2. 서버 쪽 동적 라우트 등록(add_api_route 등) — 현재 저장소엔 없음(grep 0건) 확인했으나 생기면 못 봄.\n"
        " 3. 경로 문자열은 일치하지만 body shape·쿼리 필수여부·인가 요구사항이 다른 경우 — 별도 계약 테스트 몫.\n"
        " 4. 조건부 include_router(if 분기 안)로 마운트되는 라우터.\n"
        " 5. 배포 상태(그 코드가 실제로 떠 있는지)는 안 본다 — 소스 스냅샷 대조.\n"
        " 6. 허용목록 키는 (module, method, path)다 — 같은 경로를 부르는 도구가 둘 이상이면(현재\n"
        "    실제 사례: notifications 모듈의 mark_notification_read·mark_all_notifications_read가\n"
        "    둘 다 PATCH /api/v2/notifications) 한 항목이 그 «경로 자체»를 대변한다. 하나만 고쳐도\n"
        "    다른 하나가 여전히 그 경로를 쓰면 허용목록 항목이 계속 필요하다 — 도구별 개별 추적이\n"
        "    아니다(2026-07-28 레드테스트 중 실제로 이 경계에 걸려서 알게 됨: 두 도구 중 하나의\n"
        "    허용목록 항목만 지워도 가드가 그린으로 남았다).\n"
    )

    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
