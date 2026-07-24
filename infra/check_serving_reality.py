#!/usr/bin/env python3
"""ⓓ 배포 실효 가드(story #2174) — "배포 성공"과 "사용자에게 도달"이 다른 것을 잡는다.

## 왜 만들었나 — 실제로 두 번 데였다

```
표본 A  sprintable-frontend-prod 가 traffic 을 특정 리비전에 고정한 채로 **22시간** 옛 코드를
        서빙했다(2026-07-23~24). 그동안 Cloud Build success · GHA success ·
        `describe` 의 image 필드는 새 커밋 태그 — **세 신호가 전부 초록이었다.**
표본 B  sprintable-internal-api-dev-00015-bn6 이 2026-07-20 부터 Ready=False 인 채
        방치됐고(PORT=8080 미기동) 서빙은 그 이전 00014 그대로였다 — **5일간 아무도 몰랐다.**
```
⛔**`spec.template.spec.containers[0].image` 단독 판정 금지** — 그건 "다음에 쓸 템플릿"이지
"지금 트래픽 받는 리비전의 이미지"가 아니다. 표본 A 에서 PO 가 이 필드만 보고 "배포 실효"를
선언할 뻔했고, 그랬으면 고쳐지지 않은 것을 "고쳤다"고 보고했을 것이다.

## 검사 축 둘 — 표본 하나씩에 대응한다

```
축A(고정)   traffic 이 latestRevision=true 가 아닌 서비스        ← 표본 A 를 잡는다
축B(정체)   latestReady != latestCreated 인 서비스               ← 표본 B 를 잡는다
```
둘 다 **선언 없는 것만** 잡는다 — 의도적 고정(롤백·카나리)까지 실패로 만들면 가드가 방해가
된다(story AC3). 선언은 `infra/serving-reality-allowlist.yml` 에 **사유·선언자·만료일**과 함께.

## ⭐ 선언 자체에 만료를 강제한다 — 오늘 배운 것을 가드에 적용

이 가드가 감시하는 결함군(#2128·#2160·#2161·#2174·#2182)의 공통 뿌리는 하나다:
> **끝났다는 통지가 사라지면, 시스템이 그 상태를 영영 놓지 못한다.**

허용목록도 정확히 같은 함정을 가진다 — 한 번 등재하면 아무도 다시 안 본다. 그래서 이 가드는
선언에 **`until`(만료일)을 필수**로 요구하고, 만료된 선언은 FAIL 로 취급한다. 선언은 스스로
회수된다. 가드가 감시하는 원칙을 가드 자신이 지킨다.

⭐**낡은 선언도 잡는다**: 등재돼 있는데 라이브가 이미 정상이면 그것도 FAIL 이다. 선언이
사실보다 오래 살면, 다음에 진짜 고정이 생겨도 "아, 그거 등재된 거야"로 넘어가 버린다 —
이 가드를 만든 이유가 그 자리에서 무효화된다.

## ⛔ 이 가드가 **못 잡는 것**(명시 — story AC3)

```
1. GCE MIG 는 안 본다. Cloud Run 만 열거한다. realtime-gateway-{dev,prod} 는 별도 축이며,
   실제로 dev MIG 는 2일+ 옛 이미지로 돌고 있는 것이 별도 관측됐다(2026-07-25).
2. "지금 서빙되는 것이 **최신 머지**인가"는 안 본다. 주기 실행이라 "기대 리비전"을 모른다.
   ⇒ 이 가드는 **구조적 건강**(고정·정체)만 본다. 특정 배포의 실효 확認은 배포 시점에
     별도로 해야 한다(축① 빌드 conclusion + 축② 기대 리비전 대조).
3. 트래픽 분할(카나리)에서 latestRevision=true 인 항목의 percent 가 100 미만인 경우는
   축A 로 잡히지 않는다 — 고정은 아니기 때문. 분할 자체의 적정성은 이 가드 밖이다.
4. asia-northeast3 밖 리전의 서비스는 안 본다.
5. 리비전이 Ready 인 것과 **실제로 요청을 정상 처리하는 것**은 다르다 — 헬스체크는 이 가드 밖.
6. 고정을 **누가** 했는지는 안 본다(공용 자격증명이라 감사로그로도 못 가른다 — 표본 A 에서
   실제로 못 갈랐다). 이 가드는 "누가"가 아니라 "선언됐는가"만 묻는다.
```

로컬 수동 실행:
    python3 infra/check_serving_reality.py

exit code: 0=이상 없음, 1=선언 없는 고정/정체 또는 만료·낡은 선언 발견(상세를 stdout 에 출력).
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import date, datetime, timezone
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
_REGION = "asia-northeast3"
_ALLOWLIST_PATH = _REPO_ROOT / "infra" / "serving-reality-allowlist.yml"


def _run(cmd: list[str]) -> str:
    result = subprocess.run(cmd, capture_output=True, text=True, check=True)
    return result.stdout.strip()


def _today() -> date:
    """만료 판정 기준일. `SERVING_REALITY_TODAY`(YYYY-MM-DD)로 주입 가능 — 테스트가 실제
    달력에 의존하면 어느 날 갑자기 깨지기 때문(만료 테스트는 특히)."""
    override = os.environ.get("SERVING_REALITY_TODAY")
    if override:
        return date.fromisoformat(override)
    return datetime.now(timezone.utc).date()


def _list_live_services() -> list[str]:
    """서비스 목록을 **매 실행 동적 열거**한다 — 하드코딩하지 않는다.

    check_env_drift.py 와 같은 교훈: mcp-dev 키 유출이 "아무도 안 보던 서비스"에서 났다.
    새로 생긴 서비스가 자동으로 감시망에 들어와야 한다."""
    out = _run([
        "gcloud", "run", "services", "list",
        f"--region={_REGION}", "--format=value(metadata.name)",
    ])
    return [line.strip() for line in out.splitlines() if line.strip()]


def _serving_status(service: str) -> dict:
    """서빙 실체만 뽑는다 — `status.*` 만 쓰고 `spec.template.*` 은 쓰지 않는다.

    ⛔spec 은 "다음에 쓸 템플릿"이라, 이 가드가 잡으려는 결함이 정확히 spec 과 status 가
    갈라진 상태다. spec 을 읽는 순간 이 가드는 표본 A 를 놓친다."""
    out = _run([
        "gcloud", "run", "services", "describe", service,
        f"--region={_REGION}", "--format=json(status)",
    ])
    status = json.loads(out).get("status", {}) if out else {}
    return {
        "traffic": status.get("traffic", []) or [],
        "latest_ready": status.get("latestReadyRevisionName"),
        "latest_created": status.get("latestCreatedRevisionName"),
    }


def _load_allowlist() -> tuple[dict[str, dict], dict[str, dict]]:
    """반환: ({service: entry} 고정 선언, {service: entry} 정체 선언).

    파일이 없으면 빈 선언으로 취급한다 — ⛔"선언 파일이 없으니 검사 생략"은 하지 않는다.
    그러면 파일을 지우는 것만으로 가드가 조용히 꺼진다."""
    if not _ALLOWLIST_PATH.exists():
        return {}, {}
    import yaml

    data = yaml.safe_load(_ALLOWLIST_PATH.read_text()) or {}
    pinned = {e["service"]: e for e in (data.get("declared_pins") or [])}
    stalled = {e["service"]: e for e in (data.get("declared_stalls") or [])}
    return pinned, stalled


def _is_pinned(traffic: list[dict]) -> bool:
    """트래픽이 특정 리비전에 고정돼 있는가.

    Cloud Run 은 자동 최신 추적일 때 `latestRevision: true` 인 항목을 둔다. 고정하면 그
    항목이 사라지고 `revisionName` 만 있는 항목이 된다(표본 A 의 실제 모양).

    ⚠️traffic 항목 자체가 없으면 **고정으로 취급**한다 — 판정 불가를 조용히 통과시키면
    이 가드가 가장 이상한 상태를 못 보게 된다."""
    if not traffic:
        return True
    return not any(entry.get("latestRevision") is True for entry in traffic)


def _expired(entry: dict, today: date) -> str | None:
    """만료·형식 위반이면 사유 문자열, 아니면 None.

    `until` 을 **필수**로 요구한다 — 없는 선언은 영원히 사는 선언이라 이 가드가 막으려는
    바로 그것이 된다."""
    until_raw = entry.get("until")
    if not until_raw:
        return "`until`(만료일) 이 없다 — 영원히 사는 선언은 허용하지 않는다"
    try:
        until = date.fromisoformat(str(until_raw))
    except ValueError:
        return f"`until` 형식이 YYYY-MM-DD 가 아니다: {until_raw!r}"
    if until < today:
        return f"선언이 만료됐다(until={until}) — 재확認 후 갱신하거나 상태를 고칠 것"
    if not entry.get("reason"):
        return "`reason`(사유) 이 없다 — 사유 없는 선언은 다음 사람이 판단할 수 없다"
    return None


def main() -> int:
    today = _today()
    declared_pins, declared_stalls = _load_allowlist()
    services = _list_live_services()

    undeclared_pins: list[str] = []
    undeclared_stalls: list[str] = []
    bad_declarations: list[str] = []
    live_pinned: set[str] = set()
    live_stalled: set[str] = set()

    for service in services:
        st = _serving_status(service)

        if _is_pinned(st["traffic"]):
            live_pinned.add(service)
            if service not in declared_pins:
                serving = ", ".join(
                    e.get("revisionName", "?") for e in st["traffic"]
                ) or "(traffic 항목 없음)"
                undeclared_pins.append(
                    f"{service}: traffic 이 자동최신이 아니다 — 서빙 {serving} · "
                    f"latestReady={st['latest_ready']}"
                )

        if st["latest_ready"] != st["latest_created"]:
            live_stalled.add(service)
            if service not in declared_stalls:
                undeclared_stalls.append(
                    f"{service}: 최신 리비전이 Ready 에 도달 못 했다 — "
                    f"latestCreated={st['latest_created']} · "
                    f"실제 서빙 가능한 최신={st['latest_ready']}"
                )

    # 선언 자체의 건강 — 만료·사유누락·사실과 어긋남.
    for kind, declared, live in (
        ("declared_pins", declared_pins, live_pinned),
        ("declared_stalls", declared_stalls, live_stalled),
    ):
        for service, entry in declared.items():
            problem = _expired(entry, today)
            if problem:
                bad_declarations.append(f"{kind}/{service}: {problem}")
            if service not in live:
                bad_declarations.append(
                    f"{kind}/{service}: 등재돼 있으나 라이브는 이미 정상이다 — 선언을 지울 것 "
                    "(사실보다 오래 사는 선언은 다음 진짜 건을 가린다)"
                )

    if undeclared_pins or undeclared_stalls or bad_declarations:
        print("⛔ 배포 실효 가드 FAIL — 배포가 성공했어도 사용자에게 안 닿고 있을 수 있다.\n")
        if undeclared_pins:
            print("  축A 선언 없는 트래픽 고정(새 리비전이 사용자에 안 닿는다):")
            for line in undeclared_pins:
                print(f"    - {line}")
        if undeclared_stalls:
            print("  축B 선언 없는 롤아웃 정체(새 리비전이 Ready 실패 — 옛 코드가 계속 서빙):")
            for line in undeclared_stalls:
                print(f"    - {line}")
        if bad_declarations:
            print("  선언 자체의 문제(만료·사유누락·사실과 어긋남):")
            for line in bad_declarations:
                print(f"    - {line}")
        print(
            "\n→ 의도적 고정(롤백·카나리)이면 infra/serving-reality-allowlist.yml 에 "
            "**reason·declared_by·until** 과 함께 등재. 의도가 아니면 원인을 고칠 것 — "
            "축A 는 `gcloud run services update-traffic --to-latest`, "
            "축B 는 실패한 리비전의 conditions 에 기동 실패 사유가 남는다. "
            "⛔고정 해제는 그 자체가 배포 행위다 — 의도를 확認하고 할 것."
        )
        return 1

    print(
        f"✅ 배포 실효 이상 없음 — {len(services)}개 Cloud Run 서비스 "
        f"(축A 트래픽 고정 0건·축B 롤아웃 정체 0건·선언 문제 0건). "
        f"⚠️GCE MIG·'최신 머지가 서빙되는가'는 이 가드 밖(모듈 docstring 참조)."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
