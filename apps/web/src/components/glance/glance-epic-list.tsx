'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { derivePhrase, type RoadmapEpic } from '@/services/glance';

interface GlanceEpicListProps {
  /** hero(active) 에픽을 제외한 나머지 — 다음/예정 + 방금 증명됨. */
  epics: RoadmapEpic[];
}

/**
 * E-GLANCE 2D 우측 legible 리스트(story dee92c96) — 나머지 에픽을 **작지만 전부 읽히는** 행으로.
 * ⚠️ 에픽엔 evidence/claim이 없다 → 행은 제목·roadmapStatus·진척 phrase만(가짜 증거 0·no-fiction).
 * blur/가림 0 = 글랜스 본분(한눈에 읽힘). ProofCapsule density='row'는 claim/gate 전제라 부적합.
 */
function EpicRow({ epic }: { epic: RoadmapEpic }) {
  const t = useTranslations('glance');
  const done = epic.roadmapStatus === 'done';
  const phrase = derivePhrase(epic.completionPct, epic.total);
  return (
    <Link
      href={`/epics/${epic.id}`}
      className="relative flex items-start gap-2.5 overflow-hidden rounded-lg border border-proof-line-soft bg-proof-panel px-3 py-2.5 pl-3.5 transition-colors hover:border-proof-line"
    >
      <span className={`absolute inset-y-0 left-0 w-[3px] ${done ? 'bg-proof-green' : 'bg-proof-faint'}`} aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-bold text-proof-ink">{epic.title}</span>
        <span className="mt-0.5 block truncate text-[10.5px] font-medium text-proof-faint">{t(`phrase.${phrase}`)}</span>
      </span>
      <span className={`shrink-0 self-center rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.05em] ${done ? 'bg-proof-green-soft text-proof-green' : 'bg-proof-sunk text-proof-ink-3'}`}>
        {done ? t('pillDone') : t('pillUpcoming')}
      </span>
    </Link>
  );
}

export function GlanceEpicList({ epics }: GlanceEpicListProps) {
  const t = useTranslations('glance');
  const upcoming = epics.filter((e) => e.roadmapStatus === 'upcoming');
  const done = epics.filter((e) => e.roadmapStatus === 'done');
  if (upcoming.length === 0 && done.length === 0) return null;

  return (
    <div className="space-y-4">
      {upcoming.length > 0 ? (
        <div className="space-y-2">
          <p className="px-1 text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">{t('listNextTitle')}</p>
          {upcoming.map((e) => <EpicRow key={e.id} epic={e} />)}
        </div>
      ) : null}
      {done.length > 0 ? (
        <div className="space-y-2">
          <p className="px-1 text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">{t('listDoneTitle')}</p>
          {done.map((e) => <EpicRow key={e.id} epic={e} />)}
        </div>
      ) : null}
    </div>
  );
}
