"""story 4921 (second PR) — the line a person sees for an event message on the server's surfaces. The same samples as the web's `event-preview.4921.test.ts`: no slug, id, key name, «[이벤트]» or «- key: value» in any."""
from __future__ import annotations

import re
import types

import pytest

from app.services.event_message_text import first_human_line, human_event_text, is_machine_event_content

UUID = "97470487-345a-4e85-9c45-cdf901737adb"
LEAK = re.compile(r"preset\.|org\.[a-z]|[0-9a-f]{8}-[0-9a-f]{4}-|\n- |^- \w+:|\[이벤트\]|\[Event\]|work_item|target_member_id|\bstage:")


def machine(key: str, locale: str = "ko") -> str:
    head = "[이벤트]" if locale == "ko" else "[Event]"
    return f"{head} {key}\n- work_item_id: {UUID}\n- stage: draft"


def test_machine_content_is_detected_from_the_catalog_header_in_both_languages():
    assert is_machine_event_content("[이벤트] preset.x\n- a: b")
    assert is_machine_event_content("[Event] preset.x\n- a: b")
    assert not is_machine_event_content("발행이 멈췄어요. 다시 시도해 주세요.")
    assert not is_machine_event_content("[이벤트]")
    assert not is_machine_event_content("[이벤트] ")
    assert not is_machine_event_content(None)
    assert not is_machine_event_content("그냥 글 [이벤트] 중간")


def test_a_content_somebody_wrote_is_left_to_the_caller():
    assert human_event_text("발행이 멈췄어요. 작업 상세에서 다시 시도해 주세요.", {"event_key": "preset.recipe.publish_failed", "payload": {}}) is None
    assert human_event_text("", None) is None and human_event_text(None, None) is None


def test_steer_sentence_with_the_targets_name():
    ev = {"event_key": "preset.steer.instruct", "payload": {"instruction": "먼저 봐 주세요", "target_member_id": UUID}, "refs": {"target": {"found": True, "name": "미르코"}}}
    assert human_event_text(machine("preset.steer.instruct"), ev) == "방향 전환 · 먼저 봐 주세요 → 미르코"
    assert human_event_text(machine("preset.steer.instruct", "en"), ev, "en") == "Direction change · 먼저 봐 주세요 → 미르코"


def test_steer_of_an_old_message_has_no_target_name_and_a_gone_member_is_named_so():
    old = {"event_key": "preset.steer.instruct", "payload": {"instruction": "옛 지시", "target_member_id": UUID}}
    assert human_event_text(machine("preset.steer.instruct"), old) == "방향 전환 · 옛 지시"
    assert human_event_text(machine("preset.steer.instruct"), {**old, "refs": {}}) == "방향 전환 · 옛 지시"
    gone = {**old, "refs": {"target": {"found": False}}}
    assert human_event_text(machine("preset.steer.instruct"), gone) == "방향 전환 · 옛 지시 → (알 수 없는 구성원)"


def test_a_steer_without_usable_words_falls_to_the_generic_line():
    ev = {"event_key": "preset.steer.instruct", "payload": {"instruction": "/api/v2/x", "target_member_id": UUID}}
    assert human_event_text(machine("preset.steer.instruct"), ev) == "이벤트"


@pytest.mark.parametrize("key,payload,expected", [
    ("preset.workflow.kanban", {"stage": "ready", "work_item_id": UUID}, "이벤트"),
    ("preset.marketing.video_production", {"stage": "draft", "work_item_type": "story", "work_item_id": UUID}, "이벤트"),
    ("org.acme.signup", {"message": "새 가입이 들어왔어요\n둘째 줄", "user_id": UUID}, "이벤트 · 새 가입이 들어왔어요"),
    ("org.zeta.note", {"summary": "정리 끝", "ref": UUID}, "이벤트 · 정리 끝"),
    ("preset.recipe.publish_failed", {"stage": "published", "reason_code": "x", "work_item_id": UUID}, "이벤트"),
])
def test_every_other_event_is_one_word_plus_the_persons_words_never_the_machine_text(key, payload, expected):
    line = human_event_text(machine(key), {"event_key": key, "payload": payload})
    assert line == expected
    assert not LEAK.search(line)


def test_only_person_text_fields_count_and_an_id_or_path_is_not_words():
    ev = {"event_key": "org.x.y", "payload": {"title": "/api/v2/stories/1", "body": "body 글", "content": "content 글", "reason": "reason 글"}}
    assert human_event_text(machine("org.x.y"), ev) == "이벤트"
    for bad in (UUID, "/api/v2/stories/1", "https://example.test/a", f"[{UUID}](entity:story:{UUID})", f"[](entity:story:{UUID})", "entity:story:abc"):
        assert human_event_text(machine("org.x.y"), {"event_key": "org.x.y", "payload": {"message": bad}}) == "이벤트"
    assert human_event_text(machine("org.x.y"), {"event_key": "org.x.y", "payload": {"message": UUID, "summary": "정리 끝"}}) == "이벤트 · 정리 끝"


def test_an_entity_link_in_the_words_reads_as_its_label_never_as_its_id():
    """story 4925 — «[이 일감](entity:story:<id>)» in a person's words: a preview has no chip to draw, so the line says the LABEL (the web's `entityLinksToLabels` has the same rule)"""
    def line(words):
        return human_event_text(machine("org.x.y"), {"event_key": "org.x.y", "payload": {"note": words}})

    assert line(f"[이 일감](entity:story:{UUID}) 배포를 확인했어요") == "이벤트 · 이 일감 배포를 확인했어요"
    assert line(f"[\\[결함\\] 제목 \\(1\\)](entity:story:{UUID})") == "이벤트 · [결함] 제목 (1)"  # the escaped label the chat writes for a title with brackets
    assert line(f"먼저 [A](entity:story:{UUID}) 그다음 [B](entity:doc:{UUID})") == "이벤트 · 먼저 A 그다음 B"
    assert UUID not in (line(f"[이 일감](entity:story:{UUID}) 확인") or "")
    assert line(f"[{UUID}](entity:story:{UUID})") == "이벤트"  # a label that is itself an id is not words
    assert line("[raw](entity:story:abc)") == "이벤트"  # not the chat's token shape (a UUID id): left as written, so still «not words»


def test_a_long_run_of_brackets_is_scanned_once_not_once_per_bracket():
    import time

    odd = "[" * 20_000 + "]x"
    started = time.monotonic()
    assert first_human_line(odd) == "[" * 60 + "…"
    assert time.monotonic() - started < 0.5


def test_first_line_only_and_cut_by_code_point_never_inside_an_emoji():
    assert first_human_line("첫 줄\n둘째 줄") == "첫 줄"
    assert first_human_line("\n\n  \n") is None
    text = "가" * 59 + "😀뒤에 더 있는 글"
    assert first_human_line(text) == "가" * 59 + "😀" + "…"
    assert first_human_line("가" * 80) == "가" * 60 + "…"


def test_the_events_without_a_card_still_get_the_generic_line():
    assert human_event_text(machine("org.x.y"), None) == "이벤트"
    assert human_event_text(machine("org.x.y"), {"event_key": "org.x.y", "payload": "not a dict"}) == "이벤트"


def test_preview_content_of_a_message_uses_the_event_card_and_leaves_other_messages_alone():
    from app.routers.conversations import _preview_content

    def msg(content, event):
        # `_event_payload` reads only the LOADED attributes (`__dict__`): a plain namespace has exactly that
        return types.SimpleNamespace(content=content, msg_metadata={"event": event} if event else None)

    ev = {"event_key": "preset.steer.instruct", "payload": {"instruction": "먼저 봐 주세요"}, "refs": {"target": {"found": True, "name": "미르코"}}}
    m = msg(machine("preset.steer.instruct"), ev)
    assert _preview_content(m) == "방향 전환 · 먼저 봐 주세요 → 미르코"
    assert _preview_content(msg("그냥 글", None)) == "그냥 글"
    assert _preview_content(msg("발행이 멈췄어요.", {"event_key": "preset.recipe.publish_failed", "payload": {}})) == "발행이 멈췄어요."
    assert _preview_content(msg("", None)) == ""


def test_the_language_of_the_line_follows_the_header_of_the_message_without_a_reader_locale():
    ev = {"event_key": "preset.steer.instruct", "payload": {"instruction": "Look first"}, "refs": {"target": {"found": True, "name": "Mirco"}}}
    assert human_event_text(machine("preset.steer.instruct", "en"), ev) == "Direction change · Look first → Mirco"
    assert human_event_text(machine("preset.steer.instruct", "ko"), ev) == "방향 전환 · Look first → Mirco"
    assert human_event_text(machine("org.x.y", "en"), {"event_key": "org.x.y", "payload": {}}) == "Event"
    assert human_event_text(machine("org.x.y", "en"), {"event_key": "org.x.y", "payload": {}}, "ko") == "이벤트"  # an explicit locale wins
