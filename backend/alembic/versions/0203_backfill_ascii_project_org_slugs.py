"""story #2039(P0): 비ASCII(한글 등) workspace/project slug 백필 — ASCII 강제 + 이력 기록.

Revision ID: 0203
Revises: 0202
Create Date: 2026-07-20

증상: 프로젝트 이름이 한글이면 보드·스프린트·목표·문서가 전부 클라이언트 사이드 404(서버는 200,
네트워크 요청 0 — 로그로 안 잡힘). 실측(오르테가 PO): `/api/projects` slug가 `장사왕`→`장사왕`,
`제로고`→`제로고`(원문 그대로) — 반면 `B2B Sales GTM`→`b2b-sales-gtm`처럼 ASCII 이름은 정상.

근본: 0185가 도입한 백필+router의 신규 생성 auto-derive 둘 다 `app.services.doc_slug.slugify`
(유니코드 letter/number 보존 — 한글도 그대로 통과)를 썼다. workspace/project slug는 URL path
segment로 그대로 쓰이는데, 한글이 percent-encode된 채로 FE 라우트 매처를 못 통과해 위 증상이
났다. organizations는 생성 시 client가 명시 ASCII slug를 필수로 제출(is_valid_slug_format 강제)
해 auto-derive 자체가 없어 우연히 무사했다 — 그래서 project 축만 깨졌다(app/services/entity_slug.py
상단 주석에 3안 검토(음역/치환/id-fallback) + id-fallback 채택 근거 기록).

이 마이그는 순수 재백필(스키마 변경 0) — slugify_ascii_or_fallback()로 is_valid_slug_format을
어기는 기존 slug 전부를 org-scope(project)/전역(organization) 유일성 유지하며 교체하고,
entity_slug_history에 old→new 매핑을 남긴다. `/api/v2/resolve`(story ddac96fd)가 이미 이 테이블로
구 slug 요청을 canonical slug로 redirect 처리하므로 북마크된 구 링크도 404 없이 살아난다(요구사항
③ — 별도 인프라 신설 없이 기존 메커니즘 재사용).

organizations는 이론상 전부 이미 ASCII(auto-derive 경로가 없으므로)지만, 방어적으로 동일 스캔을
같이 돌린다(발견 즉시 수정 원칙 + PO "전수" 지시 — org 케이스가 실제로 없어도 no-op이라 비용 0).
"""
from __future__ import annotations

import re
import unicodedata
import uuid

from alembic import op
import sqlalchemy as sa

revision = "0203"
down_revision = "0202"
branch_labels = None
depends_on = None

# app.services.entity_slug와 byte-identical(마이그는 app 코드 직접 import 대신 이 시점의 알고리즘을
# 고정 — 0185 선례(그 마이그 안에 own copy)와 동형. 향후 entity_slug.py가 바뀌어도 이 마이그의
# 재실행 결과가 달라지지 않아야 하므로 의도적 인라인 복제).
_SLUG_FORMAT_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
_ASCII_STRIP_RE = re.compile(r"[^a-z0-9\s-]")
_WS_RE = re.compile(r"\s+")
_DASH_RUN_RE = re.compile(r"-{2,}")
_MAX_SLUG_LEN = 200


def _is_valid_slug_format(slug: str | None) -> bool:
    return bool(slug) and bool(_SLUG_FORMAT_RE.match(slug))


def _slugify_ascii_or_fallback(title: str, fallback_prefix: str) -> str:
    s = unicodedata.normalize("NFC", title or "").strip().lower()
    s = _WS_RE.sub("-", s)
    s = _ASCII_STRIP_RE.sub("", s)
    s = _DASH_RUN_RE.sub("-", s).strip("-")
    if len(s) > _MAX_SLUG_LEN:
        s = s[:_MAX_SLUG_LEN].rstrip("-")
    if s:
        return s
    return f"{fallback_prefix}-{uuid.uuid4().hex[:8]}"


def upgrade() -> None:
    _backfill_project_slugs()
    _backfill_organization_slugs()


def _backfill_project_slugs() -> None:
    conn = op.get_bind()
    rows = conn.execute(
        sa.text("SELECT id, org_id, name, slug FROM projects WHERE deleted_at IS NULL ORDER BY created_at ASC")
    ).fetchall()

    # org-scope 유일성 — 이미 유효(ASCII)한 기존 slug도 점유분으로 미리 채워야 새 slug가 충돌 안 함.
    used_per_org: dict[str, set[str]] = {}
    for row in rows:
        if _is_valid_slug_format(row.slug):
            used_per_org.setdefault(str(row.org_id), set()).add(row.slug)

    for row in rows:
        if _is_valid_slug_format(row.slug):
            continue
        org_key = str(row.org_id)
        used = used_per_org.setdefault(org_key, set())
        base = _slugify_ascii_or_fallback(row.name or "", "project")
        candidate = base
        n = 2
        while candidate in used:
            candidate = f"{base}-{n}"
            n += 1
        used.add(candidate)
        old_slug = row.slug
        conn.execute(
            sa.text("UPDATE projects SET slug = :slug WHERE id = :id"),
            {"slug": candidate, "id": row.id},
        )
        # old_slug가 None(0185 이전 raw seed 등 nullable 잔존)이면 아무도 그 링크로 못 왔으므로
        # 이력 기록 불필요 — 실제로 깨진 문자열 slug였을 때만 구-링크 호환 이력을 남긴다.
        if old_slug:
            conn.execute(
                sa.text(
                    "INSERT INTO entity_slug_history (id, org_id, entity_type, entity_id, old_slug, new_slug)"
                    " VALUES (:id, :org_id, 'project', :entity_id, :old_slug, :new_slug)"
                ),
                {
                    "id": str(uuid.uuid4()), "org_id": row.org_id, "entity_id": row.id,
                    "old_slug": old_slug, "new_slug": candidate,
                },
            )


def _backfill_organization_slugs() -> None:
    conn = op.get_bind()
    rows = conn.execute(sa.text("SELECT id, name, slug FROM organizations ORDER BY created_at ASC")).fetchall()

    used: set[str] = {row.slug for row in rows if _is_valid_slug_format(row.slug)}

    for row in rows:
        if _is_valid_slug_format(row.slug):
            continue
        base = _slugify_ascii_or_fallback(row.name or "", "workspace")
        candidate = base
        n = 2
        while candidate in used:
            candidate = f"{base}-{n}"
            n += 1
        used.add(candidate)
        old_slug = row.slug
        conn.execute(
            sa.text("UPDATE organizations SET slug = :slug WHERE id = :id"),
            {"slug": candidate, "id": row.id},
        )
        if old_slug:
            conn.execute(
                sa.text(
                    "INSERT INTO entity_slug_history (id, org_id, entity_type, entity_id, old_slug, new_slug)"
                    " VALUES (:id, :org_id, 'organization', :entity_id, :old_slug, :new_slug)"
                ),
                {
                    "id": str(uuid.uuid4()), "org_id": row.id, "entity_id": row.id,
                    "old_slug": old_slug, "new_slug": candidate,
                },
            )


def downgrade() -> None:
    # 재백필은 순수 데이터 정합성 수정 — 되돌리면 다시 깨진(비ASCII) slug로 회귀하므로 downgrade는
    # no-op(0185/0186 선례 없음·이 케이스는 "고쳐진 상태 유지"가 유일하게 안전한 downgrade).
    pass
