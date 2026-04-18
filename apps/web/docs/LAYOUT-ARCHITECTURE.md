# Layout Architecture

레이아웃 컴포넌트 역할·책임·규칙 기준 문서.
S2~S7 코드 수정 시 이 문서를 기준으로 삼는.

---

## 1. OperatorShell

**파일**: `src/components/nav/operator-shell.tsx`

전역 네비게이션 쉘. 인증된 모든 페이지를 감싸는 최상위 레이아웃 컴포넌트.

### 구성 영역

| 영역 | 컴포넌트/위치 | 표시 조건 |
|------|-------------|----------|
| **Header** | `GlassPanel` sticky (line 238) | 항상 |
| **Desktop Sidebar** | `aside` with `GlassPanel` (line 117) | `hidden lg:flex` |
| **Main Content Area** | `flex-1 flex-col` (line 237) | 항상 |
| **Mobile Bottom Nav** | `GlassPanel grid grid-cols-5` (line 303) | `lg:hidden` |

### 색상 규칙

- 모든 색상은 `--operator-*` CSS 변수 사용
- `bg-gray-*`, `text-gray-*` 등 Tailwind 하드코딩 **금지**
- 허용 변수 목록:
  - `--operator-foreground` / `--operator-muted`
  - `--operator-surface-soft` / `--operator-surface`
  - `--operator-primary` / `--operator-primary-soft`
  - `--operator-border`

### 패딩 규칙

```
OperatorShell Main Wrapper: px-3 pt-3 (sm:px-4 lg:px-5)
Header (GlassPanel):        px-4 py-3  — Header 자체만 담당
Desktop Sidebar:            px-4 py-6  — Sidebar 자체만 담당
Mobile Bottom Nav:          px-2 py-2
```

**하위 Page Shell은 OperatorShell 패딩에 추가 패딩 중첩 금지.**

---

## 2. Header

**위치**: `OperatorShell` 내부, `GlassPanel sticky top-3`

프로젝트 컨텍스트(좌측) + 유틸리티 아이콘(우측) 영역.

### 책임

- 현재 프로젝트 표시 및 전환 (ProjectSwitcher)
- 모바일: 프로젝트 switcher (`lg:hidden` 영역에서 직접 노출)
- 유틸리티: 검색, 로케일, 메모, 받은편지함, 설정

### 패딩 규칙

- Header 자체: `px-4 py-3`
- Header 안에서 추가 수평 패딩 중첩 금지

### 색상 규칙

- `GlassPanel` 배경 사용 (operator CSS vars 적용됨)
- 아이콘 버튼: `OperatorIconButton` 컴포넌트 사용

---

## 3. GNB (Mobile Bottom Navigation)

**위치**: `OperatorShell` 내부 하단, `lg:hidden`

**파일**: `src/components/nav/operator-shell.tsx` (line 303~)

모바일 전용 메인 섹션 전환 탭바.

### 책임

- 핵심 5개 섹션 전환: Dashboard / Agent / Kanban / Docs / Inbox
- 현재 활성 섹션 하이라이트
- iOS/Android safe-area 대응

### 규칙

```
터치 타겟:  min-h-[44px] (현재 준수 중)
항목 수:    5개 고정
safe-area:  padding-bottom + env(safe-area-inset-bottom) 필수
색상:       --operator-* CSS vars만 사용
```

---

## 4. Page Shell 계열

OperatorShell이 제공하는 Main Content Area 안에서 동작하는 페이지별 사이드바/드로어.

### 4-1. MemoSidebar

**파일**: `src/components/memos/memo-sidebar.tsx`

오른쪽에서 슬라이드인되는 전체화면 드로어 (모바일: `fixed inset-0`, 데스크톱: `md:w-[88vw]`).

**현재 위반**: `bg-white`, `border-gray-200`, `text-gray-*` 하드코딩 다수 (→ Appendix A 참조).

### 4-2. DocsShellClient

**파일**: `src/app/(authenticated)/docs/docs-shell-client.tsx`

좌측 트리 사이드바 + 우측 에디터/뷰어 분할 레이아웃.

**현재 위반**: `bg-gray-900`, `border-gray-800`, `px-6` 초과 패딩 사용 (→ Appendix A 참조).

### 4-3. SettingsSidebar

**파일**: `src/components/settings/settings-sidebar.tsx`

설정 페이지 좌측 네비게이션 패널. `--operator-*` vars 사용 — **준수 중**.

### 4-4. ContextualPanelLayout

**파일**: `src/components/ui/contextual-panel-layout.tsx`

우측 컨텍스트 패널 드로어. `bg-black/55` 오버레이만 사용 — **준수 중**.

### Page Shell 공통 규칙

```
자체 수평 패딩:  모바일 px-2~3 / 데스크톱 px-4~6
색상:           --operator-* CSS vars 사용
배경:           GlassPanel 사용 권장
OperatorShell 패딩과 중첩 금지
```

---

## 5. 색상 규칙 (전체 요약)

| 허용 | 금지 |
|------|------|
| `text-[color:var(--operator-foreground)]` | `text-gray-900` |
| `bg-[color:var(--operator-surface-soft)]` | `bg-gray-50` / `bg-white` |
| `border-[color:var(--operator-border)]` | `border-gray-200` / `border-gray-800` |
| `text-[color:var(--operator-muted)]` | `text-gray-400` / `text-gray-500` |

예외: `internal-dogfood` 페이지는 internal 전용이므로 gray-* 허용.

---

## 6. 패딩 규칙 (전체 요약)

### 모바일 수평 패딩 총량 기준 (< lg)

```
OperatorShell wrapper:  px-3  = 12px × 2
Page Shell 내부:        px-2  = 8px × 2  (최대 px-3)
─────────────────────────────────────────
합계:                   40~44px  (기준 32px 이내 목표, 현재 협의치)
```

### 중첩 금지 패턴

```
❌ OperatorShell(px-3) > PageShell(px-4) > Content(px-4)  → 총 44px 초과
✅ OperatorShell(px-3) > PageShell(px-2) > Content(0)     → 총 28px
```

---

## Appendix A: 현재 위반 사항

### A-1. gray-* 하드코딩 위반처

| 파일 | 위반 유형 | 라인 (주요) |
|------|----------|-----------|
| `components/memos/memo-sidebar.tsx` | `border-gray-200`, `bg-gray-50`, `bg-white`, `text-gray-*` | 203, 208, 215, 228, 236, 242 |
| `components/memos/memo-feed.tsx` | `divide-gray-800`, `bg-gray-800`, `text-gray-100/400/500` | 29, 57~58, 65, 69, 81 |
| `components/memos/memo-thread.tsx` | `border-gray-800`, `bg-gray-800`, `text-gray-*` | 59, 121, 176, 184 |
| `app/(authenticated)/docs/docs-shell-client.tsx` | `bg-gray-900`, `border-gray-800`, `text-gray-*` | 392, 393, 424, 430, 474 |
| `app/(authenticated)/memos/memos-feed-client.tsx` | `border-gray-800`, `bg-gray-900`, `text-gray-400` | 191, 192, 213 |
| `components/ui/route-error-state.tsx` | `bg-gray-50`, `text-gray-*`, `border-gray-300` | 27, 30, 33, 47 |
| `components/ui/upgrade-modal.tsx` | `text-gray-900`, `border-gray-300`, `text-gray-700` | 18, 19, 24 |
| `components/ui/toast.tsx` | `border-l-gray-300`, `text-gray-900`, `text-gray-400/600` | 26, 32, 39 |
| `components/ui/page-skeleton.tsx` | `bg-gray-200` | 17, 22, 29 |
| `components/settings/ai-settings.tsx` | `text-gray-700`, `text-gray-500`, `text-gray-600` | 148, 151, 168 |
| `components/locale-switcher.tsx` | `text-gray-500`, `text-gray-600`, `hover:bg-gray-100` | 26, 35 |

### A-2. 패딩 초과 위반처

| 파일 | 위반 내용 | 라인 |
|------|----------|------|
| `app/(authenticated)/docs/docs-shell-client.tsx` | `px-6 py-4`, `px-6 py-6` (데스크톱 상세 패널) | 439, 450, 494, 517 |

### A-3. Page Shell 배경색 미준수

| 파일 | 현재 배경 | 권장 |
|------|----------|------|
| `components/memos/memo-sidebar.tsx` | `bg-white` (하드코딩) | `GlassPanel` 또는 `var(--operator-surface)` |
| `app/(authenticated)/docs/docs-shell-client.tsx` | `bg-gray-900` (하드코딩) | `var(--operator-surface)` |
