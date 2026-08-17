"""story #2330(CI·승격안전) — 「fresh DB로 올라간다」≠「기존 DB에 한 단 얹힌다」를 재현한다.

배경(민 로컬 재현 + 파울로 실측, 2026-07-30): 기존 CI 잡(`Alembic upgrade head (fresh DB)`)은
빈 DB에서 baseline-stamp 후 그 뒤 모든 리비전을 **단 한 번의** `command.upgrade()` 호출(=한
트랜잭션 블록) 안에서 적용한다. 그런데 실배포(dev/prod)는 언제나 「이미 어떤 리비전에 있는
DB에 «새 리비전 하나»를 얹는」 별개의 잡 실행이다 — 0217(story #2267)의 `autocommit_block()`
호출이 정확히 이 차이로 갈렸다: 빈 DB에서 한 번에 쭉 올릴 때는 통과했고, 0216까지 올려진
DB에 0217만 단독 적용할 때만 `AssertionError(self._transaction is not None)`로 죽었다.

이 스크립트는 그 실배포 경로를 **두 번의 별개** `command.upgrade()` 호출로 재현한다 —
alembic은 호출마다 `env.py`를 처음부터 다시 실행하므로(각자 새 트랜잭션 블록), 이 두 호출이
"job 실행 A, 그 뒤 별도 job 실행 B"와 동등하다(순차 실행이라 각각 독립된 alembic 프로세스가
도는 것과 같은 경계 조건을 만든다).

⛔이 스크립트가 못 잡는 것(반드시 읽어야 하는 한계 — story #2330 AC4):
  · 여러 리비전이 «한 배치»로 함께 올라갈 때만 나는 상호작용 — 이 스크립트는 항상 「head(들)
    직전까지 + head(들)만 단독」 두 단계만 재현한다. 3개 이상의 신규 리비전이 한 PR에 실려도
    이 스크립트는 마지막 한 단만 단독으로 떼어 시험한다(그 사이 리비전들끼리의 상호작용은
    이 잡의 시험 범위 밖).
  · 실제 prod 데이터 크기/분포에서만 나는 문제(락 경합·인덱스 빌드 시간) — CI DB는 비어 있다.
  · downgrade(롤백) 경로 — 이 스크립트는 upgrade만 잰다.
  · ⭐«형제 PR»의 리비전 번호(story #2401 AC5, 2026-08-16 추가) — 이 스크립트는 **자기
    브랜치의 alembic.ini만** 읽는다. gh API도, 다른 열린 PR 참조도 전혀 없다. #2397(PR
    #2777·#2781)이 develop 기준 같은 `0221`을 각자 새 리비전으로 만들었는데도 둘 다 이
    잡을 통과한 게 그래서다 — 각 PR이 «자기만» 보면 전부 초록이고, dual-head는 머지
    «후»에야 드러났다. 그 시야는 `ci_alembic_sibling_pr_collision_check.py`(story #2401)가
    별도로 메운다 — 이 잡은 여전히 "기존 DB에 한 단 얹기"만 검증하지, "그 한 단이 다른
    열린 PR과 번호가 겹치는가"는 검증하지 않는다.
「이제 다 잡는다」로 읽으면 그것이 다음 사고다(story #2330 배경 그대로).
"""
from __future__ import annotations

import sys

from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory


def _parents_of_heads(script: ScriptDirectory) -> set[str]:
    parents: set[str] = set()
    for head_id in script.get_heads():
        rev = script.get_revision(head_id)
        down = rev.down_revision
        if down is None:
            continue  # head 자체가 root(부모 없음) — 단일 스텝 재현 대상이 아니다
        if isinstance(down, (list, tuple)):
            parents.update(down)
        else:
            parents.add(down)
    return parents


def main() -> int:
    cfg = Config("alembic.ini")
    script = ScriptDirectory.from_config(cfg)
    parents = _parents_of_heads(script)

    if not parents:
        print("SKIP: head(s)에 부모 리비전이 없다(단일-리비전 히스토리) — 단일 스텝 재현 대상 아님")
        return 0

    print(f"[1/2] 부모 리비전까지 올린다(= 「이미 배포된 상태」 흉내): {sorted(parents)}", flush=True)
    for p in sorted(parents):
        command.upgrade(cfg, p)

    print("[2/2] head(들)을 «단독» 적용한다(= 이번 배포가 실제로 실행하는 것) — 별개 호출", flush=True)
    command.upgrade(cfg, "heads")

    print("OK: 기존 DB에 마지막 리비전 한 단을 얹는 경로가 성공했다", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
