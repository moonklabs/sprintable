from __future__ import annotations

import re
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import and_, case, exists, func, or_, select, true
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.hypothesis import HypothesisStoryLink
from app.models.pm import Story
from app.repositories.base import BaseRepository
from app.schemas.story import STATUS_TRANSITIONS

_PRIORITY_ORDER = case(
    (Story.priority == "critical", 0),
    (Story.priority == "high", 1),
    (Story.priority == "medium", 2),
    (Story.priority == "low", 3),
    else_=4,
)


_PURE_STORY_NUMBER_RE = re.compile(r"^#?(\d+)$")


def _title_search_filter(q: str):
    """story #2619 fix(페드루 판정, 2026-08-14) — `list()`/`list_board()`/`list_backlog()`
    3곳이 전부 `Story.title.ilike(f"%{q}%")`를 각자 심고 있었다(오늘의 3사본=내일의
    드리프트 — 판정 로직을 한 곳으로 모은다는 것이 이 처방의 근본). 공백으로 토큰화 후
    AND 결합(OR 아님 — "포함하는 단어 전부"가 사용자 기대에 더 가까움, PO 판정): 이전엔
    `q` 전체를 하나의 리터럴 연속 substring으로만 봐서 제목 단어들이어도 **어순이 다르면
    매치 실패**했다(실사례: "무인간 대화 체인 게이트"는 실제 제목 "체인 게이트의 «무인간
    대화»"와 어순이 반대라 0건 — #2619 실측). 토큰이 하나도 없으면(공백뿐인 q) 무필터로
    폴백(true) — 호출부의 `if q:` 가드가 걸러내지 못하는 이 경계를 여기서 안전하게 흡수.

    story #2645(미르코 실사용 발견, 2026-08-14) — 스토리 «번호»는 제목에 리터럴로 없다
    (별도 `story_number` 컬럼)라 title ILIKE만으로는 q="2642" 같은 번호 검색이 구조적으로
    항상 0건이었다. q(공백 트림 후)가 단일 토큰이고 순수 숫자 또는 `#`+숫자면
    (`_PURE_STORY_NUMBER_RE`), title 매치와 `story_number` 정확 일치를 **OR 결합**(PO
    조건①) — «없다»로 오독해 중복 생성/기존 결정 미발견을 제조하는 #2619와 같은 해악
    클래스(원인 축만 다름)를 막는다. OR이라 제목에도 그 숫자가 리터럴로 존재하는 케이스
    (예: 제목에 "2024")는 두 채널이 겹쳐도 자연히 단일 행으로 매치될 뿐 중복이 생기지
    않고, 서로 다른 두 스토리(제목에 "2024"가 든 것과 실제 #2024)가 둘 다 있으면 **둘 다
    반환**된다(조건② 정의 — 한쪽이 다른 쪽을 가리지 않는다). 이 정확일치는 명시
    `story_number` 파라미터(라우터 :147)와 동일하게 project_id 등 다른 필터와는 이 헬퍼가
    아니라 **호출부의 둘러싼 AND**로 스코프된다(project 무지정 org-wide 검색 시 번호가
    project간 재사용됐으면 여러 project의 동일 번호가 잡힐 수 있음 — 기존 명시
    `story_number` 파라미터도 이미 같은 특성이라 새 리스크 아님). 다중 토큰(예: "스토리
    2645")은 이 분기를 타지 않는다(PO 스펙이 "q가 순수 숫자"로 명시 — 섞인 쿼리까지
    넓히는 것은 이 스토리 범위 밖, 추측 금지)."""
    tokens = [t for t in q.split() if t]
    if not tokens:
        return true()
    title_clause = and_(*(Story.title.ilike(f"%{t}%") for t in tokens))
    if len(tokens) == 1:
        m = _PURE_STORY_NUMBER_RE.match(tokens[0])
        if m:
            return or_(title_clause, Story.story_number == int(m.group(1)))
    return title_clause


def _unattached_clause():
    """story #2532(카디르 QA REQUEST_CHANGES, 2026-08-09) — unattached 필터는 반드시 SQL
    WHERE 레벨이어야 한다. 최초 구현(라우터의 Python 후필터 `_filter_unattached`)은 SQL
    limit 後 필터라 ①페이지 경계 밖 유실(SQL이 20건만 뽑았는데 그중 3건만 unattached면 3건만
    반환 — 다음 페이지에 더 있어도 판단 근거가 없다) ②X-Total-Count/X-Next-Cursor가 필터 前
    값이라 거짓 신호(board 분기에서 재현)를 냈다. «미매달림=뷰 결부 재료» 자체가 정확해야
    하는 값이라 이 결함은 못 넘긴다 — WHERE 절로 옮겨 페이지네이션·헤더가 전부 필터 後
    진실을 말하게 한다."""
    return Story.epic_id.is_(None) & ~exists(
        select(HypothesisStoryLink.id).where(HypothesisStoryLink.story_id == Story.id)
    )


async def allocate_story_number(session: AsyncSession, project_id: uuid.UUID) -> int:
    """story 9ac9b80f(FR·대표요청): 프로젝트별 race-safe sequential #N 채번.

    advisory xact lock으로 동일 project_id 동시생성을 직렬화(recruit_service.
    acquire_agent_mutation_lock과 동형 관례) — MAX()+1은 잠금 없이는 TOCTOU(두 트랜잭션이
    같은 max를 읽어 같은 번호를 계산)에 취약하지만, 잠금이 이 함수 호출부터 caller의 커밋/롤백
    까지 동일 project_id 락을 직렬화하므로 안전. 별도 unlock 불요(트랜잭션 종료 시 자동 해제).
    caller는 이 호출과 실제 INSERT를 **같은 트랜잭션**(같은 session, 중간 commit 없음)에서
    수행해야 한다."""
    await session.execute(
        select(func.pg_advisory_xact_lock(func.hashtext(f"story_number:{project_id}")))
    )
    result = await session.execute(
        select(func.coalesce(func.max(Story.story_number), 0)).where(Story.project_id == project_id)
    )
    return int(result.scalar_one()) + 1


class StoryRepository(BaseRepository[Story]):
    def __init__(self, session: AsyncSession, org_id: uuid.UUID) -> None:
        super().__init__(Story, session, org_id)

    async def create(self, **data) -> Story:
        """story 9ac9b80f: story_number는 client-settable 아님 — 항상 서버가 project_id로
        allocate_story_number 호출해 채번한다(BaseRepository.create 전 오버라이드)."""
        story_number = await allocate_story_number(self.session, data["project_id"])
        return await super().create(story_number=story_number, **data)

    async def list(
        self, limit: int = 1000, *, q: str | None = None, cursor: datetime | None = None,
        unattached: bool = False, epic_ids: list[uuid.UUID] | None = None,
        include_unassigned: bool = False, done_within_days: int | None = None, **filters,
    ) -> tuple[list[Story], int]:
        """story #2537(카디르 QA #2932 실측, 2026-08-09) — `list_board()`와 동형으로
        `(stories, total)` 튜플을 반환한다. 이전엔 `list[Story]`만 반환해 이 분기(status
        없이 project_id+unattached=true 등으로 오는 generic 필터 경로)로 빠지는 요청은
        X-Total-Count를 아예 못 냈다 — unattached-bucket이 정확히 이 경로를 타는데
        FE(meta.total)가 항상 undefined를 받아 HIGH로 보고됐다. count는 board 분기와
        동형으로 필터 適用 後·limit 適用 前에 계산한다(cursor 필터까지 포함해야 "이 필터
        조건에서 남은 전체 건수"가 정확하다). 실 콜러는 `app/routers/stories.py`(제네릭
        분기) 단 1곳뿐이라(grep 확認, 직접-호출 테스트 0건) 시그니처 변경이 안전하다.

        story 083176e8(까심 #2148 QA 적출): 갤러리 피커 실검색 — `q`는 title ILIKE 부분일치로
        기존 동등비교 필터(**filters, base.list() 상속)와 AND 결합. BaseRepository.list()는
        범용(모든 리포지토리 공유)이라 q ILIKE 개념을 거기 얹지 않고 story 전용으로 오버라이드
        (list_board/list_by_ids와 동일하게 자체 쿼리 구성 — 기존 관례).

        story #2189(2026-07-25): ORDER BY도 cursor도 없었다 — FE(`buildCursorPageMeta`)의
        over-fetch(limit+1) 페이지네이션은 **결정적 정렬 + cursor가 WHERE로 실제 적용**되는
        전제 위에서만 동작하는데(board 분기·현재 `/api/goals`가 이미 그 전제로 동작 중), 이
        분기만 둘 다 없어 "커서를 바꿔도 같은 페이지가 반복"됐다(sprints/standup "더 보기"가
        dedup 없이 중복 누적). board 분기와 동형으로 `created_at DESC` + `cursor` WHERE를
        추가한다 — board처럼 별도 전용 정렬 우선순위(priority)를 얹지 않는 이유는 이 분기의
        전 콜러(`buildCursorPageMeta`)가 `created_at`만 cursorField로 쓰기 때문(다른 정렬
        기준을 얹으면 FE가 계산하는 nextCursor와 실제 정렬 순서가 어긋난다).

        까심군 QA 지적(2026-07-25, #2490 머지 前): `created_at`만으로는 같은 트랜잭션 배치
        insert 시 server_default=func.now()가 여러 행에 동일 값을 줄 수 있어(테스트가 이 경계를
        1초씩 벌려 피해갔던 것 자체가 "이 경로가 시험된 적 없다"는 증거였다) ORDER BY가
        비결정적이었다 — 같은 쿼리를 다시 실행해도 동률 구간의 순서가 달라질 수 있어 페이지
        재요청 시 skip/dup 위험. `id`를 안정적 2차 키로 얹어 정렬 자체를 결정적으로 만든다
        (board의 `_PRIORITY_ORDER`를 그대로 베끼지 않는 이유: 여기 필요한 건 "board와 같은
        정렬 결과"가 아니라 "커서 전진이 결정적인 것" — 목적에 맞는 최소 키면 충분하다).

        ⚠️ 남는 한계(무너지는 조건): cursor 자체는 여전히 `created_at` 단일값이라(FE
        `buildCursorPageMeta`가 그 값만 보내는 계약 — 서버 혼자 바꿀 수 없다), 동률 경계에
        걸친 행은 이론상 다음 페이지에서 스킵될 수 있다(중복 전달보다는 덜 나쁜 실패 모드로
        의도적으로 선택). board 분기도 동일한 구조적 한계를 이미 갖고 있다 — 실제로 skip이
        관측되면 그때 복합 커서(`created_at`+`id`)로 승격한다.

        story #3019(실사고, PO 확定 2026-08-24) — 에픽 스윔레인 뷰가 매 로드마다 프로젝트
        전체 역사(이 프로젝트 실측 3018건)를 31회 순차 페이지네이션으로 끌어와 37초+ 멈춤을
        냈다. 근본은 «화면이 실제로 그리는 건 활성 에픽 소속+미배정뿐인데 org 전체를 부른다»
        — epic_ids(IN)+include_unassigned(OR)로 그 스코프를 서버측에서 정확히 좁힌다.

        `epic_ids`/`include_unassigned`는 **OR** 결합(활성 에픽 소속 «또는» 미배정) —
        AND라면 "이 에픽들에 속하면서 동시에 미배정"이 돼 공집합이 된다. `unattached`
        (기존 파라미터, #2532)와 다른 개념이다 — `_unattached_clause()`는 "에픽도 가설도
        둘 다 안 매달림"이고, 여기 `include_unassigned`는 스윔레인의 "미배정 레인"과 순수
        1:1 대응하는 "에픽만 없음"(가설 링크 유무 무관) — 기존 `unattached`를 재사용하면
        가설이 매달린 미배정 스토리가 스윔레인에서 조용히 누락되는 별개 결함을 만든다.

        `done_within_days`는 list_board()의 "done: 최근 7일" 관례(CB-S4)를 이 제네릭 경로에
        일반화한 것 — done 아닌 상태는 무관(그 상태들은 자연히 유한하다, 완료 이력만 무한
        누적), done만 `created_at >= now - N일`로 좁힌다. None(기본)이면 기존 동작 그대로."""
        query = select(Story).where(self._org_filter(), Story.deleted_at.is_(None))
        for attr, val in filters.items():
            query = query.where(getattr(Story, attr) == val)
        if q:
            query = query.where(_title_search_filter(q))
        if cursor:
            query = query.where(Story.created_at < cursor)
        if unattached:
            query = query.where(_unattached_clause())
        if epic_ids is not None:
            epic_clause = Story.epic_id.in_(epic_ids)
            query = query.where(or_(epic_clause, Story.epic_id.is_(None)) if include_unassigned else epic_clause)
        elif include_unassigned:
            query = query.where(Story.epic_id.is_(None))
        if done_within_days is not None:
            cutoff = datetime.now(timezone.utc) - timedelta(days=done_within_days)
            query = query.where(or_(Story.status != "done", Story.created_at >= cutoff))

        count_q = select(func.count()).select_from(query.subquery())
        total = (await self.session.execute(count_q)).scalar_one()

        query = query.order_by(Story.created_at.desc(), Story.id.desc()).limit(limit)
        result = await self.session.execute(query)
        return list(result.scalars().all()), total

    async def list_by_ids(self, ids: list[uuid.UUID], *, unattached: bool = False) -> list[Story]:
        """배치 앵커 조회(story ca37b2b0 ② — 갤러리 등 정확한 story 집합 필요 소비자용).

        org-scoped exact-id IN 조회. ORDER BY 없음 — 호출자가 id 집합 그대로를 필요로 하는
        용도(base.list()의 "첫 N건" 비결정 순서 문제와 무관, id 정확 매칭이라 순서 개념 자체가 없음).
        """
        if not ids:
            return []
        query = select(Story).where(
            self._org_filter(), Story.id.in_(ids), Story.deleted_at.is_(None),
        )
        if unattached:
            query = query.where(_unattached_clause())
        result = await self.session.execute(query)
        return list(result.scalars().all())

    async def list_board(
        self,
        project_id: uuid.UUID,
        status: str,
        limit: int = 20,
        cursor: datetime | None = None,
        sprint_id: uuid.UUID | None = None,
        assignee_id: uuid.UUID | None = None,
        epic_id: uuid.UUID | None = None,
        story_number: int | None = None,
        q_text: str | None = None,
        unattached: bool = False,
    ) -> tuple[list[Story], int]:
        """CB-S4: 보드 상태별 쿼리 — created_at DESC + priority 보조 정렬 + cursor 페이징.

        done: 최근 7일 + limit 10 고정.

        story #2188(2026-07-25, 오르테가군 도그푸딩 적발): epic_id/story_number/q_text는
        list_stories()의 제네릭 필터 블록(:148 이하)에만 있고 이 board 분기엔 없었다 — status+
        project_id 조합이면 이 분기로 빠지면서 나머지 필터가 조용히 무시돼 "필터를 추가했는데
        결과가 늘어나는"(계약 위반) 결과를 냈다. 필터는 좁히기만 해야 한다는 불변식을
        test_2188_list_stories_filter_monotonicity.py로 고정한다.
        """
        q = select(Story).where(
            self._org_filter(),
            Story.project_id == project_id,
            Story.status == status,
            Story.deleted_at.is_(None),
        )
        if sprint_id:
            q = q.where(Story.sprint_id == sprint_id)
        if assignee_id:
            q = q.where(Story.assignee_id == assignee_id)
        if epic_id:
            q = q.where(Story.epic_id == epic_id)
        if story_number is not None:
            q = q.where(Story.story_number == story_number)
        if q_text:
            q = q.where(_title_search_filter(q_text))
        if unattached:
            q = q.where(_unattached_clause())

        # done: 최근 7일 제한
        if status == "done":
            cutoff = datetime.now(timezone.utc) - timedelta(days=7)
            q = q.where(Story.created_at >= cutoff)
            limit = min(limit, 10)

        # cursor 기반 페이징 (created_at < cursor)
        if cursor:
            q = q.where(Story.created_at < cursor)

        count_q = select(func.count()).select_from(q.subquery())
        total = (await self.session.execute(count_q)).scalar_one()

        q = q.order_by(Story.created_at.desc(), _PRIORITY_ORDER).limit(limit)
        stories = list((await self.session.execute(q)).scalars().all())
        return stories, total

    async def list_backlog(
        self,
        project_id: uuid.UUID,
        limit: int = 1000,
        epic_id: uuid.UUID | None = None,
        assignee_id: uuid.UUID | None = None,
        status: str | None = None,
        story_number: int | None = None,
        q: str | None = None,
        unattached: bool = False,
    ) -> tuple[list[Story], int]:
        """sprint 미배정 + 삭제되지 않은 스토리만 서버사이드 필터.

        story #2428: `(stories, total)` 튜플을 반환한다(list()/list_board()와 동형 — 필터
        適用 後·limit 適用 前 실 COUNT). 예전엔 total 자체를 안 내(X-Total-Count 헤더 부재)
        MCP `sprintable_list_backlog`가 「더 있는지」를 알 방법이 없었다 — 카디르가 200건
        요청 大비 이 분기가 1000건(자연 상한)까지 조용히 다 실어 320만자 응답을 낸 것도 이
        갭의 다른 얼굴(list_backlog 호출부는 이 사실 자체를 몰랐다).

        story #2188 형제(2026-07-25, 오르테가군 판정) — board 분기(#2489)와 같은 결함 클래스:
        이 분기도 epic_id/assignee_id/status/story_number/q를 받기만 하고 무시했다. 필터
        드롭 자체는 라이브 콜러 확認 결과 사용자 피해 0(FE `ApiStoryRepository.backlog()`는
        콜러 0인 죽은 코드, MCP `sprintable_list_backlog` 툴 스키마는 project_id만 받아 문제
        파라미터를 애초에 못 보냄) — 다만 REST를 직접 부르는 임시 조회(디디군이 #2188 조사
        중 실제로 걸린 자리)는 그대로 노출돼 판단 근거를 오염시킬 수 있어 medium으로 고친다.

        ⚠️ cursor는 여기 없다 — 2026-07-25 초안에서 #2190(까심군 QA)을 근거로 cursor+id
        tiebreak을 여기 얹었었으나, 오르테가군이 프록시 코드(`apps/web/src/app/api/stories/
        backlog/route.ts`)를 직접 읽고 정정: 그 프록시가 `status=backlog`를 강제 부착해
        FastAPI로 보내므로 백엔드에서는 실제로 **board 분기**(`list_board`, cursor 이미 지원)
        를 타지 이 분기로 안 온다. "URL이 `/stories/backlog`니까 이 분기겠지"로 단정한 게
        오판 원인이었다 — #2190의 진짜 원인은 그 프록시가 `apiSuccess()`에 meta를 안 넘겨
        `hasMore`가 구조적으로 항상 false인 것(다른 층의 결함)이라 이 메서드와 무관하다.
        """
        query = select(Story).where(
            self._org_filter(),
            Story.project_id == project_id,
            Story.sprint_id.is_(None),
            Story.deleted_at.is_(None),
        )
        if epic_id:
            query = query.where(Story.epic_id == epic_id)
        if assignee_id:
            query = query.where(Story.assignee_id == assignee_id)
        if status:
            query = query.where(Story.status == status)
        if story_number is not None:
            query = query.where(Story.story_number == story_number)
        if q:
            query = query.where(_title_search_filter(q))
        if unattached:
            query = query.where(_unattached_clause())

        count_q = select(func.count()).select_from(query.subquery())
        total = (await self.session.execute(count_q)).scalar_one()

        result = await self.session.execute(query.limit(limit))
        return list(result.scalars().all()), total

    async def transition_status(self, id: uuid.UUID) -> Story:
        story = await self.get(id)
        if story is None:
            raise ValueError(f"Story {id} not found")
        next_status = STATUS_TRANSITIONS.get(story.status)
        if next_status is None:
            raise ValueError(f"No forward transition from status: {story.status}")
        updated = await self.update(id, status=next_status)
        assert updated is not None
        return updated

    async def set_status(
        self, id: uuid.UUID, new_status: str, violation_level: str = "warn"
    ) -> Story:
        story = await self.get(id)
        if story is None:
            raise ValueError(f"Story {id} not found")

        from app.schemas.story import STORY_STATUSES
        if new_status not in STORY_STATUSES:
            raise ValueError(f"Invalid status: {new_status}")

        if new_status == story.status:
            return story

        current_idx = list(STORY_STATUSES).index(story.status)
        new_idx = list(STORY_STATUSES).index(new_status)
        if new_idx != current_idx + 1:
            # AC1: warn 모드이면 hard block 우회 → 전이 허용 (violation 이벤트는 caller에서 발행)
            if violation_level != "warn":
                raise ValueError(
                    f"Non-sequential transition not allowed: {story.status} → {new_status}"
                )

        updated = await self.update(id, status=new_status)
        assert updated is not None
        return updated
