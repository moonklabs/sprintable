from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Generic, TypeVar

from sqlalchemy import func, select
from sqlalchemy import update as sa_update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import Base
from app.models.base import SoftDeleteMixin

T = TypeVar("T", bound=Base)


class CasConflict(Exception):
    """story #2874: update_with_cas() 낙관적 동시성 충돌 — 호출자가 .current(최신 row)로
    409 detail(current_updated_at 등)을 구성한다."""

    def __init__(self, current: Any) -> None:
        self.current = current
        super().__init__("optimistic concurrency conflict")

# cursor 페이지네이션이 안전한 단조 정렬 컬럼 화이트리스트.
# title/priority 등 비단조 컬럼은 cursor 중복으로 누락/중복을 유발하므로 제외한다.
_ORDERABLE_FIELDS = ("created_at", "updated_at")


class BaseRepository(Generic[T]):
    def __init__(self, model: type[T], session: AsyncSession, org_id: uuid.UUID) -> None:
        self.model = model
        self.session = session
        self.org_id = org_id

    def _org_filter(self) -> Any:
        return self.model.org_id == self.org_id  # type: ignore[attr-defined]

    async def get(self, id: uuid.UUID) -> T | None:
        result = await self.session.execute(
            select(self.model).where(self._org_filter(), self.model.id == id)  # type: ignore[attr-defined]
        )
        return result.scalar_one_or_none()

    async def list_by_ids(self, ids: list[uuid.UUID]) -> list[T]:
        """배치 앵커 조회(story ca37b2b0 ②의 `StoryRepository.list_by_ids`와 동일 계약을
        제네릭화 — story #2262 PR② 칩 상태 배치조회가 epic/task/doc/artifact에도 같은
        `?ids=` 패턴을 요구해 여기로 승격한다). org-scoped exact-id IN 조회. ORDER BY
        없음(호출자가 id 집합 그대로를 필요로 하는 용도, "첫 N건" 비결정 순서 문제와 무관)."""
        if not ids:
            return []
        q = select(self.model).where(self._org_filter(), self.model.id.in_(ids))  # type: ignore[attr-defined]
        if issubclass(self.model, SoftDeleteMixin):
            q = q.where(self.model.deleted_at.is_(None))  # type: ignore[attr-defined]
        result = await self.session.execute(q)
        return list(result.scalars().all())

    async def list(self, limit: int = 1000, **filters: Any) -> list[T]:
        q = select(self.model).where(self._org_filter())
        if issubclass(self.model, SoftDeleteMixin):
            q = q.where(self.model.deleted_at.is_(None))  # type: ignore[attr-defined]
        for attr, val in filters.items():
            q = q.where(getattr(self.model, attr) == val)
        result = await self.session.execute(q.limit(limit))
        return list(result.scalars().all())

    def _orderable_fields(self) -> tuple[str, ...]:
        """cursor 페이지네이션을 허용할 정렬 컬럼. 서브클래스에서 확장 가능."""
        return _ORDERABLE_FIELDS

    async def list_paginated(
        self,
        *,
        limit: int | None = None,
        cursor: datetime | None = None,
        order_by: str = "created_at",
        **filters: Any,
    ) -> tuple[list[T], int]:
        """true cursor 페이지네이션 + 전체 카운트.

        - order_by: 단조 컬럼 화이트리스트(created_at/updated_at). 그 외는 created_at로 폴백.
        - cursor: 직전 페이지 마지막 row의 order_by 값(datetime). desc 페이지네이션(< cursor).
        - total: 필터+cursor 適用 後·limit 適用 前 전체 개수("이 필터+커서 조건에서 남은 전체
          건수" — story.py::list()가 세운 규약, #2537). ⚠️페드루 AC 리뷰(story #2428 PR③,
          2026-08-17, TaskRepository.list_in_projects()에서 먼저 잡힘)로 발견 — 이 공용
          메서드가 최초엔 cursor를 count 쿼리에서 빠뜨려(q에만 붙임) 마지막 페이지에서도
          total이 cursor-무관 grand total로 고정, has_more(=total>len(items))가 영구 참이
          되는 결함이었다. cursor를 conds에 넣어 count_q/q 둘 다 같은 조건을 보게 고쳤다 —
          이 메서드를 쓰는 모든 소비자(GoalRepository.list_goals 등)에 소급 적용된다.
        - limit: None이면 기존 list()와 동일하게 1000 cap. 지정 시 그만큼만 반환(over-fetch는 호출자 책임).
        반환: (rows, total).
        """
        conds = [self._org_filter()]
        if issubclass(self.model, SoftDeleteMixin):
            conds.append(self.model.deleted_at.is_(None))  # type: ignore[attr-defined]
        for attr, val in filters.items():
            conds.append(getattr(self.model, attr) == val)

        if order_by not in self._orderable_fields():
            order_by = "created_at"
        order_col = getattr(self.model, order_by)

        if cursor is not None:
            conds.append(order_col < cursor)

        # 전체 카운트(필터+cursor 適用 後) — 1000+ 잘림 및 "마지막 페이지"를 호출자가 인지하도록.
        count_result = await self.session.execute(
            select(func.count()).select_from(self.model).where(*conds)
        )
        total = int(count_result.scalar_one() or 0)

        q = select(self.model).where(*conds).order_by(
            order_col.desc(), self.model.id.desc()  # type: ignore[attr-defined]
        )
        q = q.limit(limit if limit is not None else 1000)
        result = await self.session.execute(q)
        return list(result.scalars().all()), total

    async def create(self, **data: Any) -> T:
        obj = self.model(org_id=self.org_id, **data)
        self.session.add(obj)
        await self.session.flush()
        await self.session.refresh(obj)
        return obj

    async def update(self, id: uuid.UUID, **data: Any) -> T | None:
        obj = await self.get(id)
        if obj is None:
            return None
        for key, value in data.items():
            setattr(obj, key, value)
        await self.session.flush()
        await self.session.refresh(obj)
        return obj

    async def update_with_cas(
        self, id: uuid.UUID, *, expected_updated_at: datetime | None = None, **data: Any
    ) -> T | None:
        """story #2874(하드닝): ``update()``는 재조회→setattr→flush로 check-then-write라
        원자적이지 않다 — 같은 밀리초대 진짜 동시 PATCH 두 건이 겹치면(둘 다 "충돌 前" 값을
        읽고 통과) 나중 flush가 먼저 것을 조용히 덮어쓸 수 있다(#3288 QA·codex 지적, 카디르
        사실 확認). ``expected_updated_at``이 주어지면 단일 SQL 문
        ``UPDATE ... WHERE id= AND updated_at=`` 로 승격 — DB가 원자적으로 비교+쓰기를
        한 스텝에 한다(진짜 CAS, TOCTOU 창 없음).

        ms-절삭 비교(docs.py 151e05f1 근거 그대로, 카디르 probe로 실증된 축 — DB μs=654321·
        클라 ms절삭 654000 전송해도 false-409 없이 통과해야 함): ``date_trunc('milliseconds',
        ...)``로 컬럼·파라미터 양쪽을 SQL 레벨에서 동일하게 절삭 후 비교한다.

        ⚠️#3291 카디르 QA rework(2026-08-21, SQL 레벨 결정적 재현): ms-절삭 토큰을 CAS 비교에
        쓰면 「T1의 write가 만든 새 updated_at이 원래 값과 같은 ms 버킷에 떨어지는」 경우
        T2가 낡은 expected를 들고 와도 date_trunc 비교가 통과해 rowcount=1로 조용히
        덮어쓴다(같은 버킷=같은 절삭값). 이 메서드는 절대 ``updated_at``을 explicit으로
        SET하지 않는다 — 대상 모델(Story/Doc)이 컬럼 자체의 ``onupdate``를 「매 write마다
        직전 값보다 최소 1ms 전진」(``GREATEST(clock_timestamp(), updated_at + 1ms)``,
        app/models/pm.py·doc.py)로 override해 뒀으므로, 이 CAS 경로뿐 아니라 일반
        ``update()``(setattr+flush, onupdate가 그대로 적용)까지 **같은 한 곳의 선언**으로
        모노토닉이 강제된다(둘 중 하나만 고치면 반쪽이 되는 걸 원천 차단).

        rowcount=0이면 대상이 없거나(404, 호출자가 반환값 None으로 판별) 그 사이 다른 write가
        있었다(409, ``CasConflict`` — 최신 row를 실어 올린다). ``expected_updated_at``이
        None이면 기존 ``update()``와 완전히 동일(무CAS·하위호환)."""
        if expected_updated_at is None:
            return await self.update(id, **data)

        result = await self.session.execute(
            sa_update(self.model)
            .where(
                self._org_filter(),
                self.model.id == id,  # type: ignore[attr-defined]
                func.date_trunc("milliseconds", self.model.updated_at)  # type: ignore[attr-defined]
                == func.date_trunc("milliseconds", expected_updated_at),
            )
            .values(**data)
        )
        # Core-style UPDATE는 세션 identity map을 자동 동기화하지 않는다 — 호출부가 이미
        # 같은 id를 로드해 둔 인스턴스(예: 라우터의 사전조회 story_before)가 있으면 재조회
        # (get)만으로는 그 캐시된 파이썬 객체를 그대로 돌려줄 뿐 새 컬럼값을 안 반영한다.
        # expire_all()로 강제 무효화 후 재조회해야 rowcount 판정과 무관하게 항상 신선하다.
        self.session.expire_all()
        if result.rowcount == 1:
            return await self.get(id)

        current = await self.get(id)
        if current is None:
            return None
        raise CasConflict(current)

    async def delete(self, id: uuid.UUID) -> bool:
        obj = await self.get(id)
        if obj is None:
            return False
        await self.session.delete(obj)
        await self.session.flush()
        return True
