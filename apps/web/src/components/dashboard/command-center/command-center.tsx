'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { Loader2, Map } from 'lucide-react';
import { isPending, type MyActions, type Overview } from './types';
import { ActionZone } from './action-zone';
import { OverviewZone } from './overview-zone';
import { derivePhrase } from '@/services/glance';

import { fetchWithAuth } from '@/lib/db/client';

/**
 * E-MODERN [Track C/command-center] 커맨드 센터 — 현 대시보드 위젯 교체. 2구역+헤더.
 * "괜찮다 / 내가 OO 해야" 한눈에. canonical 부품·색=신호·pending_data graceful(mock-0 금지).
 * 데이터: org-scope BE 2엔드포인트(caller 쿠키 resolve·param 불요) + team-members(이름 resolve).
 *
 * ⚠️이 "Track C"는 command-center라는 «조각» 이름이지, E-MODERN 블루프린트
 * (doc: e-modern-modernization-blueprint)의 전략 Track C("UI 갈아엎기" 전체 — 디자인시스템
 * enforcement·god-component 분해·랜딩 편입·alert→ConfirmDialog 등)가 아니다. 같은 글자가
 * 두 다른 체계에서 쓰여 "Track C 했다"가 어느 쪽인지 헷갈리던 것을 정정(2026-07-30) —
 * 이 커맨드 센터는 전략 Track C의 «한 조각»일 뿐, 전체가 아니다.
 */

function unwrap<T>(json: unknown): T | null {
  if (!json || typeof json !== 'object') return null;
  const d = (json as { data?: unknown }).data;
  return (d ?? json) as T;
}

export function CommandCenter({ projectName }: { projectName?: string | null }) {
  const t = useTranslations('dashboard');
  const tGlance = useTranslations('glance');
  const [myActions, setMyActions] = useState<MyActions | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [memberNames, setMemberNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [ma, ov, members] = await Promise.all([
        fetchWithAuth('/api/dashboard/my-actions').then((r) => (r.ok ? r.json() : null)).catch(() => null),
        fetchWithAuth('/api/dashboard/overview').then((r) => (r.ok ? r.json() : null)).catch(() => null),
        fetchWithAuth('/api/team-members').then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ]);
      setMyActions(unwrap<MyActions>(ma));
      setOverview(unwrap<Overview>(ov));
      const names: Record<string, string> = {};
      const rows = (unwrap<{ data?: { id: string; name: string }[] }>(members)?.data
        ?? (members as { data?: { id: string; name: string }[] } | null)?.data) ?? [];
      for (const m of Array.isArray(rows) ? rows : []) names[m.id] = m.name;
      setMemberNames(names);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // 에픽 제목 맵(overview epics) — recent_changes/attention id resolve 보조(member 맵과 함께).
  const epicTitles: Record<string, string> = {};
  for (const e of overview?.project_status.epics ?? []) epicTitles[e.epic_id] = e.title;
  const resolveName = (id: string | null | undefined): string | null =>
    id ? (memberNames[id] ?? epicTitles[id] ?? null) : null;

  const fleet = overview?.fleet;
  const activeEpic = overview?.project_status.epics.find((e) => e.status === 'active') ?? null;

  return (
    <div className="space-y-4">
      {/* 헤더: 커맨드 센터 + 프로젝트 + 우측 함대 라이브 + E-GLANCE 요약(§11 결정②: 전용 뷰+요약 카드) */}
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-sm font-semibold text-foreground">{t('commandCenter')}</h2>
          {projectName ? <span className="text-xs text-muted-foreground">· {projectName}</span> : null}
        </div>
        <div className="flex items-center gap-2">
          {activeEpic ? (
            <Link
              // story #2224(선생님 정정 2026-07-30, 진입점 전수 스윕) — `/glance` 라우트가
              // 삭제되고 `/flow`로 흡수됐다(PR#2698). bare `/flow`는 proxy.ts
              // MIGRATED_RESOURCES 안전망(오늘 등록)이 org/project 쿠키로 해소한다.
              href="/flow"
              title={t('ccFlowTooltip')}
              className="inline-flex min-w-0 items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            >
              <Map className="size-3 shrink-0" aria-hidden="true" />
              <span className="max-w-[120px] truncate font-medium text-foreground">{activeEpic.title}</span>
              <span className="shrink-0">· {tGlance(`phrase.${derivePhrase(activeEpic.completion_pct, activeEpic.total)}`)}</span>
            </Link>
          ) : null}
          {fleet ? (
            <div className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-[11px]">
              <span className="font-medium text-foreground">{t('ccFleet', { count: fleet.total_agents })}</span>
              {/* story #2338 — BE는 status_breakdown을 실 객체로 보낸다(더 이상 통짜
                  PendingData가 아니다). isPending에 걸면 이 실 객체와 영원히 안 맞아
                  아래 실측값이 렌더 코드에 도달하지 못했다(#2338이 잡은 사고). */}
              {!isPending(fleet.status_breakdown) ? (
                <span className="text-muted-foreground">
                  · {t('ccFleetOnlineWorking', { online: fleet.status_breakdown.online, working: fleet.status_breakdown.working })}
                </span>
              ) : (
                <span className="text-muted-foreground">· {t('ccFleetBreakdownPending')}</span>
              )}
            </div>
          ) : null}
        </div>
      </header>

      {loading && !myActions && !overview ? (
        <div className="flex items-center gap-2 py-12 text-xs text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t('ccLoading')}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.25fr_1fr]">
          <ActionZone data={myActions} resolveName={resolveName} epicTitles={epicTitles} />
          <OverviewZone data={overview} resolveName={resolveName} />
        </div>
      )}
    </div>
  );
}
