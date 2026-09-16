'use client';

import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import type { TodayAgentProgressItem } from '@/components/org-briefing/derive-today';

/**
 * story #3962 CHANGES-2(페드루 PO C1, 2026-09-16 16:08Z) — 시안 ①의 「정지」 자리.
 * story #3961(정지 액션 BE+MCP)이 아직 안 착지해 실행할 API가 없다 — 자리만·비활성
 * 버튼·클릭 0(옛 `today-sections.tsx::AgentProgressSection`엔 이 버튼 자체가 없어
 * 무접촉 원칙대로 v3 전용 새 컴포넌트로 짓는다). 3961 착지 뒤 이 버튼이 활성화되는
 * 자리(별 카드) — 지금은 "곧 돼요" 류 문구를 새로 짓지 않는다(카드 明示 — 자리만).
 */
function AgentProgressRow({ item }: { item: TodayAgentProgressItem }) {
  const t = useTranslations('todayV3');
  return (
    <div className="flex items-center gap-3 border-t border-border px-3 py-3 first:border-t-0" data-testid="today-v3-agent-progress-row">
      <span className="size-2 shrink-0 rounded-full bg-info" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-medium text-foreground">
          {item.workItemTitle ?? item.agentName}
        </span>
        <span className="block truncate text-xs text-muted-foreground">{item.agentName}</span>
      </div>
      <Button
        size="sm" variant="outline" disabled
        className="shrink-0 text-xs"
        data-testid="today-v3-stop-action"
      >
        {t('stopAction')}
      </Button>
    </div>
  );
}

export function TodayV3AgentProgress({ items }: { items: TodayAgentProgressItem[] }) {
  const t = useTranslations('todayV3');
  return (
    <section aria-label={t('progressSectionTitle', { count: items.length })} data-testid="today-v3-progress-section">
      <div className="mb-2.5 flex items-baseline gap-2.5">
        <h2 className="text-sm font-semibold text-foreground">{t('progressSectionTitle', { count: items.length })}</h2>
      </div>
      {items.length === 0 ? (
        <Card className="flex flex-col items-center gap-1.5 px-5 py-10 text-center">
          <p className="text-sm font-medium text-foreground">{t('progressEmptyTitle')}</p>
        </Card>
      ) : (
        <Card>{items.map((item) => <AgentProgressRow key={item.runId} item={item} />)}</Card>
      )}
    </section>
  );
}
