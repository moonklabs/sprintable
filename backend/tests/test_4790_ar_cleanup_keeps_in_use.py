"""story 4790(INFRA-DIET ⑤ · AC1) — Artifact Registry 정리 정책의 «지움 0» 시험(infra/check_ar_cleanup_keeps_in_use.py).

핵심 표본: **기본 정책만 걸면 사용 중이면서 오래된 이미지(예: 사람이 직접 배포한 prod MIG가 부팅 때 당기는 `backend:<옛 sha>`)가 지워진다.**
생성 정책(`keep-in-use` 규칙 채움)은 그것을 남긴다. 게이트가 실제로 빨개질 수 있고(양성대조), 모르면 실패한다는 것(불완전 입력 · 잘린 덤프 · 실패한 실행이 남긴 정책 파일)도 함께 보인다."""
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
    """a distinct digest per `n`. The number sits at the FRONT of the 64 hex characters, like the distinct leading characters of real digests: the policy keeps only the first 64 characters of a digest
    (Artifact Registry rejects a longer prefix), and fixtures that differ only in the last characters would all collapse to one prefix"""
    return "sha256:" + f"{n:08x}".ljust(64, "0")  # 8 distinct leading hex characters, then zeros: unique for every n, and distinct within the first 64 characters


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


def _service(name: str, revision: str, image: str) -> dict:
    return {"metadata": {"name": name}, "status": {"traffic": [{"revisionName": revision, "percent": 100}], "latestReadyRevisionName": revision},
            "spec": {"template": {"spec": {"containers": [{"image": image}]}}}}


def _revision(name: str, image: str, image_digest: str | None = None) -> dict:
    rev: dict = {"metadata": {"name": name}, "spec": {"containers": [{"image": image}]}}
    if image_digest:
        rev["status"] = {"imageDigest": image_digest}
    return rev


class Dumps:
    """a full, consistent set of the read-only dumps; tests change one thing at a time"""

    def __init__(self, tmp_path: Path):
        self.dir = tmp_path
        self.images = _images("backend", 60)
        self.services = [_service("sprintable-backend-prod", "rev-2", f"{HOST}/backend:backend-tag2")]
        self.revisions = [_revision("rev-2", f"{HOST}/backend:backend-tag2", image_digest=_digest(2))]
        self.jobs = [{"metadata": {"name": "migrate"}, "spec": {"template": {"spec": {"template": {"spec": {"containers": [{"image": f"{HOST}/backend:backend-tag3"}]}}}}}}]
        self.mig = {"startup": f"docker run {HOST}/backend:backend-tag45"}
        self.out = tmp_path / "policy.json"
        self.more_images: list[list[dict]] = []  # one more `--images` dump per further repository
        self.more_extra: list[object] = []  # further `--extra` dumps after the first template

    def argv(self, *extra_args: str, with_mig: bool = True) -> list[str]:
        files = {"images": self.images, "services": self.services, "revisions": self.revisions, "jobs": self.jobs}
        paths = {}
        for key, data in files.items():
            paths[key] = self.dir / f"{key}.json"
            paths[key].write_text(json.dumps(data))
        argv = ["--images", str(paths["images"]), "--run-services", str(paths["services"]), "--run-revisions", str(paths["revisions"]),
                "--run-jobs", str(paths["jobs"]), "--emit-policy", str(self.out), "--now", NOW.isoformat(),
                "--expect-services", str(len(self.services)), "--expect-jobs", str(len(self.jobs)), *extra_args]
        if with_mig:
            mig = self.dir / "mig.json"
            mig.write_text(json.dumps(self.mig))
            argv += ["--extra", str(mig)]
        for n, images in enumerate(self.more_images):
            path = self.dir / f"images-{n + 2}.json"
            path.write_text(json.dumps(images))
            argv += ["--images", str(path)]
        for n, blob in enumerate(self.more_extra):
            path = self.dir / f"extra-{n + 2}.json"
            path.write_text(json.dumps(blob))
            argv += ["--extra", str(path)]
        return argv


def test_refs_in_picks_tag_digest_and_bare_digest_forms_and_ignores_other_registries():
    text = json.dumps({
        "image": f"{HOST}/backend:abc123",
        "pinned": f"{HOST}/backend@{_digest(7)}",
        "resolved": _digest(8),  # a bare digest (what a revision's status.imageDigest can be)
        "sdk": "gcr.io/google.com/cloudsdktool/cloud-sdk:slim",
    })
    refs = gate.refs_in(text)
    assert {(r["package"], r["tag"], r["digest"]) for r in refs} == {
        ("backend", "abc123", None), ("backend", None, _digest(7)), (None, None, _digest(8)),
    }


def test_base_policy_alone_deletes_an_old_image_that_a_mig_template_still_pulls_at_boot():
    versions = _versions()
    # the prod MIG is deployed by hand: its template can name a commit far older than the newest 30 — here backend-tag45, 45 days old
    mig_template = {"properties": {"metadata": {"items": [{"key": "startup-script", "value": f"docker run -d {HOST}/backend:backend-tag45 \\"}]}}}
    refs, _warnings, problems = gate.collect_in_use_refs(extra=[mig_template])
    in_use, missing = gate.resolve_in_use(refs, versions)
    assert in_use == {("backend", _digest(45))} and not missing and not problems

    _deleted, hit = gate.check(versions, in_use, _base(), NOW)
    assert hit == in_use, "the base policy alone must delete it — that is why keep-in-use exists"

    policy = gate.build_policy(_base(), in_use)
    assert policy[0]["name"] == "keep-in-use" and policy[0]["condition"]["versionNamePrefixes"] == [_digest(45)[:64]]  # the registry takes at most 64 characters
    deleted, hit = gate.check(versions, in_use, policy, NOW)
    assert hit == set()
    assert ("backend", _digest(45)) not in deleted and ("backend", _digest(46)) in deleted  # only the used one stays; its neighbours go


def test_most_recent_versions_counts_per_package_and_old_images_go():
    """`olderThan 30d` and the newest-30 rule only differ for images that are old but among their own package's newest 30: a package with five images, all 40+ days old, keeps all five; counting
    globally (newest 30 over every package together) would let backend's young images push them out and delete all five"""
    frontend_old = [
        {"package": f"{HOST}/frontend", "version": _digest(10_000 + i), "tags": [f"frontend-tag{i}"],
         "createTime": (NOW - timedelta(days=40 + i)).isoformat().replace("+00:00", "Z")}
        for i in range(5)
    ]
    versions = gate.load_versions(_images("backend", 60) + frontend_old)
    deleted = gate.simulate(_base(), versions, NOW)
    backend_deleted = {d for p, d in deleted if p == "backend"}
    assert backend_deleted == {_digest(i) for i in range(31, 60)}  # newest 30 stay; of the rest only those older than 30 days go
    assert not [d for p, d in deleted if p == "frontend"], "five old images are the whole package: its newest 30 are all of them"


def test_only_serving_revisions_count_as_in_use_not_every_old_revision():
    services = [_service("sprintable-backend-prod", "rev-2", f"{HOST}/backend:backend-tag2")]
    revisions = [_revision("rev-1", f"{HOST}/backend:backend-tag50"), _revision("rev-2", f"{HOST}/backend:backend-tag2", image_digest=_digest(2))]
    refs, warnings, problems = gate.collect_in_use_refs(services, revisions)
    in_use, _ = gate.resolve_in_use(refs, _versions())
    assert in_use == {("backend", _digest(2))} and not warnings and not problems  # rev-1 serves nothing: its 50-day-old image is not protected


def test_without_a_service_list_every_revision_counts_as_in_use():
    revisions = [_revision("rev-1", f"{HOST}/backend:backend-tag50", image_digest=_digest(50))]
    refs, warnings, problems = gate.collect_in_use_refs(None, revisions)
    in_use, _ = gate.resolve_in_use(refs, _versions())
    assert in_use == {("backend", _digest(50))} and warnings and not problems  # the safe side, said out loud


def test_the_all_revisions_fallback_also_needs_the_resolved_digest_and_one_per_container():
    """no serving info -> every revision counts, but a revision deployed by tag still must carry what it runs; and a second container's digest must not hide the first container's tag"""
    refs, _warnings, problems = gate.collect_in_use_refs(None, [_revision("rev-1", f"{HOST}/backend:backend-tag50")])
    assert problems and "rev-1" in problems[0]
    two = {"metadata": {"name": "rev-2"}, "spec": {"containers": [{"image": f"{HOST}/backend:backend-tag2"}, {"image": f"{HOST}/frontend:frontend-tag1"}]},
           "status": {"imageDigest": _digest(2)}}
    _refs, _warnings, problems = gate.collect_in_use_refs([_service("s", "rev-2", f"{HOST}/backend:backend-tag2")], [two])
    assert problems, "one resolved digest cannot cover two tagged containers"
    two["status"] = {"imageDigest": _digest(2), "containerStatuses": [{"imageDigest": _digest(10_001)}]}
    _refs, _warnings, problems = gate.collect_in_use_refs([_service("s", "rev-2", f"{HOST}/backend:backend-tag2")], [two])
    assert problems, "two tagged containers cannot be paired with their digests, even when two digests are present"
    mixed = {"metadata": {"name": "rev-2"}, "spec": {"containers": [{"image": f"{HOST}/backend:backend-tag2"}, {"image": f"{HOST}/frontend@{_digest(10_001)}"}]},
             "status": {"imageDigest": _digest(10_001)}}
    _refs, _warnings, problems = gate.collect_in_use_refs([_service("s", "rev-2", f"{HOST}/backend:backend-tag2")], [mixed])
    assert problems, "a tagged container next to a digest-pinned one: the single digest could belong to either"
    one = _revision("rev-2", f"{HOST}/backend:backend-tag2", image_digest=_digest(2))
    _refs, _warnings, problems = gate.collect_in_use_refs([_service("s", "rev-2", f"{HOST}/backend:backend-tag2")], [one])
    assert not problems  # one tagged container with its resolved digest is fine


def test_a_moved_tag_is_still_protected_by_the_revisions_resolved_digest(tmp_path):
    """Cloud Run deployed `backend:latest`; the tag has since moved to a newer image. The revision still runs the OLD digest (`status.imageDigest`) — that is the image a new instance of
    that revision pulls, and it is 60 days old. A tag-only lookup would protect the new image and delete the old one."""
    d = Dumps(tmp_path)
    old, new = _digest(900), _digest(901)
    d.images += [
        {"package": f"{HOST}/backend", "version": old, "tags": [], "createTime": (NOW - timedelta(days=60)).isoformat()},
        {"package": f"{HOST}/backend", "version": new, "tags": ["latest"], "createTime": (NOW - timedelta(days=1)).isoformat()},
    ]
    d.services = [_service("sprintable-backend-prod", "rev-9", f"{HOST}/backend:latest")]
    d.revisions = [_revision("rev-9", f"{HOST}/backend:latest", image_digest=old)]
    assert gate.main(d.argv()) == 0
    kept = json.loads(d.out.read_text())[0]["condition"]["versionNamePrefixes"]
    assert old[:64] in kept and new[:64] in kept

    # a serving revision deployed by tag whose dump has no resolved digest: the gate does not guess which digest it runs — exit 3, no policy
    d.revisions = [_revision("rev-9", f"{HOST}/backend:latest")]
    assert gate.main(d.argv()) == 3 and not d.out.exists()


def test_cli_ok_writes_the_generated_policy(tmp_path):
    d = Dumps(tmp_path)
    assert gate.main(d.argv("--expect-services", "1", "--expect-jobs", "1")) == 0
    written = json.loads(d.out.read_text())
    assert written[0]["name"] == "keep-in-use"
    assert {_digest(2)[:64], _digest(3)[:64], _digest(45)[:64]} <= set(written[0]["condition"]["versionNamePrefixes"])  # service tag · job tag · MIG tag


def test_cli_the_gate_can_go_red_and_leaves_no_policy_behind(tmp_path, monkeypatch, capsys):
    d = Dumps(tmp_path)
    assert gate.main(d.argv()) == 0 and d.out.exists()
    # a policy builder that forgets keep-in-use (the thing this gate exists to catch): exit 1, and the earlier policy file is removed
    monkeypatch.setattr(gate, "build_policy", lambda base, in_use: base)
    assert gate.main(d.argv()) == 1
    assert "PROBLEM" in capsys.readouterr().out
    assert not d.out.exists(), "a failed run must not leave an applicable policy file behind"


def test_cli_incomplete_inputs_fail_closed_and_write_nothing(tmp_path, capsys):
    d = Dumps(tmp_path)
    assert gate.main(d.argv()) == 0 and d.out.exists()

    # an in-use reference the listing does not contain: refuse to promise «지움 0»
    d.mig = {"startup": f"docker run {HOST}/backend:not-in-the-listing"}
    assert gate.main(d.argv()) == 3 and not d.out.exists()

    # the service serves rev-2 but the revision dump has been cut and lacks it
    d = Dumps(tmp_path)
    d.revisions = [_revision("rev-1", f"{HOST}/backend:backend-tag50")]
    assert gate.main(d.argv()) == 3 and not d.out.exists()
    assert "rev-2" in capsys.readouterr().out

    # an extra (gateway template) dump that carries no image reference: it protects nothing, so say so
    d = Dumps(tmp_path)
    d.mig = {"startup": "no image here"}
    assert gate.main(d.argv()) == 3 and not d.out.exists()

    # a serving revision deployed by tag whose dump lacks the resolved digest
    d = Dumps(tmp_path)
    d.revisions = [_revision("rev-2", f"{HOST}/backend:backend-tag2")]
    assert gate.main(d.argv()) == 3 and not d.out.exists()

    # a reference to another repository with the same package and tag must not protect this repository's image
    d = Dumps(tmp_path)
    d.mig = {"startup": f"docker run asia-northeast3-docker.pkg.dev/sprintable-494803/other/backend:backend-tag45"}
    assert gate.main(d.argv()) == 3 and not d.out.exists()

    # a service whose block carries no image reference at all
    d = Dumps(tmp_path)
    d.services = [{"metadata": {"name": "sprintable-backend-prod"}, "status": {"traffic": [{"revisionName": "rev-2"}], "latestReadyRevisionName": "rev-2"}}]
    assert gate.main(d.argv()) == 3 and not d.out.exists()


def test_cli_bad_input_is_exit_2_never_a_green(tmp_path):
    d = Dumps(tmp_path)
    # a dump with a different count than the operator knows (cut by --limit or a wrong region)
    assert gate.main(d.argv("--expect-services", "14")) == 2 and not d.out.exists()
    assert gate.main(d.argv("--expect-jobs", "17")) == 2
    # no gateway template at all, unless said on purpose
    assert gate.main(d.argv(with_mig=False)) == 2
    with pytest.raises(SystemExit):  # the bypass is gone
        gate.main(d.argv("--no-extra", with_mig=False))
    # empty listing; empty everything in use
    d.images = []
    assert gate.main(d.argv()) == 2
    d = Dumps(tmp_path)
    d.services, d.revisions, d.jobs, d.mig = [], [], [], {}
    assert gate.main(d.argv()) == 2
    # empty service and revision dumps are bad input even when a job or a template still carries a valid reference
    d = Dumps(tmp_path)
    d.services, d.revisions = [], []
    assert gate.main(d.argv()) == 2 and not d.out.exists()


def test_empty_jobs_unreadable_times_and_a_polluted_base_policy_are_bad_input(tmp_path):
    d = Dumps(tmp_path)
    d.jobs = []
    assert gate.main(d.argv()) == 2 and not d.out.exists()
    d = Dumps(tmp_path)
    del d.images[0]["createTime"], d.images[0]["updateTime"]
    assert gate.main(d.argv()) == 2 and not d.out.exists()
    d = Dumps(tmp_path)
    base = tmp_path / "base.json"
    base.write_text(json.dumps(_base() + [{"name": "keep-in-use", "action": {"type": "Keep"}, "condition": {"versionNamePrefixes": ["sha256:" + "0" * 64]}}]))
    assert gate.main(d.argv("--base-policy", str(base))) == 2 and not d.out.exists()


def test_a_tagged_container_next_to_another_digest_of_the_same_package_is_ambiguous():
    """the false green the fifth review found: `backend:latest` plus a pinned `backend@sha256:other` (or an unrelated SHA in an annotation) must not count as «the tag's digest is known»;
    only the `status.imageDigest` field resolves a tag, and any other digest in the same revision makes it ambiguous"""
    service = [_service("s", "rev-2", f"{HOST}/backend:backend-tag2")]
    pinned = {"metadata": {"name": "rev-2"}, "spec": {"containers": [{"image": f"{HOST}/backend:backend-tag2"}, {"image": f"{HOST}/backend@{_digest(7)}"}]}, "status": {"imageDigest": _digest(2)}}
    _refs, _warnings, problems = gate.collect_in_use_refs(service, [pinned])
    assert problems, "a same-package pinned container next to a tagged one"
    annotated = {"metadata": {"name": "rev-2", "annotations": {"note": _digest(9)}}, "spec": {"containers": [{"image": f"{HOST}/backend:backend-tag2"}]}}
    _refs, _warnings, problems = gate.collect_in_use_refs(service, [annotated])
    assert problems, "an unrelated SHA in an annotation is not the resolved digest"
    clean = {"metadata": {"name": "rev-2"}, "spec": {"containers": [{"image": f"{HOST}/backend:backend-tag2"}]}, "status": {"imageDigest": f"{HOST}/backend@{_digest(2)}"}}
    _refs, _warnings, problems = gate.collect_in_use_refs(service, [clean])
    assert not problems  # the real shape: the resolved digest comes as a full pinned reference in `status.imageDigest`


def test_a_ref_without_tag_or_digest_means_latest():
    refs = gate.refs_in(json.dumps({"image": f"{HOST}/backend"}))
    assert [(r["package"], r["tag"], r["digest"]) for r in refs] == [("backend", "latest", None)]


def test_an_argument_error_still_removes_the_stale_policy_file(tmp_path):
    d = Dumps(tmp_path)
    assert gate.main(d.argv()) == 0 and d.out.exists()
    argv = d.argv()
    i = argv.index("--run-jobs")
    with pytest.raises(SystemExit):
        gate.main(argv[:i] + argv[i + 2:])
    assert not d.out.exists(), "an invocation that fails to parse must not leave the earlier policy behind"


def test_the_three_run_dumps_are_required_arguments(tmp_path):
    d = Dumps(tmp_path)
    argv = d.argv()
    i = argv.index("--run-jobs")
    with pytest.raises(SystemExit) as err:
        gate.main(argv[:i] + argv[i + 2:])
    assert err.value.code == 2


@pytest.mark.parametrize("text,seconds", [("2592000s", 2592000), ("30d", 2592000), ("12h", 43200), ("90", 90)])
def test_duration_forms(text, seconds):
    assert gate._duration(text) == timedelta(seconds=seconds)


def test_repo_base_policy_shape():
    base = _base()
    assert [r["name"] for r in base] == ["keep-recent-30", "keep-env-latest-tags", "delete-older-than-30d"]
    assert base[0]["action"]["type"] == "Keep" and base[0]["mostRecentVersions"]["keepCount"] == 30
    assert base[1]["action"]["type"] == "Keep" and base[1]["condition"] == {"tagState": "tagged", "tagPrefixes": ["latest-prod", "latest-dev"]}
    assert base[2]["action"]["type"] == "Delete" and base[2]["condition"]["olderThan"] == "2592000s"
    # keep-in-use is never committed with a digest list: it is generated right before applying (a stale list must not become the source of truth)
    assert all(r["name"] != "keep-in-use" for r in base)


def _tagged_old(package: str, n: int, tags: list[str], *, days: int = 45) -> dict:
    return {"package": f"{HOST}/{package}", "version": _digest(n), "tags": tags, "createTime": (NOW - timedelta(days=days)).isoformat().replace("+00:00", "Z")}


def test_the_image_an_environment_was_last_built_for_stays_however_old_and_however_many_newer_dev_builds_pushed_it_out():
    """story 4790 (PO, 10-28): the policy is live. A prod image that is not rebuilt for 30 days and has fallen out of its package's newest 30 (dev pushes dozens of builds) would be deleted, and a new
    instance of the serving revision could not pull it. The Cloud Build pipeline already tags the frontend, backend and support-gateway builds `latest-<env>` (cloudbuild.yaml), so the base policy keeps whatever carries that tag (the dev VM's `frontend-vm` build does not: see below)"""
    prod = _tagged_old("backend", 90_001, ["latest-prod", "abc1234"])
    dev = _tagged_old("backend", 90_002, ["latest-dev", "def5678"])
    old_by_commit = _tagged_old("backend", 90_003, ["abc9999"])  # positive control: a build that carries only its commit tag is not protected
    versions = gate.load_versions(_images("backend", 60) + [prod, dev, old_by_commit])
    deleted = gate.simulate(_base(), versions, NOW)
    assert ("backend", _digest(90_001)) not in deleted and ("backend", _digest(90_002)) not in deleted
    assert ("backend", _digest(90_003)) in deleted
    # the same images under a base policy without the tag rule: the prod image is deleted (the test can go red)
    without_rule = [r for r in _base() if r["name"] != "keep-env-latest-tags"]
    assert {("backend", _digest(90_001)), ("backend", _digest(90_002))} <= gate.simulate(without_rule, versions, NOW)


def test_the_tag_rule_is_per_environment_prefix_so_another_latest_tag_is_not_kept():
    """only the two environment tags are kept: a stray `latest` or `latest-staging` tag does not pin an image forever"""
    versions = gate.load_versions(_images("backend", 60) + [_tagged_old("backend", 90_004, ["latest"]), _tagged_old("backend", 90_005, ["latest-staging"])])
    deleted = gate.simulate(_base(), versions, NOW)
    assert {("backend", _digest(90_004)), ("backend", _digest(90_005))} <= deleted


def test_the_moved_tag_leaves_the_previous_prod_image_to_the_normal_rules():
    """the limit, stated: the tag moves at the next prod build, so the previous prod image (a rollback target) is protected only by the newest-30 and 30-day rules — or by keep-in-use at the time the policy is generated"""
    previous = _tagged_old("backend", 90_006, ["abc0001"])  # was latest-prod until the next build moved the tag
    versions = gate.load_versions(_images("backend", 60) + [previous])
    assert ("backend", _digest(90_006)) in gate.simulate(_base(), versions, NOW)
    in_use = {("backend", _digest(90_006))}
    assert gate.check(versions, in_use, gate.build_policy(_base(), in_use), NOW)[1] == set()


def _vm_frontend(count: int) -> list[dict]:
    """the dev VM frontend build (`cloudbuild-vm.yaml`, package `frontend-vm`) is pushed with its commit tag only — no `latest-dev` — so the tag rule does not reach it. Build `i` is `i` builds back and EVERY build is
    older than 30 days (40 + i days), so only the newest-30 rule and `keep-in-use` stand between a build and the delete rule (an age that grew with `i` would let the 30-day rule decide, and the test could not tell)"""
    return [
        {"package": f"{HOST}/frontend-vm", "version": _digest(80_000 + i), "tags": [f"sha{i}"], "createTime": (NOW - timedelta(days=40 + i)).isoformat().replace("+00:00", "Z")}
        for i in range(count)
    ]


def test_the_vm_frontend_package_is_outside_the_tag_rule_and_rides_on_newest_30_then_on_keep_in_use():
    """the limit the tag rule leaves, stated (codex, PR 5317): while the package has no more than 30 builds, the newest-30 rule keeps all of them however old; past 30, a build that nothing newer replaced is deleted
    once it is older than 30 days unless the generated `keep-in-use` names it. This test does not claim the VM frontend is protected by the tag rule — it is not (story 4796 decides whether to tag it)"""
    small = gate.load_versions(_vm_frontend(10))
    assert gate.simulate(_base(), small, NOW) == set()  # ten builds, all 40+ days old: kept by the newest-30 rule alone
    without_recent = [r for r in _base() if r["name"] != "keep-recent-30"]
    assert gate.simulate(without_recent, small, NOW) == {("frontend-vm", _digest(80_000 + i)) for i in range(10)}  # positive control: without that rule they all go
    big = gate.load_versions(_vm_frontend(40))
    deleted = gate.simulate(_base(), big, NOW)
    assert deleted == {("frontend-vm", _digest(80_000 + i)) for i in range(30, 40)}  # the newest 30 stay, the ten beyond them go
    serving = {("frontend-vm", _digest(80_000 + 35))}
    after_keep = gate.simulate(gate.build_policy(_base(), serving), big, NOW)
    assert after_keep == deleted - serving and gate.check(big, serving, gate.build_policy(_base(), serving), NOW)[1] == set()


def test_the_generated_policy_keeps_the_tag_rule_next_to_keep_in_use():
    in_use = {("backend", _digest(45))}
    policy = gate.build_policy(_base(), in_use)
    assert [r["name"] for r in policy] == ["keep-in-use", "keep-recent-30", "keep-env-latest-tags", "delete-older-than-30d"]


def _without(argv: list[str], flag: str) -> list[str]:
    i = argv.index(flag)
    return argv[:i] + argv[i + 2:]


def test_the_same_call_without_expect_services_exits_2(tmp_path):
    """the QA lens' surviving mutant: `--expect-services` made optional again. The one call that leaves it out (and only it) must fail, like the jobs one"""
    d = Dumps(tmp_path)
    assert gate.main(d.argv()) == 0  # the same call with it passes
    with pytest.raises(SystemExit) as err:
        gate.main(_without(d.argv(), "--expect-services"))
    assert err.value.code == 2
    with pytest.raises(SystemExit):
        gate.main(_without(d.argv(), "--expect-jobs"))


def test_a_write_that_fails_half_way_leaves_no_file_and_is_not_exit_1(tmp_path, monkeypatch, capsys):
    """exit 1 means «an in-use image would be deleted»; a failing write is another story (exit 2) and must not leave a truncated, non-JSON file (not even from an earlier run)"""
    d = Dumps(tmp_path)
    assert gate.main(d.argv()) == 0 and d.out.exists()  # an earlier good run leaves a file
    argv = d.argv()
    real = Path.write_text

    def half(self, data, *a, **k):
        if self.name.startswith(d.out.name):
            real(self, data[: len(data) // 2])
            raise OSError("File too large")
        return real(self, data, *a, **k)

    monkeypatch.setattr(Path, "write_text", half)
    assert gate.main(argv) == 2
    assert "쓰기 오류" in capsys.readouterr().out
    assert not d.out.exists(), "no policy file (not even a truncated one) is left at the target path"
    assert not list(tmp_path.glob(f"{d.out.name}*")), "no temporary file is left either"


def test_emit_policy_that_points_at_an_input_is_refused_and_the_input_survives(tmp_path):
    """`--emit-policy` equal to an input path: refuse before anything is deleted — the dump a person collected by hand (or the base policy) is not wiped by the stale-file drop"""
    d = Dumps(tmp_path)
    for flag in ("--images", "--run-services"):
        argv = d.argv()
        target = Path(argv[argv.index(flag) + 1])
        before = target.read_text()
        argv[argv.index("--emit-policy") + 1] = str(target)
        assert gate.main(argv) == 2
        assert target.exists() and target.read_text() == before, flag
    base_copy = tmp_path / "base-copy.json"
    base_copy.write_text(json.dumps(_base()))
    argv = d.argv("--base-policy", str(base_copy))
    argv[argv.index("--emit-policy") + 1] = str(base_copy)
    assert gate.main(argv) == 2 and base_copy.exists()
    # the repository's own base policy (the default `--base-policy`) is protected too
    argv = d.argv()
    argv[argv.index("--emit-policy") + 1] = str(gate._BASE_POLICY)
    before = gate._BASE_POLICY.read_text()
    assert gate.main(argv) == 2 and gate._BASE_POLICY.read_text() == before


def test_emit_policy_that_is_a_directory_exits_2_without_a_traceback(tmp_path):
    d = Dumps(tmp_path)
    argv = d.argv()
    folder = tmp_path / "a-folder"
    folder.mkdir()
    argv[argv.index("--emit-policy") + 1] = str(folder)
    assert gate.main(argv) == 2 and folder.is_dir()


def test_flag_abbreviations_are_off(tmp_path):
    """an abbreviated flag (`--emit`) would be understood by argparse but not by the pre-scan that drops a stale policy file: abbreviations are refused (argparse exit 2)"""
    d = Dumps(tmp_path)
    assert gate.main(d.argv()) == 0 and d.out.exists()
    argv = d.argv()
    argv[argv.index("--emit-policy")] = "--emit"
    with pytest.raises(SystemExit) as err:
        gate.main(argv)
    assert err.value.code == 2


def test_the_write_is_atomic_an_existing_target_survives_a_failing_write_and_a_failing_replace(tmp_path, monkeypatch):
    """`_write_policy` on its own: a target that already holds content keeps it when the write fails half way and when `os.replace` fails, and no temporary file is left"""
    target = tmp_path / "policy.json"
    target.write_text("OLD")
    real = Path.write_text

    def half(self, data, *a, **k):
        real(self, data[: len(data) // 2])
        raise OSError("File too large")

    monkeypatch.setattr(Path, "write_text", half)
    with pytest.raises(OSError):
        gate._write_policy(target, "NEWNEWNEW")
    monkeypatch.setattr(Path, "write_text", real)
    assert target.read_text() == "OLD" and [p.name for p in tmp_path.iterdir()] == ["policy.json"]

    def boom(src, dst):
        raise OSError("cross-device link")

    monkeypatch.setattr(gate.os, "replace", boom)
    with pytest.raises(OSError):
        gate._write_policy(target, "NEWNEWNEW")
    assert target.read_text() == "OLD" and [p.name for p in tmp_path.iterdir()] == ["policy.json"]


def test_only_a_policy_this_tool_wrote_is_ever_deleted(tmp_path):
    """the stale-file drop removes a generated policy and nothing else: not a stranger's file, not an input dump, not a directory, not a symlink (not even one that points to a generated policy or to a directory)"""
    generated = tmp_path / "generated.json"
    generated.write_text(json.dumps([{"name": "keep-in-use", "action": {"type": "Keep"}, "condition": {"versionNamePrefixes": []}}]))
    assert gate._drop_stale(str(generated)) is True and not generated.exists()
    stranger = tmp_path / "notes.txt"
    stranger.write_text("not json")
    dump = tmp_path / "dump.json"
    dump.write_text(json.dumps([{"package": "x", "version": "sha256:" + "0" * 64}]))
    folder = tmp_path / "folder"
    folder.mkdir()
    for p in (stranger, dump, folder):
        assert gate._drop_stale(str(p)) is False and p.exists(), p
    real_policy = tmp_path / "real.json"
    real_policy.write_text(json.dumps([{"name": "keep-in-use"}]))
    link = tmp_path / "link.json"
    link.symlink_to(real_policy)
    link_dir = tmp_path / "link-dir"
    link_dir.symlink_to(folder, target_is_directory=True)
    for p in (link, link_dir):
        assert gate._drop_stale(str(p)) is False and p.is_symlink(), p
    assert real_policy.exists()


def test_a_malformed_input_option_cannot_make_the_pre_scan_delete_an_input(tmp_path):
    """the review's case: `--ima X` (an abbreviation the pre-scan does not know) with `--emit-policy X` used to delete X before argparse rejected the call"""
    d = Dumps(tmp_path)
    argv = d.argv()
    images = argv[argv.index("--images") + 1]
    before = Path(images).read_text()
    argv[argv.index("--images")] = "--ima"
    argv[argv.index("--emit-policy") + 1] = images
    with pytest.raises(SystemExit) as err:
        gate.main(argv)
    assert err.value.code == 2
    assert Path(images).exists() and Path(images).read_text() == before


def test_emit_policy_that_is_a_symlink_to_a_directory_is_refused_and_left_alone(tmp_path):
    d = Dumps(tmp_path)
    folder = tmp_path / "real-folder"
    folder.mkdir()
    link = tmp_path / "link-to-folder"
    link.symlink_to(folder, target_is_directory=True)
    argv = d.argv()
    argv[argv.index("--emit-policy") + 1] = str(link)
    assert gate.main(argv) == 2 and link.is_symlink() and folder.is_dir()


def test_a_second_emit_policy_is_the_one_that_counts(tmp_path):
    """argparse uses the last `--emit-policy`; the stale drop looks at that one only, so an earlier path in the same call is not touched"""
    d = Dumps(tmp_path)
    other = tmp_path / "other-generated.json"
    other.write_text(json.dumps([{"name": "keep-in-use", "action": {"type": "Keep"}, "condition": {"versionNamePrefixes": []}}]))
    argv = d.argv() + ["--emit-policy", str(d.out)]
    argv[argv.index("--emit-policy") + 1] = str(other)  # the FIRST occurrence points at `other`
    assert gate.main(argv) == 0 and d.out.exists()
    assert other.exists(), "the earlier --emit-policy value was not the one in use; it is not touched"


def test_a_policy_that_cannot_be_encoded_is_exit_2_not_a_traceback(tmp_path, monkeypatch):
    """the file is written as UTF-8 whatever the locale is; an encoding failure of the text is a write error (exit 2), not an uncaught exception"""
    d = Dumps(tmp_path)
    argv = d.argv()
    monkeypatch.setattr(gate.json, "dumps", lambda *a, **k: "\ud800")  # a lone surrogate cannot be written as UTF-8
    assert gate.main(argv) == 2 and not d.out.exists()
    assert not list(tmp_path.glob(f"{d.out.name}*"))


def _in_use_of(d: "Dumps") -> tuple[list[gate.Version], set[tuple[str, str]]]:
    versions = gate.load_versions(d.images)
    return versions, {v.key() for v in versions if v.digest in {_digest(2), _digest(3), _digest(45)}}


def test_generated_prefixes_are_within_the_registry_limit_of_64_characters(tmp_path):
    """the live Artifact Registry answered `invalid prefix longer than 64 characters` to the full 71-character digest"""
    d = Dumps(tmp_path)
    versions, in_use = _in_use_of(d)
    policy = gate.build_policy(_base(), in_use)
    prefixes = policy[0]["condition"]["versionNamePrefixes"]
    assert len(prefixes) == 3 and all(len(x) == 64 for x in prefixes)
    assert sorted(prefixes) == sorted(digest[:64] for _pkg, digest in in_use)
    assert all(len(digest) == 71 for _pkg, digest in in_use)  # the full digest would have been 7 characters too long
    assert gate.policy_problems(policy) == []
    assert gate.policy_problems([{"name": "x", "condition": {"versionNamePrefixes": [_digest(2)]}}]) != []  # positive control: the check can fail


def test_the_truncated_policy_still_protects_exactly_what_is_in_use(tmp_path):
    """the simulation matches by prefix like the registry does: with the 64-character prefixes the in-use images are still not deleted, and an unused old image is"""
    d = Dumps(tmp_path)
    versions, in_use = _in_use_of(d)
    policy = gate.build_policy(_base(), in_use)
    would_delete, hit = gate.check(versions, in_use, policy, NOW)
    assert hit == set() and would_delete
    _, base_hit = gate.check(versions, in_use, _base(), NOW)  # positive control: the base policy alone does delete an old in-use image (backend-tag45 is 45 days old)
    assert base_hit


def test_a_truncated_prefix_that_matches_two_versions_stops_with_exit_3(tmp_path, capsys):
    """two different digests sharing their first 64 characters: the prefix would keep both, so the run stops and names them (safe side), and writes no policy file"""
    d = Dumps(tmp_path)
    twin = dict(d.images[2])
    twin["version"] = _digest(2)[:64] + "abcdef0"  # same first 64 characters, another tail
    twin["tags"] = ["twin-tag"]
    d.images = d.images + [twin]
    assert gate.main(d.argv()) == 3
    assert "접두" in capsys.readouterr().out
    assert not d.out.exists()


def test_without_the_twin_the_same_call_is_ok(tmp_path):
    d = Dumps(tmp_path)
    assert gate.main(d.argv()) == 0 and d.out.exists()


def test_the_written_policy_file_carries_only_prefixes_of_64_characters(tmp_path):
    d = Dumps(tmp_path)
    assert gate.main(d.argv()) == 0
    written = json.loads(d.out.read_text())
    prefixes = written[0]["condition"]["versionNamePrefixes"]
    assert written[0]["name"] == "keep-in-use" and prefixes and all(len(x) <= 64 for x in prefixes)


def test_a_policy_with_an_over_long_prefix_is_never_written_even_if_the_builder_regresses(tmp_path, monkeypatch, capsys):
    """the second line of defence: if the builder ever hands back the full 71-character digest again, the run stops (exit 2) and writes nothing — the registry would reject that file anyway"""
    d = Dumps(tmp_path)
    real = gate.build_policy

    def full_digest(base, in_use):
        policy = real(base, in_use)
        policy[0]["condition"]["versionNamePrefixes"] = sorted(dg for _pkg, dg in in_use)
        return policy

    monkeypatch.setattr(gate, "build_policy", full_digest)
    assert gate.main(d.argv()) == 2
    assert "AR" in capsys.readouterr().out and not d.out.exists()


def test_two_in_use_digests_that_share_their_first_64_characters_need_one_prefix_and_are_not_ambiguous(tmp_path):
    """both versions are in use, so the single shared prefix keeps exactly what must be kept: no ambiguity, one entry in the rule, both protected"""
    d = Dumps(tmp_path)
    d.images[3]["version"] = _digest(2)[:64] + "1234567"  # the job's image shares its first 64 characters with the service's (digest 2)
    assert gate.main(d.argv()) == 0
    prefixes = json.loads(d.out.read_text())[0]["condition"]["versionNamePrefixes"]
    assert prefixes.count(_digest(2)[:64]) == 1 and len(prefixes) == 2  # the shared one + the MIG image (digest 45)


def test_a_twin_in_another_package_is_exit_3_too(tmp_path, capsys):
    """the registry matches the version name across packages unless the rule is scoped: a frontend version with the same first 64 characters as an in-use backend digest would be kept by the prefix"""
    d = Dumps(tmp_path)
    d.images = d.images + [{
        "package": f"{HOST}/frontend", "version": _digest(2)[:64] + "abcdef0", "tags": ["frontend-twin"],
        "createTime": (NOW - timedelta(days=90)).isoformat().replace("+00:00", "Z"),
    }]
    assert gate.main(d.argv()) == 3
    assert "frontend" in capsys.readouterr().out and not d.out.exists()


def test_the_registry_limit_is_exactly_64_characters_at_the_boundary():
    at = [{"name": "x", "condition": {"versionNamePrefixes": ["a" * 64]}}]
    over = [{"name": "x", "condition": {"versionNamePrefixes": ["a" * 65]}}]
    assert gate.policy_problems(at) == []
    assert gate.policy_problems(over) != []


# ---- story 4796 AC4 precondition: several repositories, out-of-scope references, an extra without images ----

HOST_PROD = "asia-northeast3-docker.pkg.dev/sprintable-494803/sprintable-prod"
AR_HOST = HOST.split("/")[0]
SQL_PROXY = "gcr.io/cloud-sql-connectors/cloud-sql-proxy:2.8.0"


def _iso(moment: datetime) -> str:
    return moment.isoformat().replace("+00:00", "Z")


def _prod_images(count: int, *, age_days: int = 0) -> list[dict]:
    """the second repository: `backend` builds, `age_days` + i days old (digests 20_000+i, distinct from the first repository's)"""
    return [
        {"package": f"{HOST_PROD}/backend", "version": _digest(20_000 + i), "tags": [f"prod-tag{i}"], "createTime": _iso(NOW - timedelta(days=age_days + i))}
        for i in range(count)
    ]


def test_two_repositories_in_one_call_pass_and_both_digests_are_kept(tmp_path):
    """the VM template pulls from the first repository while the prod services run from the second: one call with both `--images` dumps passes, no hand-made workaround"""
    d = Dumps(tmp_path)
    d.more_images = [_prod_images(5)]
    d.mig = {"startup": f"docker run {HOST}/backend:backend-tag45 {HOST_PROD}/backend:prod-tag4"}
    assert gate.main(d.argv()) == 0
    kept = json.loads(d.out.read_text())[0]["condition"]["versionNamePrefixes"]
    assert _digest(20_004)[:64] in kept and _digest(45)[:64] in kept


def test_a_reference_into_a_repository_that_was_not_dumped_still_fails_and_says_what_to_add(tmp_path, capsys):
    """«모르면 실패한다»: the same call without the second dump — our own host, a repository the list does not hold — is exit 3 (not an out-of-scope reference) and names the way out"""
    d = Dumps(tmp_path)
    d.mig = {"startup": f"docker run {HOST}/backend:backend-tag45 {HOST_PROD}/backend:prod-tag4"}
    assert gate.main(d.argv()) == 3 and not d.out.exists()
    out = capsys.readouterr().out
    assert HOST_PROD in out and "--images" in out
    assert "범위 밖" not in out, "our own host is never out of scope"
    d.more_images = [_prod_images(5)]
    assert gate.main(d.argv()) == 0  # the same call with the dump is green: the test can tell the two apart


def test_the_newest_30_rule_counts_inside_each_repository(tmp_path):
    """the policy is applied per repository: 20 old builds in each of two repositories is 20 per repository (all kept), not 40 together (ten deleted)"""
    first = [{"package": f"{HOST}/backend", "version": _digest(i), "tags": [f"a{i}"], "createTime": _iso(NOW - timedelta(days=40 + i))} for i in range(20)]
    second = _prod_images(20, age_days=40)
    both = gate.load_versions(first + second)
    assert gate.simulate(_base(), both, NOW) == set()
    # positive control: the same forty builds in ONE repository do lose ten
    one_repo = gate.load_versions(first + [{**x, "package": f"{HOST}/backend"} for x in second])
    assert len(gate.simulate(_base(), one_repo, NOW)) == 10


def test_every_dumped_repository_is_simulated_and_an_old_unused_image_in_the_second_goes(tmp_path):
    d = Dumps(tmp_path)
    d.more_images = [_prod_images(40, age_days=40)]
    assert gate.main(d.argv()) == 0
    versions = gate.load_versions(d.images + d.more_images[0])
    deleted = gate.simulate(json.loads(d.out.read_text()), versions, NOW)
    assert {("backend", _digest(20_000 + i)) for i in range(30, 40)} <= deleted  # the second repository's own 31st-40th builds are deleted too


def test_the_same_repository_twice_or_an_empty_dump_is_bad_input(tmp_path, capsys):
    d = Dumps(tmp_path)
    d.more_images = [d.images]  # the same repository listed twice: counts would double
    assert gate.main(d.argv()) == 2 and not d.out.exists()
    assert "두 번" in capsys.readouterr().out
    d = Dumps(tmp_path)
    d.more_images = [[]]  # a repository whose list came back empty is most likely the wrong file
    assert gate.main(d.argv()) == 2 and not d.out.exists()


def test_a_reference_off_our_registry_is_counted_apart_with_its_reason_and_does_not_fail(tmp_path, capsys):
    d = Dumps(tmp_path)
    d.mig = {"startup": f"docker run {HOST}/backend:backend-tag45 && docker run {SQL_PROXY} && docker run us-docker.pkg.dev/other-project/lib/redis:7"}
    assert gate.main(d.argv()) == 0
    out = capsys.readouterr().out
    assert "범위 밖 2건" in out
    assert f"{SQL_PROXY}" in out and "외부 레지스트리(gcr.io)" in out
    assert "us-docker.pkg.dev/other-project/lib/redis:7" in out and f"우리 AR 호스트({AR_HOST})가 아님: us-docker.pkg.dev" in out
    assert "--extra 1번째" in out  # where it came from
    kept = json.loads(d.out.read_text())[0]["condition"]["versionNamePrefixes"]
    assert len(kept) == 3, "an out-of-scope reference protects nothing and adds no prefix: service · job · MIG image only"


def test_an_address_the_gate_does_not_recognise_is_not_counted_as_out_of_scope(tmp_path, capsys):
    """only a registry known to be elsewhere counts: an unknown host could be anything, and «모르면 실패한다»"""
    d = Dumps(tmp_path)
    d.mig = {"startup": f"docker run {HOST}/backend:backend-tag45 registry.example.com/team/app:1"}
    assert gate.main(d.argv()) == 0
    assert "범위 밖" not in capsys.readouterr().out  # not claimed as out of scope (and nothing depends on it)
    d = Dumps(tmp_path)
    d.mig = {"startup": "docker run registry.example.com/team/app:1"}
    assert gate.main(d.argv()) == 3 and not d.out.exists()  # a lone unrecognised address: the template shows no image at all


def test_external_refs_cover_the_known_registries_and_skip_urls_and_unknown_hosts():
    def found(text: str) -> list[tuple[str, str]]:
        return [(r["image"], r["ref"]) for r in gate.external_refs_in(json.dumps(text))]

    assert found("gcr.io/google.com/cloudsdktool/cloud-sdk:slim") == [("gcr.io/google.com/cloudsdktool/cloud-sdk", ":slim")]
    assert found("docker.io/library/redis@sha256:" + "a" * 64) == [("docker.io/library/redis", "@sha256:" + "a" * 64)]
    assert found("us.gcr.io/p/i") == [("us.gcr.io/p/i", "")]
    assert found("ghcr.io/o/r:1 quay.io/o/r:2 mcr.microsoft.com/dotnet/aspnet:8.0") == [("ghcr.io/o/r", ":1"), ("quay.io/o/r", ":2"), ("mcr.microsoft.com/dotnet/aspnet", ":8.0")]
    assert found("echo hi\ngcr.io/x/y:1") == [("gcr.io/x/y", ":1")], "an image at the start of the line after a newline (`\\n` in the JSON text) is found"
    assert found("see https://ghcr.io/x/y:1 for the page") == [], "a URL is not an image reference"
    assert found("registry.example.com/team/app:1") == [] and found("redis:7") == []
    assert found(f"{HOST}/backend:abc") == [], "our own registry is not an external one"


def test_an_extra_without_images_is_a_visible_warning_not_a_failure(tmp_path, capsys):
    d = Dumps(tmp_path)
    d.more_extra = [{"startup": "no image here"}]
    assert gate.main(d.argv()) == 0 and d.out.exists()
    out = capsys.readouterr().out
    assert "⚠️ --extra 2번째" in out and "경고 1건" in out
    # positive control: with NO image in any extra there is nothing of the VM side to see — that is still exit 3
    d = Dumps(tmp_path)
    d.mig = {"startup": "no image here"}
    d.more_extra = [{"startup": "none here either"}]
    assert gate.main(d.argv()) == 3 and not d.out.exists()


def test_an_extra_that_holds_only_an_out_of_scope_image_has_been_read():
    c = gate.collect(extra=[{"startup": f"docker run {SQL_PROXY}"}, {"startup": f"docker run {HOST}/backend:backend-tag45"}], hosts={AR_HOST})
    assert not c.problems and not c.warnings and len(c.outside) == 1


def test_a_tagged_serving_revision_with_a_sidecar_from_elsewhere_is_unresolved():
    """one `status.imageDigest` cannot say whether it belongs to our container or the sidecar: not guessed"""
    service = [_service("s", "rev-2", f"{HOST}/backend:backend-tag2")]
    both = {"metadata": {"name": "rev-2"}, "spec": {"containers": [{"image": f"{HOST}/backend:backend-tag2"}, {"image": SQL_PROXY}]}, "status": {"imageDigest": _digest(2)}}
    assert gate.collect(service, [both], hosts={AR_HOST}).problems
    pinned = {"metadata": {"name": "rev-2"}, "spec": {"containers": [{"image": f"{HOST}/backend@{_digest(2)}"}, {"image": SQL_PROXY}]}}
    assert not gate.collect(service, [pinned], hosts={AR_HOST}).problems  # pinned by digest: nothing to resolve
    ours = _revision("rev-2", f"{HOST}/backend:backend-tag2", image_digest=_digest(2))
    assert not gate.collect(service, [ours], hosts={AR_HOST}).problems  # positive control: the same revision without the sidecar is fine


def test_a_service_whose_only_image_is_off_our_registry_is_read_not_missing():
    hello = _service("hello", "hello-1", "gcr.io/cloudrun/hello")
    rev = {"metadata": {"name": "hello-1"}, "spec": {"containers": [{"image": "gcr.io/cloudrun/hello"}]}, "status": {"imageDigest": "gcr.io/cloudrun/hello@sha256:" + "b" * 64}}
    job = {"metadata": {"name": "j"}, "spec": {"template": {"spec": {"template": {"spec": {"containers": [{"image": "ghcr.io/o/job:1"}]}}}}}}
    c = gate.collect([hello], [rev], [job], hosts={AR_HOST})
    assert not c.problems and not c.refs and {o["image"] for o in c.outside} == {"gcr.io/cloudrun/hello", "ghcr.io/o/job"}
    empty = {"metadata": {"name": "j2"}, "spec": {}}
    assert gate.collect(None, None, [empty], hosts={AR_HOST}).problems  # positive control: a job with no image at all is still incomplete


def test_without_dump_hosts_every_registry_reference_stays_inside_the_scope():
    """a dump that carries no repository path gives no host to compare: the AR references are all kept as in-use candidates (못 찾으면 실패)"""
    refs, _warnings, _problems = gate.collect_in_use_refs(extra=[{"s": "docker run us-docker.pkg.dev/p/r/app:1"}])
    assert [r["package"] for r in refs] == ["app"]
    c = gate.collect(extra=[{"s": "docker run us-docker.pkg.dev/p/r/app:1"}], hosts={AR_HOST})
    assert not c.refs and len(c.outside) == 1
