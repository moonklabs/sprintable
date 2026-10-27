"""story 4791 (INFRA-DIET ⑥) — dev runs the receiver scopes' SSE lease on Postgres rows: the dev branch of the workflow turns the Redis lease off, prod keeps it.

With `SSE_LEASE_REDIS_ENABLED=false` the app answers `perkey:<agent>` from `sse_leases` / `sse_lease_taken` (services/sse_lease_pg.py); the global caps and the device count go back to each
instance's own count (the limit named in the story). Everything else Redis-backed on dev stays as it was. The REAL dev branch of the workflow's «Set deploy environment» step is run in bash.
"""
from __future__ import annotations

from tests.test_4786_dev_scale_to_zero import _PROD, _WORKFLOW
from tests.test_4786e_dev_realtime_stack_retired import _REDIS_FLAGS, _dev_outputs


def test_dev_turns_the_redis_lease_off_and_keeps_the_other_redis_flags():
    out = _dev_outputs()
    assert out["backend_sse_lease_redis_enabled"] == "false"
    for flag in _REDIS_FLAGS:  # presence · fan-out · consume · dispatch · transient replay: unchanged
        assert out[flag] == "true", flag
    assert out["redis_url"].startswith("redis://")  # the address stays: the other flags still use it


def test_prod_keeps_the_redis_lease_and_the_workflow_sets_it_exactly_once_per_branch():
    assert _PROD.count('echo "backend_sse_lease_redis_enabled=true"') == 1
    assert 'backend_sse_lease_redis_enabled=false' not in _PROD
    assert _WORKFLOW.count("backend_sse_lease_redis_enabled=") == 2  # one echo per branch (the V_ mapping below reads the output by name)
    assert "V_BACKEND_SSE_LEASE_REDIS_ENABLED: ${{ steps.env.outputs.backend_sse_lease_redis_enabled }}" in _WORKFLOW
