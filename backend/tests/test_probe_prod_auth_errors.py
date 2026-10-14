"""infra/probe_prod_auth_errors.py (prod 로그인 실패 진단 probe, 2026-10-14) — 집계가 **허용 목록만** 내보내는지 고정한다.

라이브 gcloud 없이, 실제 로그 항목의 모양에 **일부러 민감한 값(이메일 · 사용자 id · IP · UA · referer · code · state ·
토큰 · 쿠키 · 쿼리의 error 외 값)을 섞은** 표본을 넣고, 출력 어디에도 그 값이 없는지 본다. 이 테스트의 값은 «센다»가 아니라
«새지 않는다»다(까디르 렌즈).
"""
from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

_INFRA_DIR = Path(__file__).resolve().parents[2] / "infra"


def _load():
    spec = importlib.util.spec_from_file_location("probe_prod_auth_errors", _INFRA_DIR / "probe_prod_auth_errors.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


probe = _load()

# 닫힌 목록 표본 — 실제로는 소스에서 만든다(build_known). 여기선 고정 표본으로 «목록 밖은 (other)»를 본다.
KNOWN_ERRORS = frozenset({"oauth_failed", "csrf_mismatch", "oauth_no_token", "OAUTH_TOKEN_EXCHANGE_FAILED", "INVALID_STATE"})
KNOWN_BE = frozenset({"OAUTH_TOKEN_EXCHANGE_FAILED", "OAUTH_NO_TOKEN", "INVALID_STATE"})
HANDOFF = frozenset({"issue", "consume"})

# 출력에 절대 나오면 안 되는 값들 — 표본 곳곳에 심는다
SECRETS = [
    "teacher@example.com", "11111111-2222-3333-4444-555555555555", "203.0.113.77", "Mozilla/5.0 SecretUA",
    "https://referer.example/secret-path", "AUTHCODE_abc123", "STATEVALUE_xyz789", "eyJhbGciOiJIUzI1NiJ9.TOKENPART", "sp_at=COOKIEVALUE",
    "ya29.GOOGLEACCESSTOKEN", "refresh_token_secret",
]


def _web_state(ts: str, outcome="ok", provider="google", native="true") -> dict:
    return {
        "timestamp": ts,
        "textPayload": (
            f"auth.oauth.callback.state_check outcome={outcome} provider={provider} native={native} state_len=43 "
            f"stored_state_len=43 referer={SECRETS[4]} ua={SECRETS[3]}"
        ),
        "httpRequest": {"remoteIp": SECRETS[2]},
    }


def _login_error(ts: str, error: str) -> dict:
    url = f"https://app.example/login?error={error}&email={SECRETS[0]}&code={SECRETS[5]}&state={SECRETS[6]}"
    return {"timestamp": ts, "httpRequest": {"requestUrl": url, "status": 307, "remoteIp": SECRETS[2], "userAgent": SECRETS[3]}}


def _be_request(ts: str, path: str, status: int, method="POST") -> dict:
    url = f"https://api.example{path}?code={SECRETS[5]}&state={SECRETS[6]}&user={SECRETS[1]}"
    return {"timestamp": ts, "httpRequest": {"requestUrl": url, "requestMethod": method, "status": status, "remoteIp": SECRETS[2]}}


def _no_secret(text: str) -> None:
    for s in SECRETS:
        assert s not in text, f"leaked: {s!r}"
    # 보조: 값의 조각도 안 나와야 한다
    for frag in ("secret-path", "SecretUA", "AUTHCODE", "STATEVALUE", "TOKENPART", "COOKIEVALUE", "teacher@", "203.0.113", "GOOGLEACCESS"):
        assert frag not in text, f"leaked fragment: {frag!r}"


def test_state_checks_count_by_hour_outcome_provider_native():
    es = [
        _web_state("2026-10-14T03:01:00Z", "missing_cookie", "google", "true"),
        _web_state("2026-10-14T03:40:00Z", "missing_cookie", "google", "true"),
        _web_state("2026-10-14T04:05:00Z", "ok", "google", "false"),
        _web_state("2026-10-14T04:06:00Z", "state_mismatch", "apple", "true"),
    ]
    out = probe.agg_state_checks(es)
    assert out == [
        "  2026-10-14T03:00Z  outcome=missing_cookie  provider=google  native=true  2건",
        "  2026-10-14T04:00Z  outcome=ok  provider=google  native=false  1건",
        "  2026-10-14T04:00Z  outcome=state_mismatch  provider=apple  native=true  1건",
    ]
    _no_secret("\n".join(out))


def test_state_checks_values_outside_the_allowlist_are_folded_not_echoed():
    e = _web_state("2026-10-14T03:01:00Z", outcome="ok", provider="evil-provider-teacher@example.com")
    e["textPayload"] = e["textPayload"].replace("provider=evil-provider-teacher@example.com", "provider=teacher_example_com")
    out = "\n".join(probe.agg_state_checks([e]))
    assert "provider=(other)" in out
    _no_secret(out)
    assert "teacher_example_com" not in out


def test_login_errors_show_only_the_error_value_with_counts_and_times():
    es = [
        _login_error("2026-10-14T03:00:05Z", "oauth_failed"),
        _login_error("2026-10-14T05:10:09Z", "oauth_failed"),
        _login_error("2026-10-14T04:00:00Z", "csrf_mismatch"),
        _login_error("2026-10-14T04:01:00Z", "bad%20value%20teacher@example.com"),  # 목록 밖 → (other)
    ]
    out = probe.agg_login_errors(es, KNOWN_ERRORS)
    assert out == [
        "  error=oauth_failed  2건 (처음 2026-10-14T03:00:05Z · 마지막 2026-10-14T05:10:09Z)",
        "  error=(other)  1건 (처음 2026-10-14T04:01:00Z · 마지막 2026-10-14T04:01:00Z)",
        "  error=csrf_mismatch  1건 (처음 2026-10-14T04:00:00Z · 마지막 2026-10-14T04:00:00Z)",
    ]
    _no_secret("\n".join(out))


def test_login_errors_ignore_other_paths_and_other_query_values():
    e = {"timestamp": "2026-10-14T03:00:05Z", "httpRequest": {"requestUrl": f"https://app.example/other?error=oauth_failed&x={SECRETS[0]}"}}
    assert probe.agg_login_errors([e], KNOWN_ERRORS) == []


def test_login_error_values_are_a_closed_list_not_a_shape():
    """까디르 렌즈 ①: `[A-Za-z0-9_]{1,64}` 모양이면 통과하던 구멍 — 대시 없는 uuid · 점 없는 토큰꼴도 그대로 찍혔다."""
    undashed_uuid = "11111111222233334444555555555555"
    tokenish = "eyJhbGciOiJIUzI1NiJ9TOKENPARTnodots"
    es = [
        _login_error("2026-10-14T03:00:00Z", undashed_uuid),
        _login_error("2026-10-14T03:00:01Z", tokenish),
        _login_error("2026-10-14T03:00:02Z", "alice_kim_x"),
        _login_error("2026-10-14T03:00:03Z", "csrf_mismatch"),
        _login_error("2026-10-14T03:00:04Z", "OAUTH_TOKEN_EXCHANGE_FAILED"),
    ]
    out = "\n".join(probe.agg_login_errors(es, KNOWN_ERRORS))
    for leaked in (undashed_uuid, tokenish, "alice_kim_x", "11111111", "TOKENPART"):
        assert leaked not in out
    assert "error=(other)  3건" in out
    assert "error=csrf_mismatch  1건" in out and "error=OAUTH_TOKEN_EXCHANGE_FAILED  1건" in out  # 알려진 코드는 그대로


def test_backend_requests_fold_the_path_to_a_constant_and_drop_the_query():
    es = [
        _be_request("2026-10-14T03:00:01Z", "/api/v2/auth/oauth/callback", 400),
        _be_request("2026-10-14T03:05:01Z", "/api/v2/auth/oauth/callback", 400),
        _be_request("2026-10-14T03:06:01Z", "/api/v2/auth/oauth/callback", 502),
        _be_request("2026-10-14T03:07:01Z", f"/api/v2/auth/oauth-handoff/{SECRETS[1]}", 404, "GET"),
        _be_request("2026-10-14T03:08:01Z", "/api/v2/auth/oauth/callback", 200),  # 4xx/5xx 만
        _be_request("2026-10-14T03:09:01Z", "/api/v2/other", 500),  # 다른 경로는 센 적 없음
    ]
    out = probe.agg_backend_requests(es, HANDOFF)
    assert out == [
        "  GET /oauth-handoff/(other)  → 404  1건 (처음 2026-10-14T03:07:01Z · 마지막 2026-10-14T03:07:01Z)",
        "  POST /oauth/callback  → 400  2건 (처음 2026-10-14T03:00:01Z · 마지막 2026-10-14T03:05:01Z)",
        "  POST /oauth/callback  → 502  1건 (처음 2026-10-14T03:06:01Z · 마지막 2026-10-14T03:06:01Z)",
    ]
    _no_secret("\n".join(out))


def test_backend_paths_are_constant_labels_the_prefix_is_dropped():
    """까디르 렌즈 ②: `/oauth/callback` 앞 접두가 그대로 찍히던 구멍 — `/u/alice_kim_x/oauth/callback` 의 alice 가 새던 것."""
    es = [
        _be_request("2026-10-14T03:00:01Z", "/u/alice_kim_x/oauth/callback", 400),
        _be_request("2026-10-14T03:00:02Z", "/api/v2/auth/oauth/callback", 400),
        _be_request("2026-10-14T03:00:03Z", "/api/v2/auth/oauth-handoff/consume", 410, "POST"),
        _be_request("2026-10-14T03:00:04Z", "/zz/alice_kim_x/oauth-handoff/consume", 410, "POST"),
        _be_request("2026-10-14T03:00:05Z", "/api/v2/auth/oauth-handoff/alice_kim_x", 404, "GET"),
    ]
    out = "\n".join(probe.agg_backend_requests(es, HANDOFF))
    assert "alice" not in out and "/u/" not in out and "/zz/" not in out and "/api/v2" not in out
    assert "POST /oauth/callback  → 400  2건" in out  # 두 접두가 한 라벨로 접힌다
    assert "POST /oauth-handoff/consume  → 410  2건" in out  # 소스 목록의 동작 이름은 그대로
    assert "GET /oauth-handoff/(other)  → 404  1건" in out  # 목록 밖 동작 이름은 (other)


def test_backend_method_outside_the_set_is_folded():
    out = "\n".join(probe.agg_backend_requests([_be_request("2026-10-14T03:00:01Z", "/api/v2/auth/oauth/callback", 400, "ALICE")], HANDOFF))
    assert "ALICE" not in out and "? /oauth/callback" in out


def test_state_check_outcome_outside_the_set_is_folded():
    e = _web_state("2026-10-14T03:01:00Z", outcome="alice_kim_x")
    out = "\n".join(probe.agg_state_checks([e]))
    assert "alice_kim_x" not in out and "outcome=(other)" in out


def test_backend_oauth_words_outside_the_list_fold_to_other():
    """까디르 렌즈 ③: `OAUTH_` 뒤 아무 대문자 낱말이나 찍히던 구멍."""
    es = [
        {"timestamp": "2026-10-14T03:00:10Z", "textPayload": "OAUTH_ALICEKIMEXAMPLECOM failed"},
        {"timestamp": "2026-10-14T03:00:11Z", "textPayload": "OAUTH_NO_TOKEN"},
        {"timestamp": "2026-10-14T03:00:12Z", "textPayload": "ALICEKIMEXAMPLECOM"},  # OAUTH_ 꼴도 아니고 목록에도 없음 → 안 셈
    ]
    out = "\n".join(probe.agg_backend_words(es, KNOWN_BE))
    assert "ALICE" not in out
    assert "OAUTH_(other)  1건" in out and "OAUTH_NO_TOKEN  1건" in out


def test_backend_words_emit_only_the_matched_words():
    es = [
        {
            "timestamp": "2026-10-14T03:00:10Z",
            "severity": "ERROR",
            "textPayload": f"OAUTH_TOKEN_EXCHANGE_FAILED for {SECRETS[0]} code={SECRETS[5]} body={{'error': 'invalid_grant', 'access_token': '{SECRETS[9]}'}}",
            "labels": {"user": SECRETS[1]},
        },
        {"timestamp": "2026-10-14T03:30:10Z", "jsonPayload": {"message": "oauth failed INVALID_STATE", "email": SECRETS[0], "ua": SECRETS[3]}},
        {"timestamp": "2026-10-14T03:31:10Z", "textPayload": f"nothing allowed here {SECRETS[10]}"},
    ]
    out = probe.agg_backend_words(es, KNOWN_BE)
    assert out == [
        "  INVALID_STATE  1건 (처음 2026-10-14T03:30:10Z · 마지막 2026-10-14T03:30:10Z)",
        "  OAUTH_TOKEN_EXCHANGE_FAILED  1건 (처음 2026-10-14T03:00:10Z · 마지막 2026-10-14T03:00:10Z)",
        "  invalid_grant  1건 (처음 2026-10-14T03:00:10Z · 마지막 2026-10-14T03:00:10Z)",
    ]
    _no_secret("\n".join(out))


def test_malformed_entries_do_not_crash_or_leak():
    junk = [{}, {"timestamp": 5}, {"httpRequest": "x"}, {"textPayload": None}, {"jsonPayload": []}]
    assert probe.agg_state_checks(junk) == []
    assert probe.agg_login_errors(junk, KNOWN_ERRORS) == []
    assert probe.agg_backend_requests(junk, HANDOFF) == []
    assert probe.agg_backend_words(junk, KNOWN_BE) == []


def test_hours_input_is_bounded():
    assert probe.parse_hours(None) == 12
    assert probe.parse_hours("6") == 6
    for bad in ("0", "73", "-1", "abc", "12; rm -rf /", ""):
        if bad == "":
            assert probe.parse_hours(bad) == 12
            continue
        with pytest.raises(SystemExit):
            probe.parse_hours(bad)


def _fixed_known():
    k = probe.Known()
    k.web_errors, k.be_codes, k.handoff_actions, k.versions = set(KNOWN_ERRORS), set(KNOWN_BE), set(HANDOFF), ["checkout", "origin/main"]
    return k


def test_a_failing_gcloud_prints_its_error_as_the_result(monkeypatch, capsys):
    def boom(cmd):
        raise probe._GcloudError("ERROR: (gcloud.logging.read) PERMISSION_DENIED: The caller does not have permission")

    monkeypatch.setattr(probe, "_run", boom)
    monkeypatch.setattr(probe, "build_known", _fixed_known)
    monkeypatch.setenv("HOURS", "6")
    assert probe.main() == 1
    out = capsys.readouterr().out
    assert "PERMISSION_DENIED: The caller does not have permission" in out


def test_one_failing_branch_does_not_stop_the_others(monkeypatch, capsys):
    calls = []

    def fake_run(cmd):
        if cmd[:4] == ["gcloud", "run", "services", "list"]:
            return "sprintable-frontend-prod\nsprintable-backend-prod\nsprintable-backend-dev\n"
        flt = cmd[3]
        calls.append(flt)
        if "state_check" in flt:
            raise probe._GcloudError("PERMISSION_DENIED on state_check read")
        return "[]"

    monkeypatch.setattr(probe, "_run", fake_run)
    monkeypatch.setattr(probe, "build_known", _fixed_known)
    monkeypatch.setenv("HOURS", "6")
    assert probe.main() == 0
    out = capsys.readouterr().out
    assert "웹 서비스: sprintable-frontend-prod · 백엔드 서비스: sprintable-backend-prod" in out  # dev 는 안 읽는다
    assert "PERMISSION_DENIED on state_check read" in out
    assert out.count("(해당 항목 없음)") == 3  # 나머지 세 갈래는 돌았고 비어 있다
    assert len(calls) == 4
    assert all("sprintable-backend-dev" not in c for c in calls)


# ── 닫힌 목록은 소스에서 실행 때 만든다 (develop ∪ main) ─────────────────────────────────────────────────────────────────────

_LOGIN_TSX = """
  const oauthErrors: Record<string, string> = {
    oauth_init_failed: t('a'),
    csrf_mismatch: t('b'),
    // 주석: not_a_key: x
    oauth_native_issue_failed: t('c'),
  };
  const [email, setEmail] = useState('');
"""
_CALLBACK_TS = """
    return NextResponse.redirect(`${origin}/login?error=invalid_provider`);
    const errCode = errBody?.error?.code ?? 'oauth_failed';
    return NextResponse.redirect(`${origin}/login?error=${errCode}`);
"""
_AUTH_PY = """
    return _err("INVALID_STATE", "x", 400)
    raise OAuthExchangeError("OAUTH_TOKEN_EXCHANGE_FAILED", "x")
    return _err(  "EMAIL_TAKEN", "x", 409)
    log("OAUTH_NOT_A_CALL_SITE")
"""
_HANDOFF_PY = '@router.post("/oauth-handoff/issue")\n@router.post("/oauth-handoff/consume")\nX = "/oauth-handoff/not_this_one_has_digits9"'


def test_extractors_read_the_real_shapes():
    assert probe.extract_web_errors(_LOGIN_TSX, _CALLBACK_TS) == {
        "oauth_init_failed", "csrf_mismatch", "oauth_native_issue_failed", "invalid_provider", "oauth_failed",
    }  # `${errCode}` 는 리터럴이 아니라 안 잡힌다 · 주석 속 키 모양도 안 잡힌다(블록의 줄 앞 키만)
    assert probe.extract_be_codes(_AUTH_PY) == {"INVALID_STATE", "OAUTH_TOKEN_EXCHANGE_FAILED", "EMAIL_TAKEN"}
    assert probe.extract_handoff_actions(_HANDOFF_PY) == {"issue", "consume"}


def test_known_is_the_union_of_checkout_and_main():
    """PO 덧: probe 는 develop 체크아웃에서 돌지만 prod 는 main 코드 — main 에만 있는 코드가 (other) 로 묻히면 안 된다."""
    develop_auth = 'raise OAuthExchangeError("OAUTH_NEW_ON_DEVELOP", "x")'
    main_auth = 'raise OAuthExchangeError("OAUTH_ONLY_ON_MAIN", "x")'

    def reader(path):
        if path == probe._SRC_BE_AUTH:
            return [("checkout", develop_auth), ("origin/main", main_auth)]
        return [("checkout", ""), ("origin/main", "")]

    k = probe.build_known(reader)
    assert k.be_codes == {"OAUTH_NEW_ON_DEVELOP", "OAUTH_ONLY_ON_MAIN"} and k.versions == ["checkout", "origin/main"]
    errors, be, _ = k.freeze()
    out = "\n".join(probe.agg_login_errors([_login_error("2026-10-14T03:00:00Z", "OAUTH_ONLY_ON_MAIN")], errors))
    assert "error=OAUTH_ONLY_ON_MAIN" in out  # main 에만 있는 코드가 그대로 보인다
    assert "OAUTH_ONLY_ON_MAIN" in "\n".join(
        probe.agg_backend_words([{"timestamp": "2026-10-14T03:00:10Z", "textPayload": "OAUTH_ONLY_ON_MAIN"}], be)
    )


def test_a_missing_main_is_reported_not_silent():
    def reader(path):
        return [("checkout", _AUTH_PY if path == probe._SRC_BE_AUTH else "")]

    k = probe.build_known(reader)
    assert k.versions == ["checkout"]
    assert any("origin/main" in n for n in k.notes)


def test_the_real_sources_in_this_checkout_yield_the_codes_the_story_is_about():
    """손으로 적은 목록이 아니라 실제 소스 — 소스 경로/모양이 바뀌어 목록이 조용히 비면 여기서 빨강."""
    k = probe.build_known(lambda path: [("checkout", (_INFRA_DIR.parent / path).read_text(encoding="utf-8"))])
    errors, be, actions = k.freeze()
    for code in ("OAUTH_TOKEN_EXCHANGE_FAILED", "OAUTH_NO_TOKEN", "OAUTH_USERINFO_FAILED", "INVALID_STATE"):
        assert code in be and code in errors
    for code in ("csrf_mismatch", "oauth_native_issue_failed", "oauth_no_token", "oauth_failed", "oauth_missing_params"):
        assert code in errors
    assert {"issue", "consume"} <= actions
