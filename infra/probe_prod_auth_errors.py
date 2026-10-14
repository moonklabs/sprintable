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

⛔**출력은 허용 목록만이다.** 로그 항목(이메일 · 사용자 id · IP · 쿠키 · 토큰 · UA · referer · 쿼리의 code/state/error 외 값)은
어디에도 찍지 않는다 — 집계 함수는 항목에서 «정해진 칸»만 꺼내 정규식/집합으로 걸러 값만 센다. 모양이 다른 error 값은
«(other)» 로 센다. 원문 한 줄도 출력하지 않는다. 오직 예외: gcloud 가 실패하면 그 오류 문구(권한 부족 등)를 그대로 찍는다
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
_ERROR_VALUE = re.compile(r"^[A-Za-z0-9_]{1,64}$")  # `/login?error=<코드>` 의 코드 모양 — 이 밖은 «(other)»
_BACKEND_CODE = re.compile(r"\b(OAUTH_[A-Z][A-Z_]{1,40}|INVALID_STATE)\b")
_GOOGLE_ERRORS = (
    "invalid_grant", "invalid_client", "invalid_request", "redirect_uri_mismatch", "access_denied",
    "unauthorized_client", "invalid_scope", "unsupported_grant_type", "invalid_token",
)
_GOOGLE_ERROR_RE = re.compile(r"\b(" + "|".join(_GOOGLE_ERRORS) + r")\b")
_STATE_CHECK = re.compile(r"auth\.oauth\.callback\.state_check\s+outcome=(\w+)\s+provider=(\w+)\s+native=(\w+)")
_SAFE_PATH = re.compile(r"^/[A-Za-z0-9/_-]{0,80}$")
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
def _error_param(request_url: str | None) -> str | None:
    """요청 URL 의 `error` 쿼리 값 하나만 — 다른 쿼리/호스트/경로는 버린다."""
    if not isinstance(request_url, str):
        return None
    parts = urlsplit(request_url)
    if parts.path != "/login":
        return None
    vals = parse_qs(parts.query, keep_blank_values=True).get("error")
    if not vals:
        return None
    v = vals[0]
    return v if _ERROR_VALUE.match(v) else "(other)"


def agg_login_errors(entries: list[dict]) -> list[str]:
    spans: dict[str, _Span] = defaultdict(_Span)
    for e in entries:
        hr = e.get("httpRequest")
        err = _error_param(hr.get("requestUrl") if isinstance(hr, dict) else None)
        if err is None:
            continue
        spans[err].add(e.get("timestamp"))
    return [f"  error={err}  {sp.text()}" for err, sp in sorted(spans.items(), key=lambda kv: (-kv[1].n, kv[0]))]


# ── ③ 백엔드 요청 + 허용 낱말 ──────────────────────────────────────────────────────────────────────────────────────────────
def _route_label(request_url: str | None) -> str | None:
    """`/oauth/callback` · `/oauth-handoff/` 만 — 쿼리(code · state)는 버리고 경로 상수로 접는다. 다른 경로는 None."""
    if not isinstance(request_url, str):
        return None
    path = urlsplit(request_url).path
    if not _SAFE_PATH.match(path):
        return None
    if "/oauth/callback" in path:
        return path[: path.index("/oauth/callback")] + "/oauth/callback"
    if "/oauth-handoff/" in path:
        return path[: path.index("/oauth-handoff/")] + "/oauth-handoff/*"
    return None


def agg_backend_requests(entries: list[dict]) -> list[str]:
    spans: dict[tuple[str, str, int], _Span] = defaultdict(_Span)
    for e in entries:
        hr = e.get("httpRequest")
        if not isinstance(hr, dict):
            continue
        label = _route_label(hr.get("requestUrl"))
        status = hr.get("status")
        if label is None or not isinstance(status, int) or status < 400:
            continue
        method = hr.get("requestMethod")
        method = method if method in _METHODS else "?"
        spans[(label, method, status)].add(e.get("timestamp"))
    return [f"  {m} {label}  → {status}  {sp.text()}" for (label, m, status), sp in sorted(spans.items())]


def agg_backend_words(entries: list[dict]) -> list[str]:
    """백엔드 로그 항목 전체를 훑되 **정규식에 걸린 낱말만** 센다 — 항목의 나머지는 한 글자도 안 나간다."""
    spans: dict[str, _Span] = defaultdict(_Span)
    for e in entries:
        blob = json.dumps(e, ensure_ascii=False)
        seen = set(_BACKEND_CODE.findall(blob)) | set(_GOOGLE_ERROR_RE.findall(blob))
        for w in seen:
            spans[w].add(e.get("timestamp"))
    return [f"  {w}  {sp.text()}" for w, sp in sorted(spans.items(), key=lambda kv: (-kv[1].n, kv[0]))]


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


def _prod_services() -> tuple[list[str], list[str]]:
    out = _run(["gcloud", "run", "services", "list", f"--region={_REGION}", "--format=value(metadata.name)", *_project_args()])
    names = [n.strip() for n in out.splitlines() if n.strip()]
    prod = [n for n in names if "prod" in n]
    web = [n for n in prod if "frontend" in n or n.endswith("-web-prod") or "-web-" in n]
    backend = [n for n in prod if "backend" in n]
    return web, backend


def _read(flt: str) -> list[dict]:
    out = _run([
        "gcloud", "logging", "read", flt, f"--limit={_MAX_ENTRIES}", "--order=desc", "--format=json", *_project_args(),
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


def parse_hours(raw: str | None) -> int:
    try:
        hours = int((raw or "12").strip())
    except ValueError:
        raise SystemExit(f"hours 는 정수여야 한다 ({_HOURS_MIN}~{_HOURS_MAX})") from None
    if not _HOURS_MIN <= hours <= _HOURS_MAX:
        raise SystemExit(f"hours 는 {_HOURS_MIN}~{_HOURS_MAX} 이어야 한다")
    return hours


def main() -> int:
    hours = parse_hours(os.environ.get("HOURS"))
    since = (datetime.now(timezone.utc) - timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"# prod 로그인 실패 진단 — 지난 {hours}시간 (since {since}) · 허용 목록 출력만")
    try:
        web, backend = _prod_services()
    except _GcloudError as exc:
        print(f"✗ Cloud Run 서비스 목록을 못 읽었다 — gcloud 오류 문구 그대로:\n{exc}")
        return 1
    print(f"웹 서비스: {', '.join(web) or '(없음)'} · 백엔드 서비스: {', '.join(backend) or '(없음)'}")
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
            return agg_login_errors(es), len(es)
        out += _section("② 웹 요청 /login?error= (error 값)", two)

    if backend:
        def three():
            es = _read(
                f'{_service_filter(backend)} AND {req_log} AND httpRequest.status>=400 '
                f'AND (httpRequest.requestUrl:"/oauth/callback" OR httpRequest.requestUrl:"/oauth-handoff/") AND {t}'
            )
            return agg_backend_requests(es), len(es)
        out += _section("③a 백엔드 /oauth/callback · /oauth-handoff/ 4xx·5xx", three)

        def words():
            toks = " OR ".join(f'"{w}"' for w in ["OAUTH_", "INVALID_STATE", *_GOOGLE_ERRORS])
            es = _read(f'{_service_filter(backend)} AND severity>=WARNING AND ({toks}) AND {t}')
            return agg_backend_words(es), len(es)
        out += _section("③b 백엔드 로그의 허용 낱말 (OAUTH_* · INVALID_STATE · 구글 토큰 오류)", words)

    print("\n".join(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
