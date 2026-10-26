"""story 4790(INFRA-DIET ⑤ · AC1) — Artifact Registry 정리 정책의 «지움 0» 시험(infra/check_ar_cleanup_keeps_in_use.py).

핵심 표본: **기본 정책만 걸면 사용 중이면서 오래된 이미지(예: 사람이 직접 배포한 prod MIG가 부팅 때 당기는 `backend:<옛 sha>`)가 지워진다.**
생성 정책(`keep-in-use` 규칙 채움)은 그것을 남긴다. 게이트가 실제로 빨개질 수 있다는 것도 함께 보인다(양성대조)."""
from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "infra"))

import check_ar_cleanup_keeps_in_use as gate  # noqa: E402

NOW = datetime(2026, 10, 26, 12, 0, tzinfo=timezone.utc)
HOST = "asia-northeast3-docker.pkg.dev/sprintable-494803/sprintable"


def _digest(n: int) -> str:
    return "sha256:" + f"{n:064x}"


def _images(package: str, count: int, *, step_days: int = 1) -> list[dict]:
    """`gcloud artifacts docker images list --include-tags --format=json` 모양. 0번이 가장 새 것, 하루씩 오래된다."""
    return [
        {
            "package": f"{HOST}/{package}",
            "version": _digest(i + (0 if package == "backend" else 10_000)),
            "tags": [f"{package}-tag{i}"],
            "createTime": (NOW - timedelta(days=i * step_days)).isoformat().replace("+00:00", "Z"),
            "updateTime": (NOW - timedelta(days=i * step_days)).isoformat().replace("+00:00", "Z"),
        }
        for i in range(count)
    ]


def _base() -> list[dict]:
    return json.loads(gate._BASE_POLICY.read_text())


def _versions() -> list[gate.Version]:
    return gate.load_versions(_images("backend", 60) + _images("frontend", 5))


def test_refs_in_picks_tag_and_digest_forms_and_ignores_other_registries():
    text = json.dumps({
        "image": f"{HOST}/backend:abc123",
        "pinned": f"{HOST}/backend@{_digest(7)}",
        "sdk": "gcr.io/google.com/cloudsdktool/cloud-sdk:slim",
    })
    refs = gate.refs_in(text)
    assert {(r["package"], r["tag"], r["digest"]) for r in refs} == {("backend", "abc123", None), ("backend", None, _digest(7))}


def test_base_policy_alone_deletes_an_old_image_that_a_mig_template_still_pulls_at_boot():
    versions = _versions()
    # the prod MIG is deployed by hand: its template can name a commit far older than the newest 30 — here backend-tag45, 45 days old
    mig_template = {"properties": {"metadata": {"items": [{"key": "startup-script", "value": f"docker run -d {HOST}/backend:backend-tag45 \\"}]}}}
    refs, _ = gate.collect_in_use_refs(extra=[mig_template])
    in_use, missing = gate.resolve_in_use(refs, versions)
    assert in_use == {("backend", _digest(45))} and not missing

    _deleted, hit = gate.check(versions, in_use, _base(), NOW)
    assert hit == in_use, "the base policy alone must delete it — that is why keep-in-use exists"

    policy = gate.build_policy(_base(), in_use)
    assert policy[0]["name"] == "keep-in-use" and policy[0]["condition"]["versionNamePrefixes"] == [_digest(45)]
    deleted, hit = gate.check(versions, in_use, policy, NOW)
    assert hit == set()
    assert ("backend", _digest(45)) not in deleted and ("backend", _digest(46)) in deleted  # only the used one stays; its neighbours go


def test_most_recent_versions_counts_per_package_and_old_images_go():
    versions = _versions()
    deleted = gate.simulate(_base(), versions, NOW)
    backend_deleted = {d for p, d in deleted if p == "backend"}
    assert backend_deleted == {_digest(i) for i in range(31, 60)}  # newest 30 stay; of the rest only those older than 30 days go
    assert not [p for p, _ in deleted if p == "frontend"]  # 5 young images: nothing


def test_only_serving_revisions_count_as_in_use_not_every_old_revision():
    versions = _versions()
    services = [{"metadata": {"name": "sprintable-backend-prod"}, "status": {"traffic": [{"revisionName": "rev-2", "percent": 100}], "latestReadyRevisionName": "rev-2"},
                 "spec": {"template": {"spec": {"containers": [{"image": f"{HOST}/backend:backend-tag2"}]}}}}]
    revisions = [
        {"metadata": {"name": "rev-1"}, "spec": {"containers": [{"image": f"{HOST}/backend:backend-tag50"}]}},
        {"metadata": {"name": "rev-2"}, "spec": {"containers": [{"image": f"{HOST}/backend:backend-tag2"}]}},
    ]
    refs, warnings = gate.collect_in_use_refs(services, revisions)
    in_use, _ = gate.resolve_in_use(refs, versions)
    assert in_use == {("backend", _digest(2))} and not warnings  # rev-1 serves nothing: its 50-day-old image is not protected


def test_without_a_service_list_every_revision_counts_as_in_use():
    revisions = [{"metadata": {"name": "rev-1"}, "spec": {"containers": [{"image": f"{HOST}/backend:backend-tag50"}]}}]
    refs, warnings = gate.collect_in_use_refs(None, revisions)
    in_use, _ = gate.resolve_in_use(refs, _versions())
    assert in_use == {("backend", _digest(50))} and warnings  # the safe side, said out loud


def test_cli_exit_codes(tmp_path, capsys, monkeypatch):
    images = tmp_path / "images.json"
    images.write_text(json.dumps(_images("backend", 60)))
    mig = tmp_path / "mig.json"
    mig.write_text(json.dumps({"startup": f"docker run {HOST}/backend:backend-tag45"}))
    out = tmp_path / "policy.json"
    argv = ["--images", str(images), "--extra", str(mig), "--emit-policy", str(out), "--now", NOW.isoformat()]

    assert gate.main(argv) == 0
    written = json.loads(out.read_text())
    assert written[0]["name"] == "keep-in-use" and written[0]["condition"]["versionNamePrefixes"] == [_digest(45)]

    # the gate can go red: hand it a policy builder that forgets keep-in-use (the thing this gate exists to catch)
    monkeypatch.setattr(gate, "build_policy", lambda base, in_use: base)
    assert gate.main(argv) == 1
    assert "PROBLEM" in capsys.readouterr().out
    monkeypatch.undo()

    # an in-use reference the listing does not contain: refuse to promise «지움 0»
    mig.write_text(json.dumps({"startup": f"docker run {HOST}/backend:not-in-the-listing"}))
    assert gate.main(argv) == 3

    # empty listing = bad input, never a green
    images.write_text("[]")
    assert gate.main(argv) == 2


@pytest.mark.parametrize("text,seconds", [("2592000s", 2592000), ("30d", 2592000), ("12h", 43200), ("90", 90)])
def test_duration_forms(text, seconds):
    assert gate._duration(text) == timedelta(seconds=seconds)


def test_repo_base_policy_shape():
    base = _base()
    assert [r["name"] for r in base] == ["keep-recent-30", "delete-older-than-30d"]
    assert base[0]["action"]["type"] == "Keep" and base[0]["mostRecentVersions"]["keepCount"] == 30
    assert base[1]["action"]["type"] == "Delete" and base[1]["condition"]["olderThan"] == "2592000s"
    # keep-in-use is never committed with a digest list: it is generated right before applying (a stale list must not become the source of truth)
    assert all(r["name"] != "keep-in-use" for r in base)
