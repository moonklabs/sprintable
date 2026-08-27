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
    manifest = load_manifest()
    live = _live_gcp_secret_names()
    ok, lines = check(manifest, live)
    for line in lines:
        print(line)
    if ok:
        print(f"OK — manifest({len(manifest)}건)가 GCP 실물과 정확히 일치.")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
