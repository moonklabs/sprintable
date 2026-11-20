#!/usr/bin/env python3
"""prod 로그인 실패 진단 probe — 읽기 전용, **허용 목록 출력만** (serving-reality-guard.yml 의 dispatch `probe=prod_auth_errors`).

2026-10-14: 선생님 prod 폰 앱 구글 로그인이 «로그인에 실패했어요»로 막혔다. 웹 콜백은 BE
`/api/v2/auth/oauth/callback` 의 오류 코드를 받아 `/login?error=<코드>` 로 보낸다 — 어느 코드인지는 prod 로그에만
있고 우리 자리에는 읽을 길이 없었다. 이 스크립트가 그 길이다(기존 WIF 인증으로 `gcloud logging read`).

세 갈래 (지난 N시간):
  ① 웹 서비스의 `auth.oauth.callback.state_check` 줄 — 시간별 (outcome · provider · native) 개수
  ② 웹 요청 `/login?error=` — error 값 · 개수 · 처음/마지막 시각
  ③ 백엔드 `/oauth/callback` · `/oauth-handoff/` 의 4xx/5xx — 경로(상수) · 메서드 · 상태 · 개수 · 시각,
     + 백엔드 로그에서 허용 낱말(OAUTH_* · INVALID_STATE · 구글 토큰 오류 낱말)만 뽑은 개수 · 시각
  ③c(2026-10-15 · story 4689) 백엔드 `/oauth-handoff/<동작>` 요청 **전부(상태 2xx 포함)** — 시간별 «동작 라벨 · 메서드 · 상태 · 개수». ③a 는 4xx·5xx 만 세서
     «시도 때 consume 이 불렸나(→ 결과는 앱에 왔고 교환이 거절/성공) · 안 불렸나(→ 결과가 앱에 안 옴)» 를 못 가른다 — 이 칸이 그 대답이다.
     (`issue` = 콜백이 앱 복귀용 코드를 낸 것 · `consume` = 앱이 마지막 POST 로 교환한 것) 동작 이름은 소스 목록 밖이면 «(other)».
  ④ 웹 요청 로그에서 앱 링크 길의 경로 셋 — `/native/oauth-return`(앱 링크가 앱 대신 브라우저로 열리면 여기에 찍힘) ·
     `/auth/oauth-handoff`(앱이 웹뷰로 마지막 POST) · `/.well-known/assetlinks.json`(안드로이드 앱 링크 검증) — 시간별
     «경로 라벨 · 메서드 · 상태 코드 · 브라우저 갈래(닫힌 목록 chrome / android-webview / other) · 개수». 경로는 정확히 일치하는
     셋만 세고(쿼리 · 경로 뒤 값 0), User-Agent 는 원문을 어디에도 찍지 않고 닫힌 목록 셋 중 하나로만 접는다.

⑤ (2026-10-15 · 선생님 «prod 모바일앱에서만 첫 로그인 뒤 홈 → 대화 탭이 10초 넘게») **시간 창 요청 타임라인** — `TIMELINE_START` · `TIMELINE_END`(UTC `YYYY-MM-DDTHH:MM:SSZ` ·
  최대 2시간) · `TIMELINE_ENV`(`prod` | `dev`) 가 주어지면 **이 칸만** 돈다(위 ①~④ 는 안 돈다): 그 창 안의 웹 · 백엔드 서비스 요청을 «시각(초) · 서비스 갈래 · 메서드 · 경로 라벨 ·
  상태 · 걸린 시간(ms) · 브라우저 갈래» 로 시간순 나열하고, 경로 라벨별 건수 · p50 · 최대, 그리고 Cloud Run «새 인스턴스 시작(콜드 스타트)» 줄(닫힌 이유 낱말)을 더한다. 경로 라벨은
  **닫힌 목록**(소스의 웹 라우트 파일 · 백엔드 route-shape 표에서 실행 때 만든 템플릿 + 고정 몇 개 — 밖은 «(other)»)이고 템플릿의 `{}` 자리는 요청 값이 아니라 «{}» 로만 찍힌다.
  사용자 · 쿠키 · 쿼리 · IP · UA 값 0(브라우저는 닫힌 셋 갈래만).

⛔**출력은 허용 목록만이다.** 로그 항목(이메일 · 사용자 id · IP · 쿠키 · 토큰 · UA · referer · 쿼리의 code/state/error 외 값)은
어디에도 찍지 않는다 — 집계 함수는 항목에서 «정해진 칸»만 꺼내 **닫힌 목록**에 있는 값만 그대로 세고, 목록 밖은 «(other)» 로 센다.
«글자 모양이 맞으면 통과»는 호출자(URL 친 쪽)가 고른 글자를 찍는 구멍이라(까디르 렌즈) 쓰지 않는다. 원문 한 줄도 출력하지 않는다.

닫힌 목록은 **손으로 적지 않고 소스에서 실행 때 만든다**(새 코드가 생겨도 따라오게) — 그리고 prod 는 main 코드로 도니 **develop(체크아웃)
∪ origin/main 두 판의 합집합**이다(main 에만 있는 코드가 «(other)» 로 묻히지 않게):
  · 웹 `apps/web/src/app/login/page.tsx` 의 `oauthErrors` 키 + 콜백 route 의 `login?error=<리터럴>` · `errCode ?? '<기본값>'`
  · 백엔드 `backend/app/routers/auth.py` 의 `_err("CODE"` · `OAuthExchangeError("CODE"` 첫 인자(대문자)
  · 핸드오프 동작 이름: `backend/app/routers/auth_firebase_internal.py` 의 `"/oauth-handoff/<동작>"` 오직 예외: gcloud 가 실패하면 그 오류 문구(권한 부족 등)를 그대로 찍는다
(이 자체가 결과 — PO 지시. 로그 항목이 아니라 gcloud 의 stderr 다).

앱 런타임을 import 하지 않는다(gcloud + 표준 라이브러리만) — check_serving_reality.py 와 같은 규율.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlsplit

_REGION = "asia-northeast3"
_MAX_ENTRIES = 5000
_GCLOUD_TIMEOUT_SECONDS = 90
_HOURS_MIN, _HOURS_MAX = 1, 72

# ── 허용 목록 ────────────────────────────────────────────────────────────────────────────────────────────────────────────
_OUTCOMES = frozenset({"missing_cookie", "state_mismatch", "ok"})
_PROVIDERS = frozenset({"google", "apple"})
_OTHER = "(other)"
_BACKEND_CODE = re.compile(r"\b([A-Z][A-Z0-9_]{2,60})\b")  # 후보 뽑기용 — 출력은 닫힌 목록(known_be_codes)에 있는 것만
_GOOGLE_ERRORS = (
    "invalid_grant", "invalid_client", "invalid_request", "redirect_uri_mismatch", "access_denied",
    "unauthorized_client", "invalid_scope", "unsupported_grant_type", "invalid_token",
)
_GOOGLE_ERROR_RE = re.compile(r"\b(" + "|".join(_GOOGLE_ERRORS) + r")\b")
_STATE_CHECK = re.compile(r"auth\.oauth\.callback\.state_check\s+outcome=(\w+)\s+provider=(\w+)\s+native=(\w+)")

# ── 닫힌 목록의 소스 (develop 체크아웃 ∪ origin/main) ──────────────────────────────────────────────────────────────────────
_SRC_WEB_LOGIN = "apps/web/src/app/login/page.tsx"
_SRC_WEB_CALLBACK = "apps/web/src/app/api/auth/callback/[provider]/route.ts"
_SRC_BE_AUTH = "backend/app/routers/auth.py"
_SRC_BE_HANDOFF = "backend/app/routers/auth_firebase_internal.py"
_SOURCES = (_SRC_WEB_LOGIN, _SRC_WEB_CALLBACK, _SRC_BE_AUTH, _SRC_BE_HANDOFF)
_OAUTH_ERRORS_BLOCK = re.compile(r"const\s+oauthErrors\s*:[^=]*=\s*\{(.*?)\n\s*\};", re.S)
_OAUTH_ERRORS_KEY = re.compile(r"^\s*([a-z][a-z0-9_]{1,60})\s*:", re.M)
_CALLBACK_LITERAL = re.compile(r"login\?error=([a-z][a-z0-9_]{1,60})(?![A-Za-z0-9_$\{])")
_CALLBACK_DEFAULT = re.compile(r"errCode\s*=[^;\n]*\?\?\s*'([a-z][a-z0-9_]{1,60})'")
_BE_CODE_SITE = re.compile(r"(?:\b_err|\bOAuthExchangeError)\(\s*\"([A-Z][A-Z0-9_]{1,60})\"")
_HANDOFF_ACTION = re.compile(r"\"/oauth-handoff/([a-z][a-z_]{1,30})\"")
_METHODS = frozenset({"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"})


def _hour(ts: str | None) -> str:
    """`2026-10-14T03:12:34.5Z` → `2026-10-14T03:00Z` (시 단위). 모양이 다르면 «?»."""
    if not ts or not re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}", ts):
        return "?"
    return ts[:13] + ":00Z"


def _stamp(ts: str | None) -> str:
    """처음/마지막 시각 — 초까지(`2026-10-14T03:12:34Z`). 모양이 다르면 «?»."""
    if not ts or not re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}", ts):
        return "?"
    return ts[:19] + "Z"


class _Span:
    """개수 + 처음/마지막 시각."""

    def __init__(self) -> None:
        self.n = 0
        self.first: str | None = None
        self.last: str | None = None

    def add(self, ts: str | None) -> None:
        self.n += 1
        s = _stamp(ts)
        if s == "?":
            return
        if self.first is None or s < self.first:
            self.first = s
        if self.last is None or s > self.last:
            self.last = s

    def text(self) -> str:
        return f"{self.n}건 (처음 {self.first or '?'} · 마지막 {self.last or '?'})"


def _text_of(entry: dict) -> str:
    """항목의 «본문 글» — textPayload 또는 jsonPayload.message. 다른 칸은 보지 않는다."""
    t = entry.get("textPayload")
    if isinstance(t, str):
        return t
    jp = entry.get("jsonPayload")
    if isinstance(jp, dict):
        m = jp.get("message")
        if isinstance(m, str):
            return m
    return ""


# ── ① 웹 state_check ──────────────────────────────────────────────────────────────────────────────────────────────────────
def agg_state_checks(entries: list[dict]) -> list[str]:
    counts: Counter[tuple[str, str, str, str]] = Counter()
    for e in entries:
        m = _STATE_CHECK.search(_text_of(e))
        if not m:
            continue
        outcome, provider, native = m.group(1), m.group(2), m.group(3)
        # 허용 집합 밖의 값은 값 그대로 찍지 않는다
        outcome = outcome if outcome in _OUTCOMES else "(other)"
        provider = provider if provider in _PROVIDERS else "(other)"
        native = native if native in ("true", "false") else "(other)"
        counts[(_hour(e.get("timestamp")), outcome, provider, native)] += 1
    return [
        f"  {hour}  outcome={o}  provider={p}  native={n}  {c}건"
        for (hour, o, p, n), c in sorted(counts.items())
    ]


# ── ② 웹 /login?error= ─────────────────────────────────────────────────────────────────────────────────────────────────────
def _error_param(request_url: str | None, known: frozenset[str]) -> str | None:
    """요청 URL 의 `error` 쿼리 값 하나만 — 다른 쿼리/호스트/경로는 버린다. 닫힌 목록 밖은 «(other)»."""
    if not isinstance(request_url, str):
        return None
    parts = urlsplit(request_url)
    if parts.path != "/login":
        return None
    vals = parse_qs(parts.query, keep_blank_values=True).get("error")
    if not vals:
        return None
    v = vals[0]
    return v if v in known else _OTHER


def agg_login_errors(entries: list[dict], known: frozenset[str]) -> list[str]:
    spans: dict[str, _Span] = defaultdict(_Span)
    for e in entries:
        hr = e.get("httpRequest")
        err = _error_param(hr.get("requestUrl") if isinstance(hr, dict) else None, known)
        if err is None:
            continue
        spans[err].add(e.get("timestamp"))
    return [f"  error={err}  {sp.text()}" for err, sp in sorted(spans.items(), key=lambda kv: (-kv[1].n, kv[0]))]


# ── ③ 백엔드 요청 + 허용 낱말 ──────────────────────────────────────────────────────────────────────────────────────────────
def _route_label(request_url: str | None, handoff_actions: frozenset[str]) -> str | None:
    """상수 라벨만 — `/oauth/callback` · `/oauth-handoff/<동작>`. 앞 접두(`/u/alice/…` 포함)는 통째로 버리고, 쿼리도 버린다.
    동작 이름이 소스 목록 밖이면 «/oauth-handoff/(other)». 두 경로 어느 쪽도 아니면 None(세지 않는다)."""
    if not isinstance(request_url, str):
        return None
    path = urlsplit(request_url).path
    if path.endswith("/oauth/callback"):
        return "/oauth/callback"
    head, sep, tail = path.rpartition("/oauth-handoff/")
    if sep:
        return f"/oauth-handoff/{tail}" if tail in handoff_actions else f"/oauth-handoff/{_OTHER}"
    return None


def agg_backend_requests(entries: list[dict], handoff_actions: frozenset[str]) -> list[str]:
    spans: dict[tuple[str, str, int], _Span] = defaultdict(_Span)
    for e in entries:
        hr = e.get("httpRequest")
        if not isinstance(hr, dict):
            continue
        label = _route_label(hr.get("requestUrl"), handoff_actions)
        status = hr.get("status")
        if label is None or not isinstance(status, int) or status < 400:
            continue
        method = hr.get("requestMethod")
        method = method if method in _METHODS else "?"
        spans[(label, method, status)].add(e.get("timestamp"))
    return [f"  {m} {label}  → {status}  {sp.text()}" for (label, m, status), sp in sorted(spans.items())]


def agg_backend_handoff_all(entries: list[dict], handoff_actions: frozenset[str]) -> list[str]:
    """story 4689 ③c — `/oauth-handoff/<동작>` 요청을 **상태 전부(2xx 포함)** 시간별로 센다. 라벨은 `_route_label` 의 상수(동작 이름이 소스 목록 밖이면
    «(other)») · 메서드는 닫힌 집합 · 상태는 100~599 정수만(아니면 «?»). 쿼리 · 호스트 · 접두는 버린다. `/oauth/callback` 은 세지 않는다(③a)."""
    counts: Counter[tuple[str, str, str, str]] = Counter()
    for e in entries:
        hr = e.get("httpRequest")
        if not isinstance(hr, dict):
            continue
        label = _route_label(hr.get("requestUrl"), handoff_actions)
        if label is None or not label.startswith("/oauth-handoff/"):
            continue
        method = hr.get("requestMethod")
        method = method if method in _METHODS else "?"
        status = hr.get("status")
        status_text = str(status) if isinstance(status, int) and 100 <= status <= 599 else "?"
        counts[(_hour(e.get("timestamp")), label, method, status_text)] += 1
    return [f"  {hour}  {method} {label}  → {status}  {n}건" for (hour, label, method, status), n in sorted(counts.items())]


def agg_backend_words(entries: list[dict], known_be_codes: frozenset[str]) -> list[str]:
    """백엔드 로그 항목 전체를 훑되 **닫힌 목록에 있는 낱말만** 센다. `OAUTH_*` 꼴인데 목록 밖이면 «OAUTH_(other)» 로 접는다 —
    항목의 나머지는 한 글자도 안 나간다."""
    spans: dict[str, _Span] = defaultdict(_Span)
    for e in entries:
        blob = json.dumps(e, ensure_ascii=False)
        seen: set[str] = set(_GOOGLE_ERROR_RE.findall(blob))
        for w in set(_BACKEND_CODE.findall(blob)):
            if w in known_be_codes:
                seen.add(w)
            elif w.startswith("OAUTH_"):
                seen.add(f"OAUTH_{_OTHER}")
        for w in seen:
            spans[w].add(e.get("timestamp"))
    return [f"  {w}  {sp.text()}" for w, sp in sorted(spans.items(), key=lambda kv: (-kv[1].n, kv[0]))]


# ── ④ 웹 앱 링크 길 ────────────────────────────────────────────────────────────────────────────────────────────────────────
_APP_LINK_PATHS = ("/native/oauth-return", "/auth/oauth-handoff", "/.well-known/assetlinks.json")
_BROWSERS = ("chrome", "android-webview", "other")
_OTHER_BRAND_TOKENS = ("Edg/", "EdgA/", "OPR/", "SamsungBrowser/", "Firefox/", "FxiOS/", "CriOS/", "DuckDuckGo/", "YaBrowser/")


def classify_browser(user_agent: object) -> str:
    """User-Agent → 닫힌 목록 셋(chrome / android-webview / other). 원문은 어디에도 내보내지 않는다.
    안드로이드 WebView 는 `; wv)` 표지를 단다. Chrome(Custom Tab 포함)은 `Chrome/` 이 있고 WebView 표지와 다른 브랜드 표지가 없다."""
    if not isinstance(user_agent, str):
        return "other"
    if "Android" in user_agent and "; wv)" in user_agent:
        return "android-webview"
    if "Chrome/" in user_agent and not any(tok in user_agent for tok in _OTHER_BRAND_TOKENS):
        return "chrome"
    return "other"


def _app_link_label(request_url: object) -> str | None:
    """요청 URL 의 «경로»가 세 상수 중 하나와 정확히 같을 때만 그 상수를 돌려준다(쿼리 · 호스트는 버림). 아니면 None(세지 않는다)."""
    if not isinstance(request_url, str):
        return None
    path = urlsplit(request_url).path
    return path if path in _APP_LINK_PATHS else None


def agg_app_link_paths(entries: list[dict]) -> list[str]:
    counts: Counter[tuple[str, str, str, str, str]] = Counter()
    for e in entries:
        hr = e.get("httpRequest")
        if not isinstance(hr, dict):
            continue
        label = _app_link_label(hr.get("requestUrl"))
        if label is None:
            continue
        method = hr.get("requestMethod")
        method = method if method in _METHODS else "?"
        status = hr.get("status")
        status_text = str(status) if isinstance(status, int) and 100 <= status <= 599 else "?"
        counts[(_hour(e.get("timestamp")), label, method, status_text, classify_browser(hr.get("userAgent")))] += 1
    return [
        f"  {hour}  {label}  {method}  {status}  browser={browser}  {n}건"
        for (hour, label, method, status, browser), n in sorted(counts.items())
    ]


# ── 닫힌 목록 만들기 (순수 추출 + 읽기) ─────────────────────────────────────────────────────────────────────────────────────
class Known:
    """소스에서 뽑은 닫힌 목록 셋 + 어느 판을 읽었는지(출력 첫머리에 찍는다)."""

    def __init__(self) -> None:
        self.web_errors: set[str] = set()
        self.be_codes: set[str] = set()
        self.handoff_actions: set[str] = set()
        self.versions: list[str] = []
        self.notes: list[str] = []

    def freeze(self) -> tuple[frozenset[str], frozenset[str], frozenset[str]]:
        # `/login?error=` 에는 웹 리터럴과 BE 코드가 그대로 실려 온다 → 합집합
        return frozenset(self.web_errors | self.be_codes), frozenset(self.be_codes), frozenset(self.handoff_actions)


def extract_web_errors(login_page_text: str, callback_text: str) -> set[str]:
    out: set[str] = set()
    m = _OAUTH_ERRORS_BLOCK.search(login_page_text)
    if m:
        out |= set(_OAUTH_ERRORS_KEY.findall(m.group(1)))
    out |= set(_CALLBACK_LITERAL.findall(callback_text))
    out |= set(_CALLBACK_DEFAULT.findall(callback_text))
    return out


def extract_be_codes(auth_py_text: str) -> set[str]:
    return set(_BE_CODE_SITE.findall(auth_py_text))


def extract_handoff_actions(handoff_py_text: str) -> set[str]:
    return set(_HANDOFF_ACTION.findall(handoff_py_text))


def _repo_root() -> str:
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _read_versions(path: str) -> list[tuple[str, str]]:
    """(판 이름, 본문) — develop 체크아웃(디스크) + origin/main(git show). 못 읽은 판은 빠진다."""
    root = _repo_root()
    out: list[tuple[str, str]] = []
    try:
        with open(os.path.join(root, path), encoding="utf-8") as fh:
            out.append(("checkout", fh.read()))
    except OSError:
        pass
    proc = subprocess.run(["git", "show", f"origin/main:{path}"], capture_output=True, text=True, cwd=root, timeout=30)
    if proc.returncode == 0:
        out.append(("origin/main", proc.stdout))
    return out


def build_known(read_versions=_read_versions) -> Known:
    k = Known()
    seen_versions: set[str] = set()
    pages = {p: dict(read_versions(p)) for p in _SOURCES}
    for ver in ("checkout", "origin/main"):
        got = {p: pages[p].get(ver) for p in _SOURCES}
        if all(v is None for v in got.values()):
            k.notes.append(f"{ver}: 소스 파일을 못 읽었다 — 이 판은 목록에 없다")
            continue
        seen_versions.add(ver)
        k.web_errors |= extract_web_errors(got[_SRC_WEB_LOGIN] or "", got[_SRC_WEB_CALLBACK] or "")
        k.be_codes |= extract_be_codes(got[_SRC_BE_AUTH] or "")
        k.handoff_actions |= extract_handoff_actions(got[_SRC_BE_HANDOFF] or "")
        for p, v in got.items():
            if v is None:
                k.notes.append(f"{ver}: {p} 못 읽음")
    k.versions = sorted(seen_versions)
    return k


# ── gcloud ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
class _GcloudError(Exception):
    pass


def _run(cmd: list[str]) -> str:
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=_GCLOUD_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired as exc:
        raise _GcloudError(f"gcloud 가 {_GCLOUD_TIMEOUT_SECONDS}초 안에 끝나지 않았다 ({exc.cmd[2] if len(exc.cmd) > 2 else 'logging'})") from None
    if proc.returncode != 0:
        # PO: 권한이 없으면 그 오류 문구 그대로가 결과다 — gcloud 의 stderr(로그 항목이 아님). 너무 길면 자른다.
        raise _GcloudError((proc.stderr or proc.stdout or "gcloud 실패(출력 없음)").strip()[:800])
    return proc.stdout


def _project_args() -> list[str]:
    project = os.environ.get("GCP_PROJECT_ID", "").strip()
    return [f"--project={project}"] if project else []


def _env_services(env: str) -> tuple[list[str], list[str]]:
    out = _run(["gcloud", "run", "services", "list", f"--region={_REGION}", "--format=value(metadata.name)", *_project_args()])
    names = [n.strip() for n in out.splitlines() if n.strip()]
    chosen = [n for n in names if env in n]
    web = [n for n in chosen if "frontend" in n or n.endswith(f"-web-{env}") or "-web-" in n]
    backend = [n for n in chosen if "backend" in n]
    return web, backend


def _prod_services() -> tuple[list[str], list[str]]:
    return _env_services("prod")


def _read(flt: str, order: str = "desc") -> list[dict]:
    out = _run([
        "gcloud", "logging", "read", flt, f"--limit={_MAX_ENTRIES}", f"--order={order}", "--format=json", *_project_args(),
    ])
    data = json.loads(out) if out.strip() else []
    return data if isinstance(data, list) else []


def _service_filter(services: list[str]) -> str:
    return "(" + " OR ".join(f'resource.labels.service_name="{s}"' for s in services) + ")"


def _section(title: str, fn) -> list[str]:
    """한 갈래가 실패해도 다른 갈래는 돈다 — 실패 문구가 그 갈래의 결과."""
    lines = [f"## {title}"]
    try:
        body, fetched = fn()
        lines.append(f"  (읽은 항목 {fetched}개{' — 한도에 닿음, 더 있을 수 있다' if fetched >= _MAX_ENTRIES else ''})")
        lines.extend(body if body else ["  (해당 항목 없음)"])
    except _GcloudError as exc:
        lines.append(f"  ✗ 못 읽었다 — gcloud 오류 문구 그대로:\n  {exc}")
    return lines


# ── ⑤ 시간 창 요청 타임라인 ────────────────────────────────────────────────────────────────────────────────────────────────
_TL_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
_TL_MAX_SECONDS = 2 * 3600
_TL_ENVS = ("prod", "dev")
_TL_MAX_LINES = 600
_TL_FIXED_PATHS = frozenset({"/_next/image", "/api/health", "/api/v2/health", "/favicon.ico"})
_TL_STATIC_PREFIX = "/_next/static/"
_TL_STATIC_LABEL = "/_next/static/*"
_COLD_START_REASONS = frozenset({"AUTOSCALING", "MIN_INSTANCES", "MIN_INSTANCE", "MANUAL_SCALING", "DEPLOYMENT", "SCALE_TO_ZERO"})
_COLD_START_RE = re.compile(r"Starting new instance\.?(?:\s*Reason:\s*([A-Z_]+))?")
_LATENCY_RE = re.compile(r"^(\d+(?:\.\d+)?)s$")
_WEB_ROOT = "apps/web/src/app/"
_SHAPES_PATH = "scripts/web_api_route_shapes.json"
_WEB_ROUTE_FILES = frozenset({"page.tsx", "page.ts", "route.ts", "route.tsx"})


def parse_timeline_window(start: str | None, end: str | None, env: str | None) -> tuple[str, str, str]:
    """입력 셋을 검사한다 — 모양이 틀리면 SystemExit(밖의 값은 어디에도 안 쓰인다). 창은 최대 2시간, 끝이 시작보다 뒤."""
    s, e, v = (start or "").strip(), (end or "").strip(), (env or "prod").strip()
    if not (_TL_ISO.match(s) and _TL_ISO.match(e)):
        raise SystemExit("TIMELINE_START · TIMELINE_END 는 UTC `YYYY-MM-DDTHH:MM:SSZ` 이어야 한다")
    if v not in _TL_ENVS:
        raise SystemExit(f"TIMELINE_ENV 는 {' | '.join(_TL_ENVS)} 중 하나여야 한다")
    t0 = datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ")
    t1 = datetime.strptime(e, "%Y-%m-%dT%H:%M:%SZ")
    if t1 <= t0:
        raise SystemExit("TIMELINE_END 는 TIMELINE_START 보다 뒤여야 한다")
    if (t1 - t0).total_seconds() > _TL_MAX_SECONDS:
        raise SystemExit("시간 창은 최대 2시간이다")
    return s, e, v


def web_route_template(file_path: str) -> tuple[str, ...] | None:
    """웹 라우트 파일(`apps/web/src/app/…/page.tsx` · `route.ts`) → 경로 템플릿(그룹 `(x)` 는 뺀다 · `[x]` 는 «{}» · 가려진 라우트는 None)."""
    if not file_path.startswith(_WEB_ROOT):
        return None
    parts = file_path[len(_WEB_ROOT):].split("/")
    if parts[-1] not in _WEB_ROUTE_FILES:
        return None
    segs: list[str] = []
    for seg in parts[:-1]:
        if seg.startswith("(") and seg.endswith(")"):
            continue
        if seg.startswith(("@", "_", "[...", "[[")):
            return None
        segs.append("{}" if seg.startswith("[") and seg.endswith("]") else seg)
    return tuple(segs)


def shape_route_template(path: object) -> tuple[str, ...] | None:
    """백엔드 route-shape 표의 `path`(이미 «{}» 로 접힌 템플릿) → 템플릿."""
    if not isinstance(path, str) or not path.startswith("/"):
        return None
    return tuple(seg for seg in path.split("/") if seg)


def _git_files(rev: str) -> list[str]:
    proc = subprocess.run(["git", "ls-tree", "-r", "--name-only", rev, "--", _WEB_ROOT], capture_output=True, text=True, cwd=_repo_root(), timeout=60)
    if proc.returncode != 0:
        raise RuntimeError("git ls-tree failed")
    return [ln for ln in proc.stdout.splitlines() if ln]


def _git_shapes(rev: str) -> str:
    proc = subprocess.run(["git", "show", f"{rev}:{_SHAPES_PATH}"], capture_output=True, text=True, cwd=_repo_root(), timeout=60)
    if proc.returncode != 0:
        raise RuntimeError("git show failed")
    return proc.stdout


def build_route_templates(read_files=_git_files, read_shapes=_git_shapes) -> tuple[frozenset[tuple[str, ...]], list[str]]:
    """닫힌 경로 템플릿 — 웹 라우트 파일 목록 + 백엔드 route-shape 표. develop(체크아웃 HEAD) ∪ origin/main(prod 는 main 코드). 못 읽은 판은 메모로 남는다."""
    notes: list[str] = []
    templates: set[tuple[str, ...]] = set()
    for rev in ("HEAD", "origin/main"):
        try:
            for f in read_files(rev):
                t = web_route_template(f)
                if t is not None:
                    templates.add(t)
        except Exception as exc:  # noqa: BLE001 — 한 판을 못 읽어도 다른 판은 쓴다
            notes.append(f"{rev}: 웹 라우트 파일 목록을 못 읽었다 ({type(exc).__name__})")
        try:
            for row in json.loads(read_shapes(rev) or "[]"):
                t = shape_route_template(row.get("path") if isinstance(row, dict) else None)
                if t is not None:
                    templates.add(t)
        except Exception as exc:  # noqa: BLE001
            notes.append(f"{rev}: route-shape 표를 못 읽었다 ({type(exc).__name__})")
    return frozenset(templates), notes


def route_label(request_url: object, templates: frozenset[tuple[str, ...]]) -> str:
    """요청 URL 의 «경로»만 본다(쿼리 · 호스트는 버린다) → 닫힌 템플릿 하나(가장 구체적인 것) · 고정 라벨 · «(other)». 요청의 글자는 라벨에 안 실린다."""
    if not isinstance(request_url, str):
        return _OTHER
    path = urlsplit(request_url).path
    if path.startswith(_TL_STATIC_PREFIX):
        return _TL_STATIC_LABEL
    if path in _TL_FIXED_PATHS:
        return path
    segs = tuple(seg for seg in path.split("/") if seg)
    best: tuple[int, tuple[str, ...]] | None = None
    for t in templates:
        if len(t) != len(segs) or not all(a == "{}" or a == b for a, b in zip(t, segs)):
            continue
        score = sum(1 for a in t if a != "{}")
        if best is None or score > best[0] or (score == best[0] and t < best[1]):
            best = (score, t)
    return "/" + "/".join(best[1]) if best else _OTHER


_STATIC_KINDS = frozenset({"chunks", "css", "media"})


def static_label(request_url: object) -> str:
    """`/_next/static/…` 요청 → 닫힌 낱말 라벨(`chunks` · `css` · `media` · `(other)`). 빌드 해시 · 파일 이름은 라벨에 안 실린다(청크 «개수 · ms · 크기»만 본다)."""
    if not isinstance(request_url, str):
        return _OTHER
    path = urlsplit(request_url).path
    if not path.startswith(_TL_STATIC_PREFIX):
        return _OTHER
    kind = path[len(_TL_STATIC_PREFIX):].split("/", 1)[0]
    return f"{_TL_STATIC_PREFIX}{kind}/*" if kind in _STATIC_KINDS else f"{_TL_STATIC_PREFIX}(other)/*"


def _query_flag(request_url: object, key: str) -> str:
    """쿼리에 `key` 가 있나 — «1»/«0»/«?» 셋뿐(값은 안 읽는다). 라우터의 RSC 요청(`_rsc`)인지 · `?p=`(프로젝트 표지)가 실렸는지를 가른다."""
    if not isinstance(request_url, str):
        return "?"
    try:
        return "1" if key in parse_qs(urlsplit(request_url).query, keep_blank_values=True) else "0"
    except ValueError:
        return "?"


def _from_label(referer: object, templates: frozenset[tuple[str, ...]]) -> str:
    """referer → 닫힌 경로 라벨(없으면 «-»). 어디서 온 요청인지(홈 → 대화 탭 같은 이동)만 본다."""
    return "-" if not isinstance(referer, str) or not referer else route_label(referer, templates)


_PROTOCOLS = {"HTTP/1.0": "h1.0", "HTTP/1.1": "h1.1", "HTTP/2": "h2", "HTTP/2.0": "h2", "HTTP/3": "h3", "HTTP/3.0": "h3"}


def _proto(value: object) -> str:
    """요청 프로토콜 — 닫힌 낱말만(밖은 «?»). 한 연결 6개 한도(h1.1)와 다중화(h2)를 가르는 칸."""
    return _PROTOCOLS.get(value, "?") if isinstance(value, str) else "?"


def _size_bytes(value: object) -> int | None:
    """응답 크기(바이트) — Cloud Run 은 문자열 숫자로 준다. 숫자 아닌 것 · 음수 · 과대 → None."""
    text = str(value) if isinstance(value, (int, str)) else ""   # bool → «True»/«False» 는 숫자가 아니라 걸러진다
    return int(text) if text.isdigit() and len(text) <= 12 else None


def _latency_ms(value: object) -> int | None:
    m = _LATENCY_RE.match(value) if isinstance(value, str) else None
    return round(float(m.group(1)) * 1000) if m else None


def _kind(entry: dict, web: frozenset[str], backend: frozenset[str]) -> str:
    resource = entry.get("resource")
    labels = resource.get("labels") if isinstance(resource, dict) else None
    name = labels.get("service_name") if isinstance(labels, dict) else None
    return "web" if name in web else "backend" if name in backend else "other"


def _timeline_rows(entries: list[dict], labeler, templates: frozenset[tuple[str, ...]], web: frozenset[str], backend: frozenset[str]) -> list[tuple]:
    rows: list[tuple] = []
    for e in entries:
        hr = e.get("httpRequest")
        if not isinstance(hr, dict):
            continue
        method = hr.get("requestMethod")
        method = method if method in _METHODS else "?"
        status = hr.get("status")
        status_text = str(status) if isinstance(status, int) and 100 <= status <= 599 else "?"
        url = hr.get("requestUrl")
        rows.append((_stamp(e.get("timestamp")), _kind(e, web, backend), method, labeler(url), status_text,
                     _latency_ms(hr.get("latency")), classify_browser(hr.get("userAgent")), _size_bytes(hr.get("responseSize")), _proto(hr.get("protocol")),
                     _query_flag(url, "_rsc"), _query_flag(url, "p"), _from_label(hr.get("referer"), templates)))
    rows.sort(key=lambda r: r[0])
    return rows


def _timeline_output(rows: list[tuple]) -> tuple[list[str], list[str], bool]:
    lines = [
        f"  {t}  {kind}  {method} {label}  {status}  {'?' if ms is None else ms}ms  {'?' if size is None else size}B  proto={proto}  browser={browser}  rsc={rsc}  p={pq}  from={frm}"
        for t, kind, method, label, status, ms, browser, size, proto, rsc, pq, frm in rows[:_TL_MAX_LINES]
    ]
    groups: dict[tuple[str, str, str], list[int]] = defaultdict(list)
    counts: Counter[tuple[str, str, str]] = Counter()
    sizes: Counter[tuple[str, str, str]] = Counter()
    for _t, kind, method, label, _st, ms, _b, size, _p, _r, _q, _f in rows:
        counts[(kind, method, label)] += 1
        if size is not None:
            sizes[(kind, method, label)] += size
        if ms is not None:
            groups[(kind, method, label)].append(ms)
    stats: list[str] = []
    for key, n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0])):
        ms_list = sorted(groups.get(key, []))
        p50 = f"{ms_list[(len(ms_list) - 1) // 2]}ms" if ms_list else "?"
        mx = f"{ms_list[-1]}ms" if ms_list else "?"
        stats.append(f"  {key[0]}  {key[1]} {key[2]}  {n}건 · p50 {p50} · 최대 {mx} · 크기 합계 {sizes.get(key, 0)}B")
    return lines, stats, len(rows) > _TL_MAX_LINES


def agg_timeline(entries: list[dict], templates: frozenset[tuple[str, ...]], web: frozenset[str], backend: frozenset[str]) -> tuple[list[str], list[str], bool]:
    """(시간순 줄 · 경로 라벨별 통계 줄 · 줄 한도에 닿았나). 줄 = 시각(초) · 갈래 · 메서드 · 라벨 · 상태 · ms · 응답 크기(B) · 프로토콜 · 브라우저 갈래 · 쿼리에 `_rsc`·`p` 가 있나(1/0) · 어디서 온 요청인가(referer → 닫힌 라벨).
    이 밖의 칸은 안 읽는다 — 쿼리의 값 · referer 의 글자는 어디에도 안 실린다."""
    return _timeline_output(_timeline_rows(entries, lambda url: route_label(url, templates), templates, web, backend))


def agg_static(entries: list[dict], web: frozenset[str], backend: frozenset[str]) -> tuple[list[str], list[str], bool]:
    """`/_next/static/` 요청(JS · CSS · 글꼴 청크) — 닫힌 낱말 라벨(`chunks` · `css` · `media`)로 접어 시간순 · 건수 · p50 · 최대 · 크기 합계. 청크 이름 · 해시는 안 실린다.
    Cloudflare 가 캐시로 답한 요청은 오리진에 안 와 여기 없다 — 보이는 것은 오리진까지 온(MISS) 것뿐이다."""
    return _timeline_output(_timeline_rows(entries, static_label, frozenset(), web, backend))


def agg_cold_starts(entries: list[dict], web: frozenset[str], backend: frozenset[str]) -> list[str]:
    """Cloud Run 시스템 로그의 «Starting new instance» 줄 — 시각(초) · 서비스 갈래 · 닫힌 이유 낱말만(원문 줄은 안 찍는다)."""
    out: list[tuple[str, str, str]] = []
    for e in entries:
        m = _COLD_START_RE.search(_text_of(e))
        if not m:
            continue
        reason = m.group(1)
        out.append((_stamp(e.get("timestamp")), _kind(e, web, backend), reason if reason in _COLD_START_REASONS else (_OTHER if reason else "?")))
    out.sort()
    return [f"  {t}  {kind}  reason={reason}" for t, kind, reason in out]


_EDGE_PROBES = (("prod", "https://app.sprintable.ai/login"), ("dev", "https://dev-app.sprintable.ai/login"))
_EDGE_VERSIONS = {"1.0": "h1.0", "1.1": "h1.1", "2": "h2", "3": "h3"}


def _curl_version(url: str) -> str:
    """이 러너에서 가장자리(Cloudflare)까지 `curl` 이 협상한 HTTP 판 — 닫힌 낱말만(밖 · 실패는 «?»). 폰이 협상한 판은 아니다(같은 가장자리의 같은 영역일 때만 같은 말)."""
    try:
        proc = subprocess.run(["curl", "-s", "-o", "/dev/null", "--max-time", "20", "-w", "%{http_version}", url], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return "?"
    return _EDGE_VERSIONS.get(proc.stdout.strip(), "?") if proc.returncode == 0 else "?"


def edge_versions(curl=None) -> str:
    fetch = curl or _curl_version     # 부를 때 풀어 쓴다 — 시험이 `_curl_version` 을 갈아끼울 수 있게(밖으로 나가는 시험 0)
    return " · ".join(f"{name}={fetch(url)}" for name, url in _EDGE_PROBES)


_CF_STATUSES = frozenset({"HIT", "MISS", "EXPIRED", "BYPASS", "DYNAMIC", "STALE", "REVALIDATED", "UPDATING"})
_CC_PLAIN = frozenset({"public", "private", "no-store", "no-cache", "immutable", "must-revalidate"})
_CC_NUMBERED = re.compile(r"^(max-age|s-maxage)=(\d{1,10})$")
_CHUNK_URL = re.compile(r'(?:src|href)="(/_next/static/[^"\s<>]{1,300}\.(?:js|css))"')


def _curl_text(args: list[str]) -> str:
    """이 러너의 `curl` 로 읽은 글(실패 · 시간 초과 → 빈 글). 밖으로 나가는 곳은 호출부의 닫힌 주소 둘뿐이다."""
    try:
        proc = subprocess.run(["curl", "-s", "--max-time", "20", *args], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return ""
    return proc.stdout if proc.returncode == 0 else ""


def first_chunk_path(html: str) -> str | None:
    """문서에서 `/_next/static/…(.js|.css)` 주소 하나(경로) — 출력에는 안 싣는다(어느 청크인지가 아니라 «캐시 머리글»만 본다)."""
    m = _CHUNK_URL.search(html or "")
    return m.group(1) if m else None


def cache_headers_summary(header_text: str) -> str:
    """응답 머리글 글 → `cf=<닫힌 낱말|?> age=<숫자|?> cc=<알려진 지시어만|?>`. 다른 머리글 · 값은 안 읽는다."""
    cf, age, cc = "?", "?", "?"
    for line in (header_text or "").splitlines():
        name, _, value = line.partition(":")
        name, value = name.strip().lower(), value.strip()
        if name == "cf-cache-status" and value.upper() in _CF_STATUSES:
            cf = value.upper()
        elif name == "age" and value.isdigit() and len(value) <= 10:
            age = value
        elif name == "cache-control":
            kept = [d for d in (t.strip().lower() for t in value.split(",")) if d in _CC_PLAIN or _CC_NUMBERED.match(d)]
            cc = ",".join(kept) if kept else "?"
    return f"cf={cf} age={age} cc={cc}"


def edge_static_cache(curl_text=None) -> list[str]:
    """prod · dev 의 `/login` 문서에서 정적 청크 주소 하나를 골라 두 번 받아(본문은 버린다) Cloudflare 캐시 머리글만 비교한다 — 두 도메인의 정적 캐시가 같은지."""
    fetch = curl_text or _curl_text
    out: list[str] = []
    for name, login in _EDGE_PROBES:
        origin = login.rsplit("/", 1)[0]
        path = first_chunk_path(fetch([login]))
        if path is None:
            out.append(f"  {name}: 문서에서 정적 청크 주소를 못 찾았다")
            continue
        url = origin + path
        first = cache_headers_summary(fetch(["-D", "-", "-o", "/dev/null", url]))
        second = cache_headers_summary(fetch(["-D", "-", "-o", "/dev/null", url]))
        out.append(f"  {name}: 1회째 {first} · 2회째 {second}")
    return out


def run_timeline(start: str, end: str, env: str) -> int:
    try:
        web, backend = _env_services(env)
    except _GcloudError as exc:
        print(f"✗ Cloud Run 서비스 목록을 못 읽었다 — gcloud 오류 문구 그대로:\n{exc}")
        return 1
    print(f"# 요청 타임라인 — env={env} · 창 {start} ~ {end} (UTC) · 허용 목록 출력만(정적 청크는 ⑤c 에 이름 없이 건수 · ms · 크기만)")
    print(f"웹 서비스: {', '.join(web) or '(없음)'} · 백엔드 서비스: {', '.join(backend) or '(없음)'}")
    if not web and not backend:
        print(f"✗ 이름에 {env} 가 든 웹/백엔드 서비스를 못 찾았다")
        return 1
    print(f"가장자리 HTTP 판(이 러너 → Cloudflare · `curl` · 폰이 협상한 판 아님): {edge_versions()}")
    print("정적 청크 캐시(Cloudflare · 같은 청크를 두 번 받아 머리글만 · 청크 이름은 안 찍는다):")
    for line in edge_static_cache():
        print(line)
    templates, notes = build_route_templates()
    print(f"닫힌 경로 템플릿(소스에서 실행 때 만듦): {len(templates)}개")
    for note in notes:
        print(f"  ⚠ {note}")
    if not templates:
        print("  ⚠ 템플릿이 비었다 — 모든 경로가 (other) 로 나온다(소스 경로가 바뀌었는지 확인)")
    webs, backs = frozenset(web), frozenset(backend)
    window = f'timestamp>="{start}" AND timestamp<="{end}"'
    out: list[str] = []

    def requests():
        flt = f'{_service_filter(web + backend)} AND logName:"run.googleapis.com%2Frequests" AND NOT httpRequest.requestUrl:"{_TL_STATIC_PREFIX}" AND {window}'
        es = _read(flt, order="asc")
        lines, stats, cut = agg_timeline(es, templates, webs, backs)
        body = lines + ([f"  … 줄 한도({_TL_MAX_LINES})에 닿아 뒤는 생략 — 아래 통계는 읽은 전부"] if cut else [])
        shown = (body + ["  ── 경로 라벨별 (건수 · p50 · 최대) ──"] + stats) if lines else []
        return shown, len(es)
    out += _section("⑤a 요청 시간순 (시각 · 서비스 · 메서드 라벨 · 상태 · 걸린 시간 · 브라우저 갈래)", requests)

    def cold():
        flt = f'{_service_filter(web + backend)} AND logName:"run.googleapis.com%2Fvarlog%2Fsystem" AND "Starting new instance" AND {window}'
        es = _read(flt, order="asc")
        return agg_cold_starts(es, webs, backs), len(es)
    out += _section("⑤b Cloud Run 새 인스턴스 시작(콜드 스타트)", cold)

    def static():
        flt = f'{_service_filter(web)} AND logName:"run.googleapis.com%2Frequests" AND httpRequest.requestUrl:"{_TL_STATIC_PREFIX}" AND {window}'
        es = _read(flt, order="asc")
        lines, stats, cut = agg_static(es, webs, backs)
        body = lines + ([f"  … 줄 한도({_TL_MAX_LINES})에 닿아 뒤는 생략 — 아래 통계는 읽은 전부"] if cut else [])
        return ((body + ["  ── 라벨별 (건수 · p50 · 최대 · 크기 합계) ──"] + stats) if lines else []), len(es)
    out += _section("⑤c 정적 청크(/_next/static · 오리진까지 온 것만 — Cloudflare 캐시 적중분은 여기 없다)", static)
    print("\n".join(out))
    return 0



def parse_hours(raw: str | None) -> int:
    try:
        hours = int((raw or "12").strip())
    except ValueError:
        raise SystemExit(f"hours 는 정수여야 한다 ({_HOURS_MIN}~{_HOURS_MAX})") from None
    if not _HOURS_MIN <= hours <= _HOURS_MAX:
        raise SystemExit(f"hours 는 {_HOURS_MIN}~{_HOURS_MAX} 이어야 한다")
    return hours


def main() -> int:
    tl_start, tl_end = os.environ.get("TIMELINE_START", "").strip(), os.environ.get("TIMELINE_END", "").strip()
    if tl_start or tl_end:  # ⑤ — 시간 창이 주어지면 이 칸만 돈다
        return run_timeline(*parse_timeline_window(tl_start, tl_end, os.environ.get("TIMELINE_ENV")))
    hours = parse_hours(os.environ.get("HOURS"))
    since = (datetime.now(timezone.utc) - timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"# prod 로그인 실패 진단 — 지난 {hours}시간 (since {since}) · 허용 목록 출력만")
    try:
        web, backend = _prod_services()
    except _GcloudError as exc:
        print(f"✗ Cloud Run 서비스 목록을 못 읽었다 — gcloud 오류 문구 그대로:\n{exc}")
        return 1
    print(f"웹 서비스: {', '.join(web) or '(없음)'} · 백엔드 서비스: {', '.join(backend) or '(없음)'}")
    known = build_known()
    known_errors, known_be_codes, handoff_actions = known.freeze()
    print(
        f"닫힌 목록(소스에서 실행 때 만듦): 읽은 판 {' + '.join(known.versions) or '(없음)'} · "
        f"/login?error 값 {len(known_errors)}개 · BE 코드 {len(known_be_codes)}개 · 핸드오프 동작 {len(handoff_actions)}개"
    )
    for note in known.notes:
        print(f"  ⚠ {note}")
    if not known_errors:
        print("  ⚠ 목록이 비었다 — 모든 값이 (other) 로 나온다(소스 경로가 바뀌었는지 확인)")
    if not web and not backend:
        print("✗ 이름에 prod 가 든 웹/백엔드 서비스를 못 찾았다 — 위 목록 규칙(frontend/web/backend + prod)을 확인할 것")
        return 1

    req_log = 'logName:"run.googleapis.com%2Frequests"'
    t = f'timestamp>="{since}"'
    out: list[str] = []

    if web:
        def one():
            es = _read(f'{_service_filter(web)} AND "auth.oauth.callback.state_check" AND {t}')
            return agg_state_checks(es), len(es)
        out += _section("① 웹 auth.oauth.callback.state_check (시간별 outcome · provider · native)", one)

        def two():
            es = _read(f'{_service_filter(web)} AND {req_log} AND httpRequest.requestUrl:"/login?error=" AND {t}')
            return agg_login_errors(es, known_errors), len(es)
        out += _section("② 웹 요청 /login?error= (error 값)", two)

        def four():
            paths = " OR ".join(f'httpRequest.requestUrl:"{p}"' for p in _APP_LINK_PATHS)
            es = _read(f'{_service_filter(web)} AND {req_log} AND ({paths}) AND {t}')
            return agg_app_link_paths(es), len(es)
        out += _section("④ 웹 앱 링크 길 (경로 라벨 · 메서드 · 상태 · 브라우저 갈래, 시간별)", four)

    if backend:
        def three():
            es = _read(
                f'{_service_filter(backend)} AND {req_log} AND httpRequest.status>=400 '
                f'AND (httpRequest.requestUrl:"/oauth/callback" OR httpRequest.requestUrl:"/oauth-handoff/") AND {t}'
            )
            return agg_backend_requests(es, handoff_actions), len(es)
        out += _section("③a 백엔드 /oauth/callback · /oauth-handoff/ 4xx·5xx", three)

        def three_c():
            es = _read(f'{_service_filter(backend)} AND {req_log} AND httpRequest.requestUrl:"/oauth-handoff/" AND {t}')
            return agg_backend_handoff_all(es, handoff_actions), len(es)
        out += _section("③c 백엔드 /oauth-handoff/ 요청 전부(2xx 포함 · 시간별) — issue 는 코드를 낸 것 · consume 은 앱이 교환한 것", three_c)

        def words():
            toks = " OR ".join(f'"{w}"' for w in ["OAUTH_", *sorted(known_be_codes), *_GOOGLE_ERRORS])
            es = _read(f'{_service_filter(backend)} AND severity>=WARNING AND ({toks}) AND {t}')
            return agg_backend_words(es, known_be_codes), len(es)
        out += _section("③b 백엔드 로그의 허용 낱말 (OAUTH_* · INVALID_STATE · 구글 토큰 오류)", words)

    print("\n".join(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
