"""S4 Phase2 backfill — 직렬화 byte-exact 락(미르코 §1 contract) + 스캔/디코드 단위(no DB).

⚠️ 이 직렬화는 미르코 렌더러 contract라 byte-exact. 형태 바뀌면 렌더 깨짐 → 이 테스트가 회귀 게이트.
"""
from __future__ import annotations

import base64
import uuid

from app.services.doc_asset_backfill import (
    _decode_data_url,
    _extract_width,
    _scan_nodes,
    to_asset_ref_file_node,
    to_asset_ref_image_node,
)

ID = uuid.UUID("11111111-2222-3333-4444-555555555555")


def test_file_node_byte_exact():
    # 미르코 §1: data-asset-id **LAST**·data-file-data 없음.
    assert to_asset_ref_file_node(ID, "report.pdf", 1234, "application/pdf") == (
        '<div data-type="fileAttachment" data-filename="report.pdf" data-size="1234" '
        'data-mime-type="application/pdf" data-asset-id="11111111-2222-3333-4444-555555555555"></div>'
    )


def test_image_node_byte_exact_minimal():
    # src attr 없음(option ②)·order=asset-id,filename,size,mime-type.
    assert to_asset_ref_image_node(ID, "img.png", 999, "image/png") == (
        '<img data-asset-id="11111111-2222-3333-4444-555555555555" data-filename="img.png" '
        'data-size="999" data-mime-type="image/png">'
    )


def test_image_node_byte_exact_with_width_alt():
    assert to_asset_ref_image_node(ID, "img.png", 999, "image/png", width=320, alt="cat") == (
        '<img data-asset-id="11111111-2222-3333-4444-555555555555" data-filename="img.png" '
        'data-size="999" data-mime-type="image/png" width="320" alt="cat">'
    )
    # src 절대 미포함(ephemeral signed URL persist 금지).
    assert "src=" not in to_asset_ref_image_node(ID, "i.png", 1, "image/png", width=10)


def test_scan_finds_all_three_forms():
    b64 = base64.b64encode(b"hello").decode()
    content = (
        f'<div data-type="fileAttachment" data-filename="a.pdf" data-size="5" '
        f'data-mime-type="application/pdf" data-file-data="data:application/pdf;base64,{b64}"></div>\n'
        f'![cat](data:image/png;base64,{b64})\n'
        f'<img src="data:image/jpeg;base64,{b64}" alt="x" style="width:200px;max-width:100%">'
    )
    nodes = _scan_nodes(content)
    kinds = sorted(n.kind for n in nodes)
    assert kinds == ["file", "image", "image"]
    img_html = [n for n in nodes if n.kind == "image" and n.width][0]
    assert img_html.width == 200  # style width 보존


def test_scan_idempotent_skips_asset_ref():
    # 이미 변환된(data-asset-id·data: 없음) 노드는 미매치 → 2회차 0.
    converted = (
        '<div data-type="fileAttachment" data-filename="a.pdf" data-size="5" '
        'data-mime-type="application/pdf" data-asset-id="' + str(ID) + '"></div>\n'
        '<img data-asset-id="' + str(ID) + '" data-filename="i.png" data-size="9" data-mime-type="image/png">'
    )
    assert _scan_nodes(converted) == []


def test_decode_data_url():
    b64 = base64.b64encode(b"abc123").decode()
    raw, mime = _decode_data_url(f"data:image/png;base64,{b64}")
    assert raw == b"abc123" and mime == "image/png"
    assert _decode_data_url("https://x/y.png") is None  # 비 data-url
    assert _decode_data_url("data:image/png;base64,") is None  # 빈 데이터


def test_extract_width():
    assert _extract_width('<img src="x" style="width:320px;max-width:100%">') == 320
    assert _extract_width('<img src="x" width="150">') == 150
    assert _extract_width('<img src="x">') is None
