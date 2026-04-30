from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agent_deployment import AgentDeployment, AgentPersona
from app.schemas.agent_persona import PersonaSummaryResponse


def _slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.strip().lower()).strip("-")
    return slug or "persona"


def _build_summary(persona: AgentPersona, is_in_use: bool, base: AgentPersona | None = None) -> PersonaSummaryResponse:
    config: dict[str, Any] = persona.config or {}
    base_persona_id = config.get("base_persona_id") if isinstance(config.get("base_persona_id"), str) else None
    tool_allowlist: list[str] = config.get("tool_allowlist", []) if isinstance(config.get("tool_allowlist"), list) else []

    own_prompt = (persona.system_prompt or "").strip()
    base_prompt = (base.system_prompt or "").strip() if base else ""
    resolved_system = "\n\n".join(p for p in [base_prompt, own_prompt] if p) or ""

    own_style = (persona.style_prompt or "").strip() or None
    base_style = (base.style_prompt or "").strip() if base else None
    resolved_style = "\n\n".join(p for p in [base_style, own_style] if p) or None

    version_metadata: dict[str, Any] = config.get("version_metadata") or {}
    permission_boundary: dict[str, Any] = {"tool_allowlist": tool_allowlist, "restrictions": []}

    base_data = (
        {"id": str(base.id), "name": base.name, "slug": base.slug, "is_builtin": base.is_builtin}
        if base else None
    )

    return PersonaSummaryResponse(
        id=persona.id,
        org_id=persona.org_id,
        project_id=persona.project_id,
        agent_id=persona.agent_id,
        name=persona.name,
        slug=persona.slug,
        description=persona.description,
        system_prompt=own_prompt,
        style_prompt=own_style,
        resolved_system_prompt=resolved_system,
        resolved_style_prompt=resolved_style,
        model=persona.model,
        config=persona.config,
        is_builtin=persona.is_builtin,
        is_default=persona.is_default,
        is_in_use=is_in_use,
        tool_allowlist=tool_allowlist,
        base_persona_id=base_persona_id,
        base_persona=base_data,
        version_metadata=version_metadata,
        permission_boundary=permission_boundary,
        change_history=[],
        created_by=persona.created_by,
        created_at=persona.created_at,
        updated_at=persona.updated_at,
    )


class AgentPersonaRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def _is_in_use(self, persona_id: uuid.UUID) -> bool:
        r = await self.session.execute(
            select(AgentDeployment.id).where(
                AgentDeployment.persona_id == persona_id,
                AgentDeployment.deleted_at.is_(None),
            ).limit(1)
        )
        return r.scalar_one_or_none() is not None

    async def _get_base(self, config: dict, org_id: uuid.UUID) -> AgentPersona | None:
        base_id = config.get("base_persona_id")
        if not base_id or not isinstance(base_id, str):
            return None
        try:
            base_uuid = uuid.UUID(base_id)
        except ValueError:
            return None
        r = await self.session.execute(
            select(AgentPersona).where(
                AgentPersona.id == base_uuid,
                AgentPersona.org_id == org_id,
                AgentPersona.deleted_at.is_(None),
            )
        )
        return r.scalar_one_or_none()

    async def _decorate(self, persona: AgentPersona) -> PersonaSummaryResponse:
        base = await self._get_base(persona.config or {}, persona.org_id)
        in_use = await self._is_in_use(persona.id)
        return _build_summary(persona, in_use, base)

    async def list(
        self,
        org_id: uuid.UUID,
        project_id: uuid.UUID,
        agent_id: uuid.UUID,
        include_builtin: bool = False,
    ) -> list[PersonaSummaryResponse]:
        q = select(AgentPersona).where(
            AgentPersona.org_id == org_id,
            AgentPersona.project_id == project_id,
            AgentPersona.agent_id == agent_id,
            AgentPersona.deleted_at.is_(None),
        ).order_by(AgentPersona.is_default.desc(), AgentPersona.created_at.asc())
        if not include_builtin:
            q = q.where(AgentPersona.is_builtin.is_(False))
        r = await self.session.execute(q)
        personas = list(r.scalars().all())
        return [await self._decorate(p) for p in personas]

    async def get(self, persona_id: uuid.UUID, org_id: uuid.UUID, project_id: uuid.UUID) -> PersonaSummaryResponse | None:
        r = await self.session.execute(
            select(AgentPersona).where(
                AgentPersona.id == persona_id,
                AgentPersona.org_id == org_id,
                AgentPersona.project_id == project_id,
                AgentPersona.deleted_at.is_(None),
            )
        )
        persona = r.scalar_one_or_none()
        if persona is None:
            return None
        return await self._decorate(persona)

    async def create(
        self,
        org_id: uuid.UUID,
        project_id: uuid.UUID,
        agent_id: uuid.UUID,
        actor_id: uuid.UUID,
        name: str,
        slug: str | None = None,
        description: str | None = None,
        system_prompt: str | None = None,
        style_prompt: str | None = None,
        model: str | None = None,
        base_persona_id: uuid.UUID | None = None,
        tool_allowlist: list[str] | None = None,
        is_default: bool = False,
    ) -> PersonaSummaryResponse:
        if is_default:
            await self._clear_default(org_id, project_id, agent_id)

        config: dict[str, Any] = {}
        if base_persona_id:
            config["base_persona_id"] = str(base_persona_id)
        if tool_allowlist is not None:
            config["tool_allowlist"] = tool_allowlist

        persona = AgentPersona(
            org_id=org_id,
            project_id=project_id,
            agent_id=agent_id,
            name=name.strip(),
            slug=_slugify(slug or name),
            description=description.strip() if description else None,
            system_prompt=(system_prompt or "").strip(),
            style_prompt=style_prompt.strip() if style_prompt else None,
            model=model.strip() if model else None,
            config=config,
            is_builtin=False,
            is_default=is_default,
            created_by=actor_id,
        )
        self.session.add(persona)
        await self.session.flush()
        await self.session.refresh(persona)
        return await self._decorate(persona)

    async def update(
        self,
        persona_id: uuid.UUID,
        org_id: uuid.UUID,
        project_id: uuid.UUID,
        actor_id: uuid.UUID,
        **fields: Any,
    ) -> PersonaSummaryResponse | None:
        r = await self.session.execute(
            select(AgentPersona).where(
                AgentPersona.id == persona_id,
                AgentPersona.org_id == org_id,
                AgentPersona.project_id == project_id,
                AgentPersona.deleted_at.is_(None),
            )
        )
        persona = r.scalar_one_or_none()
        if persona is None:
            return None
        if persona.is_builtin:
            raise ValueError("Built-in personas cannot be modified")

        config = dict(persona.config or {})
        if "base_persona_id" in fields:
            bpid = fields.pop("base_persona_id")
            config["base_persona_id"] = str(bpid) if bpid else None
        if "tool_allowlist" in fields:
            tl = fields.pop("tool_allowlist")
            if tl is not None:
                config["tool_allowlist"] = tl

        if fields.get("is_default"):
            await self._clear_default(org_id, project_id, persona.agent_id, exclude_id=persona_id)

        patch: dict[str, Any] = {"config": config, "updated_at": datetime.now(timezone.utc)}
        for key in ("name", "slug", "description", "system_prompt", "style_prompt", "model", "is_default"):
            if key in fields and fields[key] is not None:
                val = fields[key]
                if key == "name":
                    val = val.strip()
                elif key == "slug":
                    val = _slugify(val)
                elif key in ("description", "system_prompt", "style_prompt"):
                    val = val.strip() if val else None
                elif key == "model":
                    val = val.strip() if val else None
                patch[key] = val

        await self.session.execute(
            update(AgentPersona).where(AgentPersona.id == persona_id).values(**patch)
        )
        await self.session.flush()
        await self.session.refresh(persona)
        return await self._decorate(persona)

    async def delete(self, persona_id: uuid.UUID, org_id: uuid.UUID, project_id: uuid.UUID) -> bool:
        r = await self.session.execute(
            select(AgentPersona).where(
                AgentPersona.id == persona_id,
                AgentPersona.org_id == org_id,
                AgentPersona.project_id == project_id,
                AgentPersona.deleted_at.is_(None),
            )
        )
        persona = r.scalar_one_or_none()
        if persona is None:
            return False
        if persona.is_builtin:
            raise ValueError("Built-in personas cannot be deleted")
        in_use = await self._is_in_use(persona_id)
        if in_use:
            raise ValueError("Cannot delete a persona that is currently in use")

        await self.session.execute(
            update(AgentPersona).where(AgentPersona.id == persona_id).values(
                deleted_at=datetime.now(timezone.utc),
                is_default=False,
                updated_at=datetime.now(timezone.utc),
            )
        )
        await self.session.flush()
        return True

    async def seed_builtin(self, org_id: uuid.UUID, project_id: uuid.UUID, agent_id: uuid.UUID) -> dict:
        from sqlalchemy import text
        await self.session.execute(
            text("SELECT seed_builtin_personas(:org_id::uuid, :project_id::uuid, :agent_id::uuid)"),
            {"org_id": str(org_id), "project_id": str(project_id), "agent_id": str(agent_id)},
        )
        await self.session.flush()
        return {"seeded": True}

    async def _clear_default(self, org_id: uuid.UUID, project_id: uuid.UUID, agent_id: uuid.UUID, exclude_id: uuid.UUID | None = None) -> None:
        q = update(AgentPersona).where(
            AgentPersona.org_id == org_id,
            AgentPersona.project_id == project_id,
            AgentPersona.agent_id == agent_id,
            AgentPersona.is_default.is_(True),
            AgentPersona.deleted_at.is_(None),
        ).values(is_default=False)
        if exclude_id:
            from sqlalchemy import and_
            q = update(AgentPersona).where(
                AgentPersona.org_id == org_id,
                AgentPersona.project_id == project_id,
                AgentPersona.agent_id == agent_id,
                AgentPersona.is_default.is_(True),
                AgentPersona.deleted_at.is_(None),
                AgentPersona.id != exclude_id,
            ).values(is_default=False)
        await self.session.execute(q)
