'use client';

import {
  ToastContainer as StackContainer,
  useToastLifecycle,
  type ToastItem,
} from '@/components/ui/toast';
import { ToastCard, type ToastKind } from './toast-card';

// 하나의 Context — 제공자(`ToastProvider`)와 훅(`useToast`)은 옛 `ui/toast`의 것을 그대로 다시 내보낸다. 두 곳에 두면 목록이 둘로 갈려
// 한 화면에서 토스트 스택이 둘이 된다(story #3759가 막으려던 것). 화면 주인은 임포트를 이 파일로 바꾸는 것만으로 같은 API를 쓴다.
export { ToastProvider, useToast } from '@/components/ui/toast';
export type { ToastItem, ToastAction, ToastCloseReason } from '@/components/ui/toast';

/** 옛 type(success · info · warning · error · isHighlight)을 doc v0.3 #19의 세 종으로: 오류 = error · 되돌리기(동작 단추가 붙은 것) = undo · 그 밖 = info. */
function kindOf(item: ToastItem): ToastKind {
  if (item.type === 'error') return 'error';
  if (item.action) return 'undo';
  return 'info';
}

function DsToast({ item, onDismiss }: { item: ToastItem; onDismiss: (id: string) => void }) {
  const { close, holdProps } = useToastLifecycle(item, onDismiss);
  const { action } = item;
  return (
    <ToastCard
      kind={kindOf(item)}
      title={item.title}
      body={item.body}
      bodySingleLine={item.bodySingleLine}
      actionLabel={action?.label}
      onAction={action ? () => { action.onClick(); close('action'); } : undefined}
      onDismiss={() => close('dismiss')}
      holdProps={holdProps}
    />
  );
}

/**
 * UI-3(a9d56577) 토스트 쌓기 — doc v0.3 #19. 옛 `ui/toast`의 `ToastContainer`와 같은 쌓는 구조(최신 한 장 shrink-0 · 오래된 것은 서브스택)와
 * 같은 수명(5초 · 되돌리기 8초 · 포인터/초점 붙잡기 · onClose 까닭 한 번 · 다섯 장까지)이고, 카드만 ds `ToastCard`다.
 * 셸의 BottomDock이 옛 컨테이너 대신 이것을 그리면 바뀐다(셸 주인 몫 — 이 PR은 부품만).
 */
export function ToastContainer({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: string) => void }) {
  return <StackContainer toasts={toasts} onDismiss={onDismiss} renderItem={(item, dismiss) => <DsToast item={item} onDismiss={dismiss} />} />;
}
