#!/usr/bin/env python3
"""story #3140 — 스케줄 축(GCP WIF 인증 필요, env-drift-guard.yml 선례 복제). manifest
(`infra/cloudbuild-secret-manifest.txt`)와 GCP Secret Manager 실물을 대조해 **manifest 자체의
부패**를 잡는다. PR 게이트(check_cloudbuild_secret_manifest.py)는 manifest를 신뢰하고 대조하는
쪽이라, manifest가 GCP 실물과 어긋나면 그 게이트도 같이 무력화된다 — 이 스크립트가 그 축을
막는다.

**대칭 두 방향 다 본다**:
- GCP에 있는데 manifest에 없음 = 새 시크릿이 생겼는데 manifest 갱신을 깜빡함(manifest가 낡음,
  당장 위험은 낮음 — PR 게이트가 더 엄격해질 뿐).
- manifest에 있는데 GCP에 없음 = **위험** — 시크릿이 실제로 삭제/이름변경됐는데 manifest는
  그걸 여전히 "존재"로 승인하고 있어 PR 게이트가 그 이름에 대해 거짓 안전(false green)을 낸다.

story #3272(2026-09-01) — 스케줄 워크플로우(cloudbuild-secret-manifest-guard.yml)는 schedule
트리거라 기본적으로 **main**을 checkout한다. dev 전용 시크릿(SUPPORT_GATEWAY_*_dev 3종 등,
story #3140 후속 추가분)은 develop 매니페스트가 정본이고 main엔 승격 시점에야 도착한다 —
그 사이 이 스크립트가 main만 보면 매번 "GCP엔 있는데 manifest에 없음"으로 FAIL을 쏘는
«빨강=배경음» 클래스가 된다(실측: run 33458117504, develop 매니페스트엔 3/3 존재·main엔
0/3). 처방: **main+develop 매니페스트의 합집합**을 GCP 실물과 대조한다 — `check()` 자체의
2방향 판정(위험 축/저위험 축)은 그대로 유지하면서, "아직 승격 전"이라는 정상 상태를 더 이상
드리프트로 오판하지 않는다.

**이 처방이 새로 못 잡게 되는 것**(선언): main엔 아예 없고 develop 매니페스트에만 적힌
이름이 GCP에도 존재하면(예: 실험 브랜치가 등록했지만 결국 main에 승격 안 시킨 시크릿), 이
가드는 이제 그걸 "정상"(승격 대기 중)으로 봐준다 — 실제로는 그냥 만들어두고 잊은 고아
시크릿일 수 있다. main·GCP 어느 쪽에도 없는 이름(진짜 고아)은 여전히 잡는다(develop에도
없으면 union에서 빠지므로 `only_in_gcp`로 그대로 걸린다) — 이 처방이 넓히는 "정상" 범위는
정확히 "develop 매니페스트가 이미 알고 있는 이름"으로 제한된다.

**이 스크립트가 못 잡는 것**(선언, AC3): 이름이 존재하고 manifest·GCP 둘 다 일치해도 그
시크릿의 **내용**(값)이 낡았는지는 안 본다(예: 로테이션 기한이 지난 API 키) — 이름 존재 축과
내용 신선도 축은 별개 문제.

로컬 수동 실행(gcloud 인증 필요):
    python3 infra/sync_cloudbuild_secret_manifest.py

exit code: 0=manifest와 GCP 실물 일치, 1=드리프트 발견(상세 stdout).
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from check_cloudbuild_secret_manifest import _MANIFEST_PATH, load_manifest  # noqa: E402
from cloudbuild_secret_refs import _REPO_ROOT  # noqa: E402

_MANIFEST_RELATIVE_PATH = "infra/cloudbuild-secret-manifest.txt"


def parse_manifest_text(text: str) -> set[str]:
    """load_manifest()와 동일한 파싱 규칙(빈 줄·주석 제외) — git show로 얻은 develop 쪽
    텍스트에 재사용하는 순수 함수(테스트가 git/subprocess 없이 검증)."""
    return {
        line.strip() for line in text.splitlines()
        if line.strip() and not line.strip().startswith("#")
    }


def fetch_develop_manifest_text() -> str | None:
    """origin/develop의 manifest 파일 내용을 로컬 clone 안에서 직접 읽는다(git show — 추가
    GCP 권한 불요, 이미 checkout된 로컬 저장소만 씀). 실패(fetch 안 됨·develop에 파일이
    없음 등)하면 조용히 None — 그 경우 main 단독으로 대조(구 동작으로 안전측 폴백, 회귀는
    아니고 "완화가 적용 안 됨"일 뿐)."""
    try:
        subprocess.run(
            ["git", "fetch", "--depth=1", "origin", "develop"],
            cwd=_REPO_ROOT, capture_output=True, text=True, check=True, timeout=30,
        )
        proc = subprocess.run(
            ["git", "show", f"origin/develop:{_MANIFEST_RELATIVE_PATH}"],
            cwd=_REPO_ROOT, capture_output=True, text=True, check=True, timeout=30,
        )
        return proc.stdout
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError):
        return None


def load_manifest_union() -> set[str]:
    """story #3272 — 현재 checkout(스케줄 워크플로우=main)의 manifest + develop 브랜치의
    manifest 합집합. develop 텍스트를 못 읽으면(위 fetch_develop_manifest_text 참고)
    main 단독으로 폴백한다."""
    manifest = load_manifest()
    develop_text = fetch_develop_manifest_text()
    if develop_text is not None:
        manifest |= parse_manifest_text(develop_text)
    return manifest


def _live_gcp_secret_names() -> set[str]:
    proc = subprocess.run(
        ["gcloud", "secrets", "list", "--format=value(name)"],
        capture_output=True, text=True, check=True, timeout=30,
    )
    return {line.strip() for line in proc.stdout.splitlines() if line.strip()}


def check(manifest: set[str], live: set[str]) -> tuple[bool, list[str]]:
    """순수 함수(테스트가 gcloud 없이 재사용) — main()만 실제 gcloud 호출+CLI 부작용."""
    only_in_manifest = sorted(manifest - live)  # 위험 축 — 삭제됐는데 manifest가 모름.
    only_in_gcp = sorted(live - manifest)  # 저위험 축 — manifest가 새 시크릿을 못 따라감.
    ok = not only_in_manifest and not only_in_gcp
    lines: list[str] = []
    if only_in_manifest:
        lines.append(
            f"⚠️ manifest엔 있는데 GCP에 없음(삭제/이름변경 가능성) {len(only_in_manifest)}건 — "
            "PR 게이트가 이 이름들에 거짓 안전을 낼 수 있음:"
        )
        for name in only_in_manifest:
            lines.append(f"  - {name}")
    if only_in_gcp:
        lines.append(f"GCP엔 있는데 manifest에 없음(신규, manifest 갱신 필요) {len(only_in_gcp)}건:")
        for name in only_in_gcp:
            lines.append(f"  - {name}")
    if not ok:
        lines.append(
            f"→ {_MANIFEST_PATH.relative_to(_REPO_ROOT)}를 `gcloud secrets list --format='value(name)' "
            "| sort`실측으로 갱신하세요."
        )
    return ok, lines


def main() -> int:
    manifest = load_manifest_union()
    live = _live_gcp_secret_names()
    ok, lines = check(manifest, live)
    for line in lines:
        print(line)
    if ok:
        print(f"OK — manifest(main+develop 합집합 {len(manifest)}건)가 GCP 실물과 정확히 일치.")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
