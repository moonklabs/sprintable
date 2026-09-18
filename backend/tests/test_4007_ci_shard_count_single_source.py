"""story #4007(2026-09-17, 페드루 PO 確定) — destructive-schema 샤드 수 8→12.

함정(PO 확認): 샤드 수가 실은 **두 곳**에 있었다 — ①`backend-test-destructive`
잡의 `strategy.matrix.shard` 배열 길이, ②`backend-test`(Audit) 잡의
`--shard-count` 리터럴. story #3393이 ①과 "샤드 자기 자신의 --shard-index/
--shard-count"(같은 잡 안) 축은 `strategy.job-total`로 이미 하나로 좁혀 뒀었지만,
②(다른 잡)는 그 파생이 안 닿는 자리라 별도 리터럴 `8`로 남아 있었다 — 8→12
확대 작업에서 한쪽만 바꾸면 조용히 어긋날 수 있는 사고 지점.

처방: ①잡이 `strategy.job-total`을 job output(`shard_count`)으로 내보내고,
②Audit 잡이 그 output을 그대로 `--shard-count`에 쓴다(리터럴 완전 제거 —
"두 리터럴을 맞춰 유지" 대신 "리터럴을 하나로 줄인다", #3393과 동일 원칙).

이 테스트는 그 구조를 고정한다:
- AC1: matrix.shard 배열 길이가 12(8→12 확대 자체를 pin).
- AC2: ②Audit 스텝에 하드코딩된 `--shard-count <숫자>` 리터럴이 남아있으면 RED
  (누군가 리팩터링하다 실수로 리터럴을 되살리면 즉시 잡는다 — "RED 가드").
- AC3: ②Audit 스텝이 `needs.backend-test-destructive.outputs.shard_count`를
  실제로 참조한다(파생 배선 자체가 없어지는 회귀도 잡는다).
- AC4: ①잡이 `outputs.shard_count`를 선언하고, 그 값이 가리키는 스텝이
  `strategy.job-total`을 사용한다(출처가 진짜 matrix 길이인지 — 값만 있고
  출처가 다른 리터럴로 슬쩍 바뀌는 회귀도 잡는다).
- AC5(회귀 0): #3393 축(같은 잡 안 --shard-index/--shard-count derivation)은
  이 작업과 무관하게 그대로 살아있어야 한다.

가중치(shard-weights.json)·shard_destructive_tests.py의 분배 로직은 이 스토리의
스코프 밖(페드루 PO 明示) — 여기서 손 안 댐, 테스트도 없음.
"""
from __future__ import annotations

import re
from pathlib import Path

import yaml

_WORKFLOW_PATH = Path(__file__).resolve().parents[2] / ".github" / "workflows" / "ci.yml"

_HARDCODED_SHARD_COUNT_RE = re.compile(r"--shard-count\s+\d+\b")


def _load() -> dict:
    return yaml.safe_load(_WORKFLOW_PATH.read_text())


def _destructive_job() -> dict:
    return _load()["jobs"]["backend-test-destructive"]


def _audit_job() -> dict:
    return _load()["jobs"]["backend-test"]


def _step(job: dict, name_substr: str) -> dict:
    for s in job["steps"]:
        if name_substr in (s.get("name") or ""):
            return s
    raise AssertionError(f"step containing {name_substr!r} not found in job")


def _audit_step() -> dict:
    return _step(_audit_job(), "Audit shard durations vs weights.json")


def test_matrix_shard_count_is_12():
    """AC1 — 8→12 확대 자체를 pin(story #4007, #3541의 "재발 시 착수" 실행)."""
    shards = _destructive_job()["strategy"]["matrix"]["shard"]
    assert shards == list(range(12)), (
        f"matrix.shard가 [0..11](12개)이 아님(실제: {shards}) — "
        "story #4007이 8→12로 확대한 값이 되돌아갔거나 다시 바뀜"
    )


def test_audit_step_has_no_hardcoded_shard_count_literal():
    """AC2 — RED 가드. Audit 스텝에 `--shard-count <숫자>` 리터럴이 있으면 그게 바로
    story #4007이 없앤 "두 번째 지점"의 재발이다."""
    run = _audit_step()["run"]
    match = _HARDCODED_SHARD_COUNT_RE.search(run)
    assert match is None, (
        f"Audit 스텝에 하드코딩된 --shard-count 리터럴 재발: {match.group() if match else ''!r} — "
        "matrix.shard 배열 길이에서 파생된 job output(shard_count)만 써야 한다(story #4007)"
    )


def test_audit_step_references_matrix_derived_shard_count_output():
    """AC3 — 파생 배선 자체가 없어지는 회귀(리터럴도 없고 output 참조도 없어 --shard-count
    인자 자체가 통째로 빠지는 경우)를 잡는다."""
    run = _audit_step()["run"]
    assert "needs.backend-test-destructive.outputs.shard_count" in run, (
        "Audit 스텝이 backend-test-destructive 잡의 shard_count output을 참조하지 않음 — "
        "story #4007의 단일 출처 배선이 없어졌다"
    )


def test_destructive_job_output_derives_from_matrix_job_total():
    """AC4 — output 값 자체가 진짜 matrix 길이(strategy.job-total)에서 오는지 — 다른
    리터럴로 슬쩍 바뀌는 회귀까지 잡는다."""
    job = _destructive_job()
    outputs = job.get("outputs") or {}
    assert "shard_count" in outputs, "backend-test-destructive 잡에 outputs.shard_count 선언이 없음"

    output_expr = outputs["shard_count"]
    m = re.search(r"steps\.([\w-]+)\.outputs\.shard_count", output_expr)
    assert m, f"outputs.shard_count 표현식이 steps.<id>.outputs.shard_count 형태가 아님: {output_expr!r}"
    step_id = m.group(1)

    step = next((s for s in job["steps"] if s.get("id") == step_id), None)
    assert step is not None, f"outputs.shard_count가 가리키는 step id {step_id!r}를 못 찾음"
    assert "strategy.job-total" in step["run"], (
        f"shard_count output의 원천 스텝({step_id})이 strategy.job-total을 안 씀 — "
        "matrix.shard 배열 길이가 유일한 출처여야 한다(story #4007)"
    )


def test_shard_index_axis_unaffected_regression():
    """AC5(회귀 0) — story #3393이 이미 고정한 축(같은 잡 안 --shard-index/--shard-count
    가 둘 다 matrix.shard/strategy.job-total에서 파생)은 이 스토리와 무관하게 그대로."""
    step = _step(_destructive_job(), "Determine this shard's file list")
    run = step["run"]
    assert "--shard-index ${{ matrix.shard }}" in run
    assert "--shard-count ${{ strategy.job-total }}" in run
