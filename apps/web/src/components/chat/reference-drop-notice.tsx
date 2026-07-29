'use client';

import { X } from 'lucide-react';
import { useTranslations } from 'next-intl';

/**
 * story #2294 AC8/AC9/AC11 — 메시지 전송 응답 최상위(`data`의 형제, `conversations.py:2165`)
 * `references.dropped[]` 1건. BE는 `target_type`/`target_id`만 준다 — FE는 그것으로 **분기하지
 * 않는다**(분기하면 그 자체가 "화면이 종류를 아는 것"이 되어 AC9 "종류-무관"이 깨진다). 그래서
 * 이 타입엔 일부러 target_type을 안 실었다 — 개수만 센다.
 */
export interface DroppedReference {
  target_type: string;
  target_id: string;
}

/**
 * 메시지 전송 raw 응답(최상위, `data` 아님 — command_gate와 같은 자리)에서 dropped 배열만
 * 안전하게 뽑는다. 순수 함수로 분리한 이유는 chat-view.tsx가 useDashboardContext/SSE 등
 * 컨텍스트가 많아 풀 렌더 테스트 비용이 커서(storage-view.tsx의 resolveAssetDeepLinkAction과
 * 동일 이유) — 형상이 어긋나면(구버전 응답·프록시 미갱신 등) 조용히 빈 배열로 폴백한다(throw 0).
 */
export function parseDroppedReferences(raw: unknown): DroppedReference[] {
  if (!raw || typeof raw !== 'object') return [];
  const references = (raw as { references?: unknown }).references;
  if (!references || typeof references !== 'object') return [];
  const dropped = (references as { dropped?: unknown }).dropped;
  if (!Array.isArray(dropped)) return [];
  return dropped.filter((d): d is DroppedReference =>
    Boolean(d) && typeof d === 'object'
    && typeof (d as { target_type?: unknown }).target_type === 'string'
    && typeof (d as { target_id?: unknown }).target_id === 'string');
}

/**
 * 낙관적으로 링크만 그리고 저장 결과를 확認하지 않던 침묵(AC8)을 깨는 알림 — 트리거 메시지
 * 바로 아래(command-hint-notice.tsx와 동일 위치·동일 inset 톤). ⛔종류별 문구 없음(AC9) — 몇 건이
 * 떨어졌는지만 말하고, 무엇이었는지는 말하지 않는다(그건 화면이 아니라 사람이 기억한다 —
 * "방금 내가 걸려던 것" 문맥은 사용자가 갖고 있다).
 */
export function ReferenceDropNotice({ dropped, onDismiss }: { dropped: DroppedReference[]; onDismiss: () => void }) {
  const t = useTranslations('chats');
  if (dropped.length === 0) return null;
  const lead = dropped.length === 1 ? t('referenceDropNotice') : t('referenceDropNoticeCount', { count: dropped.length });
  return (
    <div className="mx-2 flex items-start gap-2.5 rounded-xl border border-warning-border bg-warning-tint px-3.5 py-2.5">
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-sm text-foreground">{lead}</p>
        <p className="text-sm text-muted-foreground">{t('referenceDropRetryHint')}</p>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 text-muted-foreground hover:text-foreground"
        aria-label="닫기"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
