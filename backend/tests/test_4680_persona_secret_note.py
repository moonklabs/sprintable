"""story 4680 AC2 ⑥ (Kadir's lens · Yuna's help line) — the persona's text goes into every session start of the agent: the one place that says «don't write secrets here» is the schema of
the two fields that take it (the API's own documentation; a screen that edits a persona takes the ko/en line of Yuna's sheet when it exists)."""
from app.schemas.agent_persona import PERSONA_SECRET_NOTE, CreatePersonaRequest, UpdatePersonaRequest


def test_the_fields_that_become_the_sessions_instruction_say_not_to_write_secrets():
    assert "don't write keys, passwords or tokens here" in PERSONA_SECRET_NOTE
    for model in (CreatePersonaRequest, UpdatePersonaRequest):
        props = model.model_json_schema()["properties"]
        for field in ("system_prompt", "style_prompt"):
            assert props[field]["description"] == PERSONA_SECRET_NOTE, (model.__name__, field)
        assert "description" not in props["name"] or props["name"]["description"] != PERSONA_SECRET_NOTE
