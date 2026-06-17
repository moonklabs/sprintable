"""E-CAGE-REFEREE P2 + E-HO-TRUST(HO-S5): 신뢰 점수 집계 엔진.

(member, role)별 가설 outcome 적중 이력 기반 신뢰.
  - 기본 source = hypothesis_outcome_bet/execution(가설 적중 이력=substance). HO-S5에서
    CI/pr/qa/design은 기본 trust에서 제외(효과≠실행품질의 substance 전환). legacy 전 source
    합산은 include_legacy=True 명시 opt-in.
  - hit_rate = pass / (pass+fail)(resolved). pass=hit·fail=miss·null=pending.
  - 무정정 통과(clean_pass) = verdict.result='pass' AND (rounds IS NULL OR rounds=0). SP 가중 =
    story_points (null→1 fallback). is_excluded 스토리 제외. (per-role 보조 지표로 유지)
  - 온더플라이 집계 (마이그 없음) — verdict 조인 쿼리.
  - 빈데이터 graceful: 표본 없으면 rate=None (0 아님, cold-start 구분). source_breakdown으로
    제외된 source도 관측.
  - MVP 이진 산식. 데이터 쌓인 뒤 튜닝.

반환 구조:
  {
      "member_id": uuid,
      "scores": [
          {
              "role_key": str,
              "role_label": str,
              "clean_pass_verdicts": int,
              "total_verdicts": int,
              "clean_pass_rate": float | None,
              "total_sp": int,
              "clean_sp": int,
              "weighted_score": float | None,
          },
          ...
      ]
  }
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.participation import Participation, ParticipationRole
from app.models.pm import Story
from app.models.verdict import Verdict

DEFAULT_WINDOW_DAYS = 90

# HO-S5: 신뢰의 1차(primary) source = 가설 outcome verdict(가설 적중 이력=substance).
# 기본 집계는 이 source들만 trust로 환산하고 CI/pr/qa/design은 제외(legacy clean_pass는
# include_legacy=True 명시 옵션). outcome verdict의 result: pass=hit·fail=miss·null=pending.
OUTCOME_SOURCES = frozenset({"hypothesis_outcome_bet", "hypothesis_outcome_execution"})


def _is_clean_pass(result: str | None, rounds: int | None) -> bool:
    """무정정 통과 판정: pass + 정정 라운드 없음."""
    return result == "pass" and (rounds is None or rounds == 0)


async def compute_member_trust_scores(
    session: AsyncSession,
    org_id: uuid.UUID,
    member_id: uuid.UUID,
    role_key: str | None = None,
    window_days: int = DEFAULT_WINDOW_DAYS,
    *,
    include_legacy: bool = False,
) -> dict[str, Any]:
    """(member, role)별 신뢰점수 온더플라이 집계.

    HO-S5: 기본 집계 source를 가설 outcome(hypothesis_outcome_bet/execution)로 제한한다.
    CI/pr/qa/design verdict는 신뢰로 환산하지 않는다(효과≠실행품질의 substance 전환). 결과
    표본이 없으면 clean_pass_rate=None=cold-start(표본부족). legacy 전 source 합산은
    include_legacy=True로 명시 opt-in.

    Args:
        role_key: 특정 역할만 집계. None이면 전 역할.
        window_days: verdict 기준 최근 N일 윈도우.
        include_legacy: True면 모든 source를 신뢰로 합산(구 동작·명시 옵션).

    Returns:
        {"member_id", "scores", "window_days", "primary_source",
         "hypothesis_hit_rate", "resolved", "hit", "pending", "source_breakdown"}.
        scores[*]에는 기존 키(clean_pass_rate 등) + outcome 키(hit/resolved/pending/hit_rate).
    """
    window_start = datetime.now(timezone.utc) - timedelta(days=window_days)

    # 1. 조회: (participation, story, role, verdict) 조인
    p_q = (
        select(Participation, Story, ParticipationRole)
        .join(Story, Story.id == Participation.story_id)
        .join(ParticipationRole, ParticipationRole.id == Participation.role_id)
        .where(
            Participation.org_id == org_id,
            Participation.member_id == member_id,
            Story.is_excluded.is_(False),
            Story.deleted_at.is_(None),
        )
    )
    if role_key is not None:
        p_q = p_q.where(ParticipationRole.key == role_key)

    p_result = await session.execute(p_q)
    rows = p_result.all()

    if not rows:
        return {
            "member_id": str(member_id),
            "scores": [],
            "window_days": window_days,
            "primary_source": "hypothesis_outcome",
            "hypothesis_hit_rate": None,
            "resolved": 0,
            "hit": 0,
            "pending": 0,
            "source_breakdown": {},
        }

    # participation_id → (story_points, role_key, role_label) 매핑
    p_map: dict[uuid.UUID, dict] = {}
    for p, s, r in rows:
        p_map[p.id] = {
            "story_points": s.story_points or 1,
            "role_key": r.key,
            "role_label": r.label,
        }

    # 2. 해당 participation들의 verdict 조회 (윈도우 내)
    verdict_r = await session.execute(
        select(Verdict).where(
            Verdict.org_id == org_id,
            Verdict.participation_id.in_(list(p_map.keys())),
            Verdict.recorded_at >= window_start,
        )
    )
    verdicts = verdict_r.scalars().all()

    # 3. role별 집계
    role_buckets: dict[str, dict] = {}
    for p_id, meta in p_map.items():
        rk = meta["role_key"]
        if rk not in role_buckets:
            role_buckets[rk] = {
                "role_key": rk,
                "role_label": meta["role_label"],
                "clean_pass_verdicts": 0,
                "total_verdicts": 0,
                "clean_sp": 0,
                "total_sp": 0,
                # outcome 중심(가설 적중 이력): pass=hit·fail=miss·null=pending.
                "hit": 0,
                "resolved": 0,
                "pending": 0,
            }

    # source_breakdown은 윈도우 내 모든 verdict로 산출(제외된 source도 관측 가능·AC④ 진단).
    source_breakdown: dict[str, int] = {}
    for v in verdicts:
        source_breakdown[v.source] = source_breakdown.get(v.source, 0) + 1
        meta = p_map.get(v.participation_id)
        if meta is None:
            continue
        is_outcome = v.source in OUTCOME_SOURCES
        # 기본: outcome source만 신뢰로 환산(AC①·②). legacy는 명시 opt-in일 때만 합산.
        if not is_outcome and not include_legacy:
            continue
        rk = meta["role_key"]
        sp = meta["story_points"]
        bucket = role_buckets[rk]
        bucket["total_verdicts"] += 1
        bucket["total_sp"] += sp
        if _is_clean_pass(v.result, v.rounds):
            bucket["clean_pass_verdicts"] += 1
            bucket["clean_sp"] += sp
        if is_outcome:
            if v.result in ("pass", "fail"):
                bucket["resolved"] += 1
                if v.result == "pass":
                    bucket["hit"] += 1
            else:
                bucket["pending"] += 1

    # 4. 점수 계산
    scores: list[dict[str, Any]] = []
    total_hit = 0
    total_resolved = 0
    total_pending = 0
    for rk, b in role_buckets.items():
        tv = b["total_verdicts"]
        tsp = b["total_sp"]
        cp = b["clean_pass_verdicts"]
        csp = b["clean_sp"]
        hit = b["hit"]
        resolved = b["resolved"]
        pending = b["pending"]
        total_hit += hit
        total_resolved += resolved
        total_pending += pending

        clean_pass_rate: float | None = (cp / tv) if tv > 0 else None
        weighted_score: float | None = (csp / tsp) if tsp > 0 else None
        hit_rate: float | None = (hit / resolved) if resolved > 0 else None

        scores.append({
            "role_key": b["role_key"],
            "role_label": b["role_label"],
            "clean_pass_verdicts": cp,
            "total_verdicts": tv,
            "clean_pass_rate": round(clean_pass_rate, 4) if clean_pass_rate is not None else None,
            "total_sp": tsp,
            "clean_sp": csp,
            "weighted_score": round(weighted_score, 4) if weighted_score is not None else None,
            # HO-S5 outcome 중심(가설 적중 이력).
            "hit": hit,
            "resolved": resolved,
            "pending": pending,
            "hit_rate": round(hit_rate, 4) if hit_rate is not None else None,
        })

    hypothesis_hit_rate: float | None = (total_hit / total_resolved) if total_resolved > 0 else None

    return {
        "member_id": str(member_id),
        "scores": scores,
        "window_days": window_days,
        # primary 신뢰 신호는 가설 outcome(legacy 합산은 include_legacy 시에만).
        "primary_source": "legacy_all" if include_legacy else "hypothesis_outcome",
        "hypothesis_hit_rate": round(hypothesis_hit_rate, 4) if hypothesis_hit_rate is not None else None,
        "resolved": total_resolved,
        "hit": total_hit,
        "pending": total_pending,
        "source_breakdown": source_breakdown,
    }
