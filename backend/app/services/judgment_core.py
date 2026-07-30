"""story #2268(D단계, E-CONNECT — "판단 칸") — judgments write/read 코어.

AC(오르테가, 2026-07-29): pull 전용 — 「물으면 준다」, push 금지. `corrections`(앞선 말에
대한 말 — retraction·refinement·method_error, `TARGET_REQUIRED_KINDS`와 동일 집합)는 상한과
무관하게 항상 전체(캡 예외 — "철회된 걸 다시 주장 안 하는가"가 이 판의 판정기준이므로 여기서
잘리면 그 기준 자체가 무너진다). `active`(judgment/unmeasurable — corrections 아닌 나머지)는
"다음 발 수" 기준으로 캡 — 지금 실측 가능한 랭킹 신호가 recency뿐이라 그걸로 자르고
`meta.active_cap_basis`로 정직하게 선언한다(다른 신호 없으면 있는 척 안 함, #2266 backlinks의
collection_scope 정직성 패턴과 동형).

⛔story #2308(2026-07-29, 오르테가 자백): 최초 구현은 캡 예외를 `kind == "retraction"`
하나로만 좁혀 썼다 — AC 원문 「retractions는 상한과 무관하게 전량」이 «집합의 정의»가 아니라
«원소 이름 하나»를 썼기 때문(정확한 독해였지만 좁은 표현이 구현을 좁혔다). 결과: 셋 중 가장
넓게 번지는 `method_error`(그 판단 + 같은 방법으로 낸 다른 모든 말을 무효화)가 캡에 가장 먼저
걸리는, 설계 목적과 정반대인 상태였다. 지금은 `TARGET_REQUIRED_KINDS`(모델에 이미 있는 상수)를
캡 예외 집합으로 직접 파생해 쓴다 — 종류를 손으로 다시 나열하지 않는다(새 correction 종류가
생기면 자동으로 따라온다). 응답 필드도 `retractions`→`corrections`로 개명(내용이 이제 셋을
담으므로 이름이 하나만 가리키면 거짓이 된다) — 이 필드의 실제 소비자는 이 저장소 안(router
스키마·MCP 도구 wrapper·이 PR의 realdb 테스트)뿐임을 grep으로 확인했고(호출 경로·HTTP 경로
둘 다 — import 그래프만으론 부족), 배포 하루 만의 라이브 사용도 ORM 계산값이라 저장되지
않으므로 별도 마이그레이션 없이 한 커밋에서 전 소비자를 함께 갱신한다.

app-level 검증을 먼저 하는 이유(#2259 reference_core.insert_reference와 동일 패턴 — 이중
방어): DB CHECK만 믿으면 실패 시 raw IntegrityError 텍스트가 그대로 API 밖으로 샌다. 여기서
먼저 걸러 사람이 읽을 수 있는 메시지로 거절한다 — CHECK는 그래도 안 뺀다("코드가 아니라
제약이 지킨다"가 이 판의 crux, 오르테가 표현).

⛔story #2308 후속(2026-07-29, 오르테가 라이브 dogfooding — #2302에 실제 write→read 왕복):
`active`의 축은 "철회됐나"가 아니라 "말의 층위"(kind가 TARGET_REQUIRED_KINDS 밖인가)라서,
이미 retraction의 target이 된 judgment도 `active`에 그대로 남는다(설계대로 — 버그 아님).
그런데 필드 이름이 "active"라 그 목록만 읽는 소비자는 철회된 판단을 유효한 것으로 오독한다.
`corrections` 원소도 같은 함정이 있다 — method_error는 "그 판단 + 같은 방법으로 낸 다른
모든 말"을 무효화하는 «번지는» 정정이라, 정정이 다른 정정을 target하는 것이 예외가 아니라
method_error의 정상 모양이다(예: 관측 방법 자체가 틀렸다고 밝혀지면 그 방법으로 낸 판단들
전부가 흔들린다). 그래서 `active`와 `corrections` 양쪽 모두를, 각 원소가 target인
correction id 목록(`correction_ids`)으로 decorate한다 — 한 목록만 읽어도 "이건 그대로
믿으면 안 된다"를 그 자리에서 알 수 있게(계보 전체를 재귀로 펼치지 않는다 — 그건 소비자가
target_id를 따라가면 되는 별개 층위, 1단계 표시만 이 판의 경계).
`correction_ids_by_target`은 `correction_rows`(캡 예외, 항상 전량)에서만 파생하므로 캡과
무충돌 — active가 recency로 잘려도(그 항목 자체가 안 보이는 것) correction_ids 계산 자체는
항상 완전한 데이터 위에서 이뤄진다.
"""
from __future__ import annotations

import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.judgment import JUDGMENT_KINDS, JUDGMENT_SCOPES, TARGET_REQUIRED_KINDS, Judgment

DEFAULT_ACTIVE_LIMIT = 20


class InvalidJudgmentError(ValueError):
    """app-level 검증 실패 — 라우터가 422로 번역한다."""


async def create_judgment(
    session: AsyncSession,
    *,
    org_id: uuid.UUID,
    scope: str,
    work_item_ids: list[uuid.UUID],
    kind: str,
    target_id: uuid.UUID | None,
    method: str | None,
    statement: str,
    created_by: uuid.UUID,
    source_message_id: uuid.UUID | None = None,
) -> Judgment:
    """⛔2026-07-30(오르테가 철회 — target_id 순환 실측): target_id는 ㉡(TARGET_REQUIRED_KINDS)
    셋에서도 이제 선택이다 — 처음 쓰는 사람은 가리킬 이전 판정이 없다. 더 이상 필수로
    막지 않는다(아래 존재-검증만 target_id가 «주어졌을 때» 수행)."""
    if kind not in JUDGMENT_KINDS:
        raise InvalidJudgmentError(f"kind must be one of {sorted(JUDGMENT_KINDS)}")
    if scope not in JUDGMENT_SCOPES:
        raise InvalidJudgmentError(f"scope must be one of {sorted(JUDGMENT_SCOPES)}")
    # ⛔scope↔work_item_ids 쌍 — 빈 배열의 "어디에도 안 붙는 것"과 "아직 안 붙인 것" 모호성을
    # 여기서도 명확한 메시지로 막는다(DB CHECK가 최종 방어선, 이건 그 앞단).
    if scope == "general" and work_item_ids:
        raise InvalidJudgmentError("scope='general'이면 work_item_ids는 비어 있어야 합니다(일반 교훈)")
    if scope == "items" and not work_item_ids:
        raise InvalidJudgmentError("scope='items'면 work_item_ids가 최소 1개 필요합니다(아직 안 붙인 상태 금지)")

    if target_id is not None:
        target_exists = (
            await session.execute(
                select(Judgment.id).where(Judgment.id == target_id, Judgment.org_id == org_id)
            )
        ).scalar_one_or_none()
        if target_exists is None:
            raise InvalidJudgmentError(f"target_id {target_id}가 이 org에 존재하지 않습니다")

    judgment = Judgment(
        id=uuid.uuid4(), org_id=org_id, scope=scope, work_item_ids=list(work_item_ids),
        kind=kind, target_id=target_id, method=method, statement=statement,
        created_by=created_by, source_message_id=source_message_id,
    )
    session.add(judgment)
    await session.flush()
    await session.refresh(judgment)
    return judgment


async def list_judgments(
    session: AsyncSession,
    *,
    org_id: uuid.UUID,
    work_item_id: uuid.UUID | None,
    method: str | None,
    scope: str | None,
    limit: int = DEFAULT_ACTIVE_LIMIT,
) -> dict:
    """pull 진입점 코어. 세 축(work_item_id/method/scope)은 AND로 결합 — 필요한 것만
    좁혀 묻는다는 전제(#2268 AC ②의 "다음 발에 필요한 것만"과 짝)."""
    filters = [Judgment.org_id == org_id]
    if work_item_id is not None:
        filters.append(Judgment.work_item_ids.any(work_item_id))
    if method is not None:
        filters.append(Judgment.method == method)
    if scope is not None:
        filters.append(Judgment.scope == scope)

    correction_rows = (
        await session.execute(
            select(Judgment)
            .where(*filters, Judgment.kind.in_(TARGET_REQUIRED_KINDS))
            .order_by(Judgment.created_at.desc())
        )
    ).scalars().all()

    active_filters = [*filters, Judgment.kind.not_in(TARGET_REQUIRED_KINDS)]
    total_active = (
        await session.execute(select(func.count(Judgment.id)).where(*active_filters))
    ).scalar_one()
    active_rows = (
        await session.execute(
            select(Judgment).where(*active_filters).order_by(Judgment.created_at.desc()).limit(limit)
        )
    ).scalars().all()

    active_omitted_count = max(0, total_active - len(active_rows))

    # story #2308 후속: "이건 그대로 믿으면 안 된다" 교차참조 — target인 원소를 가진 모든
    # correction을 target_id별로 묶는다. corrections는 캡 예외(항상 전량)라 이 map은
    # 완전하다. active·corrections 양쪽 원소를 이 «단일» map으로 decorate — 두 자리에
    # 따로 계산하면 한쪽만 고쳐지는 비대칭이 재발한다(오늘 하루 반복 관측된 병).
    correction_ids_by_target: dict[uuid.UUID, list[uuid.UUID]] = {}
    for corr in correction_rows:
        if corr.target_id is not None:
            correction_ids_by_target.setdefault(corr.target_id, []).append(corr.id)
    for row in (*active_rows, *correction_rows):
        row.correction_ids = correction_ids_by_target.get(row.id, [])  # type: ignore[attr-defined]

    return {
        # corrections는 캡 예외 — 위 쿼리에 limit이 없으므로 항상 전량, 그러므로 이쪽은
        # 절대 잘리지 않는다(아래 meta가 active 쪽에만 있는 이유 — 어느 쪽이 잘렸는지
        # 필드 이름 자체가 말하게 한다, story #2308 AC3).
        "corrections": list(correction_rows),
        "active": list(active_rows),
        "meta": {
            "scope": scope,
            "active_capped": active_omitted_count > 0,
            "active_cap_basis": "recency",
            "active_omitted_count": active_omitted_count,
        },
    }
