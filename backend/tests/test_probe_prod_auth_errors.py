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


def test_backend_handoff_all_counts_every_status_by_hour_2xx_included():
    es = [
        _be_request("2026-10-15T05:01:01Z", "/api/v2/internal/auth/oauth-handoff/issue", 200),
        _be_request("2026-10-15T05:02:01Z", "/api/v2/internal/auth/oauth-handoff/issue", 200),
        _be_request("2026-10-15T05:03:01Z", "/api/v2/internal/auth/oauth-handoff/consume", 200),
        _be_request("2026-10-15T05:04:01Z", "/api/v2/internal/auth/oauth-handoff/consume", 401),
        _be_request("2026-10-15T06:01:01Z", "/api/v2/internal/auth/oauth-handoff/consume", 200),
        _be_request("2026-10-15T05:05:01Z", "/api/v2/auth/oauth/callback", 200),  # ③a 의 길 — 여기선 안 센다
        _be_request("2026-10-15T05:06:01Z", "/api/v2/other", 200),  # 다른 경로
        _be_request("2026-10-15T05:07:01Z", f"/api/v2/auth/oauth-handoff/{SECRETS[1]}", 200),  # 목록 밖 동작 이름 → (other)
    ]
    out = probe.agg_backend_handoff_all(es, HANDOFF)
    assert out == [
        "  2026-10-15T05:00Z  POST /oauth-handoff/(other)  → 200  1건",
        "  2026-10-15T05:00Z  POST /oauth-handoff/consume  → 200  1건",
        "  2026-10-15T05:00Z  POST /oauth-handoff/consume  → 401  1건",
        "  2026-10-15T05:00Z  POST /oauth-handoff/issue  → 200  2건",
        "  2026-10-15T06:00Z  POST /oauth-handoff/consume  → 200  1건",
    ]
    _no_secret("\n".join(out))


def test_backend_handoff_all_folds_method_and_status_and_survives_malformed_entries():
    odd = _be_request("2026-10-15T05:01:01Z", "/api/v2/internal/auth/oauth-handoff/issue", 200, "WEIRD")
    odd["httpRequest"]["status"] = "teapot"
    out = probe.agg_backend_handoff_all([odd, {}, {"httpRequest": "x"}, {"httpRequest": {"requestUrl": 7}}], HANDOFF)
    assert out == ["  2026-10-15T05:00Z  ? /oauth-handoff/issue  → ?  1건"]


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
    assert out.count("(해당 항목 없음)") == 5  # 나머지 다섯 갈래(②·④·③a·③c·③b)는 돌았고 비어 있다
    assert len(calls) == 6
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


# ── ④ 웹 앱 링크 길 (경로 셋 · 메서드 · 상태 · 브라우저 갈래) ────────────────────────────────────────────────────────────────

UA_ANDROID_WEBVIEW = (
    "Mozilla/5.0 (Linux; Android 14; SM-S918N Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Version/4.0 Chrome/120.0.6099.144 Mobile Safari/537.36 SecretUA teacher@example.com"
)
UA_ANDROID_CHROME = (
    "Mozilla/5.0 (Linux; Android 14; SM-S918N) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/120.0.6099.144 Mobile Safari/537.36 SecretUA teacher@example.com"
)
UA_SAMSUNG = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0 SamsungBrowser/23.0 Mobile Safari/537.36 SecretUA"
UA_IOS_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1 SecretUA"
UA_GOOGLE_VERIFIER = "Mozilla/5.0 (compatible; Google-Digital-Assetlinks/1.0) SecretUA"


def _web_req(ts: str, path_and_query: str, method="GET", status=200, ua=UA_ANDROID_CHROME) -> dict:
    return {
        "timestamp": ts,
        "httpRequest": {
            "requestUrl": f"https://app.example{path_and_query}", "requestMethod": method, "status": status,
            "userAgent": ua, "remoteIp": SECRETS[2], "referer": SECRETS[4],
        },
    }


def test_browser_classes_are_a_closed_three():
    assert probe.classify_browser(UA_ANDROID_WEBVIEW) == "android-webview"
    assert probe.classify_browser(UA_ANDROID_CHROME) == "chrome"
    assert probe.classify_browser(UA_SAMSUNG) == "other"
    assert probe.classify_browser(UA_IOS_SAFARI) == "other"
    assert probe.classify_browser(UA_GOOGLE_VERIFIER) == "other"
    assert probe.classify_browser(None) == "other" and probe.classify_browser(123) == "other" and probe.classify_browser("") == "other"


def test_app_link_paths_count_by_hour_label_method_status_browser():
    es = [
        _web_req("2026-10-14T03:01:00Z", "/native/oauth-return?code=AUTHCODE_abc123&state=STATEVALUE_xyz789", "GET", 200, UA_ANDROID_CHROME),
        _web_req("2026-10-14T03:20:00Z", "/native/oauth-return", "GET", 200, UA_ANDROID_CHROME),
        _web_req("2026-10-14T03:30:00Z", "/auth/oauth-handoff?token=" + SECRETS[7], "POST", 400, UA_ANDROID_WEBVIEW),
        _web_req("2026-10-14T04:05:00Z", "/.well-known/assetlinks.json", "GET", 200, UA_GOOGLE_VERIFIER),
    ]
    out = probe.agg_app_link_paths(es)
    assert out == [
        "  2026-10-14T03:00Z  /auth/oauth-handoff  POST  400  browser=android-webview  1건",
        "  2026-10-14T03:00Z  /native/oauth-return  GET  200  browser=chrome  2건",
        "  2026-10-14T04:00Z  /.well-known/assetlinks.json  GET  200  browser=other  1건",
    ]
    _no_secret("\n".join(out))


def test_app_link_paths_never_echo_the_ua_the_query_or_a_path_suffix():
    """사용자 지시: 쿼리 · 경로 뒤 값 0, UA 원문 0 — 경로는 정확히 일치하는 셋만 센다."""
    es = [
        _web_req("2026-10-14T03:01:00Z", "/native/oauth-return/alice_kim_x?email=" + SECRETS[0], ua=UA_ANDROID_WEBVIEW),  # 경로 뒤 값 → 안 셈
        _web_req("2026-10-14T03:02:00Z", "/u/alice_kim_x/native/oauth-return", ua=UA_ANDROID_WEBVIEW),  # 앞 접두 → 안 셈
        _web_req("2026-10-14T03:03:00Z", "/auth/oauth-handoff-alice", method="ALICE", ua=UA_ANDROID_CHROME),  # 다른 경로 → 안 셈
        _web_req("2026-10-14T03:04:00Z", "/auth/oauth-handoff", method="ALICE", status=99999, ua="Android ; wv) " + SECRETS[0]),
    ]
    out = "\n".join(probe.agg_app_link_paths(es))
    assert out == "  2026-10-14T03:00Z  /auth/oauth-handoff  ?  ?  browser=android-webview  1건"
    _no_secret(out)
    assert "alice" not in out and "Mozilla" not in out and "Chrome/" not in out and "SecretUA" not in out


def test_app_link_malformed_entries_do_not_crash():
    junk = [{}, {"httpRequest": "x"}, {"httpRequest": {"requestUrl": 5}}, {"httpRequest": {"requestUrl": "https://a/native/oauth-return", "userAgent": 5}}]
    assert probe.agg_app_link_paths(junk) == ["  ?  /native/oauth-return  ?  ?  browser=other  1건"]


# ── ⑤ 시간 창 요청 타임라인 (선생님 «prod 모바일앱에서만 첫 로그인 뒤 홈 → 대화 탭이 10초 넘게» · PO 10-15) ─────────────────────────────────

WEB = frozenset({"sprintable-frontend-prod"})
BACK = frozenset({"sprintable-backend-prod"})
TEMPLATES = frozenset({
    (), ("inbox",), ("api", "health"), ("api", "chat", "conversations"), ("api", "chat", "conversations", "{}", "messages"),
    ("api", "v2", "me"), ("api", "v2", "stories", "{}"), ("api", "v2", "stories", "{}", "comments"), ("{}", "{}", "flow"), ("{}",),
})


def _req(ts: str, path: str, status=200, method="GET", latency="0.250s", service="sprintable-frontend-prod", ua="Mozilla/5.0 (Linux; Android 14; wv) Chrome/120.0 SecretUA", size="1234", protocol="HTTP/2.0") -> dict:
    url = f"https://app.example{path}"
    hr = {"requestUrl": url, "requestMethod": method, "status": status, "latency": latency, "userAgent": ua, "remoteIp": SECRETS[2], "referer": SECRETS[4],
          "responseSize": size, "protocol": protocol}
    return {"timestamp": ts, "resource": {"labels": {"service_name": service}}, "httpRequest": hr}


def test_timeline_window_is_bounded_and_shaped():
    ok = probe.parse_timeline_window("2026-10-15T06:50:00Z", "2026-10-15T08:50:00Z", "prod")
    assert ok == ("2026-10-15T06:50:00Z", "2026-10-15T08:50:00Z", "prod")
    assert probe.parse_timeline_window("2026-10-15T06:50:00Z", "2026-10-15T07:00:00Z", None)[2] == "prod"  # env 기본 prod
    assert probe.parse_timeline_window(" 2026-10-15T06:50:00Z\n", "2026-10-15T07:00:00Z ", " dev ") == ("2026-10-15T06:50:00Z", "2026-10-15T07:00:00Z", "dev")  # 가장자리 공백은 걷는다
    assert probe.parse_timeline_window("2026-10-15T06:50:00Z", "2026-10-15T07:00:00Z", "dev")[2] == "dev"
    for start, end, env in [
        ("2026-10-15T06:50:00Z", "2026-10-15T08:50:01Z", "prod"),   # 2시간 + 1초
        ("2026-10-15T07:00:00Z", "2026-10-15T06:50:00Z", "prod"),   # 끝이 앞
        ("2026-10-15T07:00:00Z", "2026-10-15T07:00:00Z", "prod"),   # 길이 0
        ("2026-10-15 06:50:00", "2026-10-15T07:00:00Z", "prod"),    # 모양
        ("2026-10-15T06:50:00+09:00", "2026-10-15T07:00:00Z", "prod"),
        ("", "2026-10-15T07:00:00Z", "prod"),
        ("2026-10-15T06:50:00Z", "2026-10-15T07:00:00Z", "staging"),
        ("2026-10-15T06:50:00Z", "2026-10-15T07:0\n0:00Z", "prod"),   # 가운데 낀 개행
        ("2026-10-15T06:50:00Z", "2026-10-15T07:00:00Z", "prod; rm"),
    ]:
        with pytest.raises(SystemExit):
            probe.parse_timeline_window(start, end, env)


def test_web_route_files_become_closed_templates():
    t = probe.web_route_template
    assert t("apps/web/src/app/(authenticated)/inbox/page.tsx") == ("inbox",)
    assert t("apps/web/src/app/(authenticated)/[ws]/[proj]/flow/page.tsx") == ("{}", "{}", "flow")
    assert t("apps/web/src/app/api/chat/conversations/[id]/messages/route.ts") == ("api", "chat", "conversations", "{}", "messages")
    assert t("apps/web/src/app/page.tsx") == ()
    for hidden in ("apps/web/src/app/api/x/route.test.ts", "apps/web/src/app/(a)/inbox/page.test.tsx", "apps/web/src/app/@modal/x/page.tsx",
                   "apps/web/src/app/_private/x/page.tsx", "apps/web/src/app/docs/[...slug]/page.tsx", "apps/web/src/app/docs/[[...slug]]/page.tsx",
                   "apps/web/src/lib/x/page.tsx", "apps/web/src/app/inbox/layout.tsx"):
        assert t(hidden) is None, hidden
    assert probe.shape_route_template("/api/v2/stories/{}/comments") == ("api", "v2", "stories", "{}", "comments")
    assert probe.shape_route_template("no-slash") is None and probe.shape_route_template(5) is None


def test_build_route_templates_unions_head_and_main_and_notes_a_missing_one():
    files = {"HEAD": ["apps/web/src/app/(x)/inbox/page.tsx"], "origin/main": ["apps/web/src/app/api/health/route.ts"]}
    shapes = {"HEAD": '[{"path": "/api/v2/me"}]', "origin/main": "not json"}
    templates, notes = probe.build_route_templates(lambda rev: files[rev], lambda rev: shapes[rev])
    assert templates == frozenset({("inbox",), ("api", "health"), ("api", "v2", "me")})
    assert any("origin/main" in n and "route-shape" in n for n in notes)
    def boom(rev): raise RuntimeError("x")
    t2, n2 = probe.build_route_templates(boom, boom)
    assert t2 == frozenset() and len(n2) == 4


def test_route_label_is_a_closed_template_never_the_requests_own_text():
    lab = lambda path: probe.route_label(f"https://app.example{path}?code={SECRETS[5]}&user={SECRETS[1]}", TEMPLATES)
    assert lab("/inbox") == "/inbox"
    assert lab("/") == "/"
    assert lab(f"/api/v2/stories/{SECRETS[1]}") == "/api/v2/stories/{}"
    assert lab(f"/api/v2/stories/{SECRETS[1]}/comments") == "/api/v2/stories/{}/comments"
    assert lab("/api/chat/conversations/abc/messages") == "/api/chat/conversations/{}/messages"
    assert lab("/acme/proj/flow") == "/{}/{}/flow"
    assert lab("/api/health") == "/api/health"                       # 고정 라벨
    assert lab("/_next/static/chunks/a.js") == "/_next/static/*"
    # 가장 구체적인 템플릿이 이긴다: `/inbox` 는 `/{}` 가 아니라 `/inbox`
    assert lab("/someone") == "/{}"
    # 목록 밖은 (other) — 요청 글자는 어디에도 안 실린다
    for bad in ("/totally/unknown/path", f"/api/v2/{SECRETS[3]}", "//", "/api/chat/conversations/a/b/c/d"):
        out = lab(bad)
        assert out == "(other)" or "{}" in out or out.startswith("/"), bad
        for secret in SECRETS:
            assert secret not in out
    assert probe.route_label(None, TEMPLATES) == "(other)" and probe.route_label(7, TEMPLATES) == "(other)"
    assert probe.route_label("https://x/zzz/yyy", frozenset({("a",)})) == "(other)"


def test_timeline_lists_in_time_order_with_ms_status_and_a_closed_browser_class():
    es = [
        _req("2026-10-15T06:55:09.9Z", "/api/chat/conversations", latency="11.532s"),
        _req("2026-10-15T06:55:01.1Z", "/inbox", latency="0.080s"),
        _req("2026-10-15T06:55:05.0Z", "/api/v2/me", service="sprintable-backend-prod", status=401, method="POST", latency="0.012345678s"),
        _req("2026-10-15T06:55:06.0Z", "/api/chat/conversations", latency="garbage"),
        {"timestamp": "2026-10-15T06:55:07Z", "resource": {"labels": {"service_name": "sprintable-frontend-prod"}}, "httpRequest": {"requestUrl": f"https://a.example/inbox?token={SECRETS[7]}", "requestMethod": "WEIRD\r\nX: 1", "status": 999}},
        {"timestamp": "2026-10-15T06:55:08Z"},       # httpRequest 없음 — 건너뛴다
        {"httpRequest": "x"},
    ]
    lines, stats, cut = probe.agg_timeline(es, TEMPLATES, WEB, BACK)
    assert cut is False
    assert lines == [
        "  2026-10-15T06:55:01Z  web  GET /inbox  200  80ms  1234B  proto=h2  browser=android-webview  rsc=0  p=0  from=/{}",
        "  2026-10-15T06:55:05Z  backend  POST /api/v2/me  401  12ms  1234B  proto=h2  browser=android-webview  rsc=0  p=0  from=/{}",
        "  2026-10-15T06:55:06Z  web  GET /api/chat/conversations  200  ?ms  1234B  proto=h2  browser=android-webview  rsc=0  p=0  from=/{}",
        "  2026-10-15T06:55:07Z  web  ? /inbox  ?  ?ms  ?B  proto=?  browser=other  rsc=0  p=0  from=-",
        "  2026-10-15T06:55:09Z  web  GET /api/chat/conversations  200  11532ms  1234B  proto=h2  browser=android-webview  rsc=0  p=0  from=/{}",
    ]
    assert "  web  GET /api/chat/conversations  2건 · p50 11532ms · 최대 11532ms · 크기 합계 2468B" in stats   # ? 는 통계에서 빠진다
    assert "  web  GET /inbox  1건 · p50 80ms · 최대 80ms · 크기 합계 1234B" in stats
    _no_secret("\n".join(lines + stats))


def test_timeline_stats_p50_and_max_by_label():
    es = [_req(f"2026-10-15T06:55:{i:02d}Z", "/api/v2/me", latency=f"{ms / 1000:.3f}s", service="sprintable-backend-prod") for i, ms in enumerate([100, 900, 300, 200])]
    _lines, stats, _cut = probe.agg_timeline(es, TEMPLATES, WEB, BACK)
    assert stats == ["  backend  GET /api/v2/me  4건 · p50 200ms · 최대 900ms · 크기 합계 4936B"]   # 짝수 개 → 아래쪽 중앙값(실제로 있던 값)


def test_timeline_line_cap_is_reported_not_silent(monkeypatch):
    monkeypatch.setattr(probe, "_TL_MAX_LINES", 3)
    es = [_req(f"2026-10-15T06:55:{i:02d}Z", "/inbox") for i in range(5)]
    lines, stats, cut = probe.agg_timeline(es, TEMPLATES, WEB, BACK)
    assert cut is True and len(lines) == 3 and stats == ["  web  GET /inbox  5건 · p50 250ms · 최대 250ms · 크기 합계 6170B"]


def test_cold_starts_print_time_kind_and_a_closed_reason_only():
    def sys_entry(ts, text, service="sprintable-frontend-prod"):
        return {"timestamp": ts, "textPayload": text, "resource": {"labels": {"service_name": service}}}
    es = [
        sys_entry("2026-10-15T06:56:00Z", "Starting new instance. Reason: AUTOSCALING - Instance started due to user traffic."),
        sys_entry("2026-10-15T06:55:00Z", "Starting new instance. Reason: MIN_INSTANCES - x", "sprintable-backend-prod"),
        sys_entry("2026-10-15T06:57:00Z", f"Starting new instance. Reason: {SECRETS[8].upper().replace('.', '_')} {SECRETS[0]}"),
        sys_entry("2026-10-15T06:58:00Z", "Starting new instance."),
        sys_entry("2026-10-15T06:59:00Z", f"container log {SECRETS[0]} nothing to do with starts"),
    ]
    out = probe.agg_cold_starts(es, WEB, BACK)
    assert out == [
        "  2026-10-15T06:55:00Z  backend  reason=MIN_INSTANCES",
        "  2026-10-15T06:56:00Z  web  reason=AUTOSCALING",
        "  2026-10-15T06:57:00Z  web  reason=(other)",
        "  2026-10-15T06:58:00Z  web  reason=?",
    ]
    _no_secret("\n".join(out))


def test_timeline_mode_runs_only_the_timeline_with_the_window_in_the_filter(monkeypatch, capsys):
    calls = []

    def fake_run(cmd):
        if cmd[:4] == ["gcloud", "run", "services", "list"]:
            return "sprintable-frontend-prod\nsprintable-backend-prod\nsprintable-frontend-dev\nsprintable-realtime-prod\n"
        calls.append(cmd)
        return "[]"

    monkeypatch.setattr(probe, "_run", fake_run)
    monkeypatch.setattr(probe, "_curl_version", lambda url: "h2")      # 가짜 — 이 시험은 밖으로 나가지 않는다
    monkeypatch.setattr(probe, "_curl_text", lambda args: "")           # (정적 청크 캐시 읽기도 — 문서가 비면 «못 찾았다»)
    monkeypatch.setattr(probe, "build_route_templates", lambda: (TEMPLATES, []))
    monkeypatch.setenv("TIMELINE_START", "2026-10-15T06:50:00Z")
    monkeypatch.setenv("TIMELINE_END", "2026-10-15T07:50:00Z")
    monkeypatch.setenv("TIMELINE_ENV", "prod")
    assert probe.main() == 0
    out = capsys.readouterr().out
    assert "env=prod" in out and "sprintable-frontend-prod" in out and "sprintable-backend-prod" in out
    assert "sprintable-frontend-dev" not in out and "realtime" not in out          # dev · 실시간 서비스는 안 읽는다
    assert "state_check" not in out and "① " not in out                            # 기존 칸은 안 돈다
    assert len(calls) == 3                                                          # 요청 한 번 · 시스템 로그 한 번 · 정적 청크 한 번(4698)
    assert "prod=h2 · dev=h2" in out                                                # 가장자리 HTTP 판 줄
    assert "정적 청크 캐시(Cloudflare" in out and "prod: 문서에서 정적 청크 주소를 못 찾았다" in out and "dev: 문서에서 정적 청크 주소를 못 찾았다" in out   # 정적 캐시 비교 줄(문서가 비면 «못 찾았다»)
    flt = [c[3] for c in calls]
    assert all('timestamp>="2026-10-15T06:50:00Z" AND timestamp<="2026-10-15T07:50:00Z"' in f for f in flt)
    assert any("/_next/static/" in f and "NOT" in f for f in flt) and any("varlog%2Fsystem" in f for f in flt)
    # 정적 청크 요청은 «NOT» 없이 따로(웹 서비스만) — 기존 요청 줄에는 계속 안 섞인다
    static_f = [f for f in flt if "/_next/static/" in f and "NOT" not in f]
    assert len(static_f) == 1 and "sprintable-frontend-prod" in static_f[0] and "sprintable-backend-prod" not in static_f[0]
    assert all("--order=asc" in c for c in calls)
    monkeypatch.setenv("TIMELINE_ENV", "dev")
    calls.clear()
    assert probe.main() == 0
    assert "sprintable-frontend-dev" in capsys.readouterr().out and "sprintable-frontend-prod" not in "".join(c[3] for c in calls)


def test_a_bad_window_stops_before_any_gcloud_call(monkeypatch):
    monkeypatch.setattr(probe, "_run", lambda cmd: pytest.fail("gcloud must not be called"))
    monkeypatch.setenv("TIMELINE_START", "2026-10-15T06:50:00Z")
    monkeypatch.setenv("TIMELINE_END", "2026-10-15T10:50:00Z")  # 4시간
    with pytest.raises(SystemExit):
        probe.main()


def test_the_real_sources_in_this_checkout_yield_the_routes_the_story_is_about():
    """소스가 바뀌어 템플릿이 조용히 비면 여기서 빨강 — 홈 · 대화 · 로그인 길."""
    root = _INFRA_DIR.parent
    import subprocess
    files = subprocess.run(["git", "ls-files", "apps/web/src/app"], capture_output=True, text=True, cwd=root).stdout.splitlines()
    shapes = (root / "scripts" / "web_api_route_shapes.json").read_text(encoding="utf-8")
    templates, notes = probe.build_route_templates(lambda rev: files if rev == "HEAD" else [], lambda rev: shapes if rev == "HEAD" else "[]")
    assert len(templates) > 300
    assert ("login",) in templates and ("api", "v2", "me") in templates
    assert ("chat",) in templates and ("chats",) in templates and ("today",) in templates   # 홈 · 대화 탭의 페이지
    assert ("api", "conversations", "{}", "messages") in templates                          # 대화 메시지 API(웹 BFF)


def test_size_and_protocol_are_numbers_and_closed_words_only():
    es = [
        _req("2026-10-15T06:55:01Z", "/inbox", size="48213", protocol="HTTP/1.1"),
        _req("2026-10-15T06:55:02Z", "/inbox", size="0", protocol="HTTP/3.0"),
        _req("2026-10-15T06:55:03Z", "/inbox", size=f"12{SECRETS[1]}", protocol=f"HTTP/9 {SECRETS[3]}"),   # 숫자 아님 · 닫힌 낱말 밖
        _req("2026-10-15T06:55:04Z", "/inbox", size="-5", protocol=None),
        _req("2026-10-15T06:55:05Z", "/inbox", size="9" * 13, protocol="http/2"),                         # 너무 큼 · 대소문자
        _req("2026-10-15T06:55:06Z", "/inbox", size=True, protocol=7),
    ]
    lines, stats, _cut = probe.agg_timeline(es, TEMPLATES, WEB, BACK)
    assert [ln.split("  ")[-6:-4] for ln in lines] == [["48213B", "proto=h1.1"], ["0B", "proto=h3"], ["?B", "proto=?"], ["?B", "proto=?"], ["?B", "proto=?"], ["?B", "proto=?"]]
    assert stats == ["  web  GET /inbox  6건 · p50 250ms · 최대 250ms · 크기 합계 48213B"]
    _no_secret("\n".join(lines + stats))


# ── story 4698: probe ⑤ 확장 — 쿼리 표지(`_rsc` · `p`) · 어디서(referer 라벨) · 정적 청크 · 가장자리 HTTP 판 ─────────────────────────────────────
def _url_req(ts: str, url: str, referer=None, **kw) -> dict:
    e = _req(ts, "/x", **kw)
    e["httpRequest"]["requestUrl"] = url
    if referer is None:
        e["httpRequest"].pop("referer", None)
    else:
        e["httpRequest"]["referer"] = referer
    return e


def test_query_flags_and_the_from_label_say_which_and_from_where_without_any_value():
    es = [
        _url_req("2026-10-15T06:55:41Z", f"https://app.example/chats?_rsc={SECRETS[7]}&p={SECRETS[1]}", referer=f"https://app.example/inbox?p={SECRETS[1]}&code={SECRETS[5]}"),
        _url_req("2026-10-15T06:55:46Z", "https://app.example/chats?p=", referer="https://app.example/inbox"),
        _url_req("2026-10-15T06:55:50Z", "https://app.example/chats?other=1"),
        _url_req("2026-10-15T06:55:51Z", "https://app.example/chats", referer=""),
        _url_req("2026-10-15T06:55:52Z", "https://app.example/chats?p=%zz&_rsc", referer=7),
    ]
    lines, _stats, _cut = probe.agg_timeline(es, TEMPLATES, WEB, BACK)
    tails = [ln.split("  ")[-3:] for ln in lines]
    assert tails == [["rsc=1", "p=1", "from=/inbox"], ["rsc=0", "p=1", "from=/inbox"], ["rsc=0", "p=0", "from=-"], ["rsc=0", "p=0", "from=-"], ["rsc=1", "p=1", "from=-"]]
    _no_secret("\n".join(lines))


def test_static_requests_fold_to_three_closed_kinds_and_never_carry_a_chunk_name():
    chunk = "a1b2c3d4e5f60718"          # 빌드 해시 같은 모양
    es = [
        _url_req("2026-10-15T06:55:41Z", f"https://app.example/_next/static/chunks/app/chats/page-{chunk}.js", latency="0.400s", size="91000"),
        _url_req("2026-10-15T06:55:42Z", f"https://app.example/_next/static/chunks/webpack-{chunk}.js?v={SECRETS[5]}", latency="0.200s", size="4000"),
        _url_req("2026-10-15T06:55:43Z", f"https://app.example/_next/static/css/{chunk}.css", latency="0.100s", size="30000"),
        _url_req("2026-10-15T06:55:44Z", f"https://app.example/_next/static/media/{chunk}.woff2", latency="0.050s", size="20000"),
        _url_req("2026-10-15T06:55:45Z", f"https://app.example/_next/static/{chunk}/_buildManifest.js", latency="0.010s", size="500"),   # 빌드 아이디 폴더 → (other)
        _url_req("2026-10-15T06:55:46Z", "https://app.example/inbox"),                                                              # 정적이 아니면 (other)
    ]
    lines, stats, cut = probe.agg_static(es, WEB, BACK)
    assert cut is False
    labels = [ln.split("  ")[3] for ln in lines]
    assert labels == ["GET /_next/static/chunks/*", "GET /_next/static/chunks/*", "GET /_next/static/css/*", "GET /_next/static/media/*", "GET /_next/static/(other)/*", "GET (other)"]
    assert "  web  GET /_next/static/chunks/*  2건 · p50 200ms · 최대 400ms · 크기 합계 95000B" in stats
    text = "\n".join(lines + stats)
    assert chunk not in text and "page-" not in text and "webpack-" not in text and "_buildManifest" not in text
    _no_secret(text)
    assert probe.static_label(None) == "(other)" and probe.static_label("not a url") == "(other)"


def test_edge_versions_are_closed_words_and_a_failure_is_a_question_mark(monkeypatch):
    seen = []
    assert probe.edge_versions(lambda url: seen.append(url) or "h2") == "prod=h2 · dev=h2"
    assert seen == ["https://app.sprintable.ai/login", "https://dev-app.sprintable.ai/login"]   # 닫힌 둘 — 밖의 주소는 안 부른다
    import subprocess as sp

    def fake(stdout="", returncode=0, raises=None):
        def run(cmd, **kw):
            assert cmd[0] == "curl" and cmd[-1].startswith("https://") and "-w" in cmd
            if raises:
                raise raises
            return sp.CompletedProcess(cmd, returncode, stdout=stdout, stderr="")
        return run
    for out, want in [("2", "h2"), ("3", "h3"), ("1.1", "h1.1"), ("1.0", "h1.0"), (f"2 {SECRETS[3]}", "?"), ("", "?"), ("9", "?")]:
        monkeypatch.setattr(probe.subprocess, "run", fake(out))
        assert probe._curl_version("https://app.sprintable.ai/login") == want, out
    monkeypatch.setattr(probe.subprocess, "run", fake("2", returncode=7))
    assert probe._curl_version("https://app.sprintable.ai/login") == "?"
    for exc in (OSError("no curl"), sp.TimeoutExpired("curl", 30)):
        monkeypatch.setattr(probe.subprocess, "run", fake(raises=exc))
        assert probe._curl_version("https://app.sprintable.ai/login") == "?"


def test_cache_headers_summary_keeps_closed_words_and_known_directives_only():
    hdr = "\r\n".join([
        "HTTP/2 200", "content-type: text/javascript", f"x-secret: {SECRETS[3]}", "CF-Cache-Status: hit", "Age: 42",
        f"cache-control: public, max-age=31536000, immutable, foo={SECRETS[5]}, s-maxage=60",
    ])
    assert probe.cache_headers_summary(hdr) == "cf=HIT age=42 cc=public,max-age=31536000,immutable,s-maxage=60"
    assert probe.cache_headers_summary("cf-cache-status: SOMETHING\nage: -1\ncache-control: weird") == "cf=? age=? cc=?"
    assert probe.cache_headers_summary(f"cf-cache-status: HIT {SECRETS[3]}\nage: {'9' * 12}") == "cf=? age=? cc=?"
    assert probe.cache_headers_summary("") == "cf=? age=? cc=?" and probe.cache_headers_summary(None) == "cf=? age=? cc=?"
    _no_secret(probe.cache_headers_summary(hdr))


def test_first_chunk_path_picks_one_static_address_and_nothing_else():
    html = '<html><script src="/api/x.js"></script><link href="/_next/static/css/abc123.css"><script src="/_next/static/chunks/main-9f.js"></script>'
    assert probe.first_chunk_path(html) == "/_next/static/css/abc123.css"
    assert probe.first_chunk_path("<html>nothing</html>") is None and probe.first_chunk_path(None) is None


def test_edge_static_cache_asks_the_closed_pair_twice_and_never_prints_the_chunk():
    calls = []

    def fake(args):
        calls.append(args)
        if args[-1].endswith("/login"):
            return '<script src="/_next/static/chunks/app-SECRETCHUNK1234.js"></script>'
        hit = len([c for c in calls if "-D" in c]) % 2 == 0
        return f"HTTP/2 200\r\ncf-cache-status: {'HIT' if hit else 'MISS'}\r\nage: {7 if hit else 0}\r\ncache-control: public, max-age=31536000, immutable"
    out = probe.edge_static_cache(fake)
    assert out == [
        "  prod: 1회째 cf=MISS age=0 cc=public,max-age=31536000,immutable · 2회째 cf=HIT age=7 cc=public,max-age=31536000,immutable",
        "  dev: 1회째 cf=MISS age=0 cc=public,max-age=31536000,immutable · 2회째 cf=HIT age=7 cc=public,max-age=31536000,immutable",
    ]
    assert "SECRETCHUNK" not in "\n".join(out)
    hosts = {c[-1].split("/")[2] for c in calls}
    assert hosts == {"app.sprintable.ai", "dev-app.sprintable.ai"}                    # 닫힌 둘 — 밖의 주소는 안 부른다
    assert edge_none(lambda args: "") == ["  prod: 문서에서 정적 청크 주소를 못 찾았다", "  dev: 문서에서 정적 청크 주소를 못 찾았다"]


def edge_none(fetch):
    return probe.edge_static_cache(fetch)
