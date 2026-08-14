# 워크스페이스 잔재 자동 회수 — story #2659

2026-08-14 fleet 전면 장애(공유 Data 볼륨 926Gi 100%, 여유 117Mi — 전 에이전트 Bash 불능) 사후
처방. 실측 원인: `git worktree add`로 스토리마다 만든 격리 작업공간(각 수백MB~GB
`node_modules`)이 머지 확定 후에도 지워지지 않고 쌓였다(미르코 명명분 200개+ · 까디르
`.qa-worktrees/*` 391개 — 전부 실측 확인) + Docker.raw 149G(그 QA worktree들의 일회 테스트
Postgres 컨테이너 누적).

## 오너십 분할 (PO 판정, 2026-08-14)

- **설계+구현(이 디렉토리) = 미르코**: 스크립트 실물 + 안전검사 + 실측 테스트.
- **머신 레벨 배선(cron/launchd 등록) = PO**: 이 스크립트가 서면 등록은 PO가 선생님과
  무는다. 이 레포는 「돌릴 물건」까지만 책임진다.

## 스크립트

### `reclaim-merged-worktrees.sh`

머지 확定+push 완료+clean(무커밋 잔여 0)인 worktree만 안전하게 회수(디렉토리만 — 브랜치는
안 지움). 기본은 dry-run.

```sh
scripts/reclaim-merged-worktrees.sh              # dry-run — 무엇을 지울지만 보고
scripts/reclaim-merged-worktrees.sh --apply       # 실제 삭제(+ docker-compose down 동반)
```

안전검사(전부 AND — 하나라도 걸리면 KEEP):
1. worktree가 clean(추적/미추적 불문 무변경)
2. HEAD sha 자체가 origin에 push됨(`git branch -r --contains <sha>` — 브랜치 존재가 아니라
   **그 커밋 자체**가 실렸는지. 오늘 PO가 `--branches` 오스코프로 걸린 함정과 같은 급의 실수를
   막는 게 이 체크의 존재 이유)
3. 머지 확定 — `origin/develop` 조상관계 **또는** `gh pr list --state merged --head <branch>`
   (OR 조건 필수: squash-merge된 브랜치는 조상관계로 안 잡힌다 — 실측:
   `feature/1cb4ef97-goal-form`·`feature/5a9766eb-loop-board-ui` 둘 다 GitHub상 MERGED인데
   `git merge-base --is-ancestor`는 UNMERGED로 오판)

AC3(일회 docker 잔존 방지) — `--apply` 시 회수 대상 worktree에 `docker-compose.yml`이 있으면
`git worktree remove` **전에** `docker compose down --volumes --remove-orphans`를 먼저 부른다
(best-effort — 데몬이 죽어있어도 worktree 회수 자체는 막지 않음).

### `check-disk-usage.sh`

디스크 사용률 임계 초과 탐지(관측만 — 어디로 알릴지는 cron 배선 쪽 몫).

```sh
scripts/check-disk-usage.sh                       # 기본 90%, /System/Volumes/Data(macOS)
scripts/check-disk-usage.sh --threshold 85 --mount /
```

`exit 0`=정상 / `exit 2`=임계 초과(경보 트리거) / `exit 1`=측정 실패. stdout에 JSON 한 줄
(`{"mount":...,"used_percent":N,"threshold":N,"alert":bool}`) — cron 래퍼가 파이프로 소비.

## 테스트

`reclaim-merged-worktrees.test.sh`·`check-disk-usage.test.sh` — 진짜 sprintable 레포를 안
건드리고 `/tmp`에 합성 git 원격+worktree로 5개 시나리오(머지-ancestor/머지-squash/dirty/
unpushed/unmerged)를 재현해 KEEP/RECLAIM 판정을 **실행 결과로** 잰다(AC4 음성대조 포함).

```sh
bash scripts/reclaim-merged-worktrees.test.sh
bash scripts/check-disk-usage.test.sh
```

## 배선 전 권장 순서 (PO 몫, 참고용)

1. **첫 실행은 반드시 dry-run**으로 실제 레포에 돌려 판정 목록을 사람이 한 번 훑는다(200+ ·
   391개 규모라 예상 밖 KEEP/RECLAIM이 있는지 육안 확인 가치가 있다).
2. dry-run 결과가 납득되면 `--apply`를 cron/launchd에 등록.
3. `check-disk-usage.sh`를 짧은 주기(예: 30분)로 돌려 임계 초과 시 fleet 채널로 포워딩.

## AC5 — 재확인 시점

cron 등록 완료 시점 기준 **7일 후** 1회, `git worktree list | wc -l` 규모가 재축적 없이
안정(신규 스토리 착수분 외 잔재 0)됐는지 재확인한다. PO가 등록 시점을 알려주면 그 +7일에
재확인 요청 바람.
