"""infra/probe_dev_push.py (dev 푸시 진단 probe, story 4694) — 집계가 **허용 목록만** 내보내는지 고정한다.

라이브 gcloud 없이, 실제 로그 항목의 모양에 **일부러 민감한 값(조직 · 멤버 id · 토큰 · 이메일 · 자유 글 사유 · 앱 버전)을 섞은** 표본을 넣고,
출력 어디에도 그 값이 없는지 본다. 이 테스트의 값은 «센다»가 아니라 «새지 않는다»다(까디르 렌즈).
"""
from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

_INFRA_DIR = Path(__file__).resolve().parents[2] / "infra"


def _load():
    spec = importlib.util.spec_from_file_location("probe_dev_push", _INFRA_DIR / "probe_dev_push.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


probe = _load()

ORG = "54bac162"
ORG_FULL = "54bac162-5c0d-49fa-8e49-85977063a091"
OTHER_ORG_FULL = "99999999-aaaa-bbbb-cccc-dddddddddddd"
MEMBER = "e75ca548"
MEMBER_FULL = "e75ca548-1111-2222-3333-444444444444"
OTHER_MEMBER_FULL = "e75ca548-9999-8888-7777-666666666666"

# 출력에 절대 나오면 안 되는 값들 — 표본 곳곳에 심는다
SECRETS = [
    "teacher@example.com", "ExponentPushToken[SECRETTOKEN123]", "ya29.GOOGLEACCESSTOKEN", "SecretFreeTextReason",
    "0.9.9-secretbuild", "alice_kim_x", "11111111-2222-3333-4444-555555555555",
]


def _no_secret(text: str) -> None:
    for s in SECRETS:
        assert s not in text, f"leaked: {s!r}"
    for frag in ("SECRETTOKEN", "GOOGLEACCESS", "SecretFree", "secretbuild", "alice", "teacher@", ORG_FULL, MEMBER_FULL, OTHER_MEMBER_FULL, OTHER_ORG_FULL):
        assert frag not in text, f"leaked fragment: {frag!r}"


def _push(ts: str, event="conversation.message", devices=1, ok=1, error=0, reasons="None", org=ORG_FULL) -> dict:
    return {
        "timestamp": ts,
        "jsonPayload": {
            "severity": "INFO", "logger": "ee.services.expo_push",
            "message": f"expo push: sent org={org} event={event} devices={devices} ok={ok} error={error} reasons={reasons}",
        },
    }


def _diag(ts: str, stage="ok", permission="granted", error_code=None, platform="android", member=MEMBER_FULL) -> dict:
    jp = {
        "event": "push_diagnostics", "member_id": member, "org_id": ORG_FULL, "platform": platform,
        "app_version": SECRETS[4], "app_build": "30", "permission": permission, "can_ask_again": True, "stage": stage,
    }
    if error_code is not None:
        jp["error_code"] = error_code
    return {"timestamp": ts, "jsonPayload": jp}


# ── ① 발송 줄 ────────────────────────────────────────────────────────────────────────────────────────────────────────────
def test_pushes_show_the_closed_fields_per_send_and_per_day():
    es = [
        _push("2026-10-07T03:00:01.123Z", devices=1, ok=1),
        _push("2026-10-07T03:10:00Z", devices=1, ok=1),
        _push("2026-10-09T02:00:00Z", devices=0, ok=0),
        _push("2026-10-09T02:30:00Z", "conversation.mention", devices=1, ok=0, error=1, reasons="{'DeviceNotRegistered': 1}"),
    ]
    pushes = probe.parse_pushes(es, ORG)
    assert probe.agg_push_lines(pushes) == [
        "  2026-10-09T02:30:00Z  conversation.mention  devices=1  ok=0  error=1  reasons=DeviceNotRegistered:1",
        "  2026-10-09T02:00:00Z  conversation.message  devices=0  ok=0  error=0  reasons=none",
        "  2026-10-07T03:10:00Z  conversation.message  devices=1  ok=1  error=0  reasons=none",
        "  2026-10-07T03:00:01Z  conversation.message  devices=1  ok=1  error=0  reasons=none",
    ]
    days = probe.agg_push_days(pushes)
    assert days[0] == "  2026-10-07  conversation.message  발송 2건 · devices 합 2 · ok 합 2 · error 합 0 · devices=0 인 발송 0건 · reasons none"
    assert "2026-10-09  conversation.mention  발송 1건 · devices 합 1 · ok 합 0 · error 합 1 · devices=0 인 발송 0건 · reasons DeviceNotRegistered:1" in days[1]
    assert "2026-10-09  conversation.message  발송 1건 · devices 합 0 · ok 합 0 · error 합 0 · devices=0 인 발송 1건" in days[2]


def test_split_compares_before_and_after_the_date_chat_events_only():
    es = [
        _push("2026-10-07T23:59:59Z", devices=1, ok=1),
        _push("2026-10-08T00:00:00Z", devices=0, ok=0),
        _push("2026-10-10T00:00:00Z", devices=0, ok=0),
        _push("2026-10-10T00:00:01Z", "story.assigned", devices=5, ok=5),  # 채팅 밖 이벤트는 비교에서 뺀다
    ]
    out = probe.agg_push_split(probe.parse_pushes(es, ORG), "2026-10-08")
    assert out[0] == "  2026-10-08 앞  발송 1건 · devices 합 1 · ok 합 1 · error 합 0 · devices=0 인 발송 0건 · reasons none"
    assert out[1] == "  2026-10-08 포함 뒤  발송 2건 · devices 합 0 · ok 합 0 · error 합 0 · devices=0 인 발송 2건 · reasons none"


def test_other_orgs_and_other_events_never_reach_the_rows_as_themselves():
    es = [
        _push("2026-10-09T02:00:00Z", org=OTHER_ORG_FULL),  # 다른 조직 → 아예 안 셈
        _push("2026-10-09T02:01:00Z", "story.assigned.alice_kim_x"),  # 닫힌 둘 밖 이벤트 → (other event)
    ]
    pushes = probe.parse_pushes(es, ORG)
    assert len(pushes) == 1
    out = "\n".join(probe.agg_push_lines(pushes) + probe.agg_push_days(pushes))
    assert "(other event)" in out
    _no_secret(out)


def test_expo_reason_free_text_and_tokens_are_folded_to_other():
    """Expo 의 에러 사유는 `details.error` 가 없으면 티켓의 자유 글 메시지(토큰 원문이 든 문장)가 사유 자리에 실린다 — 닫힌 코드 밖은 모두 (other)."""
    reasons = (
        "{'DeviceNotRegistered': 1, "
        f"'\"{SECRETS[1]}\" is not a registered push notification recipient for {SECRETS[0]}': 2, "
        f"\"it's {SECRETS[3]}\": 3, 'InvalidCredentials': 1}}"
    )
    es = [_push("2026-10-09T02:00:00Z", devices=7, ok=0, error=7, reasons=reasons)]
    pushes = probe.parse_pushes(es, ORG)
    out = "\n".join(probe.agg_push_lines(pushes) + probe.agg_push_days(pushes) + probe.agg_push_split(pushes, "2026-10-08"))
    assert "DeviceNotRegistered:1" in out and "InvalidCredentials:1" in out
    assert "(other):5" in out  # 자유 글 둘 = 2 + 3, 값은 어디에도 없다
    _no_secret(out)


def test_numbers_are_digits_only_and_a_torn_line_counts_for_nothing():
    es = [
        _push("2026-10-09T02:00:00Z", devices="x1", ok=1),  # 숫자 아님 → 줄 모양이 안 맞아 안 센다
        {"timestamp": "2026-10-09T02:01:00Z", "jsonPayload": {"message": "expo push: sent org=" + ORG_FULL}},
        {"timestamp": "2026-10-09T02:02:00Z", "textPayload": f"expo push: sent org={ORG_FULL} event=conversation.message devices=2 ok=2 error=0 reasons=None"},
    ]
    pushes = probe.parse_pushes(es, ORG)
    assert [(p.stamp, p.devices) for p in pushes] == [("2026-10-09T02:02:00Z", 2)]  # textPayload 모양도 읽는다


def test_push_lines_are_capped_and_say_so():
    es = [_push(f"2026-10-09T{h:02d}:{m:02d}:00Z") for h in range(24) for m in range(0, 60, 3)] * 2  # 960건
    pushes = probe.parse_pushes(es, ORG)
    lines = probe.agg_push_lines(pushes)
    assert len(lines) == probe._PUSH_LINES_SHOWN + 1
    assert "그 앞 560건은 줄지 않았다" in lines[-1]


# ── ② push_diagnostics ───────────────────────────────────────────────────────────────────────────────────────────────────
def test_diagnostics_show_stage_permission_code_platform_and_nothing_else():
    es = [
        _diag("2026-10-08T01:00:00Z", "device_token", "granted", "FIS_AUTH_ERROR"),
        _diag("2026-10-09T01:00:00Z", "ok", "granted"),
        _diag("2026-10-10T01:00:00Z", "ok", "granted"),
        _diag("2026-10-10T02:00:00Z", "register", "granted", "HTTP_401", "ios"),
    ]
    diags, members = probe.parse_diagnostics(es, MEMBER)
    assert members == 1
    assert probe.agg_diag_summary(diags) == [
        "  stage=ok  permission=granted  error_code=-  platform=android  2건 (처음 2026-10-09T01:00:00Z · 마지막 2026-10-10T01:00:00Z)",
        "  stage=device_token  permission=granted  error_code=FIS_AUTH_ERROR  platform=android  1건 (처음 2026-10-08T01:00:00Z · 마지막 2026-10-08T01:00:00Z)",
        "  stage=register  permission=granted  error_code=HTTP_401  platform=ios  1건 (처음 2026-10-10T02:00:00Z · 마지막 2026-10-10T02:00:00Z)",
    ]
    out = "\n".join(probe.agg_diag_summary(diags) + probe.agg_diag_lines(diags))
    _no_secret(out)


def test_diagnostic_values_are_a_closed_list_not_a_shape():
    """까디르 렌즈(4689) 같은 구멍: 모양이 맞으면 통과시키지 않는다 — 대문자 모양의 아무 낱말 · 목록 밖 단계 · 낯선 플랫폼은 (other)."""
    es = [
        _diag("2026-10-09T01:00:00Z", stage="alice_kim_x", permission="teacher@example.com", error_code="ALICE_KIM_X_SECRETCODE", platform="evil"),
        _diag("2026-10-09T01:01:00Z", error_code="HTTP_99999"),  # HTTP_ 뒤 세 자리만
        _diag("2026-10-09T01:02:00Z", error_code="HTTP_503"),
        _diag("2026-10-09T01:03:00Z", error_code=SECRETS[1]),
    ]
    diags, _ = probe.parse_diagnostics(es, MEMBER)
    out = "\n".join(probe.agg_diag_summary(diags) + probe.agg_diag_lines(diags))
    assert "stage=(other)  permission=(other)  error_code=(other)  platform=(other)" in out
    assert "HTTP_503" in out and "HTTP_99999" not in out
    _no_secret(out)
    assert "SECRETCODE" not in out and "evil" not in out


def test_another_member_with_the_same_prefix_is_counted_not_named():
    es = [_diag("2026-10-09T01:00:00Z"), _diag("2026-10-09T01:01:00Z", member=OTHER_MEMBER_FULL), _diag("2026-10-09T01:02:00Z", member="aaaaaaaa-0000-0000-0000-000000000000")]
    diags, members = probe.parse_diagnostics(es, MEMBER)
    assert members == 2 and len(diags) == 2  # 앞 8자리가 다른 멤버는 아예 안 센다
    _no_secret("\n".join(probe.agg_diag_summary(diags) + probe.agg_diag_lines(diags)))


def test_other_events_in_the_log_are_not_diagnostics():
    e = _diag("2026-10-09T01:00:00Z")
    e["jsonPayload"]["event"] = "something_else"
    assert probe.parse_diagnostics([e], MEMBER) == ([], 0)


def test_malformed_entries_do_not_crash_or_leak():
    junk = [{}, {"timestamp": 5}, {"jsonPayload": []}, {"textPayload": None}, {"jsonPayload": {"event": "push_diagnostics", "member_id": 5}}]
    assert probe.parse_pushes(junk, ORG) == []
    assert probe.parse_diagnostics(junk, MEMBER) == ([], 0)
    assert probe.agg_diag_summary([]) == [] and probe.agg_diag_lines([]) == []


# ── 입력 · gcloud ───────────────────────────────────────────────────────────────────────────────────────────────────────
def test_inputs_are_bounded_and_shaped():
    assert probe.parse_days(None) == 14 and probe.parse_days("30") == 30
    for bad in ("0", "31", "-1", "abc", "7; rm -rf /"):
        with pytest.raises(SystemExit):
            probe.parse_days(bad)
    assert probe.parse_prefix("54BAC162", "ORG_PREFIX") == "54bac162"
    for bad in ("", None, "54bac16", "54bac1622", "54bac16g", '54bac162" OR "x'):
        with pytest.raises(SystemExit):
            probe.parse_prefix(bad, "ORG_PREFIX")
    assert probe.parse_split_date(None) == "2026-10-08" and probe.parse_split_date("2026-10-01") == "2026-10-01"
    for bad in ("10-08", "2026-10-08T00", '2026-10-08" OR "x'):
        with pytest.raises(SystemExit):
            probe.parse_split_date(bad)


def _env(monkeypatch):
    monkeypatch.setenv("DAYS", "14")
    monkeypatch.setenv("ORG_PREFIX", ORG)
    monkeypatch.setenv("MEMBER_PREFIX", MEMBER)
    monkeypatch.setenv("SPLIT_DATE", "2026-10-08")


def test_a_failing_gcloud_prints_its_error_as_the_result(monkeypatch, capsys):
    def boom(cmd):
        raise probe._GcloudError("ERROR: (gcloud.logging.read) PERMISSION_DENIED: The caller does not have permission")

    monkeypatch.setattr(probe, "_run", boom)
    _env(monkeypatch)
    assert probe.main() == 1
    assert "PERMISSION_DENIED: The caller does not have permission" in capsys.readouterr().out


def test_only_dev_backend_is_read_and_only_two_gcloud_verbs_are_used(monkeypatch, capsys):
    calls: list[list[str]] = []

    def fake_run(cmd):
        calls.append(cmd)
        if cmd[:4] == ["gcloud", "run", "services", "list"]:
            return "sprintable-frontend-dev\nsprintable-backend-dev\nsprintable-backend-prod\n"
        flt = cmd[3]
        if "expo push: sent" in flt:
            import json
            return json.dumps([_push("2026-10-09T02:00:00Z", devices=0, ok=0)])
        return "[]"

    monkeypatch.setattr(probe, "_run", fake_run)
    _env(monkeypatch)
    assert probe.main() == 0
    out = capsys.readouterr().out
    assert "백엔드 서비스: sprintable-backend-dev" in out and "prod" not in out
    assert "devices=0  ok=0" in out and "(해당 항목 없음)" in out
    verbs = {tuple(c[1:3]) for c in calls}
    assert verbs == {("run", "services"), ("logging", "read")}  # config · auth 를 바꾸는 명령 0
    for c in calls:
        assert "auth" not in c and "config" not in c and "activate-service-account" not in c
    reads = [c[3] for c in calls if c[1] == "logging"]
    assert all('resource.labels.service_name="sprintable-backend-dev"' in f for f in reads)
    assert any(f'"org={ORG}"' in f for f in reads) and any(f'jsonPayload.member_id:"{MEMBER}"' in f for f in reads)
    _no_secret(out)


def test_one_failing_branch_does_not_stop_the_other(monkeypatch, capsys):
    def fake_run(cmd):
        if cmd[:4] == ["gcloud", "run", "services", "list"]:
            return "sprintable-backend-dev\n"
        if "expo push: sent" in cmd[3]:
            raise probe._GcloudError("PERMISSION_DENIED on push read")
        return "[]"

    monkeypatch.setattr(probe, "_run", fake_run)
    _env(monkeypatch)
    assert probe.main() == 0
    out = capsys.readouterr().out
    assert "PERMISSION_DENIED on push read" in out and "(해당 항목 없음)" in out


def test_no_dev_backend_is_an_error(monkeypatch, capsys):
    monkeypatch.setattr(probe, "_run", lambda cmd: "sprintable-backend-prod\n")
    _env(monkeypatch)
    assert probe.main() == 1
    assert "sprintable-backend-dev 서비스를 못 찾았다" in capsys.readouterr().out
