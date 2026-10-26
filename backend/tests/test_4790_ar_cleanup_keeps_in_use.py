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

    def argv(self, *extra_args: str, with_mig: bool = True) -> list[str]:
        files = {"images": self.images, "services": self.services, "revisions": self.revisions, "jobs": self.jobs}
        paths = {}
        for key, data in files.items():
            paths[key] = self.dir / f"{key}.json"
            paths[key].write_text(json.dumps(data))
        argv = ["--images", str(paths["images"]), "--run-services", str(paths["services"]), "--run-revisions", str(paths["revisions"]),
                "--run-jobs", str(paths["jobs"]), "--emit-policy", str(self.out), "--now", NOW.isoformat(), *extra_args]
        if with_mig:
            mig = self.dir / "mig.json"
            mig.write_text(json.dumps(self.mig))
            argv += ["--extra", str(mig)]
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
    services = [_service("sprintable-backend-prod", "rev-2", f"{HOST}/backend:backend-tag2")]
    revisions = [_revision("rev-1", f"{HOST}/backend:backend-tag50"), _revision("rev-2", f"{HOST}/backend:backend-tag2", image_digest=_digest(2))]
    refs, warnings, problems = gate.collect_in_use_refs(services, revisions)
    in_use, _ = gate.resolve_in_use(refs, _versions())
    assert in_use == {("backend", _digest(2))} and not warnings and not problems  # rev-1 serves nothing: its 50-day-old image is not protected


def test_without_a_service_list_every_revision_counts_as_in_use():
    revisions = [_revision("rev-1", f"{HOST}/backend:backend-tag50")]
    refs, warnings, _problems = gate.collect_in_use_refs(None, revisions)
    in_use, _ = gate.resolve_in_use(refs, _versions())
    assert in_use == {("backend", _digest(50))} and warnings  # the safe side, said out loud


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
    assert old in kept and new in kept

    # a serving revision deployed by tag whose dump has no resolved digest: the gate does not guess which digest it runs — exit 3, no policy
    d.revisions = [_revision("rev-9", f"{HOST}/backend:latest")]
    assert gate.main(d.argv()) == 3 and not d.out.exists()


def test_cli_ok_writes_the_generated_policy(tmp_path):
    d = Dumps(tmp_path)
    assert gate.main(d.argv("--expect-services", "1", "--expect-jobs", "1")) == 0
    written = json.loads(d.out.read_text())
    assert written[0]["name"] == "keep-in-use"
    assert {_digest(2), _digest(3), _digest(45)} <= set(written[0]["condition"]["versionNamePrefixes"])  # service tag · job tag · MIG tag


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
    assert gate.main(d.argv("--no-extra", with_mig=False)) == 0
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
    assert [r["name"] for r in base] == ["keep-recent-30", "delete-older-than-30d"]
    assert base[0]["action"]["type"] == "Keep" and base[0]["mostRecentVersions"]["keepCount"] == 30
    assert base[1]["action"]["type"] == "Delete" and base[1]["condition"]["olderThan"] == "2592000s"
    # keep-in-use is never committed with a digest list: it is generated right before applying (a stale list must not become the source of truth)
    assert all(r["name"] != "keep-in-use" for r in base)
