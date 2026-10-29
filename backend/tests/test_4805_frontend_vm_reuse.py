"""story 4805 (INFRA-DIET 12) — the VM's frontend image is not built again when the frontend did not change.

Measured (the 8 days before 2026-10-29): in 12 of the 13 dispatches since the dev frontend moved into the VM bundle build, no frontend input had changed since the dispatch before, and the Next.js build
took 6.6 minutes each time. The build now has an input id (deploy/vm/bin/frontend_input_id.py): the frontend's sources, the digests of its base images, the build values and the build scripts.
An image an earlier FULL build made from the same id is reused — only the commit and the build time are put on top again (deploy/vm/frontend-restamp/Dockerfile, deploy/vm/bin/frontend-vm-image.sh).

Pinned: what is in the id and what is not (a document or a backend file is not; a source, a base image digest, a build value, the environment, a build script is), that the Dockerfile's COPY sources
are all counted (a new COPY of an uncounted folder stops the reuse instead of reusing old code), that an unpinned base image is never reused, that the restamp does what the last layers of
apps/web/Dockerfile do, and — run for real against a fake docker — the order and the fallbacks of the script: a tag present → restamp; absent / failed / wrong commit → the full build; the id tag only on
an image a full build made and pushed.
"""
from __future__ import annotations

import importlib.util
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

_ROOT = Path(__file__).resolve().parents[2]
_VMDIR = _ROOT / "deploy/vm"
sys.path.insert(0, str(_VMDIR / "bin"))


def _load(name: str):
    spec = importlib.util.spec_from_file_location(name, _VMDIR / "bin" / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


FI = _load("frontend_input_id")
SETS = {
    "NEXT_PUBLIC_GA4_MEASUREMENT_ID": "", "NEXT_PUBLIC_EE_ENABLED": "true", "NEXT_PUBLIC_SUPPORT_WIDGET_ENABLED": "true",
    "NEXT_PUBLIC_SUPPORT_GATEWAY_URL": "https://gateway.example", "NEXT_PUBLIC_TOSS_CLIENT_KEY": "",
}
SHA = "0123456789abcdef0123456789abcdef01234567"
NAME = "asia-northeast3-docker.pkg.dev/proj-1/sprintable/frontend-vm"
BASE_DIGEST = "sha256:" + "a" * 64
FULL_DIGEST = "sha256:" + "f" * 64


def _mini_root(tmp: Path) -> Path:
    """a small repository with the real build scripts, the real Dockerfile and declarations, and a few stand-in sources"""
    root = tmp / "repo"
    for rel in ("deploy/vm/bin", "deploy/vm/env", "deploy/vm/frontend-restamp"):
        shutil.copytree(_ROOT / rel, root / rel)
    (root / "apps/web/src").mkdir(parents=True)
    shutil.copy(_ROOT / "apps/web/Dockerfile", root / "apps/web/Dockerfile")
    (root / "apps/web/src/page.tsx").write_text("export default function P() { return null }\n")
    (root / "apps/web/package.json").write_text('{"name": "web"}\n')
    (root / "packages/ui").mkdir(parents=True)
    (root / "packages/ui/index.ts").write_text("export const ui = 1\n")
    (root / "ee").mkdir()
    (root / "ee/e.ts").write_text("export const e = 1\n")
    for f, body in (("package.json", "{}\n"), ("pnpm-lock.yaml", "lock: 1\n"), ("pnpm-workspace.yaml", "packages: []\n"), (".dockerignore", "node_modules\n")):
        (root / f).write_text(body)
    (root / "docs").mkdir()
    (root / "docs/notes.md").write_text("notes\n")
    (root / "README.md").write_text("readme\n")
    (root / "backend").mkdir()
    (root / "backend/app.py").write_text("x = 1\n")
    return root


def _id(root: Path, env: str = "dev", sets: dict[str, str] | None = None) -> str:
    return FI.input_id(root, root / f"deploy/vm/env/{env}.yaml", SETS if sets is None else sets)


@pytest.fixture()
def root(tmp_path: Path) -> Path:
    return _mini_root(tmp_path)


# ───────────────────────── what is in the id ─────────────────────────

def test_the_id_is_the_same_for_the_same_inputs_and_has_the_tag_shape(root: Path, tmp_path: Path) -> None:
    a = _id(root)
    assert re.fullmatch(r"inputs-[0-9a-f]{32}", a)
    assert _id(root) == a
    other = tmp_path / "copy"
    shutil.copytree(root, other)
    assert _id(other) == a, "the id is of the content, not of the place"


@pytest.mark.parametrize("rel,body", [
    ("docs/notes.md", "changed notes\n"), ("README.md", "changed\n"), ("backend/app.py", "x = 2\n"), ("docs/new.md", "a new document\n"),
    ("apps/web/node_modules/dep/index.js", "module.exports = 1\n"), ("apps/web/.next/cache/x", "cache\n"), ("packages/ui/node_modules/y", "y\n"),
])
def test_what_is_not_in_the_image_does_not_change_the_id(root: Path, rel: str, body: str) -> None:
    before = _id(root)
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(body)
    assert _id(root) == before


@pytest.mark.parametrize("rel", [
    "apps/web/src/page.tsx", "apps/web/package.json", "packages/ui/index.ts", "ee/e.ts", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".dockerignore",
    "deploy/vm/bin/build-frontend-vm.sh", "deploy/vm/bin/frontend-vm-image.sh", "deploy/vm/bin/frontend_build_args.py", "deploy/vm/bin/render_env.py", "deploy/vm/bin/frontend_input_id.py",
    "deploy/vm/frontend-restamp/Dockerfile",
])
def test_a_change_in_an_input_changes_the_id(root: Path, rel: str) -> None:
    before = _id(root)
    p = root / rel
    p.write_text(p.read_text() + "\n# changed\n")
    assert _id(root) != before


@pytest.mark.parametrize("rel", ["apps/web/src/new.tsx", "packages/ui/new.ts", "ee/new.ts"])
def test_a_new_file_in_an_input_folder_changes_the_id(root: Path, rel: str) -> None:
    before = _id(root)
    (root / rel).write_text("export const n = 1\n")
    assert _id(root) != before


def test_the_same_content_under_another_name_is_another_id(root: Path) -> None:
    before = _id(root)
    (root / "packages/ui/index.ts").rename(root / "packages/ui/renamed.ts")
    assert _id(root) != before


def test_two_files_that_swap_their_contents_are_another_id(root: Path) -> None:
    (root / "packages/ui/b.ts").write_text("export const b = 2\n")
    before = _id(root)
    a, b = root / "packages/ui/index.ts", root / "packages/ui/b.ts"
    ta, tb = a.read_text(), b.read_text()
    a.write_text(tb)
    b.write_text(ta)
    assert _id(root) != before


def test_a_removed_input_file_changes_the_id(root: Path) -> None:
    before = _id(root)
    (root / "packages/ui/index.ts").unlink()
    assert _id(root) != before


@pytest.mark.parametrize("name", list(SETS))
def test_each_public_build_value_is_in_the_id(root: Path, name: str) -> None:
    changed = {**SETS, name: SETS[name] + "-other"}
    assert _id(root, sets=changed) != _id(root)


def test_the_environment_is_in_the_id_through_its_hosts(root: Path) -> None:
    assert _id(root, "dev") != _id(root, "prod")


def test_the_base_image_digests_are_in_the_id_not_only_the_dockerfile_bytes(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """a new base image (the security patch of the node image) must make a new id even if everything else is byte for byte the same"""
    before = _id(root)
    real = FI.base_digests
    monkeypatch.setattr(FI, "base_digests", lambda text: [d.replace("0", "1", 1) for d in real(text)])
    assert _id(root) != before


def test_the_dockerfile_base_digest_is_read_and_a_new_digest_makes_a_new_id(root: Path) -> None:
    text = (root / "apps/web/Dockerfile").read_text()
    digests = FI.base_digests(text)
    assert digests and all(re.fullmatch(r"sha256:[0-9a-f]{64}", d) for d in digests)
    before = _id(root)
    (root / "apps/web/Dockerfile").write_text(text.replace(digests[0], "sha256:" + "0" * 64))
    assert _id(root) != before


# ───────────────────────── what stops the reuse ─────────────────────────

def test_a_base_image_named_by_a_tag_is_never_reused(root: Path) -> None:
    text = (root / "apps/web/Dockerfile").read_text()
    digest = FI.base_digests(text)[0]
    (root / "apps/web/Dockerfile").write_text(text.replace(f"@{digest}", "", 1))
    with pytest.raises(FI.NotReusable, match="tag, not a digest"):
        _id(root)


def test_a_stage_that_starts_from_an_earlier_stage_needs_no_digest(root: Path) -> None:
    text = "FROM node:22@sha256:" + "1" * 64 + " AS base\nFROM base AS deps\nFROM deps AS builder\nFROM node:22@sha256:" + "2" * 64 + " AS runner\n"
    assert FI.base_digests(text) == ["sha256:" + "1" * 64, "sha256:" + "2" * 64]


def test_a_copy_of_a_folder_that_is_not_counted_stops_the_reuse(root: Path) -> None:
    """new code in a folder the Dockerfile copies but the id does not count would be built into nothing: an old image would be reused for it"""
    p = root / "apps/web/Dockerfile"
    p.write_text(p.read_text() + "\nCOPY contracts/ contracts/\n")
    with pytest.raises(FI.NotReusable, match="contracts"):
        _id(root)


def test_a_copy_from_another_stage_is_not_a_context_source() -> None:
    text = "FROM node@sha256:" + "1" * 64 + " AS builder\nCOPY --from=builder --chown=a:b /app/x ./x\nCOPY a/ b/\nCOPY --chown=u:g c.txt d.txt e/\nCOPY --from=0 /y /y\n"
    assert FI.copy_sources(text) == ["a", "c.txt", "d.txt"]


@pytest.mark.parametrize("line", [
    "COPY --from=alpine:latest /bin/x /x", "COPY --from=other /bin/x /x", "COPY --from=ghcr.io/x/y@sha256:" + "1" * 64 + " /a /a",
])
def test_a_copy_from_an_image_that_is_not_a_stage_of_the_dockerfile_stops_the_reuse(line: str) -> None:
    """the tag of an external image can move without a line of ours changing: its content would not be in the id"""
    with pytest.raises(FI.NotReusable, match="not a stage"):
        FI.copy_sources("FROM node@sha256:" + "1" * 64 + " AS builder\n" + line + "\n")


@pytest.mark.parametrize("src", ["packages/../.npmrc", "../outside", "/etc/hosts", ".", ".."])
def test_a_copy_source_outside_the_context_or_through_dotdot_stops_the_reuse(src: str) -> None:
    with pytest.raises(FI.NotReusable, match="not a path inside the build context"):
        FI.copy_sources(f"FROM node@sha256:{'1' * 64} AS builder\nCOPY {src} dest/\n")


def test_the_real_dockerfile_copy_sources_are_all_counted_and_the_real_tree_has_an_id() -> None:
    text = (_ROOT / "apps/web/Dockerfile").read_text()
    sources = FI.copy_sources(text)
    assert sources, "the Dockerfile copies something from the context"
    uncounted = [s for s in sources if not FI._covered(s)]
    assert not uncounted, f"the Dockerfile copies {uncounted} which the input id does not count — add them to INPUT_PATHS in deploy/vm/bin/frontend_input_id.py"
    for env in ("dev", "prod"):
        assert re.fullmatch(r"inputs-[0-9a-f]{32}", FI.input_id(_ROOT, _VMDIR / f"env/{env}.yaml", SETS))


def test_the_command_prints_the_id_or_nothing(root: Path) -> None:
    args = [sys.executable, str(root / "deploy/vm/bin/frontend_input_id.py"), str(root / "deploy/vm/env/dev.yaml"), "--root", str(root)]
    for k, v in SETS.items():
        args += ["--set", f"{k}={v}"]
    p = subprocess.run(args, capture_output=True, text=True)
    assert p.returncode == 0 and p.stdout.strip() == _id(root)
    p = subprocess.run(args[:-2], capture_output=True, text=True)  # one of the five values missing: no id
    assert p.returncode == 3 and p.stdout == "" and "missing --set" in p.stderr


# ───────────────────────── the restamp ─────────────────────────

def test_the_restamp_does_what_the_last_layers_of_the_dockerfile_do() -> None:
    """the image still tells which commit it is: the same three lines as the runner stage of apps/web/Dockerfile, run as root as they are there (before USER nextjs)"""
    main = (_ROOT / "apps/web/Dockerfile").read_text()
    stamp = (_VMDIR / "frontend-restamp/Dockerfile").read_text()
    for line in re.findall(r"(?m)^(?:ARG APP_COMMIT_SHA=unknown|RUN date -u [^\n]*|ENV APP_COMMIT_SHA=\$\{APP_COMMIT_SHA\})$", main):
        assert line in stamp.splitlines(), line
    lines = [x for x in stamp.splitlines() if x and not x.startswith("#")]
    assert lines[0] == "ARG BASE" and lines[1] == "FROM ${BASE}"
    assert lines.index("USER root") < lines.index("USER nextjs") == len(lines) - 1, "root writes the file, the image runs as the app user again"
    assert lines.index("USER root") < next(i for i, x in enumerate(lines) if x.startswith("RUN date"))


# ───────────────────────── the script, run for real against a fake docker ─────────────────────────

_FAKE_DOCKER = r"""#!/bin/sh
echo "docker $*" >> "$FAKE_LOG"
case "$1" in
  pull) [ "$FAKE_PULL_OK" = 1 ] || exit 1 ;;
  build)
    case "$*" in *"-f apps/web/Dockerfile"*) [ -z "$FAKE_FULL_BUILD_FAILS" ] || exit 1 ;; esac ;;
  tag) : ;;
  push)
    case "$2" in *:inputs-*) [ -z "$FAKE_TAG_PUSH_FAILS" ] || exit 1 ;; esac ;;
  run)
    case "$*" in
      *APP_COMMIT_SHA*) printf '%s' "$FAKE_STAMPED" ;;
      *".build_time"*) [ -n "$FAKE_NO_BUILD_TIME" ] || echo yes ;;
      *"-rlF"*) echo 1 ;;
      *"/web/public"*) echo 0 ;;
      *"-rlE"*) echo 0 ;;
    esac ;;
  image)
    # image inspect --format … <name>:<tag>
    last=""; for a in "$@"; do last="$a"; done
    case "$last" in
      *:inputs-*) echo "${last%:*}@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" ;;
      *) if [ -n "${FAKE_FULL_REF+x}" ]; then printf '%s\n' "$FAKE_FULL_REF"; else echo "${last%:*}@sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"; fi ;;
    esac ;;
esac
exit 0
"""


@pytest.fixture()
def box(root: Path, tmp_path: Path):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "docker").write_text(_FAKE_DOCKER)
    (bin_dir / "docker").chmod(0o755)
    log = tmp_path / "calls.log"
    log.write_text("")

    def run(env: str = "dev", sets: dict[str, str] | None = None, sha: str = SHA, **fake: str):
        s = SETS if sets is None else sets
        argv = ["bash", str(root / "deploy/vm/bin/frontend-vm-image.sh"), env, sha, NAME]
        for k, v in s.items():
            argv += ["--set", f"{k}={v}"]
        e = {"PATH": f"{bin_dir}:{Path(sys.executable).parent}:/usr/bin:/bin:/usr/local/bin", "HOME": os.environ["HOME"], "FAKE_LOG": str(log),
             "FAKE_STAMPED": SHA, **fake}
        log.write_text("")
        p = subprocess.run(argv, env=e, cwd=root, capture_output=True, text=True, timeout=120)
        return p, [c for c in log.read_text().splitlines() if c.startswith("docker ")]

    run.root = root
    return run


def _builds(calls: list[str]) -> list[str]:
    return [c for c in calls if c.startswith("docker build")]


def _full_builds(calls: list[str]) -> list[str]:
    return [c for c in _builds(calls) if "-f apps/web/Dockerfile" in c]


def _restamps(calls: list[str]) -> list[str]:
    return [c for c in _builds(calls) if "frontend-restamp/Dockerfile" in c]


def test_an_image_made_from_the_same_inputs_is_reused_with_the_commit_put_on_top(box) -> None:
    id_ = _id(box.root)
    p, calls = box(FAKE_PULL_OK="1")
    assert p.returncode == 0, p.stderr
    assert p.stdout.strip().splitlines()[-1] == f"{NAME}@{FULL_DIGEST}", "the last line is the digest reference of the new image"
    assert f"docker pull --platform linux/amd64 {NAME}:{id_}" in calls
    assert _full_builds(calls) == [], "no Next.js build"
    (stamp,) = _restamps(calls)
    assert f"--build-arg BASE={NAME}@{BASE_DIGEST}" in stamp, "put on top of the earlier image, by digest"
    assert f"--build-arg APP_COMMIT_SHA={SHA}" in stamp and f"-t {NAME}:{SHA}" in stamp and "--platform linux/amd64" in stamp
    assert f"docker push {NAME}:{SHA}" in calls
    assert not any(c.startswith("docker tag") or f":{id_}" in c and c.startswith("docker push") for c in calls), "a restamped image never gets the input id tag"


def test_without_an_earlier_image_the_frontend_is_built_in_full_and_the_input_id_is_tagged_after_the_push(box) -> None:
    id_ = _id(box.root)
    p, calls = box(FAKE_PULL_OK="0")
    assert p.returncode == 0, p.stderr
    assert p.stdout.strip().splitlines()[-1] == f"{NAME}@{FULL_DIGEST}"
    assert len(_full_builds(calls)) == 1 and _restamps(calls) == []
    push_at = calls.index(f"docker push {NAME}:{SHA}")
    tag_at = calls.index(f"docker tag {NAME}:{SHA} {NAME}:{id_}")
    assert push_at < tag_at < calls.index(f"docker push {NAME}:{id_}"), "the id tag goes on an image that is already pushed"
    assert "NEXT_PUBLIC_FASTAPI_URL=https://dev-api.sprintable.ai" in _full_builds(calls)[0] + " ", "the full build is the one of build-frontend-vm.sh"


@pytest.mark.parametrize("stamped", ["", "someotherthing", "0123456"])
def test_a_restamped_image_that_does_not_carry_the_commit_is_not_pushed_the_full_build_follows(box, stamped: str) -> None:
    p, calls = box(FAKE_PULL_OK="1", FAKE_STAMPED=stamped)
    assert p.returncode == 0, p.stderr
    assert len(_restamps(calls)) == 1 and len(_full_builds(calls)) == 1
    assert calls.index(next(c for c in calls if "frontend-restamp" in c)) < calls.index(_full_builds(calls)[0])
    pushes = [c for c in calls if c.startswith(f"docker push {NAME}:{SHA}")]
    assert len(pushes) == 1 and calls.index(pushes[0]) > calls.index(_full_builds(calls)[0]), "nothing is pushed from the failed restamp"


def test_a_restamped_image_without_a_build_time_is_not_pushed_the_full_build_follows(box) -> None:
    p, calls = box(FAKE_PULL_OK="1", FAKE_NO_BUILD_TIME="1")
    assert p.returncode == 0, p.stderr
    assert len(_restamps(calls)) == 1 and len(_full_builds(calls)) == 1
    assert calls.index(_full_builds(calls)[0]) < calls.index(f"docker push {NAME}:{SHA}"), "the only push is the one of the full build"


@pytest.mark.parametrize("ref", [
    "", "garbage", f"{NAME}@sha256:abc123", f"{NAME}@sha256:" + "F" * 64, f"{NAME}:{SHA}",
    "asia-northeast3-docker.pkg.dev/proj-1/sprintable/frontend@sha256:" + "f" * 64,  # the Cloud Run image, not the VM's
    "evil.example/sprintable/frontend-vm@sha256:" + "f" * 64,
])
def test_a_full_build_that_does_not_end_in_our_digest_reference_fails_and_tags_nothing(box, ref: str) -> None:
    p, calls = box(FAKE_PULL_OK="0", FAKE_FULL_REF=ref)
    assert p.returncode != 0 and "not a digest reference" in p.stderr
    assert not any(c.startswith("docker tag") for c in calls) and not any(f":inputs-" in c for c in calls if c.startswith("docker push"))


def test_a_failing_full_build_fails_the_step_and_tags_nothing(box) -> None:
    p, calls = box(FAKE_PULL_OK="0", FAKE_FULL_BUILD_FAILS="1")
    assert p.returncode != 0
    assert not any(c.startswith("docker tag") or c.startswith("docker push") for c in calls)


def test_a_failing_id_tag_push_does_not_fail_the_step(box) -> None:
    p, calls = box(FAKE_PULL_OK="0", FAKE_TAG_PUSH_FAILS="1")
    assert p.returncode == 0, p.stderr
    assert p.stdout.strip().splitlines()[-1] == f"{NAME}@{FULL_DIGEST}"
    assert "could not tag" in p.stderr


def test_a_base_image_named_by_a_tag_goes_straight_to_the_full_build_without_looking_for_an_earlier_image(box) -> None:
    text = (box.root / "apps/web/Dockerfile").read_text()
    digest = FI.base_digests(text)[0]
    (box.root / "apps/web/Dockerfile").write_text(text.replace(f"@{digest}", "", 1))
    p, calls = box(FAKE_PULL_OK="1")
    assert p.returncode == 0, p.stderr
    assert "no input id" in p.stdout and "tag, not a digest" in p.stderr
    assert not any(c.startswith("docker pull") for c in calls) and _restamps(calls) == []
    assert len(_full_builds(calls)) == 1 and not any(c.startswith("docker tag") for c in calls), "nothing is tagged with an id that was never told"


def test_a_copy_source_that_is_not_counted_goes_to_the_full_build(box) -> None:
    p_ = box.root / "apps/web/Dockerfile"
    p_.write_text(p_.read_text() + "\nCOPY contracts/ contracts/\n")
    p, calls = box(FAKE_PULL_OK="1")
    assert p.returncode == 0, p.stderr
    assert "not among the inputs" in p.stderr and _restamps(calls) == [] and len(_full_builds(calls)) == 1


def test_a_changed_frontend_source_looks_for_a_different_image(box) -> None:
    first = _id(box.root)
    (box.root / "apps/web/src/page.tsx").write_text("export default function P() { return 1 }\n")
    p, calls = box(FAKE_PULL_OK="1")
    assert p.returncode == 0, p.stderr
    pulled = next(c for c in calls if c.startswith("docker pull"))
    assert pulled.endswith(_id(box.root)) and not pulled.endswith(first)


def test_a_document_only_change_looks_for_the_same_image(box) -> None:
    first = _id(box.root)
    (box.root / "docs/notes.md").write_text("another sentence\n")
    (box.root / "backend/app.py").write_text("x = 3\n")
    p, calls = box(FAKE_PULL_OK="1")
    assert p.returncode == 0, p.stderr
    assert next(c for c in calls if c.startswith("docker pull")).endswith(first) and _full_builds(calls) == []


def test_prod_and_dev_do_not_share_an_image(box) -> None:
    p, dev_calls = box("dev", FAKE_PULL_OK="1")
    q, prod_calls = box("prod", FAKE_PULL_OK="1")
    assert p.returncode == 0 and q.returncode == 0, (p.stderr, q.stderr)
    assert next(c for c in dev_calls if c.startswith("docker pull")) != next(c for c in prod_calls if c.startswith("docker pull"))


@pytest.mark.parametrize("args,said", [
    (["dev", SHA], "usage"), (["dev", "NOTHEX", NAME], "lower-case hex"), (["dev", SHA.upper(), NAME], "lower-case hex"), (["dev", "abc", NAME], "lower-case hex"),
    (["dev", SHA, NAME, "--bogus"], "unknown argument"), (["dev", SHA, NAME, "--set"], "--set needs"),
])
def test_bad_arguments_stop_the_script_before_docker(box, args: list[str], said: str) -> None:
    log = box.root.parent / "calls.log"
    p = subprocess.run(["bash", str(box.root / "deploy/vm/bin/frontend-vm-image.sh"), *args], capture_output=True, text=True, cwd=box.root,
                       env={"PATH": f"{box.root.parent / 'bin'}:{Path(sys.executable).parent}:/usr/bin:/bin", "FAKE_LOG": str(log)})
    assert p.returncode == 2 and said in p.stderr, p.stderr
    assert not log.read_text().strip()


# ───────────────────────── the build file ─────────────────────────

def test_the_vm_build_step_runs_the_script_with_the_environment_the_commit_and_the_image_name() -> None:
    vm = yaml.safe_load((_ROOT / "cloudbuild-vm.yaml").read_text())
    script = next(s for s in vm["steps"] if s["id"] == "build-frontend-vm")["args"][1]
    assert 'deploy/vm/bin/frontend-vm-image.sh "${_DEPLOY_ENV}" "${COMMIT_SHA}" "$$repo/frontend-vm"' in script
    assert "build-frontend-vm.sh" not in script.replace("frontend-vm-image.sh", ""), "the full build is only reached through the script that decides"
    for v in ("NEXT_PUBLIC_GA4_MEASUREMENT_ID", "NEXT_PUBLIC_EE_ENABLED", "NEXT_PUBLIC_SUPPORT_WIDGET_ENABLED", "NEXT_PUBLIC_SUPPORT_GATEWAY_URL", "NEXT_PUBLIC_TOSS_CLIENT_KEY"):
        assert f'--set "{v}=' in script, v
    assert len(script.encode()) < 6000, "a Cloud Build step has a size limit"


def test_the_commit_the_script_accepts_is_the_commit_the_health_route_reads() -> None:
    """a 64-character commit would pass an image check on the raw environment and still show as `unknown` in /api/health"""
    route = (_ROOT / "apps/web/src/app/api/health/route.ts").read_text()
    lo, hi = re.search(r"const SHA = /\^\[0-9a-f\]\{(\d+),(\d+)\}\$/;", route).groups()
    script = (_VMDIR / "bin/frontend-vm-image.sh").read_text()
    assert f'[[ "$sha" =~ ^[0-9a-f]{{{lo},{hi}}}$ ]]' in script


@pytest.mark.parametrize("sha", ["NOTHEX", SHA.upper(), "abc", "0123456 && echo x", "", "a" * 41, "a" * 64])
def test_a_commit_that_is_not_lower_case_hex_is_never_put_on_an_image(box, sha: str) -> None:
    """with an earlier image present and every value given, only the script's own check stands between a bad commit and a restamp (the build script has its own, later)"""
    p, calls = box(sha=sha, FAKE_PULL_OK="1")
    assert p.returncode == 2 and "lower-case hex" in p.stderr
    assert calls == []


# ───────────────────────── the line that says which it was ─────────────────────────

def test_one_line_says_reused_or_built_for_the_re_measurement(box) -> None:
    id_ = _id(box.root)
    p, _ = box(FAKE_PULL_OK="1")
    assert re.findall(r"(?m)^frontend-vm-reuse: .*$", p.stdout + p.stderr) == [f"frontend-vm-reuse: reused {id_}"]
    p, _ = box(FAKE_PULL_OK="0")
    assert re.findall(r"(?m)^frontend-vm-reuse: .*$", p.stdout + p.stderr) == [f"frontend-vm-reuse: built {id_}"]
    p, _ = box(FAKE_PULL_OK="1", FAKE_STAMPED="wrong")  # a restamp that failed is a build, and says so once
    assert re.findall(r"(?m)^frontend-vm-reuse: .*$", p.stdout + p.stderr) == [f"frontend-vm-reuse: built {id_}"]


def test_the_line_says_none_when_there_is_no_id(box) -> None:
    text = (box.root / "apps/web/Dockerfile").read_text()
    (box.root / "apps/web/Dockerfile").write_text(text.replace(f"@{FI.base_digests(text)[0]}", "", 1))
    p, _ = box(FAKE_PULL_OK="1")
    assert re.findall(r"(?m)^frontend-vm-reuse: .*$", p.stdout + p.stderr) == ["frontend-vm-reuse: built none"]


def test_the_script_and_the_restamp_context_are_in_the_upload_of_the_build() -> None:
    ignore = (_ROOT / ".gitignore").read_text()
    assert not re.search(r"(?m)^/?deploy/?$|^/?deploy/vm/?$|^frontend-restamp", ignore)
    for rel in ("deploy/vm/bin/frontend-vm-image.sh", "deploy/vm/bin/frontend_input_id.py", "deploy/vm/frontend-restamp/Dockerfile"):
        assert (_ROOT / rel).is_file(), rel
