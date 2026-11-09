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


# ── ③ 칸 이름만 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
def test_field_names_carry_no_values_and_odd_names_fold():
    entry = {
        "timestamp": "2026-10-09T02:00:00Z", "severity": "INFO", "labels": {SECRETS[0]: SECRETS[1]},
        "jsonPayload": {
            "message": f"expo push: sent org={ORG_FULL} token={SECRETS[1]}", "logger": "x", "member_id": MEMBER_FULL,
            SECRETS[0]: 1, MEMBER_FULL: 2, "a" * 41: 3,  # 이메일 · id · 너무 긴 이름이 «키»로 온 경우
        },
        MEMBER_FULL: "x",
    }
    names = probe.field_names(entry)
    assert names == sorted(names)
    assert {"timestamp", "severity", "labels", "jsonPayload", "jsonPayload.message", "jsonPayload.logger", "jsonPayload.member_id", "jsonPayload.(other)", "(other)"} == set(names)
    _no_secret("\n".join(names))


def test_field_names_cap_and_junk():
    names = probe.field_names({"jsonPayload": {f"k{i}": i for i in range(80)}})
    assert len(names) == probe._FIELD_NAMES_MAX + 1 and names[-1].startswith("… 외 ")
    assert probe.field_names(None) == [] and probe.field_names("x") == [] and probe.field_names({}) == []
    assert probe.field_names({"jsonPayload": "text"}) == ["jsonPayload"]


def test_main_prints_the_latest_entrys_field_names_unfiltered_and_without_values(monkeypatch, capsys):
    seen: dict[str, list[str]] = {}

    def fake_run(cmd):
        if cmd[:4] == ["gcloud", "run", "services", "list"]:
            return "sprintable-backend-dev\n"
        flt = cmd[3]
        if "expo push: sent" in flt or "push_diagnostics" in flt:
            return "[]"
        seen["cmd"] = cmd
        import json
        return json.dumps([{"timestamp": "2026-10-15T00:00:00Z", "severity": "INFO", "jsonPayload": {"message": SECRETS[1], "logger": "x"}}])

    monkeypatch.setattr(probe, "_run", fake_run)
    _env(monkeypatch)
    assert probe.main() == 0
    out = capsys.readouterr().out
    assert "jsonPayload · jsonPayload.logger · jsonPayload.message · severity · timestamp" in out
    _no_secret(out)
    assert "--limit=1" in seen["cmd"]  # 한 줄만
    assert ORG not in seen["cmd"][3] and MEMBER not in seen["cmd"][3] and "expo" not in seen["cmd"][3]  # 필터 없이(서비스 + 시각만)


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


def test_gcloud_error_text_hides_emails_and_keeps_the_rest(monkeypatch, capsys):
    """까디르 렌즈 1선: gcloud 오류 stderr 에 운영자 계정 이메일이 실릴 수 있다 — 이메일 모양만 (email) 로 가리고 다른 문구는 그대로."""
    import subprocess

    msg = (
        "ERROR: (gcloud.logging.read) PERMISSION_DENIED: Permission 'logging.logEntries.list' denied on resource "
        "(or it may not exist). account ops.person+dev@moonklabs.com and svc-1@proj.iam.gserviceaccount.com cannot read"
    )
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: subprocess.CompletedProcess(a, 1, stdout="", stderr=msg))
    with pytest.raises(probe._GcloudError) as ei:
        probe._run(["gcloud", "logging", "read", "x"])
    text = str(ei.value)
    assert "ops.person" not in text and "moonklabs.com" not in text and "iam.gserviceaccount" not in text and "@" not in text
    assert text == (
        "ERROR: (gcloud.logging.read) PERMISSION_DENIED: Permission 'logging.logEntries.list' denied on resource "
        "(or it may not exist). account (email) and (email) cannot read"
    )


def test_an_email_across_the_800_char_cut_is_hidden_before_the_cut(monkeypatch):
    import subprocess

    msg = "x" * 780 + " ops.person@moonklabs.com tail"  # 이메일이 800자 경계를 가로지른다 — 자른 뒤 가리면 «ops.person@moonklabs» 조각이 남는다
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: subprocess.CompletedProcess(a, 1, stdout="", stderr=msg))
    with pytest.raises(probe._GcloudError) as ei:
        probe._run(["gcloud", "logging", "read", "x"])
    text = str(ei.value)
    assert "ops" not in text.replace("x", "") and "@" not in text and text.endswith("(email) tail")
    assert len(text) <= 800


def test_the_whole_stdout_never_carries_planted_secrets_or_raw_ids(monkeypatch, capsys):
    """까디르 렌즈 1선: 집계 함수의 반환값만 보면 파싱 도중의 print(원문)이 안 잡힌다 — main 이 stdout 에 쓴 것 전부를 본다."""
    import json

    es_push = [
        _push("2026-10-09T02:00:00Z", devices=1, ok=0, error=1, reasons=f"{{'\"{SECRETS[1]}\" bad for {SECRETS[0]}': 1}}"),
        _push("2026-10-09T02:01:00Z", "conversation.message", org=OTHER_ORG_FULL),
    ]
    es_diag = [_diag("2026-10-09T01:00:00Z", "device_token", "granted", SECRETS[1]), _diag("2026-10-09T01:01:00Z", member=OTHER_MEMBER_FULL)]
    es_any = [{"timestamp": "2026-10-15T00:00:00Z", "jsonPayload": {"message": f"x {SECRETS[1]}", SECRETS[0]: MEMBER_FULL, "member_id": MEMBER_FULL}}]

    def fake_run(cmd):
        if cmd[:4] == ["gcloud", "run", "services", "list"]:
            return "sprintable-backend-dev\n"
        flt = cmd[3]
        if "expo push: sent" in flt:
            return json.dumps(es_push)
        if "push_diagnostics" in flt:
            return json.dumps(es_diag)
        return json.dumps(es_any)

    monkeypatch.setattr(probe, "_run", fake_run)
    _env(monkeypatch)
    assert probe.main() == 0
    captured = capsys.readouterr()
    everything = captured.out + captured.err
    _no_secret(everything)
    for raw in (ORG_FULL, MEMBER_FULL, OTHER_MEMBER_FULL, OTHER_ORG_FULL, "e75ca548-"):
        assert raw not in everything, raw
    assert "stage=device_token" in everything and "devices=1  ok=0  error=1" in everything  # 그래도 읽은 결과는 나온다


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


# ── story 4796: dev 백엔드는 10-27 부터 VM — Cloud Run 서비스가 없다 ─────────────────────────────────────────────────────────────────────

def test_no_cloud_run_dev_backend_reads_the_dev_vm_instead_and_never_the_prod_vm(monkeypatch, capsys):
    calls: list[list[str]] = []

    def fake_run(cmd):
        calls.append(cmd)
        if cmd[:4] == ["gcloud", "run", "services", "list"]:
            return "sprintable-backend-prod\nsprintable-frontend-dev\n"   # no sprintable-backend-dev
        return "[]"

    monkeypatch.setattr(probe, "_run", fake_run)
    _env(monkeypatch)
    assert probe.main() == 0                                        # not an error any more: the log is elsewhere
    out = capsys.readouterr().out
    assert "로그 출처: VM sprintable-vm-dev" in out and "story 4796" in out
    reads = [c[3] for c in calls if c[1] == "logging"]
    assert reads and all(
        'resource.type="gce_instance"' in f and 'labels."compute.googleapis.com/resource_name"="sprintable-vm-dev"' in f for f in reads
    )
    assert not any("sprintable-vm-prod" in f or "cloud_run_revision" in f for f in reads)
    # the VM's diagnostics read matches the plain-text docker line AND is narrowed to the teacher's member prefix (never every member's)
    assert any('"push_diagnostics"' in f and f'"{MEMBER}"' in f for f in reads)
    assert any('"expo push: sent"' in f and f'"org={ORG}"' in f for f in reads)
    assert {tuple(c[1:3]) for c in calls} == {("run", "services"), ("logging", "read")}      # still only the two verbs


def test_the_vm_source_names_the_logs_that_arrive_and_no_value(monkeypatch, capsys):
    import json

    def fake_run(cmd):
        if cmd[:4] == ["gcloud", "run", "services", "list"]:
            return ""
        flt = cmd[3]
        if "--limit=500" in cmd:   # ④ — the log names
            ents = [{"logName": "projects/p/logs/syslog", "textPayload": "SECRET-LINE teacher.private@example.com"}] * 3
            ents += [{"logName": "projects/p/logs/ops-agent-health", "jsonPayload": {"k": "SECRET-VALUE"}}]
            ents += [{"logName": "projects/p/logs/we ird/name with spaces!!", "textPayload": "x"}]
            ents += [{"logName": "projects/p/logs/sprintable-backend-1", "textPayload": "x"}]
            ents += [{"logName": f"projects/p/logs/{MEMBER_FULL}", "textPayload": "x"}, {"logName": "projects/p/logs/0.9.9-secretbuild", "textPayload": "x"}]
            ents += [{"logName": f"projects/p/logs/sprintable-backend-{MEMBER_FULL}", "textPayload": "x"}, {"logName": "projects/p/logs/sprintable-backend-123", "textPayload": "x"}]
            return json.dumps(ents)
        return "[]"

    monkeypatch.setattr(probe, "_run", fake_run)
    _env(monkeypatch)
    assert probe.main() == 0
    out = capsys.readouterr().out
    assert "④" in out and "syslog: 3건" in out and "ops-agent-health: 1건" in out and "sprintable-backend-1: 1건" in out and "(other): 5건" in out
    assert "SECRET" not in out and "teacher.private" not in out and "spaces" not in out
    assert MEMBER_FULL not in out and MEMBER not in out and "secretbuild" not in out and "0.9.9" not in out     # an id- or version-shaped log name never prints


def test_the_cloud_run_path_has_no_vm_section_and_keeps_its_filters(monkeypatch, capsys):
    seen: list[str] = []

    def fake_run(cmd):
        if cmd[:4] == ["gcloud", "run", "services", "list"]:
            return "sprintable-backend-dev\n"
        seen.append(cmd[3])
        return "[]"

    monkeypatch.setattr(probe, "_run", fake_run)
    _env(monkeypatch)
    assert probe.main() == 0
    out = capsys.readouterr().out
    assert "로그 출처: Cloud Run sprintable-backend-dev" in out and "④" not in out
    assert seen and all("gce_instance" not in f for f in seen)
    assert any('jsonPayload.event="push_diagnostics"' in f for f in seen)


def test_docker_shaped_entries_are_read_the_same_as_cloud_run_entries():
    line = "expo push: sent org=54bac162 event=conversation.message devices=1 ok=1 error=0 reasons=None\n"
    for e in (
        {"timestamp": "2026-11-09T07:00:00Z", "textPayload": line},
        {"timestamp": "2026-11-09T07:00:00Z", "jsonPayload": {"message": line}},
        {"timestamp": "2026-11-09T07:00:00Z", "jsonPayload": {"log": line}},            # docker json-file → Ops Agent
    ):
        (p,) = probe.parse_pushes([e], ORG)
        assert (p.devices, p.ok, p.error, p.event) == (1, 1, 0, "conversation.message")


def test_a_diagnostics_line_that_arrives_as_json_text_in_one_field_is_read_once():
    import json
    inner = json.dumps({"event": "push_diagnostics", "member_id": MEMBER_FULL, "stage": "ok", "permission": "granted", "error_code": None, "platform": "ios"})
    structured = {"timestamp": "2026-11-09T07:01:00Z", "jsonPayload": json.loads(inner)}
    wrapped = {"timestamp": "2026-11-09T07:01:00Z", "jsonPayload": {"log": inner + "\n"}}
    for e in (structured, wrapped):
        diags, members = probe.parse_diagnostics([e], MEMBER)
        assert members == 1 and [(d.stage, d.permission, d.platform) for d in diags] == [("ok", "granted", "ios")]
    # not an object / not push_diagnostics → nothing, no crash
    assert probe.parse_diagnostics([{"jsonPayload": {"log": "{not json"}}, {"jsonPayload": {"log": "[1,2]"}}], MEMBER) == ([], 0)
