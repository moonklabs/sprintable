# OSS / SaaS 레포 물리 분리 전략 (OpenCore)

## 배경 · 문제 정의

### 현재 상태 (2026-04-17 실측)

Sprintable 은 단일 `github.com/moonklabs/sprintable` 레포에 OSS 코어와 상업 SaaS 기능을 섞어서 보관. OpenCore 전략을 선언한 상태지만 **실제 경계는 문서에만 존재**.

| 범주 | 파일 수 | 위치 |
|---|---|---|
| Billing TS/TSX 소스 | 56 | `apps/web/src/app/api/billing/**`, `apps/web/src/app/settings/billing/**`, state stores |
| Billing DB 마이그레이션 | 8 | `supabase/migrations/*_billing_*.sql`, `*_subscriptions_*.sql`, `*_entitlements_*.sql` |
| Billing API 라우트 | 4 | `/api/billing`, `/api/v1/billing`, `/api/subscription`, `/api/webhooks/payment` |
| Billing UI 페이지 | 1+ | `apps/web/src/app/settings/billing/**` |

(실측: `rg -l "paddle|billing|entitlement|subscription" apps/web/src`, `ls supabase/migrations | grep -E "billing|subscription|entitlement"`)

### 경계 문제의 본질

문서·주석으로 "이건 OSS / 이건 Free / 이건 Paid" 라벨을 붙여도 경계는 만들어지지 않는다. 소스 전체가 public 레포에 있으면:

- 누구나 clone 해서 billing·entitlement 로직 그대로 재사용 가능
- AGPL 경계·라이선스 판단 불가능 (상업 코드가 공개 레포 히스토리에 영구 기록)
- contributor 에게 "건드려도 되는 영역" 신호 부재

**OpenCore 는 레포 물리 분리로만 성립한다.** 문서는 분리의 결과물이지 경계 자체가 아니다.

## 목표 상태

### 레포 2개 분리

#### A. `github.com/moonklabs/sprintable` (public, OSS, AGPL-3.0)

- Core workflow 엔진 (스토리·에픽·스프린트·태스크·메모)
- MCP 서버 프레임 + stdio harness
- Agent 프레임워크 (Ortega/은와추쿠/까심군 역할 인터페이스)
- 공용 UI 컴포넌트·인증 기본 (Supabase Auth)
- Self-host 문서 (`docs/self-hosting.md`)
- 공개 contributor 대상

#### B. `github.com/moonklabs/sprintable-saas` (private, 신규)

- Billing (Paddle integration, webhook handler)
- Entitlement resolver·미들웨어
- Usage metering (agent_runs, quota)
- Billing UI 페이지 (plan picker, invoice)
- Admin tools (org management, impersonation)
- 상업 전용 feature flag 훅
- moonklabs 내부 전용

### 공통 배포 방식

Vercel production (`sprintable.vercel.app`) 배포 시 두 레포 결합. 선택지:

#### Option 1: git submodule

- public 레포 안에 `.gitmodules` 로 private 레포 참조
- Vercel 빌드 시 `GITHUB_TOKEN` 으로 submodule 체크아웃
- **장점**: 구조 단순, 레포 간 결합 명시적
- **단점**: submodule 업데이트·pin 관리 번거로움, OSS cloner 가 실수로 submodule 포함 가능

#### Option 2: 별도 monorepo (workspace, private 전용)

- 또 다른 private 레포 `sprintable-production` 에 두 레포를 pnpm workspace 로 통합
- public `sprintable` 은 open-source 만, private `sprintable-saas` 는 상업만
- `sprintable-production` 은 deploy target (Vercel 연동 대상)
- **장점**: 각 레포 깨끗, 배포 책임 분리
- **단점**: 레포 3개로 증가, CI 복잡

#### Option 3: pnpm workspace + private npm package

- public `sprintable` 이 `package.json` 에 optional `@moonklabs/billing` 의존성
- private 패키지 레지스트리 (GitHub Packages or npm private) 에 publish
- 상업 배포: `@moonklabs/billing` 포함, OSS 빌드: stub interface 만
- **장점**: 인터페이스·계약 수준만 OSS 노출. 패키지 보안 가능
- **단점**: 패키지 버저닝·배포 파이프라인 추가

**권장**: **Option 1 (submodule)** — 구조 단순함·즉시 실행 가능. Option 3 은 초기 인터페이스 추출 비용 큼. 일단 submodule 로 분리·실행 → 운영 경험 축적 후 Option 3 으로 진화.

## Phase 실행 계획

### Phase A: 사전 설계 · private 레포 스캐폴드 (3~5 SP)

1. `github.com/moonklabs/sprintable-saas` (private) 레포 생성
2. 초기 `package.json`, `README.md`, `tsconfig.json` 스캐폴드
3. `apps/web/src` 하위 billing·entitlement 파일 목록 확정 (실측 리스트 고정)
4. Vercel 빌드 설정 변경 계획서 작성 (submodule 포함 방식)
5. `.gitmodules` 설계 및 `GITHUB_TOKEN` permission 계획

### Phase B: 코드 물리 이관 (5~8 SP)

1. private 레포에 `sprintable` 의 billing 관련 파일 **`git mv` 후 커밋** (이력 보존)
2. public 레포에서 해당 파일 **삭제 PR** (단, 결합 경로 imports 정리 필요)
3. public 레포 코어에서 billing 기능 호출 지점을 interface/stub 로 전환
4. 핵심 smoke: public 레포 단독 빌드·테스트 통과 (billing 없이도 core 작동)

### Phase C: Vercel 프로덕션 빌드 재구성 (2~3 SP)

1. Vercel 프로젝트에 submodule fetch 권한 설정 (`GITHUB_TOKEN` 또는 deploy key)
2. `.gitmodules` 커밋 (public 레포 → private submodule 참조)
3. production 배포 파이프라인 테스트 (preview → production)
4. billing · checkout · webhook 전체 플로우 실측 검증

### Phase D: 히스토리 정리 (force push, 선생님 사전 승인 필수)

1. `git-filter-repo` 로 public 레포 히스토리에서 billing 관련 변경 완전 제거
2. 기존 public 포크·PR 깨짐 검토 (외부 contributor 있을 경우 사전 공지)
3. force push 실행 (`--force-with-lease`)
4. 브랜치 보호 규칙 갱신

**Phase D 는 독립 판단 영역.** force push 는 선생님 명시 승인 없이는 절대 실행하지 않음. Phase A~C 만으로도 신규 개발·contribute 는 깨끗하게 분리됨. D 는 법무 검토 또는 정책적 필요 발생 시 추가 실행.

## 리스크 · 완화

| 리스크 | 영향 | 완화 |
|---|---|---|
| OSS cloner 가 결제 기능 기대 | 기능 부재 혼란 | public README 에 OpenCore 원칙 명시 + self-host 는 core 만 |
| submodule 누락으로 Vercel 빌드 실패 | 프로덕션 다운 | staging 선검증, rollback 준비 (이전 커밋 revert) |
| private 레포 접근 권한 실수 | 상업 코드 유출 | org-level private 강제, deploy key 스코프 제한 |
| git history 오염 잔존 (Phase D 보류 시) | 라이선스·법무 리스크 | Phase D 는 법무 검토 트리거 될 때 실행 |
| billing 호출 지점 interface 추출 누락 | public build 실패 | Phase B 에서 단독 빌드 smoke 필수 |

## 비범위

- CONTRIBUTING 문서 작성 (Phase A~C 완료 후 별도 스토리로 추가)
- AGPL 경계 법무 판단 (Phase D 와 동시에 별도 트랙)
- 결제 UX/플로우 개선 (분리와 무관한 별도 에픽)

## 에픽 매핑

- 기존 `E-OSS-SEPARATION` → **`E-OSS-SPLIT-REPO`** 로 리네임 (문서 정리가 아닌 레포 분리가 본질)
- Phase A~D 각각 독립 스토리
- 우선순위: high (OpenCore 선언의 실현, 외부 contributor 유입 전 필수 전제)

## 의사결정 요청 (선생님 허락 필요 항목)

1. Option 1 (submodule) vs Option 3 (npm package) 최종 선택
2. Phase D (history force push) 실행 시점 (Phase A~C 직후 / 법무 검토 후 / 보류)
3. private 레포 이름: `sprintable-saas` 로 확정 여부
4. 이 문서를 `docs/oss-saas-split.md` 로 public 레포에 공개 여부 (OpenCore 전략 자체를 OSS 컨트리뷰터에게 공개할지)

## 다음 단계

- 선생님 본 문서 리뷰 → 피드백/허락
- 허락 시: 은와추쿠 킥오프로 `docs/oss-saas-split.md` 파일 생성 PR → 머지 후 Phase A 스토리 등록
