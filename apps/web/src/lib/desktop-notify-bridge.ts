// 데스크톱 셸(sprintable-desktop) ↔ 웹 브릿지 — story #3074(민 레포 bridge-init.js+commands.rs
// 실물 확인, 페드루 전달). 모바일 native-shell-bridge.ts(window.ReactNativeWebView)와는 완전히
// 별개 계약 — 이쪽은 top-frame+정확 origin에서만 window.__sprintableBridge가 non-enumerable·
// writable=false로 노출된다(일반 브라우저·iframe에서는 항상 undefined).

export interface DesktopNotifyPayload {
  /** 앱이 event_type→고정 렌더한다 — title은 이 계약에 없다(자유문 제목은 설계상 무시). */
  event_type?: string;
  body: string;
  /** 앱 쪽 allowlist 검증(예: "/inbox?tab=gates") — 거부되면 반환값이 false. */
  deeplink_path: string;
}

declare global {
  interface Window {
    __sprintableBridge?: {
      notify_show(payload: DesktopNotifyPayload): Promise<boolean>;
    };
  }
}

/** Tauri IPC(rename_all)가 camelCase를 전건 거부하므로 payload 키는 반드시 snake_case. */
export function hasDesktopNotifyBridge(): boolean {
  return typeof window !== 'undefined' && typeof window.__sprintableBridge?.notify_show === 'function';
}

export function notifyViaDesktopBridge(payload: DesktopNotifyPayload): Promise<boolean> {
  return window.__sprintableBridge!.notify_show(payload);
}
