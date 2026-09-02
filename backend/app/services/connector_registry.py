"""story #3317(마케팅자동화·레시피 결함, PO 확定 2026-09-02①②③) — org_connector_registry
read/write. domain_label.py의 upsert 패턴(원자 Core upsert + populate_existing 재조회) 재사용.

이 파일이 강제하는 것 — «선언 안 된 것을 조용히 통과시키지 않는다»:
- `org_config`에 쓸 수 있는 키는 그 커넥터의 `fields`에 `source="org_config"`로 선언된
  이름뿐(오타·미선언 키는 422).
- 값의 파이썬 타입은 그 필드의 declared `type`(string|number|boolean|array)과 일치해야
  한다(예: listId를 declared type=number인데 문자열로 보내면 422).
- `requires_env`는 환경변수 **이름**만(값이 섞여 오면 422 — services 계층에서 형태로 판별,
  아래 `_looks_like_env_var_name` 참조). 시크릿 값은 이 테이블에 절대 저장되지 않는다."""
from __future__ import annotations

import re
import uuid

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.connector_registry import OrgConnectorRegistry

_ENV_VAR_NAME_RE = re.compile(r"^[A-Z_][A-Z0-9_]*$")

_FIELD_TYPES = frozenset({"string", "number", "boolean", "array"})


class InvalidConnectorSchemaError(ValueError):
    """스키마 upsert(POST) shape 위반 — fields/requires_env 모양이 계약과 다름."""


class ConnectorNotRegisteredError(LookupError):
    """이 org에 그 connector_key로 등록된 스키마가 없음(PUT config/GET 전에 POST 필요)."""


class InvalidConnectorConfigError(ValueError):
    """PUT config가 미선언 키를 쓰려 하거나, 값의 타입이 declared type과 안 맞음."""


def _looks_like_env_var_name(value: str) -> bool:
    return bool(_ENV_VAR_NAME_RE.match(value))


def _validate_fields_shape(fields: list) -> None:
    if not isinstance(fields, list):
        raise InvalidConnectorSchemaError("fields는 배열이어야 합니다.")
    for f in fields:
        if not isinstance(f, dict):
            raise InvalidConnectorSchemaError(f"fields 항목은 object여야 합니다 — {f!r}")
        if not isinstance(f.get("name"), str) or not f["name"]:
            raise InvalidConnectorSchemaError(f"fields[].name은 비어있지 않은 문자열이어야 합니다 — {f!r}")
        if f.get("source") not in ("content", "org_config"):
            raise InvalidConnectorSchemaError(
                f"fields[{f.get('name')!r}].source는 'content' 또는 'org_config'여야 합니다."
            )
        if "type" in f and f["type"] not in _FIELD_TYPES:
            raise InvalidConnectorSchemaError(
                f"fields[{f.get('name')!r}].type은 {sorted(_FIELD_TYPES)} 중 하나여야 합니다 — {f['type']!r}"
            )


def _validate_requires_env_shape(requires_env: list) -> None:
    if not isinstance(requires_env, list):
        raise InvalidConnectorSchemaError("requires_env는 배열이어야 합니다.")
    for name in requires_env:
        if not isinstance(name, str) or not _looks_like_env_var_name(name):
            raise InvalidConnectorSchemaError(
                f"requires_env 항목은 환경변수 이름(예: THREADS_ACCESS_TOKEN)이어야 합니다 — "
                f"값이 섞여 온 것으로 의심됨: {name!r}"
            )


async def get_org_connector(
    session: AsyncSession, *, org_id: uuid.UUID, connector_key: str,
) -> OrgConnectorRegistry | None:
    return (await session.execute(
        select(OrgConnectorRegistry).where(
            OrgConnectorRegistry.org_id == org_id, OrgConnectorRegistry.connector_key == connector_key,
        )
    )).scalars().one_or_none()


async def set_org_connector_schema(
    session: AsyncSession,
    *,
    org_id: uuid.UUID,
    connector_key: str,
    version: str,
    channel: str,
    fields: list,
    requires_env: list,
    created_by: uuid.UUID | None,
) -> OrgConnectorRegistry:
    """POST /connectors/{key} — describe_connector 반환을 그대로 upsert. 기존 org_config
    값은 보존한다(스키마 재등록이 이미 설정된 값을 지우면 재등록할 때마다 재설정을 강요하는
    회귀가 되므로 — org_domain_label과 달리 이 테이블은 "설정값 저장소"까지 겸하는 자리라
    schema-only 필드만 갱신)."""
    _validate_fields_shape(fields)
    _validate_requires_env_shape(requires_env)

    vals = dict(
        org_id=org_id, connector_key=connector_key, version=version, channel=channel,
        fields=fields, requires_env=requires_env, created_by=created_by,
    )
    stmt = pg_insert(OrgConnectorRegistry.__table__).values(**vals)
    stmt = stmt.on_conflict_do_update(
        index_elements=["org_id", "connector_key"],
        set_={
            "version": version, "channel": channel, "fields": fields,
            "requires_env": requires_env, "updated_at": func.now(),
        },
    )
    await session.execute(stmt)
    await session.flush()

    return (await session.execute(
        select(OrgConnectorRegistry).execution_options(populate_existing=True).where(
            OrgConnectorRegistry.org_id == org_id, OrgConnectorRegistry.connector_key == connector_key,
        )
    )).scalars().one()


_ITEM_TYPE_CHECKS = {
    "string": lambda v: isinstance(v, str),
    "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    "boolean": lambda v: isinstance(v, bool),
}


def _check_value_type(name: str, value, field: dict) -> None:
    """PO 확定(2026-09-02①, 미르코군 PR#31 실물 픽스처 stibee.groupIds 대조) — array 필드는
    `constraints.itemType`(원소 타입)까지 검사한다. 컨테이너 타입만 맞고 원소가 섞이면(예:
    groupIds에 문자열 하나) 조용히 통과했다가 커넥터 호출 시점에야 실패하는 것을 막는다."""
    declared_type = field.get("type")
    if declared_type is None:
        return  # 타입 미선언 필드는 검사 대상 아님(구 스키마 호환 — 지어내지 않음).
    ok = {
        "string": isinstance(value, str),
        "number": isinstance(value, (int, float)) and not isinstance(value, bool),
        "boolean": isinstance(value, bool),
        "array": isinstance(value, list),
    }[declared_type]
    if not ok:
        raise InvalidConnectorConfigError(
            f"org_config[{name!r}]는 type={declared_type!r}이어야 합니다 — 받은 값: {value!r}"
        )
    if declared_type == "array":
        item_type = (field.get("constraints") or {}).get("itemType")
        item_check = _ITEM_TYPE_CHECKS.get(item_type)
        if item_check is not None:
            bad = [v for v in value if not item_check(v)]
            if bad:
                raise InvalidConnectorConfigError(
                    f"org_config[{name!r}]의 원소는 전부 itemType={item_type!r}이어야 합니다 — "
                    f"어긋난 값: {bad!r}"
                )


async def set_org_connector_config(
    session: AsyncSession, *, org_id: uuid.UUID, connector_key: str, config: dict,
) -> OrgConnectorRegistry:
    """PUT /connectors/{key}/config — 제출된 키가 전부 source="org_config"로 선언된
    필드명인지, 값의 타입이 declared type과 맞는지 검증 후 **병합**(기존 값 위에 덮어쓰기 —
    한 번에 필드 하나씩 채워나가는 설정 흐름을 지원, 전체 교체가 아님)."""
    row = await get_org_connector(session, org_id=org_id, connector_key=connector_key)
    if row is None:
        raise ConnectorNotRegisteredError(
            f"org {org_id}에 connector_key={connector_key!r} 등록이 없습니다 — 먼저 스키마를 등록하세요."
        )

    org_config_fields = {f["name"]: f for f in row.fields if f.get("source") == "org_config"}
    unknown = sorted(set(config) - set(org_config_fields))
    if unknown:
        raise InvalidConnectorConfigError(
            f"이 커넥터의 org_config로 선언되지 않은 키입니다: {unknown} "
            f"(허용된 키: {sorted(org_config_fields)})"
        )
    for name, value in config.items():
        _check_value_type(name, value, org_config_fields[name])

    merged = {**row.org_config, **config}
    await session.execute(
        pg_insert(OrgConnectorRegistry.__table__)
        .values(
            org_id=org_id, connector_key=connector_key, version=row.version, channel=row.channel,
            fields=row.fields, requires_env=row.requires_env, org_config=merged,
        )
        .on_conflict_do_update(
            index_elements=["org_id", "connector_key"],
            set_={"org_config": merged, "updated_at": func.now()},
        )
    )
    await session.flush()

    return (await session.execute(
        select(OrgConnectorRegistry).execution_options(populate_existing=True).where(
            OrgConnectorRegistry.org_id == org_id, OrgConnectorRegistry.connector_key == connector_key,
        )
    )).scalars().one()
