# Contrast Guard (story #2590)

색상 대비(WCAG AA) 회귀를 두 층으로 막는다. 정적 프리필터 (A) 가 값싸게 넓게 훑고,
런타임 axe 가드 (B) 가 실제 렌더된 픽셀을 최종 판정한다. 이 문서는 두 층의 계약과 —
특히 **두 층이 무엇을 못 잡는지(AC4)** — 를 한자리에 선언한다. 다음 사람이 "대비는 다
가드가 본다"로 오독하지 않게 하기 위함이다.

## 왜 두 층인가

- **(A) 정적 프리필터** `apps/web/scripts/verify-cross-element-tint-text.ts`
  — TSX 소스를 AST 로 파싱해 "조상 요소가 pale(tint) 배경, 자식 요소가 계열색 글자"인
  교차-요소 조합을 코드 정의 시점에 잡는다. 브라우저가 없어 빠르고 결정적이라 모든 PR 에서
  돈다. 그러나 정적이라 **원리적으로 못 재는 것**이 있다(아래 AC4). 그게 (B) 의 존재 이유다.

- **(B) axe 런타임 가드** `apps/web/e2e/contrast-guard.spec.ts`
  — 실제로 렌더된 페이지를 `@axe-core/playwright` 의 `color-contrast` 룰로 재 실 픽셀 대비를
  측정한다. 교차-요소·교차-계열·알파 합성·상태(hover)·앞으로 생길 자리까지 실 맥락에서
  전수한다. **충돌 시 (B) 가 최종 authority** — (A) 가 잡았어도 (B) 가 통과 판정하면 그 자리는
  통과다(그리고 (A) 쪽에 `// tint-guard-ok: <이유>` 를 단다).

## (A) 정적 프리필터 — 계약

- 실행: `pnpm --filter web verify:cross-element-tint-text` (CI `ci` 잡, 자매 정적 대비 가드
  `verify:tint-foreground-contrast`·`verify:muted-foreground-contrast` 옆).
- baseline: `apps/web/scripts/cross-element-tint-text-baseline.json` — grandfather 목록.
  지금 "있는" 조합은 실패시키지 않고 baseline 밖의 **새** 자리만 빨간불. baseline 은
  develop 기준으로 시드했으며 **can only shrink**(채무를 갚으면 줄고, 새 채무는 못 는다).
- 측정 규칙(감사 실측 유래, #2420):
  - ① `text-warning` + 조상 pale = 항상 결함(라이트 2.0 대·아이콘조차 <3.0).
  - ② `text-{success|info|destructive}` + 작은 글자(<18px·非아이콘) + 강한-tint 조상 = 결함.
  - 제외(오탐 방지): 아이콘(svg/size-only)·옅은 muted/N 래퍼(4.5+ 통과)·큰 글자(≥18px).
- 오탐 밸브: `// tint-guard-ok: <이유>`(이유 필수·grep 가능). 이유 없는 suppress 는 통과 안 됨.

## (B) axe 런타임 가드 — 계약

- 실행: `pnpm --filter web e2e:contrast`(= `playwright test contrast-guard.spec.ts`).
  CI 에서는 authed DB 잡(postgres + alembic + owner 시드 → FastAPI + Next 서빙 → chromium)에서
  돈다. 인증은 `e2e/global-setup.ts` 가 `owner@sprintable.dev` 로그인 후 `playwright/.auth/owner.json`
  storageState 를 만든다(파일은 `.gitignore`, 생성 로직만 커밋).
- v1 스코프: **데이터-경량 표면** × 두 테마 × **rest 상태**.
  - 페이지: `/settings`, `/onboarding`, `/dashboard`, `/inbox`.
  - **hover 상태는 v2로 미룸** — 40개 인터랙티브를 훑어 hover마다 스캔하는 방식이 비결정적이었다
    (첫 CI 런 실측: 같은 표면이 run 2엔 위반·run 3엔 통과). 게이트는 결정적이어야 하므로(flaky
    게이트는 무시당해 가드보다 못함) hover는 «특정 known 요소 대상 결정적 스캔»으로 v2 재도입.
  - 데이터-무거운 `flow`/`kanban` 은 CI 시드 대 nightly 비용을 관측한 뒤 조절.
- **키 = `page::theme::색쌍(fg/bg)`** — axe의 CSS 셀렉터(`node.target`)는 클래스 순서가 런마다
  뒤바뀌어(`​.pt-4.pb-1` ↔ `.pb-1.pt-4`) 비결정적이라 키에서 뺐다. 색쌍은 위반의 결정적 정체다.
- baseline: `apps/web/e2e/contrast-axe-baseline.json` — 첫 CI 런(rest)이 드러낸 현 위반(settings의
  `text-muted-foreground` 알파 변형 저대비 2색쌍)을 grandfather로 시드. 이후 baseline 밖
  **새 색쌍**만 빨간불(자매 정적 가드와 같은 can-only-shrink 계약).

## AC4 — 이 가드가 **못** 잡는 것 (명시 선언)

이 두 층을 합쳐도 "대비 전부 커버"가 아니다. 아래는 의도된 사각지대다.

1. **(A) 가 원리적으로 못 보는 것** — (B) 로 넘어간다:
   - 조건부 조상(`cn(cond && 'bg-tint')` 처럼 항상 적용이 보장 안 되는 배경).
   - 컴포넌트 경계를 넘는 배경(`<Alert>`·`SectionCard` 헤더·Button hover-variant 등 다른 파일).
   - **자식 요소가 불투명 배경을 재설정하는 경우**(예: 조상 `bg-info/10` 아래 자식이 `bg-card`
     배지) — (A) 는 조상 tint 만 보고 자식의 불투명 재설정을 모델링하지 않아 **오탐**한다.
     현재 develop 에 그런 자리 1건(`components/org-briefing/attention-cluster-board.tsx` 배지)이
     있고 baseline 에 grandfather 되어 있다. 이 자리는 (B) axe 가 실 픽셀로 최종 판정한다.
2. **(B) 도 못 보는 것**:
   - v1 페이지 목록 밖 화면.
   - org 데이터가 있어야만 렌더되는 tint 표면(데이터-무거운 flow/kanban — v1 미포함).
   - **hover 등 상호작용 상태** — v1 미포함(검출 비결정성 때문·위 참조), v2 예정.
   - **같은 색쌍의 다른 인스턴스** — 키가 색쌍이라 접힌다. 새 «색쌍»(진짜 새 대비 버그)은 잡지만,
     이미 baseline에 있는 색쌍이 새 자리에 또 쓰이면 안 잡는다(그 색쌍은 이미 알려진 토큰 채무).
   - **색맹 대비** — axe `color-contrast` 는 명도(luminance)만 잰다. 색상 구분(빨/초 등)은 안 잰다.

## (A) ↔ (B) 요약

| | (A) 정적 | (B) axe 런타임 |
|---|---|---|
| 대상 | TSX 소스(AST) | 렌더된 실 픽셀 |
| 비용 | 값쌈(모든 PR) | 무거움(authed DB 잡) |
| 범위 | 교차-요소 tint×계열색 | 교차-요소·교차-계열·알파(rest·hover는 v2) |
| 권위 | 프리필터 | **최종 authority**(충돌 시 (B) 승) |
| baseline | 21건 시드(develop) | 2색쌍 시드(settings·첫 런) |
