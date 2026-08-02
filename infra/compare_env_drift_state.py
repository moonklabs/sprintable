#!/usr/bin/env python3
"""story #2422 — env 드리프트 가드가 나흘째 FAIL인데 아무도 못 알아챈 병의 근본 처방.

증상: 매일 같은 모양(``⛔ env 드리프트 가드 FAIL — 상세: <link>``)의 알림이 와서, "어제와
같은 실패"인지 "오늘 새로 생긴 실패"인지 알림 자체가 말해 주지 않았다 — 빨강이 «배경음»이
되면(초록이 알리바이가 되는 것의 반대편) 가드가 있어도 없는 것과 같다.

이 스크립트는 `check_env_drift.py`(``ENV_DRIFT_STATE_FILE`` 설정 시)가 매 실행 남기는
"오늘의 FAIL 집합"(dev·prod 각각, 키 이름만 — 값 없음)을 어제 지문(직전 실행분, GHA
cache로 영속화)과 대조해 셋을 가른다: 신규(새로 생긴 항목)·해소(어제 있었는데 오늘 없는
항목)·연속일수(지금 이 정확한 집합이 며칠째 그대로인지). 알림 문구가 이 셋을 말하게 하는
것이 스토리의 진짜 축이다(㉠ 드리프트 자체를 고치는 것보다 이쪽이 다음 드리프트도 똑같이
묻히는가를 가른다).

⛔절대 하지 않는 것 — "동일 반복이니 조용히 넘어간다"(오르테가군 원칙, 알림 불가/억제
절대 금지와 동형). CI job의 실패(exit 1)는 이 스크립트와 무관하게 그대로 유지된다 — 이
스크립트는 «알림 문구»만 더 정보가 있게 만들 뿐, 빨강을 초록으로 바꾸거나 알림 자체를
끄지 않는다. "동일 반복 N일째"도 여전히 알림으로 나간다 — 다만 "새 실패인가"를 한눈에
가를 수 있게 될 뿐이다.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path


def load_fail_lines(path: str) -> list[str]:
    """state 파일이 없으면(첫 실행·캐시 미스) 빈 목록 — "지문 없음"과 "지문이 빈 목록"을
    구분하지 않는다(둘 다 "그때는 알려진 게 없었다"로 같이 취급하는 게 이 대조에선 맞다 —
    캐시가 비어 있는 첫날은 뭐가 나와도 전부 "신규"로 보이는 게 오히려 정확하다)."""
    p = Path(path)
    if not p.exists():
        return []
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return []
    return list(data.get("fail_lines", []))


def compare(
    envs: list[tuple[str, str]], previous_digest_path: str, today: str,
) -> dict:
    """envs: [(label, current_state_path), ...] — 오늘 각 env가 낸 raw state 파일.
    previous_digest_path: 어제 이 함수가 남긴 digest(캐시에서 복원됨, 없으면 첫 실행).
    반환: {"current_fail": set[str]로 join 안 된 label-tagged 문자열 목록, "new_items",
    "resolved_items", "streak_days", "since", "unchanged"}."""
    current_fail: list[str] = []
    for label, path in envs:
        for line in sorted(load_fail_lines(path)):
            current_fail.append(f"[{label}] {line}")
    current_set = set(current_fail)

    prev_digest = _load_digest(previous_digest_path)
    previous_set = set(prev_digest.get("fail_lines", []))

    new_items = sorted(current_set - previous_set)
    resolved_items = sorted(previous_set - current_set)
    unchanged = current_set == previous_set

    if unchanged and prev_digest.get("since"):
        # 집합이 어제와 완전히 같다 — 연속선 그대로 이어간다(집합이 비어 있어도 "0일째 계속
        # 깨끗함"은 이 스크립트 밖 관심사, 알림은 has_fail이 없으면 애초에 안 불린다).
        since = prev_digest["since"]
        streak_days = int(prev_digest.get("streak_days", 1)) + 1
    else:
        # 집합이 달라졌다(신규·해소 어느 쪽이든) — 오늘부터 새 연속선 시작.
        since = today
        streak_days = 1

    return {
        "current_fail": sorted(current_set),
        "new_items": new_items,
        "resolved_items": resolved_items,
        "streak_days": streak_days,
        "since": since,
        "unchanged": unchanged,
    }


def _load_digest(path: str) -> dict:
    p = Path(path)
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


def write_digest(path: str, result: dict) -> None:
    payload = {
        "fail_lines": result["current_fail"],
        "since": result["since"],
        "streak_days": result["streak_days"],
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2, sort_keys=True)
        f.write("\n")


def format_discord_message(result: dict, run_url: str) -> str:
    """알림 문구 — 「새 실패인가」가 첫 줄에 오게(다음 발견을 그 자리에서 세지 못하면 이
    스토리가 고치려는 그 병이 그대로 재발한다)."""
    lines: list[str] = []
    if not result["current_fail"]:
        # has_fail이 없으면 워크플로우가 이 알림 스텝 자체를 안 부른다 — 방어적으로만 남김.
        lines.append("⛔ env 드리프트 가드 FAIL — 상세 없음(호출 경로 오류 의심)")
    elif result["new_items"] or (result["streak_days"] == 1 and not result["resolved_items"]):
        lines.append(f"⭐ env 드리프트 가드 FAIL — «새» 실패 발견({len(result['new_items'])}건)")
        for item in result["new_items"][:10]:
            lines.append(f"  + {item}")
        if len(result["new_items"]) > 10:
            lines.append(f"  ... 외 {len(result['new_items']) - 10}건")
    else:
        lines.append(
            f"⛔ env 드리프트 가드 FAIL — 동일 반복 {result['streak_days']}일째"
            f"(since {result['since']}, 새 항목 없음)"
        )

    if result["resolved_items"]:
        lines.append(f"✅ 해소된 항목({len(result['resolved_items'])}건):")
        for item in result["resolved_items"][:10]:
            lines.append(f"  - {item}")

    if result["current_fail"] and not result["new_items"]:
        lines.append(f"현재 유지 중인 실패 {len(result['current_fail'])}건 — 상세: {run_url}")
    else:
        lines.append(f"상세: {run_url}")

    return "\n".join(lines)


def _parse_args(argv: list[str]) -> dict:
    args = dict(zip(argv[::2], argv[1::2]))
    required = {"--dev-state", "--prod-state", "--previous-digest", "--output-digest", "--today", "--run-url"}
    missing = required - set(args)
    if missing:
        raise SystemExit(f"missing required args: {sorted(missing)}")
    return args


def main() -> int:
    args = _parse_args(sys.argv[1:])
    result = compare(
        [("dev", args["--dev-state"]), ("prod", args["--prod-state"])],
        args["--previous-digest"],
        args["--today"],
    )
    write_digest(args["--output-digest"], result)

    message = format_discord_message(result, args["--run-url"])
    is_new = bool(result["new_items"]) or (result["streak_days"] == 1 and bool(result["current_fail"]))

    github_output = args.get("--github-output")
    if github_output:
        with open(github_output, "a", encoding="utf-8") as f:
            f.write(f"is_new_failure={'true' if is_new else 'false'}\n")
            f.write(f"streak_days={result['streak_days']}\n")
            f.write("message<<ENV_DRIFT_MSG_EOF\n")
            f.write(message + "\n")
            f.write("ENV_DRIFT_MSG_EOF\n")

    print(message)
    return 0


if __name__ == "__main__":
    sys.exit(main())
