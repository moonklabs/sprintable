'use client';

import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastItem {
  id: string;
  title: string;
  body?: string;
  type?: 'info' | 'warning' | 'success' | 'error';
  isHighlight?: boolean;
  action?: ToastAction;
}

interface ToastProps {
  item: ToastItem;
  onDismiss: (id: string) => void;
}

function Toast({ item, onDismiss }: ToastProps) {
  const t = useTranslations('common');
  useEffect(() => {
    // action(예: 되돌리기)이 있으면 사용자가 읽고 누를 시간을 더 준다(5s→8s).
    const timer = setTimeout(() => onDismiss(item.id), item.action ? 8000 : 5000);
    return () => clearTimeout(timer);
  }, [item.id, item.action, onDismiss]);

  const borderColor = item.isHighlight
    ? 'border-l-4 border-l-brand'
    : item.type === 'success'
      ? 'border-l-4 border-l-success'
      : item.type === 'warning'
        ? 'border-l-4 border-l-warning'
        : item.type === 'error'
          ? 'border-l-4 border-l-destructive'
          : item.type === 'info'
            ? 'border-l-4 border-l-info'
            : 'border-l-4 border-l-proof-line-strong';

  // story #2096 — 토스트는 조작 결과(담당자 지정 성공 등)를 알리는 유일한 수단인 경우가
  // 많은데 role·aria-live가 없어 스크린리더가 아예 안 읽었다(까심군이 #2384 검수 때 자동으로
  // 못 잡고 스크린샷으로만 확認한 원인). AC2 — error는 사용자가 지금 막힌 상태이므로 다른
  // 작업을 끊고서라도 즉시 알려야 한다(role="alert" → 암묵적 aria-live="assertive"). 나머지
  // (success/info/warning)는 결과 보고일 뿐 흐름을 끊을 만큼 급하지 않다(role="status" →
  // 암묵적 aria-live="polite", 진행 중이던 스크린리더 낭독이 끝난 뒤 자연스럽게 이어 읽는다).
  // aria-live/aria-atomic은 role의 암묵값과 같은 값을 명시로 중복 기술한다 — role의 암묵
  // 라이브리전 매핑을 지원 안 하는 스크린리더/자동화 도구 대비.
  const isUrgent = item.type === 'error';

  return (
    <div
      role={isUrgent ? 'alert' : 'status'}
      aria-live={isUrgent ? 'assertive' : 'polite'}
      aria-atomic="true"
      // story #2969 §2 PR-4(doc proofline-system-layer-2969) — shadow-lg→--elev-overlay·
      // 나머지 3면 hairline을 proof-line-strong으로(좌측은 type별 색이 계속 덮어씀).
      className={`animate-slide-in rounded-lg border border-proof-line-strong bg-popover p-4 shadow-[var(--elev-overlay)] ${borderColor}`}
    >
      <div className="flex items-start justify-between">
        {/* 유나 지적(error-display 폴리시) — 공백 없는 초장문(토큰·URL 등)이 토스트 폭을
            넘어 넘쳐흘렀다. flex 아이템은 기본 min-width:auto라 min-w-0 없이는 안 줄어들고,
            텍스트 자체도 anywhere로 어디서나 끊을 여지를 줘야 한다(break-word는 min-content
            계산에서 여전히 안 줄어드는 경우가 있다). */}
        <div className="min-w-0">
          <p className="text-sm font-semibold text-popover-foreground [overflow-wrap:anywhere]">{item.title}</p>
          {item.body && (
            <p className="mt-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">{item.body}</p>
          )}
        </div>
        <div className="ml-3 flex shrink-0 items-center gap-3">
          {item.action && (
            <button
              type="button"
              onClick={() => { item.action?.onClick(); onDismiss(item.id); }}
              className="text-xs font-semibold text-primary hover:underline"
            >
              {item.action.label}
            </button>
          )}
          <button
            onClick={() => onDismiss(item.id)}
            aria-label={t('close')}
            className="text-muted-foreground hover:text-foreground"
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}

interface ToastContextValue {
  toasts: ToastItem[];
  addToast: (toast: Omit<ToastItem, 'id'>) => void;
  dismissToast: (id: string) => void;
}

// story #3759 — useToast()는 예전엔 호출부마다 독립된 useState였다(31곳 호출부 = 31개
// 서로 안 보이는 토스트 목록). 셸(dashboard-shell.tsx)이 딱 한 번 <ToastProvider>로 감싸고,
// 그 안의 모든 useToast() 호출이 이 하나의 Context를 공유 — addToast 하나면 어디서
// 불러도 같은 목록에 쌓이고, 렌더는 셸의 BottomDock 하나(포털 없음, 트리 그대로 — 위치가
// 이미 셸 최상단이라 포털로 옮길 이유가 없다)만 한다.
const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const addToast = useCallback((toast: Omit<ToastItem, 'id'>) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setToasts((prev) => [...prev.slice(-4), { ...toast, id }]);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const value = useMemo(() => ({ toasts, addToast, dismissToast }), [toasts, addToast, dismissToast]);

  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  // story #3759 — Provider가 있으면(실 앱 — dashboard-shell.tsx가 항상 최상단에서 감쌈)
  // 그 공유 목록을 그대로 쓴다. 아래 로컬 useState/useCallback은 Provider가 «없을 때만»
  // 쓰이는 폴백이지만, 조건부로 훅을 부르면(hooks 규칙 위반) 안 되므로 항상 호출은 하고
  // 값만 고른다 — Provider가 있는 정상 경로에선 이 로컬 상태가 그냥 버려진다(공유 목록이
  // 항상 그 자리를 대신하므로 낭비되는 리렌더 없음, setState가 한 번도 안 불림).
  //
  // 이 폴백이 존재하는 이유: 이 파일 밖 약 39곳의 격리 단위테스트(DashboardShell 없이
  // 컴포넌트 하나만 단독 마운트)가 예전 local-useState 계약을 그대로 가정한다 — 그
  // 자리에서 fail-closed로 죽이면 이 리팩터의 실제 스코프(우하단 배치 통합)와 무관한
  // 파일 39곳을 전부 고쳐야 한다. 실 앱(Provider 항상 有)에서는 이 폴백 경로 자체가
  // 실행되지 않으므로 원래 결함(31곳 분산)은 그대로 해소된 채다 — 폴백은 "테스트
  // 격리 편의"이지 프로덕션 안전판이 아니다.
  const [localToasts, setLocalToasts] = useState<ToastItem[]>([]);
  const localAddToast = useCallback((toast: Omit<ToastItem, 'id'>) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setLocalToasts((prev) => [...prev.slice(-4), { ...toast, id }]);
  }, []);
  const localDismissToast = useCallback((id: string) => {
    setLocalToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);
  if (ctx) return ctx;
  return { toasts: localToasts, addToast: localAddToast, dismissToast: localDismissToast };
}

export function ToastContainer({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
}) {
  if (toasts.length === 0) return null;

  // story #3759 — 예전엔 이 컴포넌트가 직접 position fixed로 우하단에 자리잡았다(호출부
  // 31곳 = 독립된 fixed 좌표 31벌). 지금은 셸의 BottomDock(components/nav 폴더의 dock 컬럼
  // 소유 컴포넌트) 딱 한 곳이 렌더하고, 그 dock 컬럼(fixed 위치+--bottom-dock-inset)의
  // flex 자식으로만 존재한다 — 위치 계산은 컬럼이 갖고, 이 컴포넌트는 순수 레이아웃 없는
  // 카드 스택이다.
  // 컬럼 자체는 pointer-events-none(빈 공간 클릭 통과)이라 실제 카드가 있는 이 자리는
  // pointer-events-auto로 되돌린다.
  return (
    <div className="pointer-events-auto flex flex-col gap-2">
      {toasts.map((t) => (
        <Toast key={t.id} item={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
