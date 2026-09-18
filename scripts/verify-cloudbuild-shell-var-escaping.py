#!/usr/bin/env python3
"""story #4012 CHANGES(페드루 PO 지적, 2026-09-17) — cloudbuild.yaml의 bash 스텝
스크립트 안에서 셸 로컬 변수를 대문자 `$NAME`/`${NAME}`(단일 `$`)로 적으면 Cloud Build가
자기 자신의 substitution 문법으로 오인해 미정의 치환 오류로 빌드 제출 자체를 거부한다
— 로컬 셸 변수는 반드시 `$$NAME`/`$${NAME}`로 이스케이프해야 한다(develop 기존 관례,
예: cloudbuild.yaml의 `$${BUCKET}`·`$${ENV_VARS}`). 이 PR에서 신설한 deploy-frontend
스텝이 `$ENV_VARS`(단일 `$`) 2곳을 실수로 남겨 dev·prod 배포가 빌드 제출 단계에서
막힐 뻔했다(CI는 cloudbuild.yaml을 실제로 gcloud builds submit하지 않으므로 CI 초록과
무관하게 재발 가능 — 이 가드가 사전 방어선).

CHANGES(2026-09-17, PO 실측 정정) — 첫 버전은 대소문자 구분 없이 모든 `$NAME`을 위반으로
잡아 `deploy-mcp` 검산부의 소문자 `served`/`expected`/`names`를 거짓 양성으로 baseline에
올렸다. PO가 실 dev 배포 빌드 로그(`51e212d0`, 2026-09-16 11:51 SUCCESS, `Step #17 -
"deploy-mcp"`)로 확認: `OK: sprintable-mcp-dev env names = MCP_TRANSPORT;...`처럼 **소문자
셸 변수가 실제 값으로 찍힌다** — Cloud Build 치환 문법은 사용자 치환(`_`+대문자·숫자·
밑줄)·내장 치환(전부 대문자) 형태만 해당하고, 소문자 식별자는 애초에 치환 후보가 아니라
bash로 그대로 통과한다(이스케이프 불요). 이 가드는 그래서 **대문자(숫자·밑줄 포함) 이름만**
스캔한다 — 소문자·혼합 대소문자 식별자는 Cloud Build 문법과 구조적으로 무관해 범위 밖.
baseline 파일은 걷어냈다(정정된 판정으로는 위반 0건이 맞다).

⚠️이 가드가 «못 잡는» 것:
  ㉠ entrypoint가 bash가 아닌 스텝(순수 `args:` 목록, gcloud가 직접 파싱 — 셸 이스케이프
     개념 자체가 없다)은 스캔 밖.
  ㉡ 스텝 스크립트 밖(파일 헤더 주석 등)의 `$NAME` 언급은 실행되는 코드가 아니라 스캔 밖.
  ㉢ 소문자·혼합 대소문자 셸 변수(Cloud Build 치환 문법과 무관 — 위 그라운딩 참고).
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
CLOUDBUILD_PATH = REPO_ROOT / "cloudbuild.yaml"

# Cloud Build 내장 치환(PO 지정 목록, 2026-09-17) — 이 파일이 실제로 쓰는지 여부와 무관하게
# "대문자면 다 위반"으로 잡으면 앞으로 이 목록의 다른 값을 쓰는 스텝이 늘 때마다 거짓 양성이
# 재발하므로, 공식 내장 치환 전체(이 프로젝트가 쓸 수 있는 범위)를 미리 허용한다.
BUILTIN_SUBSTITUTIONS = frozenset({
    "PROJECT_ID", "PROJECT_NUMBER", "BUILD_ID", "LOCATION",
    "COMMIT_SHA", "SHORT_SHA", "REVISION_ID",
    "BRANCH_NAME", "TAG_NAME", "REF_NAME", "REPO_NAME", "REPO_FULL_NAME",
    "TRIGGER_NAME", "SERVICE_ACCOUNT_EMAIL",
})

# $NAME 또는 ${NAME}(단일 $)만 매치 — 앞에 $가 하나 더 있으면($$NAME/$${NAME}) 이스케이프가
# 된 것이므로 제외(negative lookbehind). NAME은 Cloud Build 치환 문법과 같은 모양(대문자·
# 숫자·밑줄)만 — 소문자·혼합 대소문자는 애초에 치환 후보가 아니다(위 CHANGES 그라운딩).
_VAR_RE = re.compile(r"(?<!\$)\$(\{)?([A-Z_][A-Z0-9_]*)(\})?")


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
    """(1-indexed 줄 번호, 이름) 목록 — Cloud Build 치환(사용자 `_`접두·내장)이 아닌 대문자
    식별자가 `$$` 이스케이프 없이 쓰인 자리."""
    violations: list[tuple[int, str]] = []
    for lineno, line in enumerate(script.split("\n"), start=1):
        for m in _VAR_RE.finditer(line):
            name = m.group(2)
            if name.startswith("_") or name in BUILTIN_SUBSTITUTIONS:
                continue
            violations.append((lineno, name))
    return violations


def _self_test() -> int:
    """story #4012 — PO 요구: 이 PR이 실제로 냈던 옛 줄을 합성 입력으로 넣어 이 가드가
    잡는지·정상 이스케이프/Cloud Build 치환/소문자 셸 변수는 조용한지를 양성·음성 대조로
    pin한다(순수 함수만 건드림, 실 cloudbuild.yaml 무관 — `--self-test`는 checkout 없이도 돈다)."""
    cases: list[tuple[str, str, bool]] = [
        # (라벨, 스니펫, 위반 기대 여부)
        (
            "이 PR의 옛 버그 그대로(양성 대조) — 단일 대문자 $ENV_VARS 재사용",
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
        (
            "음성 대조(PO 실측, 2026-09-16 dev 배포 빌드 51e212d0 로그 — "
            "deploy-mcp의 소문자 $names가 실 값으로 찍힘) — 소문자 셸 변수는 "
            "Cloud Build 치환 문법과 무관, 이스케이프 불요",
            'echo "OK: sprintable-mcp-dev env names = $names"',
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

    total = 0
    for step_id, script in step_scripts:
        for lineno, name in find_unescaped_shell_vars(script):
            print(
                f"FAIL: steps[{step_id}] 스크립트 줄 {lineno} — 셸 변수 ${{{name}}}가 "
                f"$$ 이스케이프 없이 쓰임(Cloud Build가 미정의 치환으로 오인해 빌드 제출을 "
                f"거부한다) — $${{{name}}}로 고칠 것."
            )
            total += 1

    if total:
        print(f"\nFAIL: 미이스케이프 셸 변수 {total}건.")
        return 1
    print(f"OK: entrypoint:bash 스텝 {len(step_scripts)}개 — 미이스케이프 셸 변수 0건.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
