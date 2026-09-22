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
3. 머지 확定 — `origin/develop` 조상관계(단, 4번 ahead-0 가드 통과 시에만 인정) **또는**
   `gh pr list --state merged --head <branch>`
   (OR 조건 필수: squash-merge된 브랜치는 조상관계로 안 잡힌다 — 실측:
   `feature/1cb4ef97-goal-form`·`feature/5a9766eb-loop-board-ui` 둘 다 GitHub상 MERGED인데
   `git merge-base --is-ancestor`는 UNMERGED로 오판)
4. **(story #4137, 2026-09-22 추가)** ahead-0 가드 — `origin/$BASE_BRANCH..$sha` ahead-count가
   0이면 "조상관계"만으로는 머지 확定 판정에 안 넣는다. `git merge-base --is-ancestor`는 (a)
   진짜 머지된 브랜치 **AND** (b) `git worktree add -b <branch> develop`로 막 만든 커밋 0개짜리
   신규 브랜치, 둘 다에 대해 참이 된다 — 현재 git 그래프 상태만으로는 이 둘이 위상적으로
   구분 불가능(순수 그래프 계산의 한계, 증명됨). 이 가드가 없으면 방금 만든 워크트리가 "머지
   완료"로 오판되어 회수당한다(#4135 워크트리 실사고, 2026-09-22 — 작업 착수 前 grounding
   단계에서 회수됨, 데이터 손실은 없었으나 근본원인 미수정 상태였음).
   - **판별 불가 시 결과: KEEP**(사유: `머지 확定 불가: 조상이나 ahead 0·머지 PR 없음`) —
     under-reclaim이 안전 기본값. PO 확인 판단(2026-09-22): 이 조직의 실제 머지 관행은
     100% PR+squash라 진짜 머지 브랜치는 `gh pr merged` 경로로 항상 잡힌다(3번 OR절) — 이
     가드로 인한 실질적 회수 능력 손실은 없음.
   - **⚠️ 지원 경로 아님**: `git merge --no-ff`로 로컬에서 직접 머지하고 GitHub PR을 거치지
     않은 브랜치는(ahead-0 + PR 기록 없음) 영구 KEEP으로 남는다 — 마커 파일 등 git-외부 상태로
     구분하는 방안은 PO가 명시적으로 기각(진입 경로가 too varied해서 강제 불가). 이 조직은
     PR-squash 전용 운영이라 실사용에서 마주치지 않는 케이스.
5. **(story #4137)** bash 4+ 요구 — launchd가 macOS 시스템 `/bin/bash`(3.2)로 이 스크립트를
   돌리면 80행대 `declare -A`(bash 4+ 전용 연관배열)에서 원인불명 exit 2로 조용히 죽는다(실사고:
   cron/reclaim.log에 04:30 매일 실패 기록, 원인 파악까지 지연). 스크립트 최상단에서
   `${BASH_VERSINFO[0]} -ge 4`를 먼저 체크해 미달 시 "bash 4+ 필요(현재 $BASH_VERSION) —
   /opt/homebrew/bin/bash로 실행" 메시지와 함께 **exit 65**로 즉시 종료한다(declare -A 도달 前).
   **launchd/cron 배선 시 반드시 bash 4+ 바이너리 경로(예: `/opt/homebrew/bin/bash`, Homebrew
   설치 5.x)를 명시할 것** — plist 배선 자체는 PO 소관이나, 이 요구사항은 스크립트 쪽 계약.

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
건드리고 `/tmp`에 합성 git 원격+worktree로 6개 시나리오(머지-ancestor(PR 없는 no-ff, KEEP)/
머지-squash/dirty/unpushed/unmerged/신규 커밋-0 브랜치(story #4137 AC1 핵심 재현))를 재현해
KEEP/RECLAIM 판정을 **실행 결과로** 잰다(AC4 음성대조 포함). 이 머신에 `/bin/bash`가 3.2
미만으로 실제 존재할 때 한해 bash-4+ 가드(exit 65 + declare 에러 미노출)도 같은 파일에서
검증한다(story #4137 AC3 — 해당 bash가 없는 환경에서는 skip, FAIL 아님).

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
