"""Workflow Recipes API — S3-1: 자연어 가이드 생성.

GET /api/v2/workflow-recipes          활성 레시피 목록
GET /api/v2/workflow-recipes/{id}/guide  자연어 마크다운 가이드
"""
from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.workflow_template import WorkflowTemplate

router = APIRouter(prefix="/api/v2/workflow-recipes", tags=["workflow-recipes"])

# AC6: 코드 내 3종 프리셋 — DB에 없을 때 fallback + 항상 포함
_BUILTIN_RECIPES: list[dict[str, Any]] = [
    {
        "id": "scrum-3step",
        "slug": "scrum-3step",
        "name": "3단계 스크럼",
        "description": "기획 → 개발 → QA 3단계 워크플로우. 소규모~중규모 스프린트에 적합.",
        "steps": [
            {"role": "PO", "label": "요구사항 정의", "pattern": "kickoff", "action": "기능 명세 및 AC 작성"},
            {"role": "Dev", "label": "구현", "pattern": "implementation", "action": "코드 작성 및 PR 제출"},
            {"role": "QA", "label": "검증", "pattern": "qa_review", "action": "AC 체크리스트 검증 후 APPROVE/REJECT"},
        ],
        "builtin": True,
    },
    {
        "id": "kanban-simple",
        "slug": "kanban-simple",
        "name": "칸반 심플",
        "description": "할 일 → 진행 중 → 완료 단순 흐름. 지속적 딜리버리 환경에 적합.",
        "steps": [
            {"role": "Any", "label": "작업 접수", "pattern": "task_created", "action": "백로그에서 작업 선택 및 claim"},
            {"role": "Dev", "label": "진행", "pattern": "in_progress", "action": "작업 수행 및 진행 상황 업데이트"},
            {"role": "Lead", "label": "완료 확인", "pattern": "done_check", "action": "완료 기준 충족 여부 확인"},
        ],
        "builtin": True,
    },
    {
        "id": "solo",
        "slug": "solo",
        "name": "솔로 에이전트",
        "description": "단일 에이전트가 전 단계를 처리. 간단한 자동화 태스크에 적합.",
        "steps": [
            {"role": "Agent", "label": "수신 및 분석", "pattern": "received", "action": "이벤트 수신 후 컨텍스트 파악"},
            {"role": "Agent", "label": "실행", "pattern": "execute", "action": "태스크 수행 및 결과 생성"},
            {"role": "Agent", "label": "보고", "pattern": "report", "action": "결과 요약 후 채팅/메모로 보고"},
        ],
        "builtin": True,
    },
]

_BUILTIN_BY_ID = {r["id"]: r for r in _BUILTIN_RECIPES}


def _generate_guide(recipe: dict[str, Any]) -> str:
    """AC3: steps를 자연어 마크다운으로 변환."""
    lines = [
        f"# {recipe['name']}",
        "",
        recipe["description"],
        "",
        "## 워크플로우 단계",
        "",
    ]
    for i, step in enumerate(recipe.get("steps", []), 1):
        role = step.get("role", "")
        label = step.get("label", "")
        action = step.get("action", "")
        lines += [
            f"### {i}단계: {label}",
            f"- **담당 역할**: {role}",
            f"- **기대 행동**: {action}",
            "",
        ]
    lines += [
        "## 사용 지침",
        "",
        "- 각 단계를 순서대로 진행하세요.",
        "- 이전 단계 완료 후 다음 단계 담당자에게 메모로 인계하세요.",
        "- 단계별 AC를 충족해야 다음 단계로 넘어갈 수 있습니다.",
    ]
    return "\n".join(lines)


def _template_to_recipe(t: WorkflowTemplate) -> dict[str, Any]:
    steps = []
    for s in (t.steps or []):
        steps.append({
            "role": s.get("role_ref", s.get("role", "")),
            "label": s.get("default_label", s.get("label", "")),
            "pattern": s.get("pattern", ""),
            "action": s.get("action", ""),
        })
    return {
        "id": str(t.id),
        "slug": t.slug,
        "name": t.name,
        "description": t.description,
        "steps": steps,
        "builtin": False,
    }


class RecipeResponse(BaseModel):
    id: str
    slug: str
    name: str
    description: str
    steps: list[dict]
    builtin: bool = False


@router.get("", response_model=list[RecipeResponse])
async def list_recipes(
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    _auth=Depends(get_current_user),
) -> list[RecipeResponse]:
    """AC1: 프로젝트 내 활성 레시피 목록 — builtin 3종 + DB 템플릿."""
    result = await session.execute(
        select(WorkflowTemplate).where(WorkflowTemplate.is_enabled.is_(True))
    )
    db_recipes = [_template_to_recipe(t) for t in result.scalars().all()]
    db_slugs = {r["slug"] for r in db_recipes}

    # builtin 중 DB에 없는 것만 추가
    builtins = [r for r in _BUILTIN_RECIPES if r["slug"] not in db_slugs]
    all_recipes = db_recipes + builtins
    return [RecipeResponse(**r) for r in all_recipes]


@router.get("/{recipe_id}/guide")
async def get_recipe_guide(
    recipe_id: str,
    session: AsyncSession = Depends(get_db),
    _org_id: uuid.UUID = Depends(get_verified_org_id),
    _auth=Depends(get_current_user),
) -> dict:
    """AC2/3: 자연어 마크다운 가이드 텍스트 반환."""
    # builtin 프리셋 확인
    if recipe_id in _BUILTIN_BY_ID:
        recipe = _BUILTIN_BY_ID[recipe_id]
        return {"guide": _generate_guide(recipe), "recipe_id": recipe_id, "name": recipe["name"]}

    # UUID이면 DB 조회
    try:
        rid = uuid.UUID(recipe_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Recipe not found")

    result = await session.execute(
        select(WorkflowTemplate).where(
            WorkflowTemplate.id == rid,
            WorkflowTemplate.is_enabled.is_(True),
        )
    )
    template = result.scalar_one_or_none()
    if template is None:
        raise HTTPException(status_code=404, detail="Recipe not found")

    recipe = _template_to_recipe(template)
    return {"guide": _generate_guide(recipe), "recipe_id": recipe_id, "name": template.name}
