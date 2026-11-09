#!/usr/bin/env python3
"""dev 푸시 진단 probe — 읽기 전용, **허용 목록 출력만** (mobile `dev-push-probe.yml` 이 self-hosted 맥 러너에서 돌린다).

2026-10-15 (story 4694): 선생님 폰에 채팅 푸시가 데스크톱 앱 이주(10-08 무렵) 뒤 한 번도 안 온다. 서버는 채팅 메시지마다 사람 참여자에게
`dispatch_notification` → Expo 푸시를 보내고(`ee/services/expo_push.py`), 발송마다 한 줄을 남긴다:

    expo push: sent org=<조직> event=<이벤트> devices=N ok=M error=K reasons={…}

`delivery_jobs` 의 `delivered` 는 «보내는 일을 끝냈다»일 뿐 폰 도착이 아니고(기기 0대여도 delivered), 이 줄의 `devices` 가 서버가 폰까지 보냈는지의 판정이다.
앱은 푸시 등록이 멈춘 곳을 `push_diagnostics` 한 줄로 남긴다(`ee/routers/push_devices.py` · story 4394).

두 갈래 (지난 N일, dev 백엔드 로그):
  ① `expo push: sent` — 우리 조직(org 앞 8자리)의 채팅 알림(`conversation.message` · `conversation.mention`) 발송 한 건마다 «시각 · 이벤트 ·
     devices · ok · error · 사유 코드»  + 날짜별 합계 + 기준일(기본 10-08) 앞뒤 합계.
     ⚠ 이 줄은 «그 알림 한 건의 받는 사람 전체» 기기 수이고 대화 id · 멤버가 안 실린다 — 선생님 몫은 «사람 참여자가 선생님 하나뿐인 대화»(PO ↔ 선생님 DM)의
     메시지 시각에 맞춰 읽는다(출력의 시각은 초 단위).
  ② `push_diagnostics` — 선생님(member 앞 8자리)의 «시각 · stage · permission · error_code · platform».

⛔**출력은 허용 목록만이다.** 로그 항목의 나머지(조직 · 멤버 · 사용자 id 원문 · 토큰 · 이메일 · 앱 버전 · 자유 글)는 어디에도 찍지 않는다 — 집계 함수는 항목에서 «정해진 칸»만
꺼내 **닫힌 목록**에 있는 값만 그대로 세고, 목록 밖은 «(other)» 로 센다. «글자 모양이 맞으면 통과»는 쓰지 않는다(까디르 렌즈, 4689). 특히 Expo 의 에러 사유는
`details.error` 가 없으면 티켓의 **자유 글 메시지**(토큰 원문이 든 문장)가 사유 자리에 실리므로(`expo_push.py` `err = … or ticket.get("message")`) 닫힌 코드 목록 밖은 모두 (other).
필터에 쓰는 앞 8자리(org · member)는 출력 어디에도 안 나온다. 원문 한 줄도 출력하지 않는다.
  ③ 필터 없이 이 서비스의 최근 1줄의 «칸 이름만»(값 0) — ① ② 가 0건일 때 «필터가 틀렸나 · 정말 0인가»를 가르는 용도(PO 요청). 이름이 짧은 식별자 모양이 아니면 (other).
예외: gcloud 가 실패하면 그 오류 문구(권한 부족 등)를 찍는다(이 자체가 결과 — PO 지시. 로그 항목이 아니라 gcloud 의 stderr 다). 단 운영자 계정 이메일이 문구에
실릴 수 있어(`account x@y does not have permission`) 이메일 모양 글자는 «(email)» 로 가린 뒤 800자로 자른다(까디르 렌즈 1선).

앱 런타임을 import 하지 않는다(gcloud + 표준 라이브러리만) — probe_prod_auth_errors.py 와 같은 규율. gcloud 는 `run services list` 와 `logging read` 만 부른다.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone

_REGION = "asia-northeast3"
_VM_NAME = "sprintable-vm-dev"  # story 4796 — dev 백엔드는 10-27 부터 이 VM(docker compose) 위에서 돈다. Cloud Run dev 서비스는 없다.
_MAX_ENTRIES = 5000
_GCLOUD_TIMEOUT_SECONDS = 90
_DAYS_MIN, _DAYS_MAX, _DAYS_DEFAULT = 1, 30, 14
_PUSH_LINES_SHOWN = 400
_DIAG_LINES_SHOWN = 60
_OTHER = "(other)"
_OTHER_EVENT = "(other event)"

# ── 허용 목록 ────────────────────────────────────────────────────────────────────────────────────────────────────────────
_CHAT_EVENTS = ("conversation.message", "conversation.mention")
# Expo 푸시 API 가 주는 고정 에러 코드(`details.error`) + 사유가 없을 때의 `unknown`. 이 밖(티켓의 자유 글 메시지 포함)은 모두 (other).
_EXPO_REASONS = frozenset({
    "DeviceNotRegistered", "MessageTooBig", "MessageRateExceeded", "MismatchSenderId", "InvalidCredentials", "unknown",
})
_STAGES = ("permission", "device_token", "expo_token", "register", "ok")
_PERMISSIONS = ("granted", "provisional", "denied", "undetermined")
_PLATFORMS = ("android", "ios")
# 앱이 보낼 수 있는 코드 중 우리가 아는 것(`lib/pushDiagnostics.js` 시험 · FCM · Expo). 밖은 (other) — 필요하면 목록을 넓힌다.
_DIAG_CODES = frozenset({
    "E_REGISTRATION_FAILED", "FIS_AUTH_ERROR", "SERVICE_NOT_AVAILABLE", "ERR_NETWORK", "ERR_NOTIFICATIONS_PERMISSIONS",
    "UNKNOWN", "TOO_MANY_REGISTRATIONS", "MISSING_INSTANCEID_SERVICE", "INVALID_SENDER", "AUTHENTICATION_FAILED",
    "PHONE_REGISTRATION_ERROR", "ERR_UNAVAILABLE", "E_NETWORK",
})
_HTTP_CODE = re.compile(r"^HTTP_([1-5]\d\d)$")
_PREFIX8 = re.compile(r"^[0-9a-f]{8}$")
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

_PUSH_LINE = re.compile(
    r"expo push: sent\s+org=(\S{1,64})\s+event=(\S{1,64})\s+devices=(\d{1,6})\s+ok=(\d{1,6})\s+error=(\d{1,6})\s+reasons=(.{0,600})$",
    re.S,
)
# 사유 dict 의 «이름: 개수» 쌍 — 이름 칸은 닫힌 목록에 있을 때만 그대로 쓰므로 모양은 느슨하게 읽는다.
_REASON_PAIR = re.compile(r"""['"](.{1,400}?)['"]\s*:\s*(\d{1,6})""", re.S)


def _stamp(ts: object) -> str:
    """초 단위 시각(`2026-10-14T03:12:34Z`). 모양이 다르면 «?»."""
    if not isinstance(ts, str) or not re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}", ts):
        return "?"
    return ts[:19] + "Z"


def _day(ts: object) -> str:
    s = _stamp(ts)
    return s[:10] if s != "?" else "?"


def _text_of(entry: dict) -> str:
    """항목의 «본문 글» — textPayload · jsonPayload.message · jsonPayload.log(docker json-file 을 Ops Agent 가 올릴 때의 칸 · story 4796). 다른 칸은 보지 않는다."""
    t = entry.get("textPayload")
    if isinstance(t, str):
        return t
    jp = entry.get("jsonPayload")
    if isinstance(jp, dict):
        for key in ("message", "log"):
            m = jp.get(key)
            if isinstance(m, str):
                return m
    return ""


def _json_payload_of(entry: dict) -> dict:
    """구조화 칸(jsonPayload). 줄이 JSON 글 그대로 한 칸에 담겨 오면 — jsonPayload 의 `log`/`message`, 또는 줄 전체가 `textPayload` 로 저장되는 모양(story 4796 · Ops Agent 가 JSON 으로 안 푼 모양) —
    그 글을 한 번 푼다. 객체가 아니면 빈 dict(없는 jsonPayload 는 {})."""
    jp = entry.get("jsonPayload")
    if isinstance(jp, dict):
        if "event" in jp:
            return jp
        texts = [jp.get("log"), jp.get("message")]
    else:
        texts = [entry.get("textPayload")]
    for raw in texts:
        if isinstance(raw, str) and raw.lstrip().startswith("{"):
            try:
                inner = json.loads(raw)
            except ValueError:
                continue
            if isinstance(inner, dict):
                return inner
    return jp if isinstance(jp, dict) else {}


# ── ① expo push: sent ─────────────────────────────────────────────────────────────────────────────────────────────────────
class Push:
    """발송 한 건 — 닫힌 칸만."""

    __slots__ = ("stamp", "day", "event", "devices", "ok", "error", "reasons")

    def __init__(self, stamp: str, event: str, devices: int, ok: int, error: int, reasons: dict[str, int]) -> None:
        self.stamp, self.day, self.event = stamp, stamp[:10] if stamp != "?" else "?", event
        self.devices, self.ok, self.error, self.reasons = devices, ok, error, reasons


def _reasons_of(raw: str) -> dict[str, int]:
    """`None` · `{'DeviceNotRegistered': 2}` → {닫힌 코드 or (other): 개수}. 이름은 목록 밖이면 값 그대로 안 나간다."""
    out: dict[str, int] = defaultdict(int)
    for name, n in _REASON_PAIR.findall(raw):
        out[name if name in _EXPO_REASONS else _OTHER] += int(n)
    return dict(out)


def parse_pushes(entries: list[dict], org_prefix: str) -> list[Push]:
    """우리 조직(org 앞 8자리)의 발송 줄만. 이벤트는 닫힌 둘 아니면 «(other event)»."""
    out: list[Push] = []
    for e in entries:
        m = _PUSH_LINE.search(_text_of(e))
        if not m:
            continue
        org, event, devices, ok, error, reasons = m.groups()
        if not org.lower().startswith(org_prefix.lower()):
            continue
        out.append(Push(
            _stamp(e.get("timestamp")), event if event in _CHAT_EVENTS else _OTHER_EVENT,
            int(devices), int(ok), int(error), _reasons_of(reasons),
        ))
    return out


def _reasons_text(reasons: dict[str, int]) -> str:
    return " ".join(f"{k}:{v}" for k, v in sorted(reasons.items())) if reasons else "none"


def agg_push_lines(pushes: list[Push]) -> list[str]:
    """발송 한 건마다 한 줄(최신 먼저) — 시각은 초 단위, 선생님 DM 메시지 시각에 맞추려는 것."""
    rows = sorted(pushes, key=lambda p: p.stamp, reverse=True)
    lines = [
        f"  {p.stamp}  {p.event}  devices={p.devices}  ok={p.ok}  error={p.error}  reasons={_reasons_text(p.reasons)}"
        for p in rows[:_PUSH_LINES_SHOWN]
    ]
    if len(rows) > _PUSH_LINES_SHOWN:
        lines.append(f"  … 그 앞 {len(rows) - _PUSH_LINES_SHOWN}건은 줄지 않았다(날짜별 합계에는 들어 있다)")
    return lines


def _sum(pushes: list[Push]) -> tuple[int, int, int, int, int, dict[str, int]]:
    reasons: dict[str, int] = defaultdict(int)
    for p in pushes:
        for k, v in p.reasons.items():
            reasons[k] += v
    return (
        len(pushes), sum(p.devices for p in pushes), sum(p.ok for p in pushes), sum(p.error for p in pushes),
        sum(1 for p in pushes if p.devices == 0), dict(reasons),
    )


def _sum_text(pushes: list[Push]) -> str:
    n, d, ok, err, zero, reasons = _sum(pushes)
    return f"발송 {n}건 · devices 합 {d} · ok 합 {ok} · error 합 {err} · devices=0 인 발송 {zero}건 · reasons {_reasons_text(reasons)}"


def agg_push_days(pushes: list[Push]) -> list[str]:
    """날짜(UTC)별 · 이벤트별 합계."""
    groups: dict[tuple[str, str], list[Push]] = defaultdict(list)
    for p in pushes:
        groups[(p.day, p.event)].append(p)
    return [f"  {day}  {event}  {_sum_text(ps)}" for (day, event), ps in sorted(groups.items())]


def agg_push_split(pushes: list[Push], split_date: str) -> list[str]:
    """기준일 앞/뒤 합계 — 채팅 이벤트 둘만(그 밖의 이벤트는 비교에서 뺀다)."""
    chat = [p for p in pushes if p.event in _CHAT_EVENTS]
    before = [p for p in chat if p.day != "?" and p.day < split_date]
    after = [p for p in chat if p.day != "?" and p.day >= split_date]
    return [f"  {split_date} 앞  {_sum_text(before)}", f"  {split_date} 포함 뒤  {_sum_text(after)}"]


# ── ② push_diagnostics ────────────────────────────────────────────────────────────────────────────────────────────────────
class Diag:
    __slots__ = ("stamp", "stage", "permission", "error_code", "platform")

    def __init__(self, stamp: str, stage: str, permission: str, error_code: str, platform: str) -> None:
        self.stamp, self.stage, self.permission, self.error_code, self.platform = stamp, stage, permission, error_code, platform


def _closed(value: object, allowed: tuple[str, ...] | frozenset[str]) -> str:
    return value if isinstance(value, str) and value in allowed else _OTHER


def _diag_code(value: object) -> str:
    if value is None:
        return "-"
    if isinstance(value, str):
        if value in _DIAG_CODES:
            return value
        if _HTTP_CODE.match(value):
            return value
    return _OTHER


def parse_diagnostics(entries: list[dict], member_prefix: str) -> tuple[list[Diag], int]:
    """`push_diagnostics` 줄 → (닫힌 칸만 담은 목록, 앞 8자리에 걸린 «서로 다른 멤버»의 수). 멤버 id 원문은 어디에도 안 남긴다 — 수만 센다."""
    out: list[Diag] = []
    members: set[str] = set()
    for e in entries:
        jp = _json_payload_of(e)
        if jp.get("event") != "push_diagnostics":
            continue
        mid = jp.get("member_id")
        if not isinstance(mid, str) or not mid.lower().startswith(member_prefix.lower()):
            continue
        members.add(mid.lower())
        out.append(Diag(
            _stamp(e.get("timestamp")), _closed(jp.get("stage"), _STAGES), _closed(jp.get("permission"), _PERMISSIONS),
            _diag_code(jp.get("error_code")), _closed(jp.get("platform"), _PLATFORMS),
        ))
    return out, len(members)


def agg_diag_summary(diags: list[Diag]) -> list[str]:
    spans: dict[tuple[str, str, str, str], list[str]] = defaultdict(list)
    for d in diags:
        spans[(d.stage, d.permission, d.error_code, d.platform)].append(d.stamp)
    rows = []
    for (stage, perm, code, plat), stamps in spans.items():
        ok_stamps = sorted(s for s in stamps if s != "?")
        first, last = (ok_stamps[0], ok_stamps[-1]) if ok_stamps else ("?", "?")
        rows.append((len(stamps), f"  stage={stage}  permission={perm}  error_code={code}  platform={plat}  {len(stamps)}건 (처음 {first} · 마지막 {last})"))
    return [text for _, text in sorted(rows, key=lambda r: (-r[0], r[1]))]


def agg_diag_lines(diags: list[Diag]) -> list[str]:
    rows = sorted(diags, key=lambda d: d.stamp, reverse=True)
    lines = [
        f"  {d.stamp}  stage={d.stage}  permission={d.permission}  error_code={d.error_code}  platform={d.platform}"
        for d in rows[:_DIAG_LINES_SHOWN]
    ]
    if len(rows) > _DIAG_LINES_SHOWN:
        lines.append(f"  … 그 앞 {len(rows) - _DIAG_LINES_SHOWN}건은 줄지 않았다(위 요약에는 들어 있다)")
    return lines


# ── ③ 필터 없이 그 서비스 최근 1줄의 «칸 이름만» ──────────────────────────────────────────────────────────────────────────────
_FIELD_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,39}")  # fullmatch
_HEX_RUN = re.compile(r"[0-9A-Fa-f]{12,}")                  # a key / id written as a field name (Kadir 5461): never printed
_FIELD_NAMES_MAX = 40


def _plain_name(k: object) -> bool:
    """짧은 식별자 모양 AND 16진 덩어리(밑줄을 뺀 12자 이상)를 품지 않음 — 키 · id 가 «이름»으로 와도 값이 아니라 «(other)» 로 접힌다."""
    return isinstance(k, str) and _FIELD_NAME.fullmatch(k) is not None and _HEX_RUN.search(k.replace("_", "")) is None


def field_names(entry: object) -> list[str]:
    """로그 항목 하나의 «칸 이름»만 — 최상위 칸과 `jsonPayload.<칸>`. **값은 한 글자도 안 낸다.** 이름이 짧은 식별자 모양이 아니면 «(other)» 로 접는다
    (이름이 값이 되는 항목 — 예: 사용자 id 를 키로 쓴 맵 — 을 막는다). 필터가 틀렸는지 정말 0건인지를 가르려는 것."""
    if not isinstance(entry, dict):
        return []
    names: set[str] = set()
    for k, v in entry.items():
        names.add(k if _plain_name(k) else _OTHER)
        if k == "jsonPayload" and isinstance(v, dict):
            for jk in v:
                names.add(f"jsonPayload.{jk}" if _plain_name(jk) else f"jsonPayload.{_OTHER}")
    ordered = sorted(names)
    return ordered[:_FIELD_NAMES_MAX] + ([f"… 외 {len(ordered) - _FIELD_NAMES_MAX}개"] if len(ordered) > _FIELD_NAMES_MAX else [])


# 닫힌 목록(codex 검수 · 로그 이름이 멤버 id · 앱 버전 꼴일 수 있다): 알려진 시스템 로그 이름 + 우리 compose 서비스 이름(`sprintable-<서비스>` · 끝에 숫자 한두 자리). 그 밖은 «(other)».
_KNOWN_LOG_IDS = frozenset({"syslog", "messages", "auth", "kern", "ops-agent-health", "ops-agent-fluent-bit", "ops-agent-metrics", "docker", "containers"})
_COMPOSE_LOG_ID = re.compile(r"sprintable-(backend|frontend|caddy|db|migrate|gateway-db|deployer)(-[0-9]{1,2})?")  # fullmatch: no trailing newline passes
_LOG_IDS_READ = 500


def log_ids(entries: list[dict]) -> list[str]:
    """항목들의 «로그 이름 끝 칸»(`projects/…/logs/<이 칸>`)과 개수 — VM 에서 어떤 로그가 올라오는지(syslog · ops-agent-health · 백엔드 컨테이너 …)를 가르는 용도.
    이름이 닫힌 목록(알려진 시스템 로그 · 우리 compose 서비스 이름) 밖이면 «(other)» 로 접는다 — 멤버 id · 앱 버전 꼴 이름이 새지 않게. 값(본문)은 읽지 않는다."""
    counts: dict[str, int] = defaultdict(int)
    for e in entries:
        name = e.get("logName") if isinstance(e, dict) else None
        tail = name.rsplit("/", 1)[-1] if isinstance(name, str) else "?"
        counts[tail if tail in _KNOWN_LOG_IDS or _COMPOSE_LOG_ID.fullmatch(tail) else _OTHER] += 1
    return [f"  {k}: {v}건" for k, v in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))]


# ── gcloud ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
class _GcloudError(Exception):
    pass


_EMAIL = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}")


def redact_gcloud_text(text: str) -> str:
    """gcloud 의 오류 문구는 그대로 찍되(PO 지시) 이메일 모양 글자(운영자 계정이 «account x@y does not have permission» 꼴로 실린다)는 «(email)» 로 가린다.
    가린 **뒤에** 길이를 자른다(자르다 이메일 조각이 남지 않게)."""
    return _EMAIL.sub("(email)", text)


def _run(cmd: list[str]) -> str:
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=_GCLOUD_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired as exc:
        raise _GcloudError(f"gcloud 가 {_GCLOUD_TIMEOUT_SECONDS}초 안에 끝나지 않았다 ({exc.cmd[2] if len(exc.cmd) > 2 else 'logging'})") from None
    if proc.returncode != 0:
        # PO: 권한이 없으면 그 오류 문구 그대로가 결과다 — gcloud 의 stderr(로그 항목이 아님). 너무 길면 자른다.
        raise _GcloudError(redact_gcloud_text((proc.stderr or proc.stdout or "gcloud 실패(출력 없음)").strip())[:800])
    return proc.stdout


def _project_args() -> list[str]:
    project = os.environ.get("GCP_PROJECT_ID", "").strip()
    return [f"--project={project}"] if project else []


def _dev_backends() -> list[str]:
    out = _run(["gcloud", "run", "services", "list", f"--region={_REGION}", "--format=value(metadata.name)", *_project_args()])
    names = [n.strip() for n in out.splitlines() if n.strip()]
    return [n for n in names if n == "sprintable-backend-dev"]


def _vm_filter() -> str:
    """dev VM(story 4796)의 로그 — 인스턴스 이름으로 가른다(prod VM · 다른 서비스가 섞이지 않게). 컨테이너 로그가 Cloud Logging 에 올라와 있어야 줄이 나온다."""
    return f'(resource.type="gce_instance" AND labels."compute.googleapis.com/resource_name"="{_VM_NAME}")'


def _read(flt: str, limit: int = _MAX_ENTRIES) -> list[dict]:
    out = _run([
        "gcloud", "logging", "read", flt, f"--limit={limit}", "--order=desc", "--format=json", *_project_args(),
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


def parse_days(raw: str | None) -> int:
    return _int_env_value(raw, _DAYS_DEFAULT, _DAYS_MIN, _DAYS_MAX, "DAYS")


def _int_env_value(raw: str | None, default: int, lo: int, hi: int, name: str) -> int:
    try:
        v = int((raw or str(default)).strip())
    except ValueError:
        raise SystemExit(f"{name} 는 정수여야 한다 ({lo}~{hi})") from None
    if not lo <= v <= hi:
        raise SystemExit(f"{name} 는 {lo}~{hi} 이어야 한다")
    return v


def parse_prefix(raw: str | None, name: str) -> str:
    v = (raw or "").strip().lower()
    if not _PREFIX8.match(v):
        raise SystemExit(f"{name} 는 소문자 16진수 8자리여야 한다")
    return v


def parse_split_date(raw: str | None) -> str:
    v = (raw or "2026-10-08").strip()
    if not _DATE.match(v):
        raise SystemExit("SPLIT_DATE 는 YYYY-MM-DD 여야 한다")
    return v


def main() -> int:
    days = parse_days(os.environ.get("DAYS"))
    org_prefix = parse_prefix(os.environ.get("ORG_PREFIX"), "ORG_PREFIX")
    member_prefix = parse_prefix(os.environ.get("MEMBER_PREFIX"), "MEMBER_PREFIX")
    split_date = parse_split_date(os.environ.get("SPLIT_DATE"))
    since = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"# dev 푸시 진단 — 지난 {days}일 (since {since}) · 기준일 {split_date} · 허용 목록 출력만 · 시각은 모두 UTC")
    print("  주의: ① 의 devices · ok · error 는 «그 알림 한 건의 받는 사람 전체» 합이다(대화 · 멤버는 로그에 없다) — 선생님 몫은 선생님 하나만 참여자인 DM 의 메시지 시각에 맞춘다.")
    try:
        backends = _dev_backends()
    except _GcloudError as exc:
        print(f"✗ Cloud Run 서비스 목록을 못 읽었다 — gcloud 오류 문구 그대로:\n{exc}")
        return 1
    print(f"백엔드 서비스: {', '.join(backends) or '(Cloud Run 에 없음)'}")
    if backends:
        svc, vm = _service_filter(backends), False
        print(f"로그 출처: Cloud Run {', '.join(backends)}")
    else:
        # story 4796: dev 백엔드는 10-27 부터 VM 위에서 돈다 — Cloud Run 서비스가 없는 것은 오류가 아니라 «로그가 다른 자리에 있다»는 뜻.
        svc, vm = _vm_filter(), True
        print(f"로그 출처: VM {_VM_NAME}(Cloud Run 에 dev 백엔드 서비스 없음 — story 4796) · 컨테이너 로그가 Cloud Logging 에 안 올라와 있으면 ① ② 는 0건이고 ③ 이 그것을 보인다")

    t = f'timestamp>="{since}"'
    out: list[str] = []

    def one():
        events = " OR ".join(f'"event={e}"' for e in _CHAT_EVENTS)
        es = _read(f'{svc} AND "expo push: sent" AND "org={org_prefix}" AND ({events}) AND {t}')
        pushes = parse_pushes(es, org_prefix)
        if not pushes:
            return [], len(es)
        return agg_push_split(pushes, split_date) + ["", "  [날짜별 합계]"] + agg_push_days(pushes) + ["", "  [발송 한 건마다 — 최신 먼저]"] + agg_push_lines(pushes), len(es)

    out += _section("① expo push: sent — 채팅 알림 발송 (devices · ok · error · reasons)", one)

    def two():
        if vm:  # docker 줄이 JSON 글 그대로 한 칸에 오는 모양까지(parse_diagnostics 가 한 번 푼다)
            diag_flt = f'{svc} AND ("push_diagnostics" AND "{member_prefix}") AND {t}'
        else:
            diag_flt = f'{svc} AND jsonPayload.event="push_diagnostics" AND jsonPayload.member_id:"{member_prefix}" AND {t}'
        es = _read(diag_flt)
        diags, members = parse_diagnostics(es, member_prefix)
        warn = [f"  ⚠ 앞 8자리에 서로 다른 멤버 {members}명이 걸렸다 — 아래는 섞여 있다"] if members > 1 else []
        if not diags:
            return warn, len(es)
        return warn +agg_diag_summary(diags) + ["", "  [한 건마다 — 최신 먼저]"] + agg_diag_lines(diags), len(es)

    out += _section("② push_diagnostics — 선생님 폰이 등록에서 멈춘 곳 (stage · permission · error_code)", two)

    def three():
        es = _read(f"{svc} AND {t}", limit=1)
        return ([f"  {' · '.join(field_names(es[0]))}"] if es else []), len(es)

    out += _section("③ 필터 없이 이 서비스 최근 1줄의 칸 이름만 (값 0) — ① ② 가 0건일 때 «필터가 틀렸나 · 정말 0인가»를 가르는 용도", three)

    if vm:
        def four():
            es = _read(f"{svc} AND {t}", limit=_LOG_IDS_READ)
            return log_ids(es), len(es)

        out += _section("④ 이 VM 에서 Cloud Logging 으로 올라오는 로그 이름과 개수(최근 항목 중) — 백엔드 컨테이너 로그가 목록에 없으면 «올라오지 않는다»가 답(story 4796 · 4869)", four)

    print("\n".join(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
