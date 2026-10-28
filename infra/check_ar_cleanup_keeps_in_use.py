#!/usr/bin/env python3
"""story 4790(INFRA-DIET ⑤ · AC1) — Artifact Registry 정리 정책의 «지움 0» 점검 — **보조 도구**다(gcloud 불요 · 읽기 전용 JSON만 읽는다).

성격(PO 결정 2026-10-26): 이 스크립트는 «사용 중 이미지 목록을 뽑아 보이고, 기본 정책이 그것을 지우는지» 계산해 주는 보조 도구이지, 덤프가 완전하다는 것을 증명하는 장치가 아니다.
사람이 모은 덤프의 완전함(AR 목록이 잘리지 않았나 · prod · dev 템플릿이 모두 들어왔나)은 코드가 증명할 수 없고, 적용 절차가 막는다: 개수 기대값을 적고 · 템플릿을 모두 넣고 ·
덤프 → 확인 → dry-run → 적용을 한 번에 이어서 한다(그 사이 배포 · 템플릿 변경 · 태그 이동 금지). 출력의 사용 중 목록과 dry-run이 지울 목록을 사람이 대조한다.

정리 정책을 건 뒤에도 **지금 쓰는 이미지는 하나도 안 지워져야** 한다. 이 스크립트는 PO가 모은 JSON으로 «정책이 지울 이미지 집합»을 계산하고
사용 중 이미지와 겹치는지를 본다. 지운 이미지는 복구되지 않으므로 **모르면 실패한다**(초록은 «다 보고 겹침 0»일 때만).

사용 중인 것(이 저장소에서 «지우면 서비스가 못 뜨는» 것):
  · Cloud Run 서비스가 트래픽을 주는 리비전과 최신 준비 · 최신 생성 리비전의 이미지, 서비스 템플릿 이미지(새 인스턴스는 시작 때 이미지를 당겨 온다)
    — 리비전의 `status.imageDigest`(태그로 배포했어도 그 리비전이 실제로 쥔 digest)까지 센다
  · Cloud Run job의 이미지
  · GCE MIG 인스턴스 템플릿이 가리키는 `backend:<커밋 sha>`(VM이 부팅 · 자동 복구될 때 그 태그를 `docker pull`한다 —
    prod MIG는 사람이 직접 배포하므로 커밋이 오래됐을 수 있다. backend/scripts/deploy_realtime_gce.sh IMAGE)

입력(전부 `gcloud … --format=json` 출력. 키 이름을 추측하지 않고 이미지 참조 문자열(태그 · digest · 맨 digest)을 정규식으로 줍는다):
  --images        gcloud artifacts docker images list <repo> --include-tags --format=json        (--limit 금지: 잘린 목록은 거짓 초록을 만든다)
                  **정리 정책을 거는 저장소마다 한 번씩**(여러 번). 사용 중 이미지가 다른 저장소에 있으면 그 저장소의 덤프도 넣는다. 한 파일이 비었거나 같은 이미지가 두 파일에 있으면 입력 오류
  --run-services  gcloud run services list --region=… --format=json                              (필수)
  --run-revisions gcloud run revisions list --region=… --format=json                             (필수)
  --run-jobs      gcloud run jobs list --region=… --format=json                                  (필수)
  --extra         그 밖의 JSON(MIG 인스턴스 템플릿 등, 여러 번). 하나 이상 필수 — 건너뛰는 길은 없다
  --expect-services N · --expect-jobs N   덤프 개수(필수: 서비스 14 · job 17) — 잘린 덤프를 잡는다

산출: `--emit-policy PATH`로 기본 정책(infra/artifact-registry/cleanup-policy.base.json)에 `keep-in-use` Keep 규칙을 채운 정책을 쓴다 —
**통과(exit 0)일 때만** 쓰고, 실패하면 이전 실행이 남긴 같은 이름의 파일을 지운다(실패한 입력으로 만든 정책이 적용되지 않게).
PO는 이 생성본을 dry-run → 적용한다(기본 정책만 적용하면 사용 중이면서 오래된 이미지가 지워질 수 있다).
저장소가 여럿이면 «생성본 하나»를 --images로 넣은 저장소마다 적용한다(`keep-in-use`는 digest 접두 목록이라 다른 저장소에서는 아무것도 안 맞춘다). 최근 30개 규칙은 저장소마다 따로 센다.

exit code: 0=지움 0 · 1=사용 중 이미지가 지워진다 · 2=입력 오류(AR 목록 · 서비스 · 리비전이 비었다 · 필수 덤프 없음 · 개수가 안 맞음) ·
          3=불완전(사용 중 참조를 AR 목록에서 못 찾음 · 서빙 리비전 덤프 누락 · 이미지 참조 없는 서비스/job · --extra가 «전부» 이미지 참조 없음 ·
          태그로 배포된 서빙 리비전에 `status.imageDigest`가 없음) — 안전하게 실패.
참조는 `<host>/<project>/<repo>/<package>`까지 같아야 같은 이미지로 친다(다른 저장소의 같은 이름은 보호하지 않는다). 태그도 digest도 없는 참조는 `:latest`로 본다. `태그@digest` 꼴은 digest로 읽는다(Docker는 digest로 당긴다 — 태그가 그 뒤 옮겨졌어도 그 digest가 사용 중이다).

범위 밖(실패가 아니라 따로 센다): 정리 정책이 «닿을 수 없는» 참조 — **우리 AR 호스트가 아님이 확실한 것뿐**이다. 우리 호스트 = `--images` 덤프가 속한 `<지역>-docker.pkg.dev`.
  · 다른 호스트의 AR 참조(다른 지역) · 알려진 외부 레지스트리(gcr.io · Docker Hub · ghcr.io · quay.io · mcr.microsoft.com · registry.k8s.io · ECR · ACR)
  → 사용 중 목록에 넣지 않고, 출력에 «범위 밖 N건 + 이유 + 어디서 나왔나»로 보인다. 컨테이너 옆에 범위 밖 이미지가 있는 서빙 리비전은 `status.imageDigest`가 누구 것인지 모르므로 불완전(exit 3)이다.
  · **우리 호스트인데 덤프에 없는 저장소 · 이미지는 범위 밖이 아니다** — 여전히 exit 3(그 저장소의 --images를 더한다). 알아보지 못하는 레지스트리 주소도 범위 밖으로 세지 않는다(모르면 실패한다).
  · JSON의 `image` 값이 호스트 없는 Docker 이름(`gotenberg/gotenberg:8.36` · `nginx`)이면 Docker Hub로 읽어 범위 밖에 센다 — Docker의 이름 규칙: 첫 경로 조각에 `.`도 `:`도 없고 `localhost`도 아니면 호스트가 아니다.
    우리 AR은 늘 호스트가 붙으므로 이 이름이 우리 이미지를 가리는 일은 없다. `registry.example.com/x` · `host:5000/x` · `localhost/x`는 호스트가 있는 이름이라 여기 들지 않는다(아래 줄).
  · JSON의 `image` 값이 우리 AR 주소도 알려진 외부 레지스트리도 아니면 exit 3(다른 곳에 외부 주소 한 줄이 있어도 가려지지 않는다). `status.imageDigest`는 맨 digest 또는 우리 AR 꼴일 때만 «쥔 digest»로 받는다.
  · --extra 문자열 속의 «알아보지 못하는 레지스트리 주소»(`<도메인>/<경로>:<태그>`)는 ⚠️ 경고로 «보이기만» 한다 — 범위 밖으로도, 읽은 것으로도 세지 않는다.
이미지 참조가 없는 --extra 하나는 «보이는 경고»(⚠️)이고 통과를 막지 않는다(이미지를 쓰지 않는 템플릿이 있을 수 있다). 다만 --extra가 «전부» 그렇다면 VM이 당기는 이미지를 하나도 못 본 것이라 exit 3이다.

한계: 태그로 배포된 리비전이 컨테이너를 여럿 가지면 짝을 지을 수 없어 항상 exit 3이다(이 저장소의 서비스는 컨테이너 하나).
한계(받아들인 것): 이 도구는 한 사람이 자기 작업 폴더에서 돌리는 보조 도구다 — 경로가 «동시에» 바뀌는 경쟁 상태(검사와 지우기 사이)와, 입력 덤프가 일부러 `keep-in-use`로 시작하는 정책 모양인 경우는 막지 않는다(실수를 막는 장치이지 공격 방어가 아니다).
한계(적용 절차로 막는다): 생성 정책의 `keep-in-use`는 «덤프 시각의» 사용 중 digest 목록이다. 그 뒤에 사용 중 이미지가 «최근 30개 밖의 옛 이미지»로 바뀌면(예: 손으로 배포하는 prod MIG 템플릿을 옛 sha로 되돌림 · 옛 리비전으로 롤백) 새 목록이 없어 지워질 수 있다 —
덤프 → 확인 → dry-run → 적용은 «한 번에 이어서, 그 사이 배포 · MIG 변경 · 태그 이동 금지»로 한다(확인기는 이를 강제하지 못한다 — 절차가 막는다).
그런 일 前에는 이 확인기를 다시 돌려 정책을 다시 만들어 적용한다(정책은 자동으로 따라가지 않는다). 덤프는 «그 시각의» 모습이다. 덤프 → 확인 → dry-run → 적용을 한 번에 이어서 하고(그 사이 배포 금지), GCE가 당기는 `backend:<sha>` 같은 태그가 그 사이에 옮겨지지 않게 한다.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable, NamedTuple

_BASE_POLICY = Path(__file__).resolve().parent / "artifact-registry" / "cleanup-policy.base.json"

# <host>-docker.pkg.dev/<project>/<repo>/<package>[:<tag>][@sha256:<64 hex>] — `태그@digest` 꼴(Docker가 받는다)은 digest가 이긴다: 실제로 당기는 것은 digest다(태그가 그 뒤 옮겨졌어도)
_IMAGE_REF = re.compile(
    r"(?P<host>[a-z0-9-]+-docker\.pkg\.dev)/(?P<project>[a-z0-9-]+)/(?P<repo>[a-z0-9._-]+)/(?P<package>[a-z0-9._-]+(?:/[a-z0-9._-]+)*)"
    r"(?::(?P<tag>[A-Za-z0-9_][A-Za-z0-9_.-]*))?(?:@(?P<digest>sha256:[0-9a-f]{64}))?"
)
# 맨 digest(`status.imageDigest`가 이 꼴로 올 수 있다): 위 전체 참조의 `@sha256:…` 꼬리는 제외한다
_BARE_DIGEST = re.compile(r"(?<![@0-9A-Za-z:/_.-])(sha256:[0-9a-f]{64})")

# «우리 AR이 아님이 확실한» 레지스트리 주소 — 알려진 외부 레지스트리만 센다(목록에 없는 주소는 «모르는 것»이라 범위 밖으로 세지 않는다).
_EXTERNAL_HOSTS = (
    r"(?:[a-z0-9-]+\.)?gcr\.io|(?:index\.|registry-1\.)?docker\.io|ghcr\.io|quay\.io|mcr\.microsoft\.com|registry\.k8s\.io|public\.ecr\.aws"
    r"|[a-z0-9-]+\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com|[a-z0-9-]+\.azurecr\.io"
)
# 앞에 `/ . : @ - 영숫자`가 오면 URL(`https://ghcr.io/…`) · 다른 호스트 이름의 일부다 — 단 JSON 속 줄바꿈(`\n`) 바로 뒤는 새 줄의 시작이다
_EXTERNAL_REF = re.compile(
    r"(?:(?<![A-Za-z0-9._/:@-])|(?<=\\n)|(?<=\\t)|(?<=\\r))(?P<host>" + _EXTERNAL_HOSTS + r")/(?P<path>[a-z0-9._-]+(?:/[a-z0-9._-]+)*)"
    r"(?::(?P<tag>[A-Za-z0-9_][A-Za-z0-9_.-]*))?(?:@(?P<digest>sha256:[0-9a-f]{64}))?"
)


class Version:
    """AR의 이미지 한 판(digest 하나)."""

    def __init__(self, package: str, digest: str, tags: list[str], created: datetime, repo: str | None = None):
        self.repo = repo  # `<host>/<project>/<repo>` — 같은 패키지 · 태그 이름이어도 다른 저장소의 이미지를 지키는 일이 없게
        self.package = package  # 짧은 이름(backend · frontend · support-gateway)
        self.digest = digest
        self.tags = tags
        self.created = created

    def key(self) -> tuple[str, str]:
        return (self.package, self.digest)


Ref = dict[str, "str | None"]
Outside = dict[str, str]  # 범위 밖 참조: image(<host>/…/<package>) · ref(`:tag` · `@digest` · 빈 문자열) · reason · where


def _parse_time(value: Any) -> datetime:
    if isinstance(value, str) and value:
        text = value.replace("Z", "+00:00")
        try:
            dt = datetime.fromisoformat(text)
        except ValueError:
            dt = None
        if dt is not None:
            return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    return datetime.fromtimestamp(0, tz=timezone.utc)


def _short_package(package: str) -> str:
    """`…-docker.pkg.dev/<project>/<repo>/backend` → `backend`(저장소 안 이름)."""
    parts = package.split("/")
    return "/".join(parts[3:]) if len(parts) > 3 and "docker.pkg.dev" in parts[0] else package


def load_versions(data: Any) -> list[Version]:
    """`images list --include-tags --format=json` → Version 목록. tags는 리스트 또는 «,»로 이은 문자열 둘 다 받는다."""
    items = data["items"] if isinstance(data, dict) and "items" in data else data
    if not isinstance(items, list):
        raise ValueError("images JSON must be a list")
    out: list[Version] = []
    for it in items:
        if not isinstance(it, dict):
            continue
        digest = it.get("version") or it.get("digest") or ""
        package = it.get("package") or ""
        if not digest or not package:
            continue
        raw_tags = it.get("tags") or []
        tags = [t for t in (raw_tags.split(",") if isinstance(raw_tags, str) else raw_tags) if t]
        parts = package.split("/")
        repo = "/".join(parts[:3]) if len(parts) > 3 and "docker.pkg.dev" in parts[0] else None
        when = it.get("createTime") or it.get("updateTime")
        if _parse_time(when).timestamp() == 0:
            raise ValueError(f"이미지 {package} {digest}에 읽을 수 있는 createTime/updateTime이 없다")
        out.append(Version(_short_package(package), digest, tags, _parse_time(when), repo))
    return out


def refs_in(text: str) -> list[Ref]:
    """문자열 안의 이미지 참조를 전부 줍는다: 전체 참조(태그 또는 digest)와 맨 digest(package=None — 어느 패키지든 그 digest)."""
    refs: list[Ref] = [
        {"package": _short_package(f"{m['host']}/{m['project']}/{m['repo']}/{m['package']}"), "tag": None if m["digest"] else (m["tag"] or "latest"),
         "digest": m["digest"], "repo": f"{m['host']}/{m['project']}/{m['repo']}", "host": m["host"]}
        for m in _IMAGE_REF.finditer(text)
    ]
    refs += [{"package": None, "tag": None, "digest": m.group(1), "repo": None, "host": None} for m in _BARE_DIGEST.finditer(text)]
    return refs


def external_refs_in(text: str) -> list[Outside]:
    """문자열 안의 «알려진 외부 레지스트리» 이미지 참조(gcr.io · Docker Hub …). 우리 AR이 아님이 확실하니 정리 정책이 닿을 수 없다."""
    return [
        {"image": f"{m['host']}/{m['path']}", "ref": f"@{m['digest']}" if m["digest"] else (f":{m['tag']}" if m["tag"] else ""),
         "reason": f"AR이 아닌 외부 레지스트리({m['host']})"}
        for m in _EXTERNAL_REF.finditer(text)
    ]


def _items(data: Any) -> list[dict]:
    if isinstance(data, dict):
        data = data.get("items", [data])
    return [d for d in data if isinstance(d, dict)] if isinstance(data, list) else []


def _name_of(obj: dict) -> str:
    return str((obj.get("metadata") or {}).get("name") or obj.get("name") or "")


def _serving_revision_names(services: Any) -> set[str]:
    """서비스가 «트래픽을 주는 · 최신 준비 · 최신 생성» 리비전의 이름."""
    names: set[str] = set()
    for svc in _items(services):
        status = svc.get("status") or {}
        for t in status.get("traffic") or []:
            if isinstance(t, dict) and t.get("revisionName"):
                names.add(t["revisionName"])
        for key in ("latestReadyRevisionName", "latestCreatedRevisionName"):
            if status.get(key):
                names.add(status[key])
    return names


_SHA = re.compile(r"sha256:[0-9a-f]{64}")


def _status_digest(rev: dict) -> str | None:
    """리비전이 실제로 쥔 digest — `status.imageDigest` 필드에서만 읽는다(주석 · 환경 변수 속 아무 SHA가 «해결된 digest»인 척하지 못하게).
    값은 맨 digest이거나 우리 AR 꼴(`<host>-docker.pkg.dev/…@sha256:…`)일 때만 받는다 — 알아보지 못하는 레지스트리의 digest를 «우리 컨테이너의 digest»로 읽지 않는다(모르면 «없음»)."""
    status = rev.get("status")
    value = status.get("imageDigest") if isinstance(status, dict) else None
    if not isinstance(value, str):
        return None
    value = value.strip()
    if _SHA.fullmatch(value):
        return value
    m = _IMAGE_REF.fullmatch(value)
    return m["digest"] if m and m["digest"] else None


def _image_values(node: Any) -> Iterable[Any]:
    """JSON 안의 모든 `image` 키의 값(Cloud Run 컨테이너의 `image`). 이 키 이름을 «읽기»에만 쓴다 — 못 알아보는 값을 실패로 올리는 쪽(더 엄격한 쪽)으로만 작동한다.
    값이 문자열이 아니어도(객체 · 목록 · 숫자) 그대로 내준다 — 못 읽는 `image`를 건너뛰지 않는다."""
    if isinstance(node, dict):
        for key, value in node.items():
            if key == "image":
                yield value
            if isinstance(value, (dict, list)):
                yield from _image_values(value)
    elif isinstance(node, list):
        for value in node:
            yield from _image_values(value)


# 호스트가 없는 Docker 이름(`gotenberg/gotenberg:8.36` · `nginx`): Docker의 이름 규칙은 «첫 경로 조각에 `.`도 `:`도 없고 `localhost`도 아니면 호스트가 아니다 → docker.io(Docker Hub)»다.
# `registry.example.com/x` · `host:5000/x` · `localhost/x`는 호스트가 있는 이름이라 여기 들지 않는다(모르는 레지스트리로 남아 실패한다).
# 문법은 distribution/reference(Docker의 이름 문법)를 따른다: 경로 조각 = 소문자·숫자 덩어리를 `.` `_` `__` `-`(연속 가능)로 잇고, 태그는 128자까지. 값 앞뒤 공백은 이름이 아니다(다듬지 않는다).
_HUB_COMPONENT = r"[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*"
_HUB_SHORT = re.compile(
    rf"(?P<path>(?:{_HUB_COMPONENT}/)*{_HUB_COMPONENT})(?::(?P<tag>[A-Za-z0-9_][A-Za-z0-9_.-]{{0,127}}))?(?:@(?P<digest>[A-Za-z][A-Za-z0-9]*(?:[-_+.][A-Za-z][A-Za-z0-9]*)*:[0-9a-fA-F]{{32,}}))?"
)
_HUB_NAME_MAX = 255  # distribution/reference: 저장소 이름(호스트를 뺀 경로) 전체 길이 상한


def _hub_short(value: Any, where: str) -> Outside | None:
    """`image` 값이 호스트 없는 Docker 이름이면 «알려진 외부(Docker Hub)»로 읽은 범위 밖 참조, 아니면 None. 우리 AR은 늘 호스트(`…-docker.pkg.dev`)가 붙으므로 Docker Hub 이름이 우리 이미지를 가리는 일이 없다."""
    if not isinstance(value, str):
        return None
    m = _HUB_SHORT.fullmatch(value)
    if not m:
        return None
    path = m["path"]
    if len(path if "/" in path else f"library/{path}") > _HUB_NAME_MAX:
        return None
    if "/" in path and ("." in path.split("/")[0] or path.split("/")[0] == "localhost"):
        return None
    return {"image": "docker.io/" + (path if "/" in path else f"library/{path}"), "ref": f"@{m['digest']}" if m["digest"] else (f":{m['tag']}" if m["tag"] else ""),
            "reason": "알려진 외부 레지스트리(Docker Hub — 호스트 없는 짧은 이름)", "where": where}


def _scan_blob(blob: Any, where: str, hosts: set[str]) -> tuple[list[Ref], list[Outside]]:
    """`_scan`(문자열 속 참조)에, `image` 키의 «호스트 없는 Docker 이름»을 범위 밖(Docker Hub)으로 더한다."""
    found, out = _scan(json.dumps(blob), where, hosts)
    seen = {(o["image"], o["ref"]) for o in out}
    for value in _image_values(blob):
        short = _hub_short(value, where)
        if short and (short["image"], short["ref"]) not in seen:
            seen.add((short["image"], short["ref"]))
            out.append(short)
    return found, out


def _unknown_images(blob: Any, where: str) -> list[str]:
    """`image` 값 중 우리 AR 주소도 알려진 외부 레지스트리도 아닌 것(문자열이 아닌 값 포함) — 그런 이미지가 «있다»는 사실이 다른 곳의 외부 주소 한 줄에 가려지지 않게 실패로 올린다."""
    problems: dict[str, None] = {}
    for value in _image_values(blob):
        if isinstance(value, str) and (refs_in(value) or external_refs_in(value) or _hub_short(value, where)):
            continue
        shown = value[:80] if isinstance(value, str) else json.dumps(value, ensure_ascii=False)[:80]
        problems[f"{where}의 image 값 {shown!r}을 알아보지 못함(우리 AR 주소도 알려진 외부 레지스트리도 아니다) — 모르면 실패한다"] = None
    return list(problems)


# 어느 레지스트리인지 모르는 주소 꼴(`<도메인>/<경로>:<태그>` · `@sha256:`) — 문자열(시작 스크립트 등) 속에서 «있다»를 보이게만 한다. 우리 AR · 알려진 외부 레지스트리는 따로 센다.
_ANY_REGISTRY_REF = re.compile(
    r"(?:(?<![A-Za-z0-9._/:@-])|(?<=\\n)|(?<=\\t)|(?<=\\r))(?P<host>(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?)/(?P<path>[a-z0-9._-]+(?:/[a-z0-9._-]+)*)"
    r"(?::(?P<tag>[A-Za-z0-9_][A-Za-z0-9_.-]*)|@(?P<digest>sha256:[0-9a-f]{64}))"
)
_KNOWN_HOST = re.compile(r"(?:" + _EXTERNAL_HOSTS + r")")


def _unknown_registry_refs(text: str) -> list[str]:
    """문자열 속의 «알아보지 못하는 레지스트리» 이미지 주소(우리 AR도 알려진 외부 레지스트리도 아닌 것)."""
    found: dict[str, None] = {}
    for m in _ANY_REGISTRY_REF.finditer(text):
        host = m["host"]
        if host.endswith("-docker.pkg.dev") or _KNOWN_HOST.fullmatch(host):
            continue
        found[f"{host}/{m['path']}" + (f":{m['tag']}" if m["tag"] else f"@{m['digest']}")] = None
    return list(found)


def _unresolved_reason(rev: dict, found: list[Ref], outside: Iterable[Outside] = ()) -> str | None:
    """태그로 배포된 이미지가 있을 때 «모르는» 경우의 까닭(없으면 None). `found`는 범위 안 참조만:
    · 이미지 패키지가 둘 이상이거나 태그가 둘 이상(컨테이너 여럿 — 하나뿐인 `status.imageDigest`를 짝지을 수 없다). 같은 패키지 · 태그 이름이어도 **저장소가 다르면** 다른 이미지다
    · 같은 리비전에 범위 밖 이미지가 함께 있다(그 digest가 우리 컨테이너 것인지 옆 컨테이너 것인지 가릴 수 없다)
    · 스펙 쪽에 digest가 있다(digest로 고정된 옆 컨테이너나 주석 속 SHA — 값이 `status.imageDigest`와 같아도 어느 것이 태그의 것인지 가릴 수 없다)
    · `status.imageDigest` 필드가 없다
    · 그 digest와 다른 digest가 같은 리비전에 더 있다(상태 쪽의 다른 digest)"""
    tagged = {(r["repo"], r["package"], r["tag"]) for r in found if r["tag"]}
    if not tagged:
        return None
    packages = {(r["repo"], r["package"]) for r in found if r["package"]}
    if len(tagged) > 1 or len(packages) > 1:
        return "태그로 배포된 이미지가 있는데 컨테이너가 여럿이다(하나뿐인 status.imageDigest를 짝지을 수 없다)"
    if any(True for _ in outside):
        return "태그로 배포된 이미지 옆에 범위 밖 이미지가 있다(status.imageDigest가 누구 것인지 가릴 수 없다)"
    # `status`를 뺀 나머지(스펙 · 주석 …)에 digest가 하나라도 있으면(digest로 고정된 옆 컨테이너 · 무관한 SHA) `status.imageDigest`가 그 digest의 것일 수도 있다 — 값이 같아 보여도 짝을 지을 수 없다
    if any(r["digest"] for r in refs_in(json.dumps({k: v for k, v in rev.items() if k != "status"}))):
        return "태그로 배포된 이미지가 있는데 스펙 쪽(옆 컨테이너 · 주석)에 digest가 있어 status.imageDigest가 누구 것인지 가릴 수 없다"
    resolved = _status_digest(rev)
    if resolved is None:
        return "태그로 배포된 이미지가 있는데 그만큼의 status.imageDigest가 없다(어느 digest를 쥐었는지 모른다)"
    if any(r["digest"] and r["digest"] != resolved for r in found):
        return "태그로 배포된 이미지가 있는데 status 쪽에 다른 digest가 더 있다(어느 것이 태그의 것인지 가릴 수 없다)"
    return None


class Collected(NamedTuple):
    refs: list[Ref]  # 사용 중 이미지 참조(우리 AR 범위 안)
    warnings: list[str]
    problems: list[str]
    outside: list[Outside]  # 범위 밖 참조(정리 정책이 닿을 수 없는 것 — 실패가 아니라 따로 센다)


def _scan(text: str, where: str, hosts: set[str]) -> tuple[list[Ref], list[Outside]]:
    """한 덩어리의 이미지 참조를 «범위 안»(우리 AR 호스트 · 맨 digest)과 «범위 밖»으로 가른다. 범위 밖은 우리 호스트가 아님이 확실한 것뿐 —
    `hosts`가 비어 있으면(저장소 이름을 못 읽은 덤프) AR 참조는 전부 범위 안으로 둔다(모르면 안쪽: 못 찾으면 실패한다)."""
    inside: list[Ref] = []
    outside: dict[tuple[str, str], Outside] = {}
    for ref in refs_in(text):
        if hosts and ref["host"] and ref["host"] not in hosts:
            tail = f":{ref['tag']}" if ref["tag"] and not ref["digest"] else (f"@{ref['digest']}" if ref["digest"] else "")
            image = f"{ref['repo']}/{ref['package']}"
            outside.setdefault((image, tail), {"image": image, "ref": tail, "where": where,
                                               "reason": f"우리 AR 호스트({', '.join(sorted(hosts))})가 아님: {ref['host']}"})
        else:
            inside.append(ref)
    for ext in external_refs_in(text):
        outside.setdefault((ext["image"], ext["ref"]), {**ext, "where": where})
    return inside, list(outside.values())


def collect(
    services: Any = None, revisions: Any = None, jobs: Any = None, extra: Iterable[Any] = (), hosts: Iterable[str] = ()
) -> Collected:
    """사용 중 이미지 참조 · 경고 · 불완전한 까닭들 · 범위 밖 참조. 불완전한 까닭이 하나라도 있으면 «지움 0»을 약속하지 않는다(exit 3).
    서비스 JSON이 있으면 «서빙 중 리비전»만, 없으면 모든 리비전을 사용 중으로 본다(안전한 쪽). `hosts` = 우리 AR 호스트들(`--images` 덤프가 속한 호스트).
    이미지 참조가 «하나도» 없는 서비스 · job은 불완전이다. 범위 밖 참조만 있는 것은 아니다(우리 이미지가 아닐 뿐 읽은 것이다)."""
    host_set = set(hosts)
    refs: list[Ref] = []
    warnings: list[str] = []
    problems: list[str] = []
    outside: list[Outside] = []
    for svc in _items(services) if services is not None else []:
        found, out = _scan_blob(svc, f"서비스 {_name_of(svc) or '?'}", host_set)
        if not found and not out:
            problems.append(f"서비스 {_name_of(svc) or '?'}에서 이미지 참조를 못 찾음")
        problems += _unknown_images(svc, f"서비스 {_name_of(svc) or '?'}")
        refs += found
        outside += out
    if revisions is not None:
        revs = _items(revisions)
        serving = _serving_revision_names(services) if services is not None else set()
        if serving:
            have = {_name_of(r) for r in revs}
            for name in sorted(serving - have):
                problems.append(f"서빙 중 리비전 {name}이 리비전 덤프에 없음(덤프가 잘렸거나 다른 지역)")
            for rev in revs:
                if _name_of(rev) in serving:
                    found, out = _scan_blob(rev, f"서빙 중 리비전 {_name_of(rev) or '?'}", host_set)
                    if not found and not out:
                        problems.append(f"서빙 중 리비전 {_name_of(rev)}에서 이미지 참조를 못 찾음")
                    elif reason := _unresolved_reason(rev, found, out):
                        # 태그로 배포된 이미지마다 실제로 쥔 digest(`status.imageDigest`)를 모르면, 태그가 그 뒤 옮겨졌을 때 옛 이미지를 못 지킨다 — 모르면 실패
                        problems.append(f"서빙 중 리비전 {_name_of(rev)}: {reason}")
                    problems += _unknown_images(rev, f"서빙 중 리비전 {_name_of(rev) or '?'}")
                    refs += found
                    outside += out
        else:
            warnings.append("서비스 JSON에서 서빙 중 리비전을 못 읽어 모든 리비전을 사용 중으로 셌다(안전한 쪽).")
            for rev in revs:
                found, out = _scan_blob(rev, f"리비전 {_name_of(rev) or '?'}", host_set)
                if reason := _unresolved_reason(rev, found, out):
                    problems.append(f"리비전 {_name_of(rev) or '?'}: {reason}(서빙 여부를 몰라 모든 리비전을 센다)")
                problems += _unknown_images(rev, f"리비전 {_name_of(rev) or '?'}")
                refs += found
                outside += out
    for job in _items(jobs) if jobs is not None else []:
        found, out = _scan_blob(job, f"job {_name_of(job) or '?'}", host_set)
        if not found and not out:
            problems.append(f"job {_name_of(job) or '?'}에서 이미지 참조를 못 찾음")
        problems += _unknown_images(job, f"job {_name_of(job) or '?'}")
        refs += found
        outside += out
    extra_blobs = list(extra)
    extra_read = False
    for n, blob in enumerate(extra_blobs, 1):
        text = json.dumps(blob)
        found, out = _scan_blob(blob, f"--extra {n}번째", host_set)
        problems += _unknown_images(blob, f"--extra {n}번째")
        for unknown in _unknown_registry_refs(text):
            # 문자열 속의 모르는 주소는 «보이게만» 한다(범위 밖으로도, 읽은 것으로도 세지 않는다) — 아래 «읽었나» 판정은 우리 주소와 알려진 외부 주소만으로 한다
            warnings.append(f"--extra {n}번째에 알아보지 못하는 레지스트리 주소 {unknown}가 있다 — 우리 AR도 알려진 외부 레지스트리도 아니라 범위 밖으로 세지 않았다(그 주소가 가리키던 이미지가 있으면 사람이 확인한다).")
        if found or out:
            extra_read = True
        else:
            # 이미지를 쓰지 않는 템플릿일 수 있다 — 통과를 막지 않고 «보이게» 경고한다(아래: 전부 그렇다면 막는다)
            warnings.append(f"--extra {n}번째 JSON에는 이미지 참조가 없다(이 파일로 지켜지는 이미지는 0) — 이미지를 쓰지 않는 템플릿이 맞는지 사람이 확인한다.")
        refs += found
        outside += out
    if extra_blobs and not extra_read:
        problems.append("--extra가 전부 이미지 참조 없음 — VM이 부팅 때 당기는 이미지를 하나도 못 읽었다(건너뛴 것과 같다)")
    return Collected(refs, warnings, problems, outside)


def collect_in_use_refs(
    services: Any = None, revisions: Any = None, jobs: Any = None, extra: Iterable[Any] = (), hosts: Iterable[str] = ()
) -> tuple[list[Ref], list[str], list[str]]:
    """`collect`의 앞 셋(사용 중 참조 · 경고 · 불완전한 까닭들)."""
    c = collect(services, revisions, jobs, extra, hosts)
    return c.refs, c.warnings, c.problems


def resolve_in_use(refs: list[Ref], versions: list[Version]) -> tuple[set[tuple[str, str]], list[Ref]]:
    """참조(태그 · digest · 맨 digest) → AR의 (package, digest). 못 찾은 참조는 따로 돌려준다.
    태그는 «지금» AR의 태그 대응으로만 풀린다 — 옮겨진 태그의 옛 digest는 리비전의 `status.imageDigest`(맨 digest)가 막아 준다."""
    by_digest = {(v.repo, *v.key()): v for v in versions}
    by_digest_any: dict[str, list[Version]] = {}
    by_tag: dict[tuple[str | None, str, str], list[Version]] = {}
    for v in versions:
        by_digest_any.setdefault(v.digest, []).append(v)
        for tag in v.tags:
            by_tag.setdefault((v.repo, v.package, tag), []).append(v)
    found: set[tuple[str, str]] = set()
    missing: list[Ref] = []
    for ref in refs:
        pkg = ref["package"]
        if ref["digest"] and pkg is None:  # 맨 digest: 패키지를 모른다 — 그 digest를 가진 모든 판
            hit = by_digest_any.get(ref["digest"])
            if hit:
                found.update(v.key() for v in hit)
            else:
                missing.append(ref)
        elif ref["digest"]:
            key = (ref.get("repo"), pkg or "", ref["digest"])
            if key in by_digest:
                found.add(key[1:])
            else:
                missing.append(ref)
        elif ref["tag"]:
            hit = by_tag.get((ref.get("repo"), pkg or "", ref["tag"]))
            if hit:
                found.update(v.key() for v in hit)
            else:
                missing.append(ref)
    return found, missing


# Artifact Registry는 `versionNamePrefixes`의 한 항이 64자를 넘으면 정책을 거절한다("invalid prefix longer than 64 characters"). digest 전체(`sha256:` + 64자 = 71자)는 못 쓴다 —
# 앞 64자(`sha256:` + 16진 57자 = 228비트)로 자른다. 자른 접두가 «사용 중인 그 하나»에만 맞는지는 `prefix_ambiguities`가 목록에서 확인한다(2026-10-26 PO 실측: 실제 API가 거절).
_PREFIX_MAX = 64


def keep_prefix(digest: str) -> str:
    return digest[:_PREFIX_MAX]


def build_policy(base: list[dict], in_use: set[tuple[str, str]]) -> list[dict]:
    """기본 정책 앞에 `keep-in-use`(Keep) 규칙을 채워 넣는다. 사용 중 digest의 앞 `_PREFIX_MAX`자를 `versionNamePrefixes`로(AR의 상한)."""
    prefixes = sorted({keep_prefix(d) for _pkg, d in in_use})
    policy = [p for p in base if p.get("name") != "keep-in-use"]
    if prefixes:
        policy.insert(0, {"name": "keep-in-use", "action": {"type": "Keep"}, "condition": {"versionNamePrefixes": prefixes}})
    return policy


def prefix_ambiguities(in_use: set[tuple[str, str]], versions: list[Version]) -> list[str]:
    """자른 접두가 «사용 중인 그 버전» 말고 다른 버전에도 맞으면 그 목록. 정책은 더 많이 «남기는» 쪽(안전)이지만 접두가 digest 하나를 가리킨다는 가정이 깨진 것이라 사람이 보도록 멈춘다."""
    out: list[str] = []
    for _pkg, digest in sorted(in_use):
        prefix = keep_prefix(digest)
        extra = sorted(v.key() for v in versions if v.digest.startswith(prefix) and v.key() not in in_use)
        if extra:
            out.append(f"keep-in-use 접두 {prefix}가 사용 중이 아닌 버전 {len(extra)}개에도 맞는다: " + ", ".join(f"{pkg} {d}" for pkg, d in extra[:3]))
    return out


def policy_problems(policy: list[dict]) -> list[str]:
    """AR이 거절하는 모양(64자를 넘는 `versionNamePrefixes` 항)이 정책에 남아 있으면 그 목록."""
    return [
        f"규칙 {rule.get('name', '?')}의 versionNamePrefixes에 {len(pre)}자짜리 항이 있다(AR 상한 {_PREFIX_MAX}자)"
        for rule in policy
        for pre in (rule.get("condition") or {}).get("versionNamePrefixes", [])
        if len(pre) > _PREFIX_MAX
    ]


_DURATION = re.compile(r"^(\d+)(s|m|h|d)?$")


def _duration(text: str) -> timedelta:
    m = _DURATION.match(str(text).strip())
    if not m:
        raise ValueError(f"unsupported duration: {text!r}")
    n, unit = int(m.group(1)), m.group(2) or "s"
    return timedelta(seconds=n * {"s": 1, "m": 60, "h": 3600, "d": 86400}[unit])


def _matches(cond: dict, v: Version, now: datetime) -> bool:
    state = (cond.get("tagState") or "any").lower()
    if state == "tagged" and not v.tags:
        return False
    if state == "untagged" and v.tags:
        return False
    prefixes = cond.get("tagPrefixes")
    if prefixes and not any(t.startswith(p) for t in v.tags for p in prefixes):
        return False
    vprefixes = cond.get("versionNamePrefixes")
    if vprefixes and not any(v.digest.startswith(p) for p in vprefixes):
        return False
    pprefixes = cond.get("packageNamePrefixes")
    if pprefixes and not any(v.package.startswith(p) for p in pprefixes):
        return False
    if cond.get("olderThan") and not (now - v.created) > _duration(cond["olderThan"]):
        return False
    if cond.get("newerThan") and not (now - v.created) < _duration(cond["newerThan"]):
        return False
    return True


def simulate(policy: list[dict], versions: list[Version], now: datetime) -> set[tuple[str, str]]:
    """정책이 지울 (package, digest) 집합 — **저장소마다 따로** 모의한다(AR 정리 정책은 저장소 단위: «최근 30개»도 저장소 안에서 센다)."""
    by_repo: dict[str | None, list[Version]] = {}
    for v in versions:
        by_repo.setdefault(v.repo, []).append(v)
    deleted: set[tuple[str, str]] = set()
    for group in by_repo.values():
        deleted |= _simulate_repo(policy, group, now)
    return deleted


def _simulate_repo(policy: list[dict], versions: list[Version], now: datetime) -> set[tuple[str, str]]:
    """저장소 하나의 모의. Keep이 Delete를 이긴다(AR 정리 정책의 규칙), 어느 쪽에도 안 걸리면 남는다."""
    keep: set[tuple[str, str]] = set()
    delete: set[tuple[str, str]] = set()
    for rule in policy:
        action = (rule.get("action") or {}).get("type", "").lower()
        if "mostRecentVersions" in rule:
            spec = rule["mostRecentVersions"]
            names = spec.get("packageNamePrefixes")
            pool = [v for v in versions if not names or any(v.package.startswith(p) for p in names)]
            matched: list[Version] = []
            for pkg in {v.package for v in pool}:
                newest = sorted((v for v in pool if v.package == pkg), key=lambda v: v.created, reverse=True)
                matched += newest[: int(spec.get("keepCount", 0))]
        else:
            matched = [v for v in versions if _matches(rule.get("condition") or {}, v, now)]
        (keep if action == "keep" else delete).update(v.key() for v in matched)
    return delete - keep


def check(
    versions: list[Version], in_use: set[tuple[str, str]], policy: list[dict], now: datetime
) -> tuple[set[tuple[str, str]], set[tuple[str, str]]]:
    """(지워지는 집합, 그중 사용 중인 것)."""
    would_delete = simulate(policy, versions, now)
    return would_delete, would_delete & in_use


def _load(path: str | None) -> Any:
    if not path:
        return None
    return json.loads(Path(path).read_text())


_INPUT_FLAGS = ("--images", "--run-services", "--run-revisions", "--run-jobs", "--extra", "--base-policy")


def _same_file(a: str, b: str) -> bool:
    """같은 파일인가 — 둘 다 있으면 inode로(하드 링크 · 심볼릭 링크까지), 아니면 경로로. **모르면 «같다»**(지우지 않고 거부하는 쪽이 안전하다)."""
    try:
        if Path(a).exists() and Path(b).exists():
            return os.path.samefile(a, b)
        return Path(a).resolve() == Path(b).resolve()
    except OSError:
        return True


def _raw_values(raw: list[str], flags: tuple[str, ...]) -> list[str]:
    """인자를 파싱하기 前에, 주어진 플래그들의 값을 글자 그대로 줍는다(`--flag V` · `--flag=V`)."""
    out: list[str] = []
    for i, a in enumerate(raw):
        for f in flags:
            if a == f and i + 1 < len(raw):
                out.append(raw[i + 1])
            elif a.startswith(f + "="):
                out.append(a.split("=", 1)[1])
    return out


def _is_generated_policy(path: Path) -> bool:
    """이 도구가 만든 정책 파일인가: 심볼릭 링크 · 디렉터리가 아닌 «일반 파일»이고, JSON 목록의 첫 규칙 이름이 `keep-in-use`(`build_policy`가 늘 맨 앞에 넣는 규칙)이다.
    입력 덤프 · 기본 정책(`keep-in-use`를 가지면 그 자체가 입력 오류) · 다른 사람의 파일은 이 모양이 아니다."""
    try:
        if path.is_symlink() or not path.is_file():
            return False
        rules = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    return isinstance(rules, list) and bool(rules) and isinstance(rules[0], dict) and rules[0].get("name") == "keep-in-use"


def _drop_stale(path: str | None, protect: Iterable[str] = ()) -> bool:
    """실패한 실행이 이전 성공의 정책 파일을 «현재 입력의 통과본»인 척 남기지 않게 한다. **이 도구가 만든 정책 파일만** 지운다(`_is_generated_policy`) — 입력 파일 · 디렉터리 · 심볼릭 링크 · 낯선 파일은
    어떤 경로 철자로 불려도 건드리지 않는다. `protect`(입력 경로 철자들)는 한 겹 더 두는 안전장치다. 지웠거나 원래 없으면 True."""
    if not path or any(_same_file(path, q) for q in protect):
        return False
    target = Path(path)
    if not (target.exists() or target.is_symlink()):
        return True
    if not _is_generated_policy(target):
        return False
    try:
        target.unlink()
    except OSError:
        return False
    return True


def _write_policy(path: Path, text: str) -> None:
    """같은 폴더에 **배타적으로 만든** 임시 파일(`mkstemp`: O_EXCL · 무작위 이름)에 쓰고 `os.replace`로 바꾼다 — 쓰다 실패해도 잘린 파일이 최종 경로에 남지 않고, 이미 있던 목표 파일은 그대로다.
    실패하면 임시 파일을 치우고 OSError를 그대로 올린다."""
    fd, tmp_name = tempfile.mkstemp(dir=path.parent, prefix=f"{path.name}.", suffix=".tmp")
    tmp = Path(tmp_name)
    try:
        os.close(fd)
        tmp.write_text(text, encoding="utf-8")
        os.replace(tmp, path)
    except (OSError, UnicodeError):
        try:
            tmp.unlink()
        except OSError:
            pass
        raise


def _duplicate_images(versions: list[Version]) -> list[str]:
    """같은 (저장소, 패키지, digest)가 두 번 나오면 그 목록 — 같은 저장소 덤프를 두 번 넣었거나 한 파일이 겹친 것이다(개수가 부풀어 «다 봤다»가 틀려 보인다).
    저장소 이름을 못 읽은 덤프(`repo` 없음)는 가를 수 없어 보지 않는다."""
    seen: set[tuple[str, str, str]] = set()
    dupes: list[str] = []
    for v in versions:
        if not v.repo:
            continue
        key = (v.repo, v.package, v.digest)
        if key in seen:
            dupes.append(f"{v.repo}/{v.package} {v.digest}")
        seen.add(key)
    return dupes


def _outside_lines(outside: list[Outside]) -> list[str]:
    """범위 밖 참조를 «이미지 · 이유 · 어디서 나왔나»로 한 번씩만(같은 이미지가 리비전 · 서비스에 겹쳐 나와도 한 줄)."""
    grouped: dict[tuple[str, str, str], list[str]] = {}
    for o in outside:
        wheres = grouped.setdefault((o["image"], o["ref"], o["reason"]), [])
        if o["where"] not in wheres:
            wheres.append(o["where"])
    if not grouped:
        return []
    lines = [f"범위 밖 {len(grouped)}건 — 정리 정책이 닿을 수 없는 참조라 사용 중 목록에 넣지 않았다(우리 AR 호스트가 아님이 확실한 것뿐):"]
    for (image, ref, reason), wheres in sorted(grouped.items()):
        lines.append(f"  - {image}{ref} — {reason} · {', '.join(wheres)}")
    return lines


def _missing_hint(ref: Ref, repos: list[str]) -> str:
    """못 찾은 참조의 저장소가 덤프에 아예 없으면 어떻게 하면 되는지 — 범위 밖으로 세지는 않는다(우리 호스트의 저장소다)."""
    repo = ref.get("repo")
    if repo and repo not in repos:
        return f" — 그 저장소({repo})의 덤프가 --images에 없다. 정리 정책을 거는 저장소면 그 저장소의 --images를 더한다"
    return ""


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0], allow_abbrev=False)  # 약어(`--emit` 등)를 끈다: 사전 스캔이 못 보는 이름으로 낡은 정책 파일 삭제를 건너뛰는 길이 없게
    ap.add_argument("--images", action="append", required=True, help="AR 이미지 목록(정리 정책을 거는 저장소마다 한 번씩)")
    ap.add_argument("--run-services", required=True)
    ap.add_argument("--run-revisions", required=True)
    ap.add_argument("--run-jobs", required=True)
    ap.add_argument("--extra", action="append", default=[], help="MIG 인스턴스 템플릿 등(하나 이상 필수 — 건너뛰는 길은 없다)")
    ap.add_argument("--expect-services", type=int, required=True, help="서비스 개수(잘린 덤프를 잡는다)")
    ap.add_argument("--expect-jobs", type=int, required=True, help="job 개수(잘린 덤프를 잡는다)")
    ap.add_argument("--base-policy", default=str(_BASE_POLICY))
    ap.add_argument("--emit-policy")
    ap.add_argument("--now")
    raw = argv if argv is not None else sys.argv[1:]
    protect = [*_raw_values(raw, _INPUT_FLAGS), str(_BASE_POLICY)]
    for emit in _raw_values(raw, ("--emit-policy",))[-1:]:  # 인자 오류로 끝나도 이전 실행이 남긴 정책 파일은 지운다(argparse가 쓰는 «마지막» 하나만 · 입력 파일이면 지우지 않는다)
        _drop_stale(emit, protect)
    args = ap.parse_args(argv)
    if args.emit_policy:
        clash = [q for q in (*args.images, args.run_services, args.run_revisions, args.run_jobs, args.base_policy, *args.extra) if _same_file(args.emit_policy, q)]
        if clash:
            print(f"입력 오류: --emit-policy가 입력 파일과 같은 경로다({clash[0]}) — 입력을 덮어쓰지도 지우지도 않는다. 다른 경로를 준다.")
            return 2
        if Path(args.emit_policy).is_dir():
            print(f"입력 오류: --emit-policy가 디렉터리다({args.emit_policy}) — 파일 경로를 준다.")
            return 2
    if not args.extra:
        print("입력 오류: --extra(MIG 인스턴스 템플릿 JSON)가 하나도 없다. VM이 부팅 때 당기는 이미지를 못 본다 — 건너뛸 수 없다.")
        return 2
    versions: list[Version] = []
    try:
        for path in args.images:
            one = load_versions(_load(path))
            if not one:
                print(f"입력 오류: AR 이미지 목록이 비었다({path}) — 비어 있는 저장소의 덤프를 넣지 않는다.")
                return 2
            versions += one
        base = json.loads(Path(args.base_policy).read_text())
        extra = [json.loads(Path(p).read_text()) for p in args.extra]
        services, revisions, jobs = _load(args.run_services), _load(args.run_revisions), _load(args.run_jobs)
    except (OSError, ValueError, KeyError) as err:
        print(f"입력 오류: {err}")
        return 2
    if not versions:
        print("입력 오류: AR 이미지 목록이 비었다.")
        return 2
    dupes = _duplicate_images(versions)
    if dupes:
        print(f"입력 오류: 같은 이미지가 --images 덤프에 두 번 이상 있다(같은 저장소를 두 번 넣었다) — {dupes[0]} 등 {len(dupes)}개.")
        return 2
    if any(r.get("name") == "keep-in-use" for r in base):
        print("입력 오류: 기본 정책에 이미 keep-in-use 규칙이 있다(생성본이 덮어쓰면 보호가 사라질 수 있다) — 기본 정책에는 두지 않는다.")
        return 2
    for label, data, expect in (("서비스", services, args.expect_services), ("job", jobs, args.expect_jobs)):
        if expect is not None and len(_items(data)) != expect:
            print(f"입력 오류: {label} 덤프가 {len(_items(data))}개인데 {expect}개여야 한다(덤프가 잘렸다).")
            return 2
    if not _items(services) or not _items(revisions) or not _items(jobs):
        print("입력 오류: 서비스 · 리비전 · job 덤프 중 비어 있는 것이 있다(사용 중 이미지를 다 알 수 없다).")
        return 2
    repos = sorted({v.repo for v in versions if v.repo})
    hosts = {r.split("/")[0] for r in repos}
    refs, warnings, problems, outside = collect(services, revisions, jobs, extra, hosts)
    if not refs:
        # 사용 중 참조가 하나도 안 잡히면 «지움 0»은 빈 입력 위의 거짓 초록이다(서비스 JSON이 비었거나 형식이 다름) — 절대 통과시키지 않는다.
        print(f"입력 오류: 사용 중 이미지 참조가 하나도 안 잡혔다(서비스 · 리비전 · job · 템플릿 JSON이 비었거나 형식이 다르다 · 범위 밖으로 센 참조 {len(outside)}건).")
        return 2
    now = _parse_time(args.now) if args.now else datetime.now(timezone.utc)
    in_use, missing = resolve_in_use(refs, versions)
    policy = build_policy(base, in_use)
    bad_policy = policy_problems(policy)
    if bad_policy:
        print("입력 오류: 생성 정책이 AR이 거절하는 모양이다 — " + "; ".join(bad_policy))
        return 2
    problems = [*problems, *prefix_ambiguities(in_use, versions)]
    would_delete, hit = check(versions, in_use, policy, now)
    base_delete, base_hit = check(versions, in_use, base, now)
    for w in warnings:
        print(f"⚠️ {w}")
    print(f"AR 이미지 {len(versions)}개(저장소 {len(repos)}곳{': ' + ', '.join(r.split('/', 1)[1] for r in repos) if repos else ''}) · 사용 중 참조 {len(refs)}건 → 사용 중 digest {len(in_use)}개")
    print(f"기본 정책만: 지움 {len(base_delete)}개 중 사용 중 {len(base_hit)}개  ← 0이 아니면 생성본의 keep-in-use가 필요한 까닭")
    print(f"생성 정책:   지움 {len(would_delete)}개 중 사용 중 {len(hit)}개")
    for line in _outside_lines(outside):
        print(line)
    if hit:
        print("PROBLEM — 지워지는 사용 중 이미지:")
        for pkg, digest in sorted(hit):
            print(f"  - {pkg} {digest}")
        return 1
    if missing or problems:
        print("불완전 — «지움 0»을 약속할 수 없다(정책 파일도 쓰지 않았다):")
        for ref in missing:
            print(f"  - 사용 중 참조를 AR 목록에서 못 찾음: {ref['package'] or '?'} {ref['tag'] or ref['digest']}{_missing_hint(ref, repos)}")
        for why in problems:
            print(f"  - {why}")
        return 3
    if args.emit_policy:
        try:
            _write_policy(Path(args.emit_policy), json.dumps(policy, indent=2, ensure_ascii=False) + "\n")
        except (OSError, UnicodeError) as err:
            # exit 1은 «쓰는 이미지가 지워진다»의 코드다 — 쓰기 실패는 다른 이야기라 입력 오류(2)로 돌려주고, 잘린 파일이 남지 않게 한다
            _drop_stale(args.emit_policy, protect)
            print(f"쓰기 오류: 정책 파일을 쓰지 못했다({err.__class__.__name__}: {err}) — 파일을 남기지 않았다.")
            return 2
        print(f"생성 정책을 썼다: {args.emit_policy}")
    note = f" (경고 {len(warnings)}건 — 위 ⚠️ 줄을 읽는다)" if warnings else ""
    print(f"OK — 생성 정책이 지우는 이미지 중 사용 중인 것은 0.{note}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
