"""story #4532 AC5: channel files are served inline only for an allowed type; html · svg · xml · js and anything unknown are a
download (octet-stream + attachment), and the type is never sniffed."""
from __future__ import annotations

import pytest

from app.routers import channel


@pytest.mark.asyncio
@pytest.mark.parametrize("name", ["evil.html", "evil.htm", "evil.svg", "evil.xml", "evil.js", "evil.xhtml", "noext", "evil.bin"])
async def test_script_capable_and_unknown_files_are_a_download(tmp_path, monkeypatch, name):
    monkeypatch.setattr(channel, "_FILES_DIR", tmp_path)
    (tmp_path / name).write_bytes(b"<html><script>alert(1)</script></html>")
    res = await channel.channel_files(name)
    assert res.media_type == "application/octet-stream"
    assert res.headers["content-disposition"] == "attachment"
    assert res.headers["x-content-type-options"] == "nosniff"


@pytest.mark.asyncio
@pytest.mark.parametrize(("name", "kind"), [("a.png", "image/png"), ("a.jpg", "image/jpeg"), ("a.pdf", "application/pdf"), ("a.mp4", "video/mp4")])
async def test_allowed_types_stay_inline(tmp_path, monkeypatch, name, kind):
    monkeypatch.setattr(channel, "_FILES_DIR", tmp_path)
    (tmp_path / name).write_bytes(b"x")
    res = await channel.channel_files(name)
    assert res.media_type == kind
    assert "content-disposition" not in res.headers
    assert res.headers["x-content-type-options"] == "nosniff"
