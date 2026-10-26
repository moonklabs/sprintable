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
  --run-services  gcloud run services list --region=… --format=json                              (필수)
  --run-revisions gcloud run revisions list --region=… --format=json                             (필수)
  --run-jobs      gcloud run jobs list --region=… --format=json                                  (필수)
  --extra         그 밖의 JSON(MIG 인스턴스 템플릿 등, 여러 번). 하나 이상 필수 — 건너뛰는 길은 없다
  --expect-services N · --expect-jobs N   덤프 개수(필수: 서비스 14 · job 17) — 잘린 덤프를 잡는다

산출: `--emit-policy PATH`로 기본 정책(infra/artifact-registry/cleanup-policy.base.json)에 `keep-in-use` Keep 규칙을 채운 정책을 쓴다 —
**통과(exit 0)일 때만** 쓰고, 실패하면 이전 실행이 남긴 같은 이름의 파일을 지운다(실패한 입력으로 만든 정책이 적용되지 않게).
PO는 이 생성본을 dry-run → 적용한다(기본 정책만 적용하면 사용 중이면서 오래된 이미지가 지워질 수 있다).

exit code: 0=지움 0 · 1=사용 중 이미지가 지워진다 · 2=입력 오류(AR 목록 · 서비스 · 리비전이 비었다 · 필수 덤프 없음 · 개수가 안 맞음) ·
          3=불완전(사용 중 참조를 AR 목록에서 못 찾음 · 서빙 리비전 덤프 누락 · 이미지 참조 없는 서비스/job/--extra ·
          태그로 배포된 서빙 리비전에 `status.imageDigest`가 없음) — 안전하게 실패.
참조는 `<host>/<project>/<repo>/<package>`까지 같아야 같은 이미지로 친다(다른 저장소의 같은 이름은 보호하지 않는다). 태그도 digest도 없는 참조는 `:latest`로 본다.

한계: 태그로 배포된 리비전이 컨테이너를 여럿 가지면 짝을 지을 수 없어 항상 exit 3이다(이 저장소의 서비스는 컨테이너 하나).
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
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

_BASE_POLICY = Path(__file__).resolve().parent / "artifact-registry" / "cleanup-policy.base.json"

# <host>-docker.pkg.dev/<project>/<repo>/<package>[:<tag> | @sha256:<64 hex>]
_IMAGE_REF = re.compile(
    r"(?P<host>[a-z0-9-]+-docker\.pkg\.dev)/(?P<project>[a-z0-9-]+)/(?P<repo>[a-z0-9._-]+)/(?P<package>[a-z0-9._-]+(?:/[a-z0-9._-]+)*)"
    r"(?::(?P<tag>[A-Za-z0-9_][A-Za-z0-9_.-]*)|@(?P<digest>sha256:[0-9a-f]{64}))?"
)
# 맨 digest(`status.imageDigest`가 이 꼴로 올 수 있다): 위 전체 참조의 `@sha256:…` 꼬리는 제외한다
_BARE_DIGEST = re.compile(r"(?<![@0-9A-Za-z:/_.-])(sha256:[0-9a-f]{64})")


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
        {"package": _short_package(f"{m['host']}/{m['project']}/{m['repo']}/{m['package']}"), "tag": m["tag"] or (None if m["digest"] else "latest"),
         "digest": m["digest"], "repo": f"{m['host']}/{m['project']}/{m['repo']}"}
        for m in _IMAGE_REF.finditer(text)
    ]
    refs += [{"package": None, "tag": None, "digest": m.group(1), "repo": None} for m in _BARE_DIGEST.finditer(text)]
    return refs


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
    """리비전이 실제로 쥔 digest — `status.imageDigest` 필드에서만 읽는다(주석 · 환경 변수 속 아무 SHA가 «해결된 digest»인 척하지 못하게)."""
    status = rev.get("status")
    value = status.get("imageDigest") if isinstance(status, dict) else None
    m = _SHA.search(value) if isinstance(value, str) else None
    return m.group(0) if m else None


def _unresolved_tags(rev: dict, found: list[Ref]) -> bool:
    """태그로 배포된 이미지가 있으면 «모르는» 경우를 모두 true로 돌려준다:
    · 이미지 패키지가 둘 이상이거나 태그가 둘 이상(컨테이너 여럿 — 하나뿐인 `status.imageDigest`를 짝지을 수 없다)
    · `status.imageDigest` 필드가 없다
    · 그 digest와 다른 digest가 같은 리비전에 더 있다(digest로 고정된 컨테이너나 무관한 SHA — 어느 것이 태그의 것인지 가릴 수 없다)"""
    tagged = {(r["package"], r["tag"]) for r in found if r["tag"]}
    if not tagged:
        return False
    packages = {r["package"] for r in found if r["package"]}
    if len(tagged) > 1 or len(packages) > 1:
        return True
    resolved = _status_digest(rev)
    if resolved is None:
        return True
    return any(r["digest"] and r["digest"] != resolved for r in found)


def collect_in_use_refs(
    services: Any = None, revisions: Any = None, jobs: Any = None, extra: Iterable[Any] = ()
) -> tuple[list[Ref], list[str], list[str]]:
    """(사용 중 이미지 참조 목록, 경고, 불완전한 까닭들). 불완전한 까닭이 하나라도 있으면 «지움 0»을 약속하지 않는다(exit 3).
    서비스 JSON이 있으면 «서빙 중 리비전»만, 없으면 모든 리비전을 사용 중으로 본다(안전한 쪽)."""
    refs: list[Ref] = []
    warnings: list[str] = []
    problems: list[str] = []
    for svc in _items(services) if services is not None else []:
        found = refs_in(json.dumps(svc))
        if not found:
            problems.append(f"서비스 {_name_of(svc) or '?'}에서 이미지 참조를 못 찾음")
        refs += found
    if revisions is not None:
        revs = _items(revisions)
        serving = _serving_revision_names(services) if services is not None else set()
        if serving:
            have = {_name_of(r) for r in revs}
            for name in sorted(serving - have):
                problems.append(f"서빙 중 리비전 {name}이 리비전 덤프에 없음(덤프가 잘렸거나 다른 지역)")
            for rev in revs:
                if _name_of(rev) in serving:
                    found = refs_in(json.dumps(rev))
                    if not found:
                        problems.append(f"서빙 중 리비전 {_name_of(rev)}에서 이미지 참조를 못 찾음")
                    elif _unresolved_tags(rev, found):
                        # 태그로 배포된 이미지마다 실제로 쥔 digest(`status.imageDigest`)를 모르면, 태그가 그 뒤 옮겨졌을 때 옛 이미지를 못 지킨다 — 모르면 실패
                        problems.append(f"서빙 중 리비전 {_name_of(rev)}에 태그로 배포된 이미지가 있는데 그만큼의 status.imageDigest가 없다(어느 digest를 쥐었는지 모른다)")
                    refs += found
        else:
            warnings.append("서비스 JSON에서 서빙 중 리비전을 못 읽어 모든 리비전을 사용 중으로 셌다(안전한 쪽).")
            for rev in revs:
                found = refs_in(json.dumps(rev))
                if _unresolved_tags(rev, found):
                    problems.append(f"리비전 {_name_of(rev) or '?'}에 태그로 배포된 이미지가 있는데 그만큼의 status.imageDigest가 없다(서빙 여부를 몰라 모든 리비전을 센다)")
                refs += found
    for job in _items(jobs) if jobs is not None else []:
        found = refs_in(json.dumps(job))
        if not found:
            problems.append(f"job {_name_of(job) or '?'}에서 이미지 참조를 못 찾음")
        refs += found
    for n, blob in enumerate(extra, 1):
        found = refs_in(json.dumps(blob))
        if not found:
            problems.append(f"--extra {n}번째 JSON에서 이미지 참조를 못 찾음(비었거나 형식이 다르다)")
        refs += found
    return refs, warnings, problems


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


_INPUT_FLAGS = ("--images", "--run-services", "--run-revisions", "--run-jobs", "--extra", "--base-policy")


def _same_file(a: str, b: str) -> bool:
    try:
        return Path(a).resolve() == Path(b).resolve()
    except OSError:
        return False


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


def _drop_stale(path: str | None, protect: Iterable[str] = ()) -> bool:
    """실패한 실행이 이전 성공의 정책 파일을 «현재 입력의 통과본»인 척 남기지 않게 한다. **입력 파일은 지우지 않는다**(`--emit-policy`가 입력 경로와 같을 때 사람이 손으로 모은 덤프가 사라지지 않게)
    · 지울 수 없는 경로(디렉터리 · 권한)는 건드리지 않고 False를 돌려준다."""
    if not path or any(_same_file(path, q) for q in protect):
        return False
    try:
        Path(path).unlink()
    except FileNotFoundError:
        pass
    except OSError:
        return False
    return True


def _write_policy(path: Path, text: str) -> None:
    """같은 폴더의 임시 파일에 쓰고 `os.replace`로 바꾼다 — 쓰다 실패해도 잘린 파일(JSON 아님)이 최종 경로에 남지 않는다. 실패하면 임시 파일을 치우고 OSError를 그대로 올린다."""
    tmp = path.with_name(f"{path.name}.tmp{os.getpid()}")
    try:
        tmp.write_text(text)
        os.replace(tmp, path)
    except OSError:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0], allow_abbrev=False)  # 약어(`--emit` 등)를 끈다: 사전 스캔이 못 보는 이름으로 낡은 정책 파일 삭제를 건너뛰는 길이 없게
    ap.add_argument("--images", required=True)
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
    for emit in _raw_values(raw, ("--emit-policy",)):  # 인자 오류로 끝나도 이전 실행이 남긴 정책 파일은 지운다(입력 파일이면 지우지 않는다)
        _drop_stale(emit, protect)
    args = ap.parse_args(argv)
    if args.emit_policy:
        clash = [q for q in (args.images, args.run_services, args.run_revisions, args.run_jobs, args.base_policy, *args.extra) if _same_file(args.emit_policy, q)]
        if clash:
            print(f"입력 오류: --emit-policy가 입력 파일과 같은 경로다({clash[0]}) — 입력을 덮어쓰지도 지우지도 않는다. 다른 경로를 준다.")
            return 2
        if Path(args.emit_policy).is_dir():
            print(f"입력 오류: --emit-policy가 디렉터리다({args.emit_policy}) — 파일 경로를 준다.")
            return 2
    if not args.extra:
        print("입력 오류: --extra(MIG 인스턴스 템플릿 JSON)가 하나도 없다. VM이 부팅 때 당기는 이미지를 못 본다 — 건너뛸 수 없다.")
        return 2
    try:
        versions = load_versions(_load(args.images))
        base = json.loads(Path(args.base_policy).read_text())
        extra = [json.loads(Path(p).read_text()) for p in args.extra]
        services, revisions, jobs = _load(args.run_services), _load(args.run_revisions), _load(args.run_jobs)
    except (OSError, ValueError, KeyError) as err:
        print(f"입력 오류: {err}")
        return 2
    if not versions:
        print("입력 오류: AR 이미지 목록이 비었다.")
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
    refs, warnings, problems = collect_in_use_refs(services, revisions, jobs, extra)
    if not refs:
        # 사용 중 참조가 하나도 안 잡히면 «지움 0»은 빈 입력 위의 거짓 초록이다(서비스 JSON이 비었거나 형식이 다름) — 절대 통과시키지 않는다.
        print("입력 오류: 사용 중 이미지 참조가 하나도 안 잡혔다(서비스 · 리비전 · job · 템플릿 JSON이 비었거나 형식이 다르다).")
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
    if hit:
        print("PROBLEM — 지워지는 사용 중 이미지:")
        for pkg, digest in sorted(hit):
            print(f"  - {pkg} {digest}")
        return 1
    if missing or problems:
        print("불완전 — «지움 0»을 약속할 수 없다(정책 파일도 쓰지 않았다):")
        for ref in missing:
            print(f"  - 사용 중 참조를 AR 목록에서 못 찾음: {ref['package'] or '?'} {ref['tag'] or ref['digest']}")
        for why in problems:
            print(f"  - {why}")
        return 3
    if args.emit_policy:
        try:
            _write_policy(Path(args.emit_policy), json.dumps(policy, indent=2, ensure_ascii=False) + "\n")
        except OSError as err:
            # exit 1은 «쓰는 이미지가 지워진다»의 코드다 — 쓰기 실패는 다른 이야기라 입력 오류(2)로 돌려주고, 잘린 파일이 남지 않게 한다
            _drop_stale(args.emit_policy)
            print(f"쓰기 오류: 정책 파일을 쓰지 못했다({err.__class__.__name__}: {err}) — 파일을 남기지 않았다.")
            return 2
        print(f"생성 정책을 썼다: {args.emit_policy}")
    print("OK — 생성 정책이 지우는 이미지 중 사용 중인 것은 0.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
