#!/usr/bin/env python3
"""story 4790(INFRA-DIET ⑤ · AC1) — Artifact Registry 정리 정책의 «지움 0» 시험(gcloud 불요 · 읽기 전용 JSON만 읽는다).

정리 정책을 건 뒤에도 **지금 쓰는 이미지는 하나도 안 지워져야** 한다. 이 스크립트는 PO가 모은 JSON으로 «정책이 지울 이미지 집합»을 계산하고
사용 중 이미지와 겹치는지를 본다. 겹치면 exit 1.

사용 중인 것(이 저장소에서 «지우면 서비스가 못 뜨는» 것):
  · Cloud Run 서비스가 트래픽을 주는 리비전과 최신 준비 · 최신 생성 리비전의 이미지, 서비스 템플릿 이미지(새 인스턴스는 시작 때 이미지를 당겨 온다)
  · Cloud Run job의 이미지
  · GCE MIG 인스턴스 템플릿이 가리키는 `backend:<커밋 sha>`(VM이 부팅 · 자동 복구될 때 그 태그를 `docker pull`한다 —
    prod MIG는 사람이 직접 배포하므로 커밋이 오래됐을 수 있다. backend/scripts/deploy_realtime_gce.sh IMAGE)

입력(전부 `gcloud … --format=json` 출력. 키 이름을 추측하지 않고 이미지 참조 문자열을 정규식으로 줍는다):
  --images        gcloud artifacts docker images list <repo> --include-tags --format=json
  --run-services  gcloud run services list --region=… --format=json
  --run-revisions gcloud run revisions list --region=… --format=json
  --run-jobs      gcloud run jobs list --region=… --format=json
  --extra         그 밖의 JSON(MIG 인스턴스 템플릿 등, 여러 번)

산출: `--emit-policy PATH`로 기본 정책(infra/artifact-registry/cleanup-policy.base.json)에 `keep-in-use` Keep 규칙을 채운 정책을 쓴다.
PO는 **이 생성본**을 dry-run → 적용한다(기본 정책만 적용하면 사용 중이면서 오래된 이미지가 지워질 수 있다).

exit code: 0=지움 0, 1=사용 중 이미지가 지워진다, 2=입력 오류, 3=사용 중 참조를 AR 목록에서 못 찾음(목록이 잘렸거나 다른 저장소 — 안전하게 실패).
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

_BASE_POLICY = Path(__file__).resolve().parent / "artifact-registry" / "cleanup-policy.base.json"

# <host>-docker.pkg.dev/<project>/<repo>/<package>[:<tag> | @sha256:<64 hex>]
_IMAGE_REF = re.compile(
    r"(?P<host>[a-z0-9-]+-docker\.pkg\.dev)/(?P<project>[a-z0-9-]+)/(?P<repo>[a-z0-9._-]+)/(?P<package>[a-z0-9._-]+(?:/[a-z0-9._-]+)*?)"
    r"(?::(?P<tag>[A-Za-z0-9_][A-Za-z0-9_.-]*)|@(?P<digest>sha256:[0-9a-f]{64}))"
)


class Version:
    """AR의 이미지 한 판(digest 하나)."""

    def __init__(self, package: str, digest: str, tags: list[str], created: datetime):
        self.package = package  # 짧은 이름(backend · frontend · support-gateway)
        self.digest = digest
        self.tags = tags
        self.created = created

    def key(self) -> tuple[str, str]:
        return (self.package, self.digest)


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
        out.append(Version(_short_package(package), digest, tags, _parse_time(it.get("createTime") or it.get("updateTime"))))
    return out


def refs_in(text: str) -> list[dict[str, str | None]]:
    """문자열 안의 AR 이미지 참조를 전부 줍는다(태그 또는 digest)."""
    return [
        {"package": _short_package(f"{m['host']}/{m['project']}/{m['repo']}/{m['package']}"), "tag": m["tag"], "digest": m["digest"]}
        for m in _IMAGE_REF.finditer(text)
    ]


def _walk(obj: Any) -> Iterable[Any]:
    yield obj
    if isinstance(obj, dict):
        for v in obj.values():
            yield from _walk(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _walk(v)


def _items(data: Any) -> list[dict]:
    if isinstance(data, dict):
        data = data.get("items", [data])
    return [d for d in data if isinstance(d, dict)] if isinstance(data, list) else []


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


def collect_in_use_refs(
    services: Any = None, revisions: Any = None, jobs: Any = None, extra: Iterable[Any] = ()
) -> tuple[list[dict[str, str | None]], list[str]]:
    """(사용 중 이미지 참조 목록, 경고). 서비스 JSON이 있으면 «서빙 중 리비전»만, 없으면 모든 리비전을 사용 중으로 본다(안전한 쪽)."""
    refs: list[dict[str, str | None]] = []
    warnings: list[str] = []
    if services is not None:
        refs += refs_in(json.dumps(services))  # 서비스 템플릿 이미지
    if revisions is not None:
        serving = _serving_revision_names(services) if services is not None else set()
        if serving:
            for rev in _items(revisions):
                if (rev.get("metadata") or {}).get("name") in serving:
                    refs += refs_in(json.dumps(rev))
        else:
            warnings.append("서비스 JSON에서 서빙 중 리비전을 못 읽어 모든 리비전을 사용 중으로 셌다(안전한 쪽).")
            refs += refs_in(json.dumps(revisions))
    if jobs is not None:
        refs += refs_in(json.dumps(jobs))
    for blob in extra:
        refs += refs_in(json.dumps(blob))
    return refs, warnings


def resolve_in_use(refs: list[dict[str, str | None]], versions: list[Version]) -> tuple[set[tuple[str, str]], list[dict[str, str | None]]]:
    """참조(태그 · digest) → AR의 (package, digest). 못 찾은 참조는 따로 돌려준다."""
    by_digest = {v.key(): v for v in versions}
    by_tag: dict[tuple[str, str], list[Version]] = {}
    for v in versions:
        for tag in v.tags:
            by_tag.setdefault((v.package, tag), []).append(v)
    found: set[tuple[str, str]] = set()
    missing: list[dict[str, str | None]] = []
    for ref in refs:
        pkg = ref["package"] or ""
        if ref["digest"]:
            key = (pkg, ref["digest"])
            if key in by_digest:
                found.add(key)
            else:
                missing.append(ref)
        elif ref["tag"]:
            hit = by_tag.get((pkg, ref["tag"]))
            if hit:
                found.update(v.key() for v in hit)
            else:
                missing.append(ref)
    return found, missing


def build_policy(base: list[dict], in_use: set[tuple[str, str]]) -> list[dict]:
    """기본 정책 앞에 `keep-in-use`(Keep) 규칙을 채워 넣는다. 사용 중 digest 전체를 `versionNamePrefixes`로."""
    digests = sorted({d for _pkg, d in in_use})
    policy = [p for p in base if p.get("name") != "keep-in-use"]
    if digests:
        policy.insert(0, {"name": "keep-in-use", "action": {"type": "Keep"}, "condition": {"versionNamePrefixes": digests}})
    return policy


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
    """정책이 지울 (package, digest) 집합. Keep이 Delete를 이긴다(AR 정리 정책의 규칙), 어느 쪽에도 안 걸리면 남는다."""
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


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--images", required=True)
    ap.add_argument("--run-services")
    ap.add_argument("--run-revisions")
    ap.add_argument("--run-jobs")
    ap.add_argument("--extra", action="append", default=[])
    ap.add_argument("--base-policy", default=str(_BASE_POLICY))
    ap.add_argument("--emit-policy")
    ap.add_argument("--now")
    args = ap.parse_args(argv)
    try:
        versions = load_versions(_load(args.images))
        base = json.loads(Path(args.base_policy).read_text())
        extra = [json.loads(Path(p).read_text()) for p in args.extra]
        refs, warnings = collect_in_use_refs(_load(args.run_services), _load(args.run_revisions), _load(args.run_jobs), extra)
    except (OSError, ValueError, KeyError) as err:
        print(f"입력 오류: {err}")
        return 2
    if not versions:
        print("입력 오류: AR 이미지 목록이 비었다.")
        return 2
    now = _parse_time(args.now) if args.now else datetime.now(timezone.utc)
    in_use, missing = resolve_in_use(refs, versions)
    policy = build_policy(base, in_use)
    would_delete, hit = check(versions, in_use, policy, now)
    base_delete, base_hit = check(versions, in_use, base, now)
    for w in warnings:
        print(f"⚠️ {w}")
    print(f"AR 이미지 {len(versions)}개 · 사용 중 참조 {len(refs)}건 → 사용 중 digest {len(in_use)}개")
    print(f"기본 정책만: 지움 {len(base_delete)}개 중 사용 중 {len(base_hit)}개  ← 0이 아니면 생성본의 keep-in-use가 필요한 까닭")
    print(f"생성 정책:   지움 {len(would_delete)}개 중 사용 중 {len(hit)}개")
    if args.emit_policy:
        Path(args.emit_policy).write_text(json.dumps(policy, indent=2, ensure_ascii=False) + "\n")
        print(f"생성 정책을 썼다: {args.emit_policy}")
    if hit:
        print("PROBLEM — 지워지는 사용 중 이미지:")
        for pkg, digest in sorted(hit):
            print(f"  - {pkg} {digest}")
        return 1
    if missing:
        print(f"사용 중 참조 {len(missing)}건을 AR 목록에서 못 찾음(목록이 잘렸거나 다른 저장소) — 지움 0을 확정할 수 없다:")
        for ref in missing:
            print(f"  - {ref['package']} {ref['tag'] or ref['digest']}")
        return 3
    print("OK — 생성 정책이 지우는 이미지 중 사용 중인 것은 0.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
