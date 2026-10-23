"""story 4725 (codex 01a147b6) — after a reclaim the OAuth callback waits until a new token's `iat` (whole seconds) is strictly after the cut-off, whatever fraction the
stored cut-off carries, and never longer than 2 s."""
from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone

import pytest

from app.routers.auth import _wait_for_second_after


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_the_first_whole_second_after_a_fractional_cutoff_is_reached():
    now = datetime.now(timezone.utc)
    epoch = now.replace(microsecond=0) + timedelta(milliseconds=300)     # a cut-off with a fraction, in this very second (or just past)
    await _wait_for_second_after(epoch)
    assert int(datetime.now(timezone.utc).timestamp()) > int(epoch.timestamp())      # a token minted now carries iat > floor(cut-off): the check `iat <= cut-off` passes it


@pytest.mark.anyio
async def test_a_cutoff_in_the_past_does_not_wait():
    t0 = time.monotonic()
    await _wait_for_second_after(datetime.now(timezone.utc) - timedelta(minutes=5))
    assert time.monotonic() - t0 < 0.2


@pytest.mark.anyio
async def test_a_cutoff_far_in_the_future_is_capped():
    t0 = time.monotonic()
    await _wait_for_second_after(datetime.now(timezone.utc) + timedelta(hours=1))
    assert time.monotonic() - t0 < 2.6
