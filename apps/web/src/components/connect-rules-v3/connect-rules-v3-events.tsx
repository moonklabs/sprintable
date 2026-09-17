'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { CountBadge } from '@/components/ui/count-badge';
import { fetchWithAuth } from '@/lib/db/client';
import {
  ConnectRulesV3SectionEmpty,
  ConnectRulesV3SectionError,
  ConnectRulesV3SectionSkeleton,
} from './connect-rules-v3-section-state';

/**
 * story #3985(E-UX-OVERHAUL·「연결·규칙」 흡수 2편) — 시안 ⑤ 「이벤트·자동화」 진입·요약
 * 절. 콘텐츠 규칙 아래, 편집은 여전히 `/organization/events`(무접촉) — 여기는 진입·요약만.
 *
 * AC1 그라운딩(코드 前 필수, PR 본문 동일 인용) — `GET /api/events/definitions`
 * (organization/events/page.tsx가 이미 부르는 그 콜)의 각 정의는 `org_id`를 갖고,
 * 그 화면 자신이 이미 `org_id === null`→기본 제공(`presetDefs`)·`org_id !== null`→
 * 내가 만든 것(`customDefs`)으로 가른다(같은 술어 재사용, 새 판정식 0). 반면 「켜진
 * 워크플로 프리셋 이름」의 실 출처는 없다 — `workflow-line-config/active`
 * (ActiveLineResponse: entity_type·has_active·definition_id·config만, 이름 필드 0)도
 * `versions`(VersionResponse: version 정수·config_hash뿐, name 필드 0)도 사람이 읽을
 * "프리셋 이름"을 안 준다. **출처 없음** — 이 줄은 그리지 않는다(지어내기 0).
 */
interface EventDefinitionListItem {
  org_id: string | null;
}

export function ConnectRulesV3Events({ orgId }: { orgId: string }) {
  const t = useTranslations('connectRulesV3');
  const to = useTranslations('organization');
  const [defs, setDefs] = useState<EventDefinitionListItem[] | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'error' | 'ready'>('loading');
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoadState('loading');
      try {
        const res = await fetchWithAuth('/api/events/definitions');
        if (!res.ok) {
          if (!cancelled) setLoadState('error');
          return;
        }
        const json = await res.json() as EventDefinitionListItem[] | { data?: EventDefinitionListItem[] };
        if (cancelled) return;
        setDefs(Array.isArray(json) ? json : (json.data ?? []));
        setLoadState('ready');
      } catch {
        if (!cancelled) setLoadState('error');
      }
    })();
    return () => { cancelled = true; };
  }, [orgId, retryKey]);

  if (loadState === 'loading') return <ConnectRulesV3SectionSkeleton rows={2} />;
  if (loadState === 'error') return <ConnectRulesV3SectionError onRetry={() => setRetryKey((k) => k + 1)} />;

  const customCount = (defs ?? []).filter((d) => d.org_id !== null).length;
  const presetCount = (defs ?? []).filter((d) => d.org_id === null).length;

  return (
    <div className="space-y-2">
      {!defs || defs.length === 0 ? (
        <ConnectRulesV3SectionEmpty title={t('eventsAutomationEmptyTitle')} />
      ) : (
        <>
          <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-3 py-2.5 text-sm">
            <span className="font-medium text-foreground">{to('eventsCustomGroupTitle')}</span>
            <CountBadge count={customCount} />
          </div>
          <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-3 py-2.5 text-sm">
            <span className="font-medium text-foreground">{to('eventsPresetGroupTitle')}</span>
            <CountBadge count={presetCount} />
          </div>
        </>
      )}
      <Link href="/organization/events" className="inline-block text-xs font-medium text-primary hover:underline">
        {t('goToEventsLink')}
      </Link>
    </div>
  );
}
