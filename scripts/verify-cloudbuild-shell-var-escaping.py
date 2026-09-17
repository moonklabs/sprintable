#!/usr/bin/env python3
"""story #4012 CHANGES(페드루 PO 지적, 2026-09-17) — cloudbuild.yaml의 bash 스텝
스크립트 안에서 셸 로컬 변수를 `$NAME`/`${NAME}`(단일 `$`)로 적으면 Cloud Build가
자기 자신의 substitution 문법으로 오인해 미정의 치환 오류로 빌드 제출 자체를 거부한다
— 로컬 셸 변수는 반드시 `$$NAME`/`$${NAME}`로 이스케이프해야 한다(develop 기존 관례,
예: cloudbuild.yaml의 `$${BUCKET}`·`$${ENV_VARS}`). 이 PR에서 신설한 deploy-frontend
스텝이 `$ENV_VARS`(단일 `$`) 2곳을 실수로 남겨 dev·prod 배포가 빌드 제출 단계에서
막힐 뻔했다(CI는 cloudbuild.yaml을 실제로 gcloud builds submit하지 않으므로 CI 초록과
무관하게 재발 가능 — 이 가드가 사전 방어선).

이 가드를 처음 돌려서 `deploy-mcp` 스텝의 검산부(`served`/`expected`/`names`, 배포 자체가
아니라 그 뒤 "서빙 이미지가 기대와 같은가" 확인 echo/조건문)에 같은 클래스의 기존
미이스케이프가 3개 더 있는 것을 발견했다(이 PR이 만든 게 아님 — story #2426/#2701
이후 어느 시점에 들어간 것으로 보임). 이 스토리 스코프(1 PR = 이 카드만·인프라는 PO
레인)를 지키기 위해 그 3개는 손대지 않고 `cloudbuild-shell-var-escaping-baseline.txt`에
grandfather로 등재만 한다(PO에게 별도 보고) — 이 가드는 baseline에 없는 **새** 위반만 잡는다
(story #3779류 "줄기만 허용" 관례와 동형).

⚠️이 가드가 «못 잡는» 것:
  ㉠ entrypoint가 bash가 아닌 스텝(순수 `args:` 목록, gcloud가 직접 파싱 — 셸 이스케이프
     개념 자체가 없다)은 스캔 밖.
  ㉡ 스텝 스크립트 밖(파일 헤더 주석 등)의 `$NAME` 언급은 실행되는 코드가 아니라 스캔 밖.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
CLOUDBUILD_PATH = REPO_ROOT / "cloudbuild.yaml"
BASELINE_PATH = REPO_ROOT / "scripts" / "cloudbuild-shell-var-escaping-baseline.txt"

# Cloud Build 내장 치환(공식 전체 목록 중 이 파일이 실제로 쓰는 것만 — 안 쓰는 값까지
# 미리 다 허용하면 "이 레포가 실제로 쓰는 값"이라는 가드의 근거가 흐려진다).
BUILTIN_SUBSTITUTIONS = frozenset({"PROJECT_ID", "COMMIT_SHA"})

# $NAME 또는 ${NAME}(단일 $)만 매치 — 앞에 $가 하나 더 있으면($$NAME/$${NAME}) 이스케이프가
# 된 것이므로 제외(negative lookbehind).
_VAR_RE = re.compile(r"(?<!\$)\$(\{)?([A-Za-z_][A-Za-z0-9_]*)(\})?")


def find_bash_step_scripts(cloudbuild_yaml_text: str) -> list[tuple[str, str]]:
    """(스텝 id, bash 스크립트 원문) 목록 — `entrypoint: bash`인 스텝의 `args: [-c, <script>]`만.
    id 없는 스텝은 index를 문자열로 대신 쓴다(이 파일엔 없지만 방어적으로)."""
    data = yaml.safe_load(cloudbuild_yaml_text)
    scripts: list[tuple[str, str]] = []
    for i, step in enumerate(data.get("steps", [])):
        if step.get("entrypoint") != "bash":
            continue
        args = step.get("args") or []
        if len(args) >= 2 and args[0] == "-c":
            scripts.append((step.get("id") or f"index-{i}", args[1]))
    return scripts


def find_unescaped_shell_vars(script: str) -> list[tuple[int, str]]:
    """(1-indexed 줄 번호, 이름) 목록 — Cloud Build 치환(사용자 `_`접두·내장)이 아닌데
    `$$` 이스케이프 없이 쓰인 식별자."""
    violations: list[tuple[int, str]] = []
    for lineno, line in enumerate(script.split("\n"), start=1):
        for m in _VAR_RE.finditer(line):
            name = m.group(2)
            if name.startswith("_") or name in BUILTIN_SUBSTITUTIONS:
                continue
            violations.append((lineno, name))
    return violations


def baseline_key(step_id: str, name: str) -> str:
    return f"{step_id}::{name}"


def load_baseline(path: Path) -> set[str]:
    if not path.exists():
        return set()
    return {
        line.strip()
        for line in path.read_text().splitlines()
        if line.strip() and not line.strip().startswith("#")
    }


def _self_test() -> int:
    """story #4012 — PO 요구 ②: 이 PR이 실제로 냈던 옛 줄을 합성 입력으로 넣어 이 가드가
    잡는지·정상 이스케이프/Cloud Build 치환은 조용한지를 양성·음성 대조로 pin한다(순수
    함수만 건드림, 실 cloudbuild.yaml 무관 — `--self-test`는 checkout 없이도 돈다)."""
    cases: list[tuple[str, str, bool]] = [
        # (라벨, 스니펫, 위반 기대 여부)
        (
            "이 PR의 옛 버그 그대로(양성 대조) — 단일 $ENV_VARS 재사용",
            'ENV_VARS="$ENV_VARS,DESKTOP_DOWNLOAD_ENABLED=true"',
            True,
        ),
        (
            "고친 형태 — $$ENV_VARS(이스케이프)",
            'ENV_VARS="$${ENV_VARS},DESKTOP_DOWNLOAD_ENABLED=true"',
            False,
        ),
        (
            "Cloud Build 사용자 치환(_ 접두) — 이스케이프 불요",
            'if [ "${_DEPLOY_ENV}" == "dev" ]; then',
            False,
        ),
        (
            "Cloud Build 내장 치환(PROJECT_ID) — 이스케이프 불요",
            'echo "${PROJECT_ID}"',
            False,
        ),
        (
            "$$HOME(이스케이프된 임의 셸 변수) — 조용",
            'echo "$$HOME"',
            False,
        ),
    ]
    failed = 0
    for label, snippet, expect_violation in cases:
        got = bool(find_unescaped_shell_vars(snippet))
        ok = got == expect_violation
        status = "ok" if ok else "FAIL"
        print(f"  {status}  {label} — 위반 기대={expect_violation} 실측={got}")
        if not ok:
            failed += 1
    if failed:
        print(f"\nFAIL self-test: {failed}/{len(cases)} 케이스 불일치.", file=sys.stderr)
        return 1
    print(f"\nOK self-test: {len(cases)}/{len(cases)} 케이스 일치.")
    return 0


def main() -> int:
    if "--self-test" in sys.argv:
        return _self_test()

    text = CLOUDBUILD_PATH.read_text()
    step_scripts = find_bash_step_scripts(text)
    # self-assert — 재료가 비정상적으로 적으면(파싱이 헛돌고 있으면) 조용한 통과 대신 죽는다.
    if len(step_scripts) < 5:
        print(
            f"FAIL: entrypoint:bash 스텝이 {len(step_scripts)}개뿐 — 스캔 재료가 비정상적으로 "
            "적다(YAML 파싱 실패 의심).",
            file=sys.stderr,
        )
        return 1

    baseline = load_baseline(BASELINE_PATH)
    new_violations = 0
    grandfathered = 0
    for step_id, script in step_scripts:
        for lineno, name in find_unescaped_shell_vars(script):
            key = baseline_key(step_id, name)
            if key in baseline:
                grandfathered += 1
                continue
            print(
                f"FAIL: steps[{step_id}] 스크립트 줄 {lineno} — 셸 변수 ${{{name}}}가 "
                f"$$ 이스케이프 없이 쓰임(Cloud Build가 미정의 치환으로 오인해 빌드 제출을 "
                f"거부한다) — $${{{name}}}로 고칠 것."
            )
            new_violations += 1

    if new_violations:
        print(f"\nFAIL: 신규 미이스케이프 셸 변수 {new_violations}건(grandfather {grandfathered}건은 baseline 통과).")
        return 1
    print(
        f"OK: entrypoint:bash 스텝 {len(step_scripts)}개 — 신규 미이스케이프 셸 변수 0건"
        f"(grandfather {grandfathered}건, {BASELINE_PATH.name} 참고)."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
