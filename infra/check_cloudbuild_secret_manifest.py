#!/usr/bin/env python3
"""story #3140 — PR 게이트 축(gcloud 인증 불요). cloudbuild.yaml/배포 스크립트가 참조하는
시크릿명 전수(cloudbuild_secret_refs.extract_all_secret_refs)가 전부
`infra/cloudbuild-secret-manifest.txt`(manifest — GCP 실물의 정기 스냅샷) 안에 있는지만
목록 diff로 대조한다.

**이 스크립트가 잡는 것**: 참조명 오탈자·존재하지 않는 이름 참조 — manifest에 없으면 즉시 red
(gcloud 호출 0, PR 게이트 무-GCP-인증 전제 유지).
**이 스크립트가 못 잡는 것**(선언, AC3): manifest 자체가 GCP 실물과 어긋나 있으면(새 시크릿을
GCP에서 지웠는데 manifest 갱신을 깜빡함 등) 이 스크립트는 못 본다 — 그건
`sync_cloudbuild_secret_manifest.py`(스케줄 워크플로우, WIF 인증)의 몫. 또한 "이름이 존재하지만
내용이 낡은 시크릿"(값 로테이션 누락 등)은 이름 대조 축 밖이라 어느 쪽도 못 잡는다.

로컬 수동 실행:
    python3 infra/check_cloudbuild_secret_manifest.py

exit code: 0=전부 manifest 안에 있음, 1=manifest에 없는 참조명 발견(상세 stdout).
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cloudbuild_secret_refs import _REPO_ROOT, extract_all_secret_refs  # noqa: E402

_MANIFEST_PATH = _REPO_ROOT / "infra" / "cloudbuild-secret-manifest.txt"


def load_manifest(path: Path = _MANIFEST_PATH) -> set[str]:
    return {
        line.strip()
        for line in path.read_text().splitlines()
        if line.strip() and not line.strip().startswith("#")
    }


def check(manifest: set[str] | None = None) -> tuple[bool, list[str]]:
    """(ok, 상세라인목록) 반환 — 테스트가 gcloud 없이 재사용할 수 있게 exit()/print() 없이
    순수 함수로 분리(main()만 CLI 부작용을 갖는다)."""
    manifest = manifest if manifest is not None else load_manifest()
    refs = extract_all_secret_refs()
    missing = sorted(refs.resolved - manifest)
    lines: list[str] = []
    ok = True
    if missing:
        ok = False
        lines.append(f"cloudbuild가 참조하는데 manifest에 없는 시크릿명 {len(missing)}건:")
        for name in missing:
            lines.append(f"  - {name}")
        lines.append(
            "→ 오탈자면 참조부(cloudbuild.yaml/backend/scripts/*.sh)를 고치고, 신규 시크릿이면 "
            f"GCP에 만든 뒤 {_MANIFEST_PATH.relative_to(_REPO_ROOT)}에 추가하세요."
        )
    if refs.unresolved:
        lines.append(
            f"⚠️ 정적으로 못 푼 시크릿 바인딩 토큰 {len(refs.unresolved)}건(대조 불가, 수동 확인 필요): "
            + ", ".join(sorted(refs.unresolved))
        )
    return ok, lines


def main() -> int:
    ok, lines = check()
    for line in lines:
        print(line)
    if ok:
        print("OK — cloudbuild 참조 시크릿명 전부 manifest 안에 있음.")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
