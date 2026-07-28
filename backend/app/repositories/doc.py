from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.doc import Doc
from app.repositories.base import BaseRepository


def encode_doc_cursor(doc: Doc) -> str:
    """story #2191: (sort_order, id) 복합 커서 — sort_order 는 기본값 0 이 절대다수라
    단독으로는 동률(tie)이 흔하다(모델 default=0, 수동 재배치 안 한 doc이 대다수).
    id 를 2차 정렬키로 더해야 페이지 경계에서 행이 누락되거나 중복되지 않는다."""
    return f"{doc.sort_order}:{doc.id}"


def parse_doc_cursor(cursor: object) -> tuple[int, uuid.UUID] | None:
    """오르테가군 지적(2026-07-27, #2540 CI): 이 함수는 HTTP(FastAPI 가 Query(...)를
    리졸브해 진짜 str|None 을 줌)와 직접호출(테스트·내부 — 인자를 명시로 안 넘기면
    파이썬 기본값인 Query(...) 센티넬 객체 그 자체가 들어옴) 두 경로로 불린다.
    예전엔 `if not cursor:` 가 "값이 있는지"만 보고 "그 값이 문자열인지"는 안 봐서,
    Query 객체(truthy)가 그대로 통과해 .split() 에서 터졌다(또는 AttributeError→400
    으로 변질돼 정상 "커서 없음" 요청을 거절하는 쪽으로 오동작). 문자열이 아니면
    타입 단계에서 즉시 None(커서 없음) 취급 — 값의 존재가 아니라 값의 종류를 본다."""
    if not isinstance(cursor, str) or not cursor:
        return None
    try:
        sort_order_str, id_str = cursor.split(":", 1)
        return int(sort_order_str), uuid.UUID(id_str)
    except ValueError as exc:
        from fastapi import HTTPException
        raise HTTPException(status_code=400, detail="Invalid cursor format") from exc


class DocRepository(BaseRepository[Doc]):
    def __init__(self, session: AsyncSession, org_id: uuid.UUID) -> None:
        super().__init__(Doc, session, org_id)

    async def list(
        self, limit: int = 500, cursor: str | None = None, **filters: Any
    ) -> list[Doc]:  # type: ignore[override]
        q = select(Doc).where(self._org_filter(), Doc.deleted_at.is_(None))
        for attr, val in filters.items():
            q = q.where(getattr(Doc, attr) == val)
        parsed = parse_doc_cursor(cursor)
        if parsed is not None:
            q = q.where(tuple_(Doc.sort_order, Doc.id) > tuple_(*parsed))
        q = q.order_by(Doc.sort_order, Doc.id).limit(limit)
        result = await self.session.execute(q)
        return list(result.scalars().all())

    async def get_by_slug(self, project_id: uuid.UUID, slug: str) -> Doc | None:
        result = await self.session.execute(
            select(Doc).where(
                self._org_filter(),
                Doc.project_id == project_id,
                Doc.slug == slug,
                Doc.deleted_at.is_(None),
            ).limit(1)
        )
        return result.scalar_one_or_none()

    async def get_by_alias(self, project_id: uuid.UUID, old_slug: str) -> Doc | None:
        """4dd399c6 AC3: 구 slug(alias) → canonical doc 해소. live(get_by_slug) 미스 시 fallback."""
        from app.models.doc import DocSlugAlias

        result = await self.session.execute(
            select(Doc)
            .join(DocSlugAlias, DocSlugAlias.doc_id == Doc.id)
            .where(
                self._org_filter(),
                DocSlugAlias.project_id == project_id,
                DocSlugAlias.old_slug == old_slug,
                Doc.deleted_at.is_(None),
            )
            .limit(1)
        )
        return result.scalar_one_or_none()

    async def list_tree(
        self, project_id: uuid.UUID, parent_id: uuid.UUID | None = None, limit: int = 500, cursor: str | None = None,
    ) -> list[Doc]:
        """project 내 특정 parent 하위 docs 조회 (트리 1레벨)."""
        q = select(Doc).where(
            self._org_filter(),
            Doc.project_id == project_id,
            Doc.deleted_at.is_(None),
        )
        if parent_id is None:
            q = q.where(Doc.parent_id.is_(None))
        else:
            q = q.where(Doc.parent_id == parent_id)
        parsed = parse_doc_cursor(cursor)
        if parsed is not None:
            q = q.where(tuple_(Doc.sort_order, Doc.id) > tuple_(*parsed))
        q = q.order_by(Doc.sort_order, Doc.id).limit(limit)
        result = await self.session.execute(q)
        return list(result.scalars().all())

    async def search_by_tags(
        self, project_id: uuid.UUID, tags: list[str], limit: int = 500, cursor: str | None = None,
    ) -> list[Doc]:
        """tags 배열이 주어진 태그를 모두 포함하는 docs 조회 (@> 연산자).

        story #2191: 예전엔 ORDER BY 자체가 없어(암묵적 DB 순서, 비결정적) 커서 페이지네이션이
        애초에 안전하지 않았다 — list()/list_tree()와 같은 (sort_order,id) 규약으로 통일한다."""
        from sqlalchemy import cast
        from sqlalchemy.dialects.postgresql import ARRAY
        from sqlalchemy import Text

        q = select(Doc).where(
            self._org_filter(),
            Doc.project_id == project_id,
            Doc.deleted_at.is_(None),
            Doc.tags.contains(cast(tags, ARRAY(Text))),
        )
        parsed = parse_doc_cursor(cursor)
        if parsed is not None:
            q = q.where(tuple_(Doc.sort_order, Doc.id) > tuple_(*parsed))
        q = q.order_by(Doc.sort_order, Doc.id).limit(limit)
        result = await self.session.execute(q)
        return list(result.scalars().all())

    async def search_full_text(
        self, project_id: uuid.UUID, query: str, limit: int = 50
    ) -> list[tuple[Doc, str | None]]:
        """tsvector 기반 전문 검색. ts_rank 내림차순. snippet 포함.

        story #2191: 이 분기는 의도적으로 (sort_order,id) 커서 규약을 안 쓴다 — 정렬 기준이
        관련도(ts_rank)라 위치/시간 커서를 얹으면 페이지마다 순위가 뒤섞인다(오르테가군 판단,
        2026-07-27). limit=50 상한 안에서만 결과를 낸다 — 그 너머로 스크롤하는 UX는 이 함수의
        스코프 밖(검색 결과 심층 페이지네이션이 필요해지면 별도 설계로 다룰 것)."""
        from sqlalchemy import func, literal_column

        tsquery = func.plainto_tsquery("simple", query)
        snippet_expr = func.ts_headline(
            "simple",
            Doc.content,
            tsquery,
            literal_column("'MaxWords=30, MinWords=15, ShortWord=3, MaxFragments=1'"),
        )

        stmt = (
            select(Doc, snippet_expr.label("snippet"))
            .where(
                self._org_filter(),
                Doc.project_id == project_id,
                Doc.deleted_at.is_(None),
                Doc.search_vector.op("@@")(tsquery),
            )
            .order_by(func.ts_rank(Doc.search_vector, tsquery).desc())
            .limit(limit)
        )
        result = await self.session.execute(stmt)
        return [(row.Doc, row.snippet) for row in result]
