"""story 4798 (AC12) — every file that reads a secret's value is on `infra/secret-reads.yml`, and the list has nothing the repository no longer does.

The check itself is `infra/check_secret_reads.py` (what counts as a read is written at its top). Here: the repository as it is is exact; and the check really sees the shapes a reader can take — a command line, the words as separate list items
(the shape that escaped a one-line search and was found only when a build was refused), the client call, the client class, the REST path — and really does not see a reference (`--set-secrets`), a write (`versions add`), a document or a test."""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest
import yaml

_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_ROOT / "infra"))
import check_secret_reads as csr  # noqa: E402


def _tree(tmp_path: Path, files: dict[str, str]) -> list[Path]:
    out = []
    for rel, text in files.items():
        p = tmp_path / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")
        out.append(p)
    return out


def test_the_repository_is_exact_against_the_registry():
    found = csr.find_readers(_ROOT)
    problems = csr.compare(found, csr.load_registry())
    assert problems == [], problems
    assert len(found) >= 5  # the five known readers: a scan that finds nothing is not «exact», it is blind


def test_the_script_exits_zero_on_the_repository_and_prints_ok():
    r = subprocess.run([sys.executable, "-I", str(_ROOT / "infra" / "check_secret_reads.py")], capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stdout + r.stderr
    assert r.stdout.startswith("OK:")


@pytest.mark.parametrize(
    "name, text",
    [
        ("command line", 'X=$(gcloud secrets versions access latest --secret="A")\n'),
        ("command line, backslash continuation", "gcloud secrets versions \\\n  access latest --secret=A\n"),
        ("words as separate list items (double quotes)", 'run(["secrets", "versions", "access", v, "--secret=A"])\n'),
        ("words as separate list items (single quotes, a line break)", "args = ['secrets', 'versions',\n  'access']\n"),
        ("client call", "resp = client.access_secret_version(name=n)\n"),
        ("client method in another library's spelling (camel case)", "const [v] = await client.accessSecretVersion({ name });\n"),
        ("client method in another library's spelling (Pascal case)", "resp, err := c.AccessSecretVersion(ctx, req)\n"),
        ("REST path", 'curl "https://secretmanager.googleapis.com/v1/projects/p/secrets/s/versions/latest:access"\n'),
        ("a versions path ending :access", 'path = f"projects/{p}/secrets/{s}/versions/{v}:access"\n'),
    ],
)
def test_every_shape_of_a_read_is_seen(tmp_path, name, text):
    files = _tree(tmp_path, {"svc/reader.txt": text})
    assert list(csr.find_readers(tmp_path, files)) == ["svc/reader.txt"], name


@pytest.mark.parametrize(
    "name, text",
    [
        ("a reference", "gcloud run deploy x --set-secrets=A=A:latest --update-secrets=B=B:latest\n"),
        ("a write", "printf %s v | gcloud secrets versions add A --data-file=-\n"),
        ("an IAM binding", "gcloud secrets add-iam-policy-binding A --role=roles/secretmanager.secretAccessor\n"),
        ("enabling the API", "gcloud services enable secretmanager.googleapis.com\n"),
        ("creating the client object", "c = secretmanager.SecretManagerServiceClient()\n"),
        ("a write over REST", 'curl -X POST "https://secretmanager.googleapis.com/v1/projects/p/secrets/s:addVersion"\n'),
        ("describing a secret over REST", 'curl "https://secretmanager.googleapis.com/v1/projects/p/secrets/s"\n'),
        ("listing versions", "gcloud secrets versions list A\n"),
    ],
)
def test_a_reference_a_write_or_a_listing_is_not_a_read(tmp_path, name, text):
    files = _tree(tmp_path, {"svc/other.sh": text})
    assert csr.find_readers(tmp_path, files) == {}, name


def test_documents_tests_and_vendored_folders_are_not_scanned(tmp_path):
    text = 'gcloud secrets versions access latest --secret="A"\n'
    files = _tree(tmp_path, {"docs/howto.md": text, "backend/tests/test_x.py": text, "apps/web/src/a.test.ts": text, "node_modules/p/i.js": text, "pnpm-lock.yaml": text, "svc/real.sh": text})
    assert list(csr.find_readers(tmp_path, files)) == ["svc/real.sh"]


@pytest.mark.parametrize("rel", ["svc/test/helper.sh", "svc/build/deploy.sh", "svc/dist/run.py", "svc/image.svg", "svc/app.js.map", "svc/x.test.sh"])
def test_a_script_in_a_folder_called_test_build_or_dist_is_still_scanned(tmp_path, rel):
    files = _tree(tmp_path, {rel: 'gcloud secrets versions access latest --secret="A"\n'})
    assert list(csr.find_readers(tmp_path, files)) == [rel]


def test_a_file_with_odd_bytes_and_a_file_name_with_odd_characters_are_still_read(tmp_path):
    p = tmp_path / "svc" / "odd name é.sh"
    p.parent.mkdir(parents=True)
    p.write_bytes(b'\xff\xfe gcloud secrets versions access latest --secret="A"\n')
    assert list(csr.find_readers(tmp_path, [p])) == ["svc/odd name é.sh"]


def test_a_new_reader_is_a_failure_that_names_the_file_and_the_line(tmp_path):
    files = _tree(tmp_path, {"svc/new.py": "x = 1\nrun(['secrets', 'versions', 'access', 'latest'])\n"})
    problems = csr.compare(csr.find_readers(tmp_path, files), {})
    assert len(problems) == 1 and problems[0].startswith("NEW READER svc/new.py (line 2)")


def test_a_stale_entry_is_a_failure(tmp_path):
    problems = csr.compare({}, {"svc/gone.py": {"file": "svc/gone.py", "runs_as": "x", "reason": "y"}})
    assert len(problems) == 1 and problems[0].startswith("STALE ENTRY svc/gone.py")


def test_an_entry_needs_a_reason_and_a_runner_and_no_duplicates(tmp_path):
    def reg(readers):
        p = tmp_path / "r.yml"
        p.write_text(yaml.safe_dump({"readers": readers}))
        return p

    with pytest.raises(SystemExit):
        csr.load_registry(reg([{"file": "a", "runs_as": "x", "reason": "   "}]))
    with pytest.raises(SystemExit):
        csr.load_registry(reg([{"file": "a", "runs_as": "  ", "reason": "y"}]))
    with pytest.raises(SystemExit):
        csr.load_registry(reg([{"file": "a", "reason": "y"}]))
    with pytest.raises(SystemExit):
        csr.load_registry(reg([{"file": "a", "runs_as": "x", "reason": "y"}, {"file": "a", "runs_as": "x", "reason": "y"}]))
    bad_shape = tmp_path / "bad.yml"
    bad_shape.write_text("other: 1")
    with pytest.raises(SystemExit):
        csr.load_registry(bad_shape)
    assert list(csr.load_registry(reg([{"file": "a", "runs_as": "x", "reason": "y"}]))) == ["a"]


def test_the_registry_of_the_repository_has_a_reason_for_every_entry():
    registry = csr.load_registry()
    assert len(registry) >= 5
    for f, item in registry.items():
        assert item["reason"].strip() and item["runs_as"].strip(), f
