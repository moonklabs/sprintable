"""story #3654(BE·REST·소형, 페드루 PO 確定 2026-09-07) — org 스코프 콘텐츠 REST 경로
(`/api/v2/organizations/{org_id}/<segment>...`)가 `_PATH_GROUP_PREFIXES`(고정 prefix
매칭)에 없어 toolset 그룹 게이트 밖이었다 — MCP 쪽은 story #3631로 "content" 그룹이
섰는데 같은 기능의 REST 문은 그룹 없이 열려 있던 것(story b4027b2e가 visual-artifacts에서
겪은 것과 동일 클래스, 까심 라이브 실증 선례).

이 파일의 관심사 둘:
1. 그라운딩②에서 실제 스캔한 9개 콘텐츠 세그먼트가 정확히 "content"로 판정되는지
   (`test_3614_content_toolset_group_changes.py`의 대표 표본 pin과 별개로 여기서 전수).
2. **정적 가드**(페드루 PO 追加 요구) — `app/routers/` 전수에서 `/api/v2/organizations`
   (또는 `/api/v2/projects` 등 다른 prefix에 얹힌 org-scope 서브라우터, 예: gate_config.py
   의 org_router) prefix 라우터의 모든 `{org_id}`(또는 `{id}`) 뒤 첫 세그먼트를 모아,
   `_ORG_SCOPED_PATH_GROUP_SEGMENTS`(매핑)나 `_ORG_SCOPED_UNMAPPED_SEGMENTS_WITH_REASON`
   (명시 예외+이유) 어느 한쪽에도 없으면 가드가 스스로 RED — 새 org-scoped 자원이 표
   없이 조용히 미매핑(permissive)으로 빠지는 것을 막는다."""
from __future__ import annotations

import re
from pathlib import Path

import pytest

_APP_DIR = Path(__file__).parent.parent / "app"
_ROUTERS_DIR = _APP_DIR / "routers"


def _extract_org_scoped_segments() -> dict[str, list[str]]:
    """`app/routers/*.py` 전수에서 `<var> = APIRouter(prefix="/api/v2/organizations", ...)`
    로 선언된 라우터 변수(파일당 여러 개 가능 — 예: gate_config.py의 router+org_router)를
    찾고, 그 변수에 걸린 `@<var>.<method>("<path>", ...)` 데코레이터의 path 리터럴에서
    "org_id 뒤 첫 세그먼트"를 뽑는다. 반환은 {segment: [file, ...]}(어느 파일이 그 세그먼트를
    쓰는지, 실패 메시지 진단용).

    세그먼트 규칙(mcp_toolset.py::_org_scoped_content_group의 런타임 매칭과 동형) — path를
    "/"로 쪼갠 뒤:
    - 첫 조각이 `{...}`(동적 파라미터, org_id 또는 id)이고 그 다음 조각이 있으면 그것.
    - 첫 조각이 `{...}`인데 그 다음이 없으면(그 파라미터 자체가 리소스, 예 `/{id}`)
      "(root, org_id only)".
    - path가 비어있으면("") "(empty/root)".
    - 그 외(동적 파라미터로 시작 안 함 — 이 스토리 대상 밖 모양)는 무시(collect 안 함,
      org_id 뒤에 붙는 형이 아니므로 이 가드의 관심사가 아니다)."""
    router_method_re = re.compile(r'@(\w+)\.(get|post|put|patch|delete)\(\s*\n?\s*"([^"]*)"')
    segments: dict[str, list[str]] = {}
    for path in sorted(_ROUTERS_DIR.glob("*.py")):
        text = path.read_text()
        org_router_vars = set(re.findall(r'(\w+)\s*=\s*APIRouter\(\s*prefix="/api/v2/organizations"', text))
        if not org_router_vars:
            continue
        for m in router_method_re.finditer(text):
            varname, _method, route_path = m.groups()
            if varname not in org_router_vars:
                continue
            parts = [p for p in route_path.split("/") if p]
            if not parts:
                seg = "(empty/root)"
            elif parts[0].startswith("{"):
                seg = parts[1] if len(parts) > 1 else "(root, org_id only)"
            else:
                continue  # org_id로 시작 안 하는 모양 — 이 가드 대상 밖.
            segments.setdefault(seg, []).append(path.name)
    return segments


def test_grounding_extraction_finds_known_content_segments():
    """자가 확認 — 스캐너 자체가 실제로 라우터를 읽고 있다는 증거(빈 결과로 「전수 0건이라
    전부 통과」하는 항진명제 가드가 되지 않도록)."""
    segments = _extract_org_scoped_segments()
    assert "channel-posts" in segments
    assert "channel_posts.py" in segments["channel-posts"]
    assert "publications" in segments
    assert {"channel_post_comments.py", "insight_snapshots.py"} <= set(segments["publications"])


def test_every_org_scoped_segment_is_mapped_or_explicitly_excused():
    """정적 가드 본체(페드루 PO 追加 요구) — app/routers/ 전수의 org-scoped 세그먼트가
    _ORG_SCOPED_PATH_GROUP_SEGMENTS(매핑)나 _ORG_SCOPED_UNMAPPED_SEGMENTS_WITH_REASON
    (명시 예외+이유) 어느 한쪽에도 없으면 이 테스트가 RED — 새 org-scoped 리소스가 표
    없이 조용히 미매핑(permissive-unmapped)으로 새 프로덕션에 들어가는 것을 막는다."""
    from app.services.mcp_toolset import (
        _ORG_SCOPED_PATH_GROUP_SEGMENTS,
        _ORG_SCOPED_UNMAPPED_SEGMENTS_WITH_REASON,
    )

    mapped = {seg for seg, _group in _ORG_SCOPED_PATH_GROUP_SEGMENTS}
    excused = set(_ORG_SCOPED_UNMAPPED_SEGMENTS_WITH_REASON)
    declared = mapped | excused

    found_segments = set(_extract_org_scoped_segments())
    unaccounted = found_segments - declared
    assert not unaccounted, (
        f"org-scoped 세그먼트가 매핑 표에도 예외 목록에도 없다(가드 정의, story #3654): "
        f"{sorted(unaccounted)} — mcp_toolset.py의 _ORG_SCOPED_PATH_GROUP_SEGMENTS(content면) "
        f"또는 _ORG_SCOPED_UNMAPPED_SEGMENTS_WITH_REASON(아니면 이유와 함께)에 등재하라."
    )

    # 반대 방향(표에 있는데 실제 라우터엔 없는 segment) — 죽은 등재를 조용히 안 남긴다.
    stale_in_map = mapped - found_segments
    assert not stale_in_map, f"매핑 표에 있지만 실제 라우터에서 못 찾은 세그먼트(죽은 등재): {sorted(stale_in_map)}"


def test_content_group_reason_dict_has_no_overlap_with_mapped_segments():
    """표와 예외 목록이 같은 세그먼트를 이중 등재하지 않는다(어느 쪽이 이기는지 모호해지는
    것을 막는다 — 둘은 배타적 집합이어야 한다)."""
    from app.services.mcp_toolset import (
        _ORG_SCOPED_PATH_GROUP_SEGMENTS,
        _ORG_SCOPED_UNMAPPED_SEGMENTS_WITH_REASON,
    )

    mapped = {seg for seg, _group in _ORG_SCOPED_PATH_GROUP_SEGMENTS}
    excused = set(_ORG_SCOPED_UNMAPPED_SEGMENTS_WITH_REASON)
    assert not (mapped & excused), f"표·예외 목록 중복 등재: {sorted(mapped & excused)}"


@pytest.mark.parametrize(
    "path,expected_group",
    [
        ("/api/v2/organizations/org-1/channel-posts/drafts", "content"),
        ("/api/v2/organizations/org-1/site-posts", "content"),
        ("/api/v2/organizations/org-1/publication-commands/cmd-1/retry", "content"),
        ("/api/v2/organizations/org-1/channel-connections", "content"),
        ("/api/v2/organizations/org-1/publications/pub-1/comments", "content"),
        ("/api/v2/organizations/org-1/publications/pub-1/insights", "content"),
        ("/api/v2/organizations/org-1/comments/c-1/replies", "content"),
        ("/api/v2/organizations/org-1/insights-board", "content"),
        ("/api/v2/organizations/org-1/publishing-metrics", "content"),
    ],
)
def test_all_nine_content_segments_gated_positive(path, expected_group):
    """AC1 — 그라운딩②가 찾은 9개 세그먼트 전부가 실제로 content로 판정되고, content
    scope 없는 키는 403급으로 막힌다(path_allowed_for_scope False)."""
    from app.services.mcp_toolset import path_allowed_for_scope, path_to_tool_group

    assert path_to_tool_group(path) == expected_group
    assert path_allowed_for_scope(path, ["stories"]) is False
    assert path_allowed_for_scope(path, ["content"]) is True


def test_unmapped_segment_stays_permissive_as_declared():
    """예외 목록에 있는 세그먼트(예: campaigns)는 여전히 미매핑·허용 — 이 스토리가
    건드리는 축이 아니라는 것을 실제로도 못박는다(그룹 재설계는 범위 밖)."""
    from app.services.mcp_toolset import path_allowed_for_scope, path_to_tool_group

    campaigns_path = "/api/v2/organizations/org-1/campaigns"
    assert path_to_tool_group(campaigns_path) is None
    assert path_allowed_for_scope(campaigns_path, ["stories"]) is True


def test_mutation_removing_channel_posts_from_map_reopens_gap_and_fails_static_guard(monkeypatch):
    """뮤테이션(페드루 PO 명시) — 표에서 세그먼트 1개(channel-posts)를 제거하면 (a)
    path_allowed 테스트가 RED(무관 scope도 다시 통과) (b) 정적 가드도 RED(스캐너는 여전히
    라우터에서 channel-posts를 찾는데 표에 없으니 unaccounted)."""
    import app.services.mcp_toolset as mod

    mutated = tuple((seg, g) for seg, g in mod._ORG_SCOPED_PATH_GROUP_SEGMENTS if seg != "channel-posts")
    monkeypatch.setattr(mod, "_ORG_SCOPED_PATH_GROUP_SEGMENTS", mutated)

    path = "/api/v2/organizations/org-1/channel-posts/drafts"
    assert mod.path_to_tool_group(path) is None, "뮤테이션이 걸리지 않았다(여전히 content로 판정)"
    assert mod.path_allowed_for_scope(path, ["stories"]) is True, "뮤테이션이 걸리지 않았다(여전히 막힘)"

    mapped = {seg for seg, _g in mod._ORG_SCOPED_PATH_GROUP_SEGMENTS}
    excused = set(mod._ORG_SCOPED_UNMAPPED_SEGMENTS_WITH_REASON)
    assert "channel-posts" not in (mapped | excused), "뮤테이션이 표/예외 목록 어느 쪽에서도 안 빠졌다"
