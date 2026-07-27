#!/usr/bin/env python3
"""ⓔ 배포 실효 가드 axis②(story #2174) — "새 리비전이 떴다" ≠ "내가 민 그 커밋이다".

## 왜 만들었나 — 오늘(2026-07-27) prod 승격에서 실제로 이 축이 마지막 관문이었다

`check_serving_reality.py`(축A 고정·축B 정체)는 스스로 이렇게 선언한다:
> "지금 서빙되는 것이 최신 머지인가"는 안 본다. 주기 실행이라 "기대 리비전"을 모른다.

이 스크립트가 그 빈칸을 채운다. 승격 직후, "이 커밋 SHA가 실제로 서빙 중인가"를 **digest
문자열 비교**로 확認한다 — 사람이 오늘 `gcloud` 명령 몇 줄로 손으로 하던 절차 그대로다.

## 왜 두 신호(빌드 conclusion·리비전 존재) 만으로는 부족한가

```
표본(오늘 직접 관측): dev backend 승격 중 새 리비전이 04:57Z 에 떴으나, 그건 두 커밋 중 하나
(#2513)만 반영된 것이었다 — 두 번째 빌드(#2511)는 그 시점에 여전히 WORKING 이었다.
「새 리비전이 존재한다」로 판정을 멈췄으면 **아직 안 실린 커밋을 실렸다고 오판**했을 것이다.
```
⇒ 반드시 **서빙 리비전의 실제 image digest**를 그 커밋 SHA로 태깅된 이미지의 digest와
**문자열로 정확히 대조**해야 한다. 이름이 같은 리비전이 존재하는 것과 그 안의 코드가
기대한 그 코드인 것은 다른 질문이다.

## ⛔ 서비스의 spec 은 여전히 안 쓴다 — 리비전 자신의 spec 은 쓴다(원칙 분리)

`check_serving_reality.py`의 핵심 원칙(서비스 `spec` 은 "다음에 쓸 템플릿"이라 못 믿는다)은
여기서도 유효하다 — **다만 그 원칙이 겨눈 대상은 "서비스"이지 "리비전"이 아니다.**
Cloud Run 리비전은 생성된 순간 불변(immutable)이다 — 한 번 만들어진 리비전의
`spec.containers[0].image`는 그 뒤로 절대 바뀌지 않는다. 그래서 **"지금 실제로 트래픽을
받고 있는 그 리비전"(`status.latestReadyRevisionName`, 즉 서비스 status 에서 얻는다)의
**리비전 자체의** spec 을 읽는 것은 안전하다 — "다음에 쓸 템플릿" 문제가 원리적으로 발생할
수 없다(그 리비전은 이미 확定됐고 다시 안 바뀐다).

## 사용법

로컬/워크플로우 실행:
    python3 infra/check_deploy_digest.py <service> <commit_sha> [--region asia-northeast3]

exit code: 0=digest 일치(그 커밋이 실제로 서빙 중) · 1=불일치 또는 조회 실패(상세 stdout).

## ⛔ 이 가드가 못 잡는 것(check_serving_reality.py와 같은 정직 선언 원칙)
```
1. GCE MIG 는 안 본다 — Cloud Run 서비스만 대상이다. (check_serving_reality.py 동일 선언 참조)
2. **호출자가 "기대 커밋 SHA"를 정확히 알아야 한다** — 이 스크립트 스스로는 "무엇이 최신
   머지인가"를 모른다. 배포 워크플로우가 자신이 방금 민 커밋을 넘겨줘야 의미가 있다.
3. Artifact Registry 에 그 커밋 SHA 태그가 아직 없으면(빌드가 아직 안 끝났으면) "기대 digest
   조회 실패"로 FAIL 한다 — 이건 "불일치"가 아니라 "아직 판정 불가"다. 호출자가 재시도
   간격을 두거나, 빌드 완료를 먼저 기다려야 한다(오늘 실제로 겪은 "두 번째 빌드가 아직
   WORKING" 상황과 동형).
4. 트래픽이 그 리비전에 실제로 100% 가는지는 안 본다 — 그건 축A(check_serving_reality.py)의
   책임이다. 이 스크립트는 순수히 "latestReady 리비전의 코드가 기대한 코드인가"만 묻는다.
   ⇒ 완전한 배포 실효 확認은 **이 스크립트 + check_serving_reality.py 축A 둘 다** 필요하다.
"""
from __future__ import annotations

import json
import subprocess
import sys

_DEFAULT_REGION = "asia-northeast3"


def _run(cmd: list[str]) -> str:
    result = subprocess.run(cmd, capture_output=True, text=True, check=True)
    return result.stdout.strip()


def _serving_revision(service: str, region: str) -> str | None:
    """지금 실제로 준비된(트래픽을 받을 수 있는) 리비전 이름.

    ⛔서비스의 status 에서 얻는다(spec 아님) — check_serving_reality.py 와 동일 원칙."""
    out = _run([
        "gcloud", "run", "services", "describe", service,
        f"--region={region}", "--format=value(status.latestReadyRevisionName)",
    ])
    return out or None


def _revision_image(service: str, revision: str, region: str) -> str:
    """그 **리비전 자신**의 image 필드(digest 포함) — 리비전은 불변이라 이 조회는 안전하다."""
    return _run([
        "gcloud", "run", "revisions", "describe", revision,
        f"--region={region}", "--format=value(spec.containers[0].image)",
    ])


def _digest_of(image_ref: str) -> str | None:
    """`repo@sha256:...` 형태에서 digest 부분만 뽑는다. tag 만 있고 digest 가 없으면 None
    (Cloud Run 서빙 리비전은 항상 digest-pinned 이므로 정상 경로에선 발생하지 않는다 —
    발생하면 그 자체가 이상 신호이므로 별도로 보고한다)."""
    if "@sha256:" not in image_ref:
        return None
    return image_ref.split("@", 1)[1]


def _expected_digest(image_repo: str, commit_sha: str) -> str | None:
    """Artifact Registry 에서 그 커밋 SHA 태그가 붙은 이미지의 digest.

    ⛔CI/배포 워크플로우가 이미지를 푸시할 때 커밋 SHA 를 태그로 붙이는 기존 관례(오늘 실측:
    `e21c7cf5970353e443c388c45639048e081964fe` 같은 40자 SHA 가 실제로 태그로 존재)에 의존한다.
    그 관례가 깨지면(태그가 안 붙으면) None 을 반환하고 호출자가 "판정 불가"로 처리한다.

    ⛔`--filter=tags:<sha>` 서버측 필터로는 안 된다 — 로컬 실측(2026-07-27, 까심): `tags`가
    반복(list) 필드라 `tags:`/`TAGS:`/`tags~` 어느 조합으로도 매치가 안 됨(gcloud 쪽 제약으로
    보인다 — 정확한 원인은 미상). 대신 전체 목록을 JSON 으로 받아 **클라이언트 사이드**에서
    태그 리스트에 그 커밋 SHA 가 포함되는지 직접 대조한다.

    ⛔digest 필드 이름도 함정이다 — `--format=json(tags,digest)`로 뽑으면 `digest` 키가 아예
    안 나온다(로컬 실측). 실제 digest는 최상위 `version` 필드에 `sha256:...` 형태로 들어 있다
    (`digest`는 이 API 응답에 존재하지 않는 필드명이다 — `gcloud run` 계열과 필드명이 다르다).
    ⛔`--limit`도 안 준다 — sort 없이 limit을 걸면 최신이 아니라 임의 순서의 앞부분만 잘려
    나와 원하는 태그가 뒤에 있으면 못 찾는다(로컬 실측: limit=3로는 최근 커밋이 안 잡혔다).
    전체를 받아 클라이언트에서 찾는 쪽이 순서 의존성이 없어 안전하다."""
    out = _run([
        "gcloud", "artifacts", "docker", "images", "list", image_repo,
        "--include-tags", "--format=json",
    ])
    if not out:
        return None
    for entry in json.loads(out):
        if commit_sha in (entry.get("tags") or []):
            return entry.get("version")
    return None


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print(
            "usage: check_deploy_digest.py <service> <commit_sha> "
            f"[--region {_DEFAULT_REGION}]",
            file=sys.stderr,
        )
        return 2

    service, commit_sha = argv[1], argv[2]
    region = _DEFAULT_REGION
    if "--region" in argv:
        region = argv[argv.index("--region") + 1]

    try:
        revision = _serving_revision(service, region)
    except Exception as exc:  # noqa: BLE001
        print(f"⛔ {service}: 서빙 리비전 조회 실패 — {type(exc).__name__}: {exc}")
        return 1
    if not revision:
        print(f"⛔ {service}: latestReadyRevisionName 이 비어 있다 — Ready 상태가 아니다.")
        return 1

    try:
        image_ref = _revision_image(service, revision, region)
    except Exception as exc:  # noqa: BLE001
        print(f"⛔ {service}/{revision}: 리비전 image 조회 실패 — {type(exc).__name__}: {exc}")
        return 1

    serving_digest = _digest_of(image_ref)
    if not serving_digest:
        print(
            f"⛔ {service}/{revision}: image 필드에 digest 가 없다({image_ref!r}) — "
            "정상 서빙 리비전이라면 항상 digest-pinned 여야 한다. 이 자체가 이상 신호다."
        )
        return 1

    image_repo = image_ref.split("@", 1)[0]
    try:
        expected_digest = _expected_digest(image_repo, commit_sha)
    except Exception as exc:  # noqa: BLE001
        print(f"⛔ {commit_sha}: Artifact Registry 조회 실패 — {type(exc).__name__}: {exc}")
        return 1
    if not expected_digest:
        print(
            f"⛔ {commit_sha}: 이 커밋 SHA 태그를 가진 이미지가 {image_repo} 에 아직 없다 — "
            "빌드가 아직 안 끝났을 수 있다(불일치가 아니라 판정 불가). "
            "빌드 완료를 기다린 뒤 재시도할 것."
        )
        return 1

    if serving_digest != expected_digest:
        print(
            f"⛔ {service}: digest 불일치 — 서빙 중인 코드가 기대한 커밋이 아니다.\n"
            f"    서빙 리비전({revision}) digest: {serving_digest}\n"
            f"    기대 커밋({commit_sha[:12]}...) digest: {expected_digest}\n"
            "→ 배포가 아직 반영 전이거나(재시도), 다른 커밋이 실렸다(원인 조사)."
        )
        return 1

    print(
        f"✅ {service}: digest 일치 — {commit_sha[:12]}... 이(가) 실제로 서빙 중이다 "
        f"(리비전 {revision})."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
