#!/usr/bin/env python3
"""story #4022 — PR 게이트 축(gcloud 인증 불요). `cloudbuild.yaml`의 백엔드 배포 스텝
`SECRETS_FLAG`(~L821-826) dev/prod 두 갈래가 바인딩하는 **ENV 키 이름**(`KEY=VALUE:latest`의
KEY, 시크릿 리소스명이 아니라 컨테이너가 보는 환경변수 이름)의 대칭을 대조한다.

`cloudbuild_secret_refs.py`(story #3140)와는 축이 다르다 — 그쪽은 VALUE(GCP Secret Manager
리소스명)가 manifest에 실재하는지를 본다. 이 모듈은 KEY(ENV 이름) 집합이 dev↔prod 사이에서
한쪽에만 있는지를 본다: dev에만 있는 키는 "prod엔 그 기능 자체가 없다"를 의도한 게 아니라면
보통 배선 누락(이번 카드의 채널 시크릿 2개가 그 사례)이고, 반대도 마찬가지다.

의도된 비대칭은 코드에서 확認된 근거와 함께 아래 예외 목록에 명시로만 허용한다(암묵적 침묵
금지) — 새로 비대칭이 생기면 이 파일에 근거를 추가하지 않는 한 항상 red.

로컬 수동 실행:
    python3 infra/check_secrets_flag_env_symmetry.py

exit code: 0=대칭(예외 제외), 1=예외 없는 비대칭 키 발견(상세 stdout).
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cloudbuild_secret_refs import _CLOUDBUILD_YAML, _REPO_ROOT  # noqa: E402

# dev에만 있고 prod엔 없어도 되는 키 — 근거는 코드에서 직접 확認된 것만 등재.
_DEV_ONLY_EXCEPTIONS: dict[str, str] = {
    "SUPPORT_GATEWAY_TOKEN_SECRET": (
        "지원 게이트웨이 연동 자체가 cloudbuild.yaml ENV_VARS 조립부(L782-818, 예: "
        "SUPPORT_GATEWAY_OPERATOR_REPLY_URL 등)에서 `_DEPLOY_ENV != prod`로 걸려 있어 "
        "prod 백엔드는 이 값을 쓸 코드 경로 자체가 배선 안 됨 — 값 누락이 아니라 기능 자체가 dev 전용."
    ),
}

# prod에만 있고 dev엔 없어도 되는 키 — 근거는 코드에서 직접 확認된 것만 등재.
_PROD_ONLY_EXCEPTIONS: dict[str, str] = {
    "DATABASE_URL_READ": (
        "backend/app/core/config.py:24·database.py:68,139 — 읽기 전용 read replica DSN, "
        "미설정 時 코드가 자체적으로 primary(database_url)로 안전 폴백함(Phase3 §6). dev는 "
        "read replica 인프라 자체가 없어 이 키가 필요 없음(누락이 아니라 설계상 미배선)."
    ),
}

# SECRETS_FLAG 블록 자체를 앵커로 잡는다(cloudbuild.yaml 안의 다른 `_DEPLOY_ENV` 분기와
# 혼동 방지) — story #2445/#3110/#3118 docstring 아카이브가 이 블록의 정본 위치.
_SECRETS_FLAG_BLOCK_RE = re.compile(
    r'SECRETS_FLAG=""\s*\n'
    r'\s*if \[ "\$\{_DEPLOY_ENV\}" == "dev" \]; then\s*\n'
    r'\s*SECRETS_FLAG="--update-secrets=([^"]*)"\s*\n'
    r'\s*elif \[ "\$\{_DEPLOY_ENV\}" == "prod" \]; then\s*\n'
    r'\s*SECRETS_FLAG="--update-secrets=([^"]*)"\s*\n'
    r'\s*fi'
)


def _keys_from_spec(spec: str) -> set[str]:
    """`KEY=NAME:latest,KEY2=NAME2:latest` → {KEY, KEY2}(VALUE 아닌 KEY만)."""
    keys: set[str] = set()
    for entry in spec.split(","):
        if "=" not in entry:
            continue
        key, _, _rest = entry.partition("=")
        key = key.strip()
        if key:
            keys.add(key)
    return keys


def extract_secrets_flag_keys(cloudbuild_text: str | None = None) -> tuple[set[str], set[str]]:
    """(dev_keys, prod_keys) 반환. 블록을 못 찾으면 RuntimeError — 조용히 빈 집합으로
    "대칭"을 자칭하지 않는다(cloudbuild.yaml 구조가 바뀌면 이 가드 자체가 즉시 시끄러워야 함)."""
    text = cloudbuild_text if cloudbuild_text is not None else _CLOUDBUILD_YAML.read_text()
    match = _SECRETS_FLAG_BLOCK_RE.search(text)
    if not match:
        raise RuntimeError(
            "cloudbuild.yaml에서 SECRETS_FLAG dev/prod 분기 블록을 못 찾음 — 구조가 바뀌었으면 "
            "이 가드의 _SECRETS_FLAG_BLOCK_RE를 같이 갱신해야 함."
        )
    dev_spec, prod_spec = match.group(1), match.group(2)
    return _keys_from_spec(dev_spec), _keys_from_spec(prod_spec)


def check(
    dev_keys: set[str] | None = None, prod_keys: set[str] | None = None
) -> tuple[bool, list[str]]:
    """(ok, 상세라인목록) 반환 — 테스트가 실제 cloudbuild.yaml 없이도 재사용 가능하게 순수 함수로
    분리(main()만 CLI 부작용을 갖는다)."""
    if dev_keys is None or prod_keys is None:
        file_dev, file_prod = extract_secrets_flag_keys()
        dev_keys = dev_keys if dev_keys is not None else file_dev
        prod_keys = prod_keys if prod_keys is not None else file_prod

    dev_only = sorted((dev_keys - prod_keys) - _DEV_ONLY_EXCEPTIONS.keys())
    prod_only = sorted((prod_keys - dev_keys) - _PROD_ONLY_EXCEPTIONS.keys())

    lines: list[str] = []
    ok = True
    if dev_only:
        ok = False
        lines.append(f"dev SECRETS_FLAG에만 있고 prod엔 없는 ENV 키 {len(dev_only)}건(예외 미등재):")
        for key in dev_only:
            lines.append(f"  - {key}")
        lines.append(
            "→ prod 배선 누락이면 cloudbuild.yaml SECRETS_FLAG prod 갈래에 추가하고, 의도된 "
            "dev 전용이면 이 파일 _DEV_ONLY_EXCEPTIONS에 코드 근거와 함께 등재하세요."
        )
    if prod_only:
        ok = False
        lines.append(f"prod SECRETS_FLAG에만 있고 dev엔 없는 ENV 키 {len(prod_only)}건(예외 미등재):")
        for key in prod_only:
            lines.append(f"  - {key}")
        lines.append(
            "→ dev 배선 누락이면 cloudbuild.yaml SECRETS_FLAG dev 갈래에 추가하고, 의도된 "
            "prod 전용이면 이 파일 _PROD_ONLY_EXCEPTIONS에 코드 근거와 함께 등재하세요."
        )
    return ok, lines


def main() -> int:
    ok, lines = check()
    for line in lines:
        print(line)
    if ok:
        print("OK — SECRETS_FLAG dev/prod ENV 키 대칭(예외 목록 근거 有 비대칭 제외).")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
