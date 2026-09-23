"""story #4202(E-RECIPE-2·i18n)·#4203 — 플랫폼 사이클형 프리셋(event_definitions.org_id IS NULL · `preset.*` 중
stage enum이 있는 것 — `preset.marketing.*`·`preset.workflow.*`) 이름·설명의 로케일 문안 짝 가드. 실 PG(alembic heads) 기준이라 새 마케팅 프리셋 시드 마이그레이션이 들어오면
그 PR에서 자동으로 검사된다(4188 문구 가드 옆).

FE는 `apps/web/src/lib/platform-preset-copy.ts`의 두 표(PLATFORM_PRESET_NAME_KEY·…_DESCRIPTION_KEY)로 key →
messages `recipePreset.<키>`를 찾아 그린다. 표에 없는 key는 시드 원문(한국어)을 그대로 그리므로 누락이 곧
en 화면의 한국어다 — 그래서:
1. 시드 key 집합 == 두 표의 key 집합(양방향 — 시드에 없는 표 행도 낡은 행이라 RED).
2. 표가 가리키는 messages 키가 ko·en 둘 다 있고 비어 있지 않다.
3. 마케팅(`preset.marketing.*`)만: ko 값 == 시드 원문(name·description) — 시드 문안이 바뀌면 ko 화면도 같이
   바뀌어야 한다(두 곳이 갈리지 않게). 워크플로우는 시드가 언어가 섞여 있어(«Kanban Flow»·«칸반 심플») ko·en 모두
   유나 확정 새 문안이 기준이다 — 시드 원문 동일성을 걸지 않는다(#4203 카드).
4. (#4209) 단계 설명: 시드에서 action이 있는 (key·stage) 전수 ↔ PLATFORM_PRESET_ACTION_KEY(양방향) · messages ko·en ·
   마케팅 ko == 시드 action 원문. 모든 stage slug가 단계 라벨 표(recipe-stage-label.ts)에 있다(카드 본문 «{단계}»).
5. (#4209) 채팅 카드 block_template 모양: header 1 · 단계 자리(`{{label.stage}}`/`{{payload.stage}}`)가 든 text · 필드면 라벨 «대상»
   — FE localizePresetBlockTemplate가 덮는 모양. 새 프리셋 시드가 다른 모양이면 RED(규칙이 조용히 못 덮는 것을 막는다).
범위: 사이클형 `preset.*`(#4202 만료 조건대로 #4203에서 넓힘). 신호형 프리셋(stage enum 없음 — `preset.gate.verdict`
등)은 제외: 이 짝 가드가 여는 화면(갤러리·적용·실행 만들기)은 사이클형만 그린다.
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
]

_REPO_ROOT = Path(__file__).resolve().parents[2]
_COPY_TS = _REPO_ROOT / "apps/web/src/lib/platform-preset-copy.ts"
_STAGE_LABEL_TS = _REPO_ROOT / "apps/web/src/lib/recipe-stage-label.ts"
_SEED_TARGET_LABEL = "대상"
_MESSAGES = {lang: _REPO_ROOT / f"apps/web/messages/{lang}.json" for lang in ("ko", "en")}
_NAMESPACE = "recipePreset"


def _ts_string_list(name: str, path: Path = _COPY_TS) -> list[str]:
    """FE `export const NAME: readonly string[] = [ ... ];`의 문자열 목록 — 카드 모양 판정이 FE와 같은 목록을 쓰게(한 곳)."""
    m = re.search(rf"export const {name}: readonly string\[\] = \[(.*?)\];", path.read_text(encoding="utf-8"), re.DOTALL)
    assert m, f"{name} 목록을 {path.name}에서 못 찾음"
    return re.findall(r"'([^']*)'", m.group(1))
_SEED_IS_KO_SOURCE_PREFIX = "preset.marketing."


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _cyclic_platform_presets() -> dict[str, dict]:
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine

    engine = create_async_engine(_async_url())
    try:
        async with engine.connect() as conn:
            rows = (await conn.execute(text(
                "SELECT key, name, description, stage_metadata, block_template, payload_schema FROM event_definitions "
                "WHERE org_id IS NULL AND key LIKE 'preset.%' "
                "AND jsonb_typeof(payload_schema->'properties'->'stage'->'enum') = 'array' ORDER BY key"
            ))).mappings().all()
    finally:
        await engine.dispose()
    return {r["key"]: dict(r) for r in rows}


def _ts_table(table_name: str, path: Path = _COPY_TS) -> dict[str, str]:
    src = path.read_text(encoding="utf-8")
    m = re.search(rf"const {table_name}: Record<string, string> = \{{(.*?)\n\}};", src, re.S)
    assert m, f"{_COPY_TS.name}에서 {table_name} 표를 못 찾음 — 표 이름/형태가 바뀌었으면 이 파서를 같이 고쳐라"
    # 한 줄 단위로만(주석 줄은 건너뛴다) — `\s`는 줄바꿈까지 먹어 주석이 다음 키에 붙는다.
    table = dict(re.findall(r"^[ \t]*'?([A-Za-z0-9_.:-]+)'?[ \t]*:[ \t]*'([^']+)'[ \t]*,?[ \t]*$", m.group(1), re.M))
    assert table, f"{table_name} 파싱 결과가 비었다"
    return table


def _messages(lang: str) -> dict:
    return json.loads(_MESSAGES[lang].read_text(encoding="utf-8")).get(_NAMESPACE, {})


def find_gaps(presets: dict[str, dict], names: dict[str, str], descriptions: dict[str, str],
              messages: dict[str, dict]) -> list[str]:
    gaps: list[str] = []
    seeded = set(presets)
    for label, table in (("NAME", names), ("DESCRIPTION", descriptions)):
        in_table = {k for k in table if k.startswith("preset.")}
        gaps += [f"{k}: PLATFORM_PRESET_{label}_KEY에 행 없음(en 화면에 한국어 원문)" for k in sorted(seeded - in_table)]
        gaps += [f"{k}: PLATFORM_PRESET_{label}_KEY 행이 시드에 없음(낡은 행)" for k in sorted(in_table - seeded)]
    for key, row in presets.items():
        for field, table in (("name", names), ("description", descriptions)):
            msg_key = table.get(key)
            if not msg_key:
                continue
            for lang, ns in messages.items():
                value = ns.get(msg_key)
                if not isinstance(value, str) or not value.strip():
                    gaps.append(f"{key} {field}: messages/{lang}.json {_NAMESPACE}.{msg_key} 없음/빈 값")
            if not key.startswith(_SEED_IS_KO_SOURCE_PREFIX):
                continue
            seed = row.get(field) or ""
            if messages.get("ko", {}).get(msg_key) not in (None, seed):
                gaps.append(f"{key} {field}: ko 문안이 시드 원문과 다름 — 시드 {seed!r} / ko {messages['ko'].get(msg_key)!r}")
    return gaps


@pytest.mark.anyio
async def test_cyclic_preset_keys_pair_with_messages_on_real_seed():
    presets = await _cyclic_platform_presets()
    # 양성 대조 — 시드가 비면 이 가드가 공허하게 통과한다(두 가족 다 실제로 잡히는지).
    assert {"preset.marketing.video_production", "preset.marketing.social_card_news",
            "preset.marketing.social_text_post", "preset.workflow.kanban", "preset.workflow.loop_agency"} <= set(presets), sorted(presets)
    # 음성 대조 — 신호형은 범위 밖이어야 한다.
    assert "preset.gate.verdict" not in presets
    gaps = find_gaps(presets, _ts_table("PLATFORM_PRESET_NAME_KEY"), _ts_table("PLATFORM_PRESET_DESCRIPTION_KEY"),
                     {lang: _messages(lang) for lang in _MESSAGES})
    assert gaps == [], "\n".join(gaps)


def test_find_gaps_catches_each_failure_mode():
    """가드 자체 — 네 갈래(표 누락·낡은 표 행·messages 누락·ko≠시드)를 각각 잡는다."""
    presets = {"preset.marketing.a": {"key": "preset.marketing.a", "name": "가", "description": "가 설명"}}
    names = {"preset.marketing.a": "aName"}
    descs = {"preset.marketing.a": "aDescription"}
    ok = {"ko": {"aName": "가", "aDescription": "가 설명"}, "en": {"aName": "A", "aDescription": "A desc"}}
    assert find_gaps(presets, names, descs, ok) == []

    new_seed = {**presets, "preset.marketing.b": {"key": "preset.marketing.b", "name": "나", "description": ""}}
    assert any("preset.marketing.b: PLATFORM_PRESET_NAME_KEY에 행 없음" in g for g in find_gaps(new_seed, names, descs, ok))
    stale = {**names, "preset.marketing.gone": "goneName"}
    assert any("낡은 행" in g for g in find_gaps(presets, stale, descs, ok))
    no_en = {"ko": ok["ko"], "en": {"aName": "A"}}
    assert any("messages/en.json recipePreset.aDescription" in g for g in find_gaps(presets, names, descs, no_en))
    drift = {"ko": {"aName": "다른 이름", "aDescription": "가 설명"}, "en": ok["en"]}
    assert any("ko 문안이 시드 원문과 다름" in g for g in find_gaps(presets, names, descs, drift))

    # 워크플로우(#4203) — ko가 시드와 달라도 정상(새 문안이 기준), 키 누락은 그대로 RED.
    wf = {"preset.workflow.w": {"key": "preset.workflow.w", "name": "Kanban Flow", "description": "원문"}}
    wf_names, wf_descs = {"preset.workflow.w": "wName"}, {"preset.workflow.w": "wDescription"}
    wf_msgs = {"ko": {"wName": "칸반 알림", "wDescription": "새 설명"}, "en": {"wName": "Kanban alerts", "wDescription": "New"}}
    assert find_gaps(wf, wf_names, wf_descs, wf_msgs) == []
    assert any("preset.workflow.w: PLATFORM_PRESET_NAME_KEY에 행 없음" in g for g in find_gaps(wf, {}, wf_descs, wf_msgs))


def find_action_and_card_gaps(presets: dict[str, dict], actions: dict[str, str], stage_labels: set[str],
                              messages: dict[str, dict], *, stage_texts: list[str] | None = None,
                              target_values: list[str] | None = None) -> list[str]:
    """#4209 — 단계 설명 짝·단계 라벨·카드 템플릿 모양(모양 목록은 FE platform-preset-copy.ts에서)."""
    stage_texts = stage_texts if stage_texts is not None else _ts_string_list("SEED_STAGE_TEXTS")
    target_values = target_values if target_values is not None else _ts_string_list("SEED_TARGET_VALUES")
    gaps: list[str] = []
    seeded: dict[str, str] = {}
    for key, row in presets.items():
        for stage, meta in (row.get("stage_metadata") or {}).items():
            if isinstance(meta, dict) and isinstance(meta.get("action"), str):
                seeded[f"{key}:{stage}"] = meta["action"]
        enum = (((row.get("payload_schema") or {}).get("properties") or {}).get("stage") or {}).get("enum") or []
        gaps += [f"{key}: stage `{s}` 단계 라벨 표(recipe-stage-label.ts)에 없음 — 카드 본문에 slug 원문" for s in enum if s not in stage_labels]
        # PR #4575 — FE는 [머리말 · 단계 문장 · «대상» 필드 1]의 **정확한 모양**일 때만 카드를 로케일 문안으로 바꾸고 아니면
        # 원문 그대로 둔다(다른 문구 증발 방지). 그러니 시드 전수가 그 모양이어야 en 화면이 한국어로 새지 않는다.
        blocks = (row.get("block_template") or {}).get("blocks") or []
        shape_ok = (
            len(blocks) == 3
            and all(isinstance(b, dict) for b in blocks)
            and blocks[0].get("type") == "header"
            and blocks[1].get("type") == "text" and blocks[1].get("text") in stage_texts
            and blocks[2].get("type") == "fields" and len(blocks[2].get("fields") or []) == 1
            and (blocks[2]["fields"][0] or {}).get("label") == _SEED_TARGET_LABEL
            and (blocks[2]["fields"][0] or {}).get("value") in target_values
        )
        if not shape_ok:
            gaps.append(f"{key}: block_template이 FE가 아는 시드 카드 모양(머리말·단계 문장·«대상» 필드 1)이 아님 — 카드가 원문 그대로 나감: {blocks!r}")
    table = {k: v for k, v in actions.items() if k.startswith("preset.")}
    gaps += [f"{k}: PLATFORM_PRESET_ACTION_KEY에 행 없음(en 화면에 원문 단계 설명)" for k in sorted(set(seeded) - set(table))]
    gaps += [f"{k}: PLATFORM_PRESET_ACTION_KEY 행이 시드에 없음(낡은 행)" for k in sorted(set(table) - set(seeded))]
    for k, msg_key in table.items():
        for lang, ns in messages.items():
            v = ns.get(msg_key)
            if not isinstance(v, str) or not v.strip():
                gaps.append(f"{k}: messages/{lang}.json {_NAMESPACE}.{msg_key} 없음/빈 값")
        if k.startswith(_SEED_IS_KO_SOURCE_PREFIX) and k in seeded and messages.get("ko", {}).get(msg_key) not in (None, seeded[k]):
            gaps.append(f"{k}: 마케팅 단계 설명 ko가 시드 원문과 다름 — 시드 {seeded[k]!r}")
    return gaps


@pytest.mark.anyio
async def test_cyclic_preset_actions_stage_labels_and_card_shape_on_real_seed():
    presets = await _cyclic_platform_presets()
    assert presets, "시드가 비면 가드가 공허하게 통과한다"
    gaps = find_action_and_card_gaps(
        presets, _ts_table("PLATFORM_PRESET_ACTION_KEY"),
        set(_ts_table("STAGE_LABEL_KEYS", _STAGE_LABEL_TS)),
        {lang: _messages(lang) for lang in _MESSAGES},
    )
    assert gaps == [], "\n".join(gaps)


def test_find_action_and_card_gaps_catches_each_failure_mode():
    """가드 자체 — 행 누락·낡은 행·messages 누락·마케팅 ko drift·단계 라벨 누락·카드 모양 3종."""
    good_tpl = {"blocks": [{"type": "header", "text": "H"}, {"type": "text", "text": "**{{label.stage}}** 단계로 넘어갔습니다"},
                           {"type": "fields", "fields": [{"label": "대상", "value": "{{label.work_item_target}}"}]}]}
    row = {"stage_metadata": {"draft": {"action": "초안"}}, "block_template": good_tpl,
           "payload_schema": {"properties": {"stage": {"enum": ["draft"]}}}}
    presets = {"preset.marketing.a": row}
    actions = {"preset.marketing.a:draft": "aDraft"}
    msgs = {"ko": {"aDraft": "초안"}, "en": {"aDraft": "Draft"}}
    assert find_action_and_card_gaps(presets, actions, {"draft"}, msgs) == []
    assert any("ACTION_KEY에 행 없음" in g for g in find_action_and_card_gaps(presets, {}, {"draft"}, msgs))
    assert any("낡은 행" in g for g in find_action_and_card_gaps(presets, {**actions, "preset.marketing.a:gone": "x"}, {"draft"}, msgs))
    assert any("en.json" in g for g in find_action_and_card_gaps(presets, actions, {"draft"}, {"ko": msgs["ko"], "en": {}}))
    assert any("시드 원문과 다름" in g for g in find_action_and_card_gaps(presets, actions, {"draft"}, {"ko": {"aDraft": "다른"}, "en": msgs["en"]}))
    assert any("단계 라벨 표" in g for g in find_action_and_card_gaps(presets, actions, set(), msgs))
    for bad in (
        {"blocks": [good_tpl["blocks"][1], good_tpl["blocks"][2]]},
        {"blocks": [good_tpl["blocks"][0], {"type": "text", "text": "단계 없음"}, good_tpl["blocks"][2]]},
        {"blocks": [good_tpl["blocks"][0], good_tpl["blocks"][1], {"type": "fields", "fields": [{"label": "Target", "value": "{{label.work_item_target}}"}]}]},
        # PR #4575 — 정확한 모양만: 단계 문장에 다른 문구가 붙음 · 모르는 «대상» 값 · 블록이 하나 더.
        {"blocks": [good_tpl["blocks"][0], {"type": "text", "text": "**{{payload.stage}}** 로 넘어갔습니다; 사유 {{payload.reason}}"}, good_tpl["blocks"][2]]},
        {"blocks": [good_tpl["blocks"][0], good_tpl["blocks"][1], {"type": "fields", "fields": [{"label": "대상", "value": "{{payload.title}}"}]}]},
        {"blocks": [*good_tpl["blocks"], {"type": "text", "text": "덧붙임"}]},
    ):
        assert find_action_and_card_gaps({"preset.marketing.a": {**row, "block_template": bad}}, actions, {"draft"}, msgs), bad
