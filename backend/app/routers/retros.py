import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.retro import RetroItem, RetroSession, RetroVote
from app.services import hypothesis as hyp_svc
from app.services import retro_hypothesis_seed as seed_svc
from app.services import retro_synthesis as synth_svc
from app.services.member_resolver import canonicalize_member_id, resolve_member
from app.services.project_auth import has_project_access
from app.repositories.retro import (
    RetroActionRepository,
    RetroItemRepository,
    RetroSessionRepository,
    RetroVoteRepository,
)
from app.schemas.hypothesis import HypothesisCreate, HypothesisLinkRequest
from app.schemas.retro import (
    ActionResponse,
    AdoptNextHypothesis,
    CreateAction,
    CreateItem,
    CreateSession,
    GroupItem,
    ItemResponse,
    PhaseTransition,
    SessionListResponse,
    SessionResponse,
    UpdateAction,
    VoteResponse,
)

router = APIRouter(prefix="/api/v2/retros", tags=["retros"])


def _get_session_repo(
    db: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> RetroSessionRepository:
    return RetroSessionRepository(db, org_id)


def _has_valid_synthesis(synthesis: object) -> bool:
    """recommend-next 게이팅(까심 codex RC①·②, 2026-07-03) — `synthesis is None`만 보면
    `{}`·`[]`·`{"learned": []}` 같은 malformed/empty 값이 게이트를 통과한다. `synthesis=[]`는
    `_build_next_hypotheses_prompt`의 `.get("learned")` 호출에서 AttributeError(500)까지
    난다. **1차 라운드에서 "learned가 비어있지 않은 list"까지만 봤는데 codex가 아이템 shape
    미검증을 다시 잡음**(`{"learned":[123]}`·`{"learned":[{}]}` 통과해 recommend-next가 사실상
    빈 종합으로 LLM 호출/persist) — ≥1개 dict 아이템이 non-blank `text`를 가져야 유효."""
    if not isinstance(synthesis, dict):
        return False
    learned = synthesis.get("learned")
    if not isinstance(learned, list) or not learned:
        return False
    return any(
        isinstance(item, dict) and isinstance(item.get("text"), str) and item["text"].strip()
        for item in learned
    )


async def _require_retro_project_access(
    session: AsyncSession, session_id: uuid.UUID, user_id: uuid.UUID, org_id: uuid.UUID
) -> RetroSession:
    """대상 retro session의 canonical project-scope authz(doc-gate #1796 `_require_doc_project_access`
    와 동일 패턴). session을 org-scope로 로드하고 caller의 그 session project 접근(has_project_access
    SSOT=team_member∪grant∪owner/admin)을 강제 — 없으면 404·무권한 403. 기존 `_get_session_repo`가
    org-level만 검증해 same-org cross-project IDOR가 있었음(#1801 까심 QA HIGH). 반환=로드된
    session(caller 재사용 가능)."""
    retro = (
        await session.execute(
            select(RetroSession).where(RetroSession.id == session_id, RetroSession.org_id == org_id)
        )
    ).scalar_one_or_none()
    if retro is None:
        raise HTTPException(status_code=404, detail="Retro session not found")
    if not await has_project_access(session, user_id, retro.project_id, org_id):
        raise HTTPException(status_code=403, detail="해당 회고의 프로젝트 접근 권한이 없습니다")
    return retro


async def _require_item_in_session(
    session: AsyncSession, session_id: uuid.UUID, item_id: uuid.UUID
) -> RetroItem:
    """item_id가 session_id 소속인지 확인(2차 IDOR 방어 — item_id를 타 session 것으로 조작해
    부모 session project-access 체크만 우회하는 것 차단)."""
    item = (
        await session.execute(
            select(RetroItem).where(RetroItem.id == item_id, RetroItem.session_id == session_id)
        )
    ).scalar_one_or_none()
    if item is None:
        raise HTTPException(status_code=404, detail="Item not found")
    return item


@router.get("", response_model=list[SessionListResponse])
async def list_sessions(
    project_id: uuid.UUID | None = Query(default=None),
    sprint_id: uuid.UUID | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    repo: RetroSessionRepository = Depends(_get_session_repo),
) -> list[SessionListResponse]:
    user_id = uuid.UUID(auth.user_id)
    if project_id is not None:
        # 명시 필터 시 그 프로젝트 접근권 선검증(무권한 project_id로 org 존재 여부 탐색 차단).
        if not await has_project_access(db, user_id, project_id, repo.org_id):
            raise HTTPException(status_code=403, detail="해당 프로젝트 접근 권한이 없습니다")
    filters: dict = {}
    if project_id:
        filters["project_id"] = project_id
    if sprint_id:
        filters["sprint_id"] = sprint_id
    sessions = await repo.list(**filters)
    if project_id is None:
        # project_id 생략 시 org 전체 세션이 나오던 갭 — 각 세션의 실제 project 접근권으로 필터.
        sessions = [
            s for s in sessions if await has_project_access(db, user_id, s.project_id, repo.org_id)
        ]
    return [SessionListResponse.model_validate(s) for s in sessions]


@router.post("", response_model=SessionListResponse, status_code=201)
async def create_session(
    body: CreateSession,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> SessionListResponse:
    # body.project_id 를 검증 없이 신뢰하면 무권한 project 에 session 을 심는 mutation IDOR.
    if not await has_project_access(db, uuid.UUID(auth.user_id), body.project_id, org_id):
        raise HTTPException(status_code=403, detail="해당 프로젝트 접근 권한이 없습니다")
    # P0(9f27af8f): created_by는 "누가 이 session을 만들었나"라는 행위자(actor) attribution —
    # body.created_by(client 지정)를 신뢰하면 타인 명의 spoofing 벡터. auth로 canonical
    # requester id를 직접 해소(B4/vote_item과 동일 SSOT 패턴), body.created_by는 무시.
    creator = await resolve_member(auth, org_id, db, project_id=body.project_id)
    repo = RetroSessionRepository(db, org_id)
    session = await repo.create(
        project_id=body.project_id,
        title=body.title,
        sprint_id=body.sprint_id,
        created_by=creator.id,
    )
    return SessionListResponse.model_validate(session)


async def _build_session_response(
    db: AsyncSession, session: RetroSession, auth: AuthContext
) -> SessionResponse:
    item_repo = RetroItemRepository(db)
    action_repo = RetroActionRepository(db)
    items = await item_repo.list_by_session(session.id)
    actions = await action_repo.list_by_session(session.id)

    # P1(9f27af8f, 유나 real-payload 재현): grouped child를 items에서 제외하면 FE가 클러스터를
    # 그릴 데이터 자체가 없어짐(FE는 items를 top-level/child로 필터링해 렌더 — child 객체가
    # 있어야 함). session GET은 **flat 배열로 전부 노출**(parent_item_id로 FE가 필터), export만
    # top-level-only 유지(별도 필터, 아래). grouped_item_ids는 parent 조회 편의상 유지.
    grouped_by_parent: dict[uuid.UUID, list[uuid.UUID]] = {}
    for i in items:
        if i.parent_item_id is not None:
            grouped_by_parent.setdefault(i.parent_item_id, []).append(i.id)

    # B4: voted_by_me — client 지정 voter_id 무신뢰. auth 로 canonical requester id 를 직접 해소
    # (P0(9f27af8f) 이후 RetroVote.voter_id 는 vote_item 이 resolve_member 로 직접 써넣은
    # members.id 공간이고, 휴먼은 members.id=org_members.id 로 ID-preserving 백필돼 여기
    # resolve_member(레거시 경로).id 와 동일 공간 — 별도 매핑 불요).
    resolved = await resolve_member(auth, session.org_id, db, project_id=session.project_id)
    voted_item_ids: set[uuid.UUID] = set()
    if items:
        voted_rows = await db.execute(
            select(RetroVote.item_id).where(
                RetroVote.voter_id == resolved.id,
                RetroVote.item_id.in_([i.id for i in items]),
            )
        )
        voted_item_ids = set(voted_rows.scalars().all())

    # dc861e44 §5 — sprint 링크 가설(story 1 sprint_id 필터 재사용). sprint 미연결 회고는 [].
    hypotheses = await synth_svc.build_hypotheses_items(
        db, session.org_id, session.project_id, session.sprint_id
    )

    return SessionResponse(
        id=session.id,
        project_id=session.project_id,
        org_id=session.org_id,
        sprint_id=session.sprint_id,
        created_by=session.created_by,
        title=session.title,
        phase=session.phase,
        created_at=session.created_at,
        updated_at=session.updated_at,
        items=[
            ItemResponse(
                id=i.id,
                session_id=i.session_id,
                author_id=i.author_id,
                category=i.category,
                text=i.text,
                vote_count=i.vote_count,
                created_at=i.created_at,
                voted_by_me=i.id in voted_item_ids,
                parent_item_id=i.parent_item_id,
                grouped_item_ids=grouped_by_parent.get(i.id, []),
            )
            for i in items
        ],
        actions=[ActionResponse.model_validate(a) for a in actions],
        hypotheses=hypotheses,
        synthesis=session.synthesis,
        next_hypotheses=session.next_hypotheses,
    )


@router.get("/{id}", response_model=SessionResponse)
async def get_session(
    id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    repo: RetroSessionRepository = Depends(_get_session_repo),
) -> SessionResponse:
    session = await _require_retro_project_access(db, id, uuid.UUID(auth.user_id), repo.org_id)
    return await _build_session_response(db, session, auth)


@router.post("/{id}/synthesize", response_model=SessionResponse)
async def synthesize_session(
    id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    repo: RetroSessionRepository = Depends(_get_session_repo),
) -> SessionResponse:
    """dc861e44 §3 — L2 종합(on-demand·버튼 트리거). overwrite 저장(PO 결).

    ⚠️ result가 None(LLM 생성 실패)이면 **저장하지 않는다** — 기존 good synthesis 캐시를
    빈 결과로 덮어써 잃는 data-loss(오르테가 지적 2026-07-03·S28 캐시게이트 버그와 동형)를
    막는다. 502로 실패를 명시하고 재시도를 유도(자동 backfill 없음)."""
    session = await _require_retro_project_access(db, id, uuid.UUID(auth.user_id), repo.org_id)
    result = await synth_svc.synthesize(db, session)
    if result is None:
        raise HTTPException(
            status_code=502,
            detail={"code": "SYNTHESIS_GENERATION_FAILED", "message": "AI 종합 생성에 실패했습니다. 잠시 후 다시 시도해주세요."},
        )
    updated = await repo.update(id, synthesis=result)
    assert updated is not None
    return await _build_session_response(db, updated, auth)


@router.post("/{id}/recommend-next", response_model=SessionResponse)
async def recommend_next_session(
    id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    repo: RetroSessionRepository = Depends(_get_session_repo),
) -> SessionResponse:
    """dc861e44 §3 — L3 다음가설 추천(on-demand). synthesis 선행 필수 — PO 결(2026-07-03):
    fail-closed(409), 자동 선행 생성 안 함(HITL 순서 — 팀이 종합을 보고/편집한 뒤 추천)."""
    session = await _require_retro_project_access(db, id, uuid.UUID(auth.user_id), repo.org_id)
    if not _has_valid_synthesis(session.synthesis):
        raise HTTPException(
            status_code=409,
            detail={"code": "SYNTHESIS_REQUIRED", "message": "종합을 먼저 생성해야 합니다."},
        )
    result = await synth_svc.recommend_next(session.synthesis)
    if result is None:
        # synthesize_session과 동일 원칙 — 실패를 빈 배열로 조용히 저장해 기존 good
        # next_hypotheses 캐시를 지우지 않는다(오르테가 지적 2026-07-03).
        raise HTTPException(
            status_code=502,
            detail={"code": "RECOMMENDATION_GENERATION_FAILED", "message": "다음가설 추천 생성에 실패했습니다. 잠시 후 다시 시도해주세요."},
        )
    updated = await repo.update(id, next_hypotheses=result)
    assert updated is not None
    return await _build_session_response(db, updated, auth)


# story 4b87d3a6: FE `retro/[id]/page.tsx`+BFF는 `POST /{id}/synthesis`(명사) 1콜로
# {synthesis, next_hypotheses}를 한번에 기대하는데(retro-sessions/[id]/synthesis/route.ts),
# 이 라우터엔 `/synthesize`+`/recommend-next` 2분리 동사 엔드포인트만 있어 `/synthesis` 자체가
# dev 라이브 404였다. L2(synthesize)+L3(recommend_next)를 순차 오케스트레이션 — 새 로직 0줄,
# 기존 두 서비스 함수 재사용.
@router.post("/{id}/synthesis", response_model=SessionResponse)
async def synthesize_and_recommend(
    id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    repo: RetroSessionRepository = Depends(_get_session_repo),
) -> SessionResponse:
    """dc861e44 §3 L2+L3 combined(FE 계약 정합, story 4b87d3a6). L2 실패 → 502(`/synthesize`와
    동일 코드). L2 성공+L3 실패는 **combined 호출 자체를 실패시키지 않는다**(PO crux
    2026-07-04 ①): synthesis는 이미 확정 저장됐고, next_hypotheses는 기존 캐시를 그대로
    유지(#1863 data-loss 방지 원칙 연장 — 방금 실패한 L3로 예전 good 캐시를 지우지 않음).
    FE도 원래 next_hypotheses를 optional로 취급(`?? []`)이라 L3만 실패해도 L2 성과가
    죽지 않는다."""
    session = await _require_retro_project_access(db, id, uuid.UUID(auth.user_id), repo.org_id)
    sresult = await synth_svc.synthesize(db, session)
    if sresult is None:
        raise HTTPException(
            status_code=502,
            detail={"code": "SYNTHESIS_GENERATION_FAILED", "message": "AI 종합 생성에 실패했습니다. 잠시 후 다시 시도해주세요."},
        )
    updated = await repo.update(id, synthesis=sresult)
    assert updated is not None

    nresult = await synth_svc.recommend_next(updated.synthesis)
    if nresult is not None:
        updated = await repo.update(id, next_hypotheses=nresult)
        assert updated is not None
    # nresult is None → 조용히 스킵(위 docstring 참고) — updated.next_hypotheses는 DB의
    # 기존(가능하면 예전) 값 그대로.

    return await _build_session_response(db, updated, auth)


@router.post("/{id}/next-hypotheses/adopt", response_model=SessionResponse)
async def adopt_next_hypothesis(
    id: uuid.UUID,
    body: AdoptNextHypothesis,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    repo: RetroSessionRepository = Depends(_get_session_repo),
) -> SessionResponse:
    """ecc531ce §3 — L3 추천 채택 → proposed 가설 persist + 다음 sprint 있으면
    link_type="seeded"로 링크(없으면 backlog proposed). 신규 hypothesis 서비스 로직 0줄 —
    기존 create_hypothesis + link_hypothesis 조합. sprint_id는 서버가 조회(§2 PO 결)해서
    클라이언트가 넘기지 않으므로 그 축의 IDOR가 설계상 없다.

    story 4b87d3a6: candidate_id는 path가 아니라 body의 `id`(FE `{...rec, statement}`
    spread가 실어보내는 필드 — FE 코드 변경 0). 누락/malformed면 Pydantic이 자동 422
    (PO crux 2026-07-04: 암묵계약 drift 대비 graceful 422 확인 완료).

    ⭐HITL statement 편집 반영(story 4b87d3a6, PO crux "§3.7.1 확정은 당신이" 위반 지적) —
    body.statement가 있으면(사람이 sprint-close-cockpit의 OperatorTextarea로 편집한 값)
    그걸 쓰고, 없으면 서버 저장 candidate의 statement 그대로. metric_definition/
    measure_after는 여전히 서버 값만 신뢰(클라 위조 방지 — AI 산출 수치는 편집 대상 아님,
    문구만 사람이 다듬는 게 UX 의도).

    SOUL-LOCK(유나 §6) "채택=인간 게이트" — agent caller는 403.

    원자성(까심 crux 2026-07-03): `repo.get_for_update`로 이 session row를 잠가 동시
    더블클릭이 직렬화되게 한다 — 안 그러면 둘 다 "미채택"을 읽고 각자 create_hypothesis를
    호출해 중복 proposed 가설이 생긴다(#1862 set_sprint_link TOCTOU와 같은 클래스)."""
    session = await _require_retro_project_access(db, id, uuid.UUID(auth.user_id), repo.org_id)
    caller = await resolve_member(auth, session.org_id, db, project_id=session.project_id)
    if caller.type != "human":
        raise HTTPException(
            status_code=403,
            detail={"code": "ADOPTION_REQUIRES_HUMAN", "message": "다음가설 채택은 사람만 할 수 있습니다."},
        )

    locked = await repo.get_for_update(id)
    if locked is None:
        raise HTTPException(status_code=404, detail="Retro session not found")

    candidate = seed_svc.find_candidate(locked.next_hypotheses, body.id)
    if candidate is None:
        raise HTTPException(
            status_code=404,
            detail={"code": "CANDIDATE_NOT_FOUND", "message": "추천 가설을 찾을 수 없습니다."},
        )
    if candidate.get("adopted_hypothesis_id"):
        raise HTTPException(
            status_code=409,
            detail={"code": "ALREADY_ADOPTED", "message": "이미 채택된 추천입니다."},
        )

    statement = body.statement.strip() if body.statement and body.statement.strip() else candidate["statement"]

    hyp = await hyp_svc.create_hypothesis(
        db, session.org_id, caller,
        HypothesisCreate(
            project_id=session.project_id,
            statement=statement,
            metric_definition=candidate["metric_definition"],
            measure_after=candidate["measure_after"],
            status="proposed",
            source_type="retro_synthesis",
            source_id=session.id,
        ),
    )

    next_sprint = await seed_svc.resolve_next_sprint(db, session.org_id, session.project_id)
    if next_sprint is not None:
        await hyp_svc.link_hypothesis(
            db, session.org_id, hyp.id,
            HypothesisLinkRequest(sprint_id=next_sprint.id, link_type="seeded"),
        )

    updated_candidates = [
        {**c, "adopted_hypothesis_id": str(hyp.id)} if str(c.get("id")) == str(body.id) else c
        for c in locked.next_hypotheses
    ]
    updated = await repo.update(id, next_hypotheses=updated_candidates)
    assert updated is not None
    return await _build_session_response(db, updated, auth)


@router.patch("/{id}/phase", response_model=SessionListResponse)
async def advance_phase(
    id: uuid.UUID,
    body: PhaseTransition,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    repo: RetroSessionRepository = Depends(_get_session_repo),
) -> SessionListResponse:
    await _require_retro_project_access(db, id, uuid.UUID(auth.user_id), repo.org_id)
    try:
        session = await repo.set_phase(id, body.phase)
    except (ValueError, Exception) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return SessionListResponse.model_validate(session)


@router.post("/{id}/items", response_model=ItemResponse, status_code=201)
async def add_item(
    id: uuid.UUID,
    body: CreateItem,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    repo: RetroSessionRepository = Depends(_get_session_repo),
) -> ItemResponse:
    session = await _require_retro_project_access(db, id, uuid.UUID(auth.user_id), repo.org_id)
    item_repo = RetroItemRepository(db)
    # P0(9f27af8f): author_id도 행위자(actor) attribution — body.author_id(client 지정) 무시,
    # auth로 canonical requester id를 직접 해소(vote_item/create_session과 동일 SSOT 패턴).
    author_id = (await resolve_member(auth, session.org_id, db, project_id=session.project_id)).id
    item = await item_repo.create(
        session_id=id, category=body.category, text=body.text, author_id=author_id
    )
    return ItemResponse.model_validate(item)


@router.post("/{id}/items/{item_id}/group", response_model=ItemResponse)
async def group_item(
    id: uuid.UUID,
    item_id: uuid.UUID,
    body: GroupItem,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    repo: RetroSessionRepository = Depends(_get_session_repo),
) -> ItemResponse:
    """B2: item_id를 body.parent_item_id 아래 병합('group' phase 중복 정리)."""
    await _require_retro_project_access(db, id, uuid.UUID(auth.user_id), repo.org_id)
    item_repo = RetroItemRepository(db)
    try:
        item = await item_repo.group_under_parent(id, item_id, body.parent_item_id)
    except ValueError as exc:
        if "ITEM_NOT_FOUND" in str(exc):
            raise HTTPException(status_code=404, detail="Item not found") from exc
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return ItemResponse.model_validate(item)


@router.post("/{id}/items/{item_id}/ungroup", response_model=ItemResponse)
async def ungroup_item(
    id: uuid.UUID,
    item_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    repo: RetroSessionRepository = Depends(_get_session_repo),
) -> ItemResponse:
    await _require_retro_project_access(db, id, uuid.UUID(auth.user_id), repo.org_id)
    item_repo = RetroItemRepository(db)
    item = await item_repo.ungroup(id, item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Item not found")
    return ItemResponse.model_validate(item)


@router.delete("/{id}/items/{item_id}", status_code=200)
async def delete_item(
    id: uuid.UUID,
    item_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    repo: RetroSessionRepository = Depends(_get_session_repo),
) -> dict:
    await _require_retro_project_access(db, id, uuid.UUID(auth.user_id), repo.org_id)
    item_repo = RetroItemRepository(db)
    ok = await item_repo.delete_from_session(id, item_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Item not found")
    return {"ok": True}


@router.post("/{id}/items/{item_id}/vote", response_model=VoteResponse, status_code=201)
async def vote_item(
    id: uuid.UUID,
    item_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    repo: RetroSessionRepository = Depends(_get_session_repo),
) -> VoteResponse:
    # P0(9f27af8f): 원래 client-supplied `voter_id: Query(...)` — 타인 대신 투표하는
    # spoofing 벡터였고, FE(#1801 리라이트)는 애초에 이 파라미터를 보내지 않아 전 투표가
    # 422로 깨져 있었다(유나 라이브 E2E 적출). 근본수정: voter는 auth에서 canonical
    # requester id로 서버사이드 해소(client 입력 전혀 신뢰하지 않음).
    session = await _require_retro_project_access(db, id, uuid.UUID(auth.user_id), repo.org_id)
    item = await _require_item_in_session(db, id, item_id)
    if item.parent_item_id is not None:
        # B2: 그룹핑된 child는 투표 불가 — 투표는 parent로 이관/집계.
        raise HTTPException(status_code=400, detail="Grouped child items cannot be voted directly")
    voter_id = (await resolve_member(auth, session.org_id, db, project_id=session.project_id)).id
    vote_repo = RetroVoteRepository(db)
    try:
        vote = await vote_repo.vote(item_id, voter_id)
    except ValueError as exc:
        if "DUPLICATE_VOTE" in str(exc):
            raise HTTPException(status_code=409, detail="Already voted") from exc
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return VoteResponse.model_validate(vote)


@router.get("/{id}/actions", response_model=list[ActionResponse])
async def list_actions(
    id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    repo: RetroSessionRepository = Depends(_get_session_repo),
) -> list[ActionResponse]:
    await _require_retro_project_access(db, id, uuid.UUID(auth.user_id), repo.org_id)
    action_repo = RetroActionRepository(db)
    actions = await action_repo.list_by_session(id)
    return [ActionResponse.model_validate(a) for a in actions]


@router.post("/{id}/actions", response_model=ActionResponse, status_code=201)
async def create_action(
    id: uuid.UUID,
    body: CreateAction,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    repo: RetroSessionRepository = Depends(_get_session_repo),
) -> ActionResponse:
    await _require_retro_project_access(db, id, uuid.UUID(auth.user_id), repo.org_id)
    action_repo = RetroActionRepository(db)
    assignee_id = (await canonicalize_member_id(body.assignee_id, db)) if body.assignee_id else None
    action = await action_repo.create(
        session_id=id, title=body.title, assignee_id=assignee_id
    )
    return ActionResponse.model_validate(action)


@router.patch("/{id}/actions/{action_id}", response_model=ActionResponse)
async def update_action(
    id: uuid.UUID,
    action_id: uuid.UUID,
    body: UpdateAction,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    repo: RetroSessionRepository = Depends(_get_session_repo),
) -> ActionResponse:
    # #1801 까심 QA HIGH — 이 라우트가 org-only 게이트였던 원 적출 지점.
    await _require_retro_project_access(db, id, uuid.UUID(auth.user_id), repo.org_id)
    action_repo = RetroActionRepository(db)
    data = body.model_dump(exclude_unset=True)
    action = await action_repo.update_in_session(id, action_id, **data)
    if action is None:
        raise HTTPException(status_code=404, detail="Action not found")
    return ActionResponse.model_validate(action)


@router.get("/{id}/export")
async def export_session(
    id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    repo: RetroSessionRepository = Depends(_get_session_repo),
) -> Response:
    session = await _require_retro_project_access(db, id, uuid.UUID(auth.user_id), repo.org_id)

    item_repo = RetroItemRepository(db)
    action_repo = RetroActionRepository(db)
    # B2: 그룹핑된 child는 export에서도 제외(parent에 집계된 vote_count로만 노출).
    items = [i for i in await item_repo.list_by_session(id) if i.parent_item_id is None]
    actions = await action_repo.list_by_session(id)

    lines = [
        f"# {session.title}",
        f"**Phase:** {session.phase}",
        "",
        "## 잘된 점 (Good)",
        *[f"- {i.text} ({i.vote_count} votes)" for i in items if i.category == "good"],
        "",
        "## 아쉬운 점 (Bad)",
        *[f"- {i.text} ({i.vote_count} votes)" for i in items if i.category == "bad"],
        "",
        "## 개선할 점 (Improve)",
        *[f"- {i.text} ({i.vote_count} votes)" for i in items if i.category == "improve"],
        "",
        "## Action Items",
        *[f"- [{a.status}] {a.title}" for a in actions],
    ]

    return Response(content="\n".join(lines), media_type="text/markdown")
