"""story #f8f7cb0f(Phase1·마케팅운영, 페드루 PO 확定 2026-09-03·20:46 KST 정정) — 채널
발행 링크의 UTM 자동 부착. 채널·provider 무관 순수 함수(`attach_utm`)와, 이 스토리가
실제로 쓰는 campaign 해소 규칙(`resolve_utm_campaign`)을 분리한다 — 후자만 Phase1
site_post URL 패턴을 안다, 전자는 재사용 가능한 일반 유틸.

`[관측]` 그라운딩 확認 — 이 백엔드에 채널 링크용 UTM attach 유틸이 착수 전엔 없었다
(`git grep utm_source`는 signup-attribution(`users.signup_utm_*`, 회원가입 유입 추적 —
완전 다른 도메인)만 나왔다)."""
from __future__ import annotations

import re
import uuid
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

# story #3369(Phase0 S3)의 공개 URL 조립 패턴(`_resolve_public_url`, site_posts.py)과
# 짝 — `/{lang}/blog/{slug}` 그대로. site_base_url 설정 여부와 무관하게 경로 형태만
# 본다(호스트는 안 본다 — 어느 도메인이든 이 경로 모양이면 "우리 글"로 해소).
_BLOG_PATH_RE = re.compile(r"^/([a-z]{2}(?:-[A-Z]{2})?)/blog/([a-z0-9]+(?:-[a-z0-9]+)*)/?$")


def attach_utm(url: str, *, source: str, medium: str, campaign: str) -> str:
    """기존 쿼리 파라미터를 보존하고, `utm_`로 시작하는 키가 이미 하나라도 있으면
    아무것도 건드리지 않고 원본을 그대로 돌려준다(PO 확定 — "자동 부착"은 없을 때만
    채운다. 사용자가 이미 넣어 둔 UTM을 서버가 덮어쓰지 않는다)."""
    parsed = urlsplit(url)
    query = parse_qsl(parsed.query, keep_blank_values=True)
    if any(k.startswith("utm_") for k, _ in query):
        return url
    query += [("utm_source", source), ("utm_medium", medium), ("utm_campaign", campaign)]
    return urlunsplit(parsed._replace(query=urlencode(query)))


def resolve_utm_campaign(link_url: str | None, *, fallback_draft_id: uuid.UUID) -> str:
    """campaign 값 해소(PO 정정 2026-09-03 20:46 KST) — link_url의 경로가 공개 글 URL
    패턴(`/{lang}/blog/{slug}`)이면 그 slug(=대상 글), 아니면 이 채널 포스트 자신의
    draft_id. 물음이 "어느 글이 어느 가입을 만들었나"이므로 campaign은 경로(Threads
    포스트)가 아니라 목적지(글)여야 한다는 근거 — site_post UTM 확定(11:19Z)·담롱
    taxonomy v2와 한 벌, 두 벌을 두지 않는다.

    이 함수는 경로 형태만 본다(DB에 그 slug 행이 실제로 있는지는 확인하지 않는다) —
    PO 확定 문구 그대로("경로가 패턴이면 그 slug")이고, 존재 여부까지 확인하려면
    DB 왕복이 필요해 이 함수를 순수 함수 밖으로 밀어내야 한다(이 스토리 범위 밖)."""
    if link_url:
        try:
            path = urlsplit(link_url).path
        except ValueError:
            path = ""
        match = _BLOG_PATH_RE.match(path)
        if match:
            return match.group(2)
    return str(fallback_draft_id)
