'use client';

import { useCallback, useEffect, useState, type KeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ds/button';
import { Banner } from '@/components/ds/banner';
import { Chip } from '@/components/ds/chip';
import { CountBadge } from '@/components/ds/count-badge';
import { EmptyState } from '@/components/ds/empty-state';
import { FilterBar } from '@/components/ds/filter-bar';
import { Icon, type IconName } from '@/components/ds/icon';
import { Kbd } from '@/components/ds/kbd';
import { PageFrame } from '@/components/ds/page-frame';
import { RowList, RowListItem } from '@/components/ds/row-list';
import { NativeSelect } from '@/components/ds/select';
import { Skeleton, SkeletonGroup } from '@/components/ds/skeleton';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { LoopStatusBadge, type LoopStatus } from '@/components/loops/loop-status-badge';
import { LoopStageBar } from '@/components/loops/loop-stage-bar';
import { OutcomeBadge } from '@/components/loops/outcome-badge';
import { LoopCreateDialog } from '@/components/loops/loop-create-dialog';

import { fetchWithAuth } from '@/lib/db/client';
import { LoopsTopBarTitle } from '@/components/nav/flat-tab-top-bar';
import { LOOP_FILTER_STICKY, LOOP_ROW_FACE, LOOP_ROW_HOVER } from './loops-layer';

// story 1eb18bd8(doc resource-view-firsttouch-identity-pattern §2/§4 — 실험실 파일럿): 빈
// first-touch 정체성 visual = "4노드(가설→실행→검증→학습+↻다음 Loop) 가로 플로우(과설명 금지·
// 아이콘+라벨)"(스토리 AC 원문). 아이콘+짧은 라벨만 — 문장 설명 없음.
function LoopCycleFlow({ t }: { t: (key: 'loopNodeHypothesis' | 'loopNodeExecute' | 'loopNodeVerify' | 'loopNodeLearn' | 'loopNodeNext') => string }) {
  const nodes: Array<{ icon: IconName; label: string }> = [
    { icon: 'lightbulb', label: t('loopNodeHypothesis') },
    { icon: 'play_arrow', label: t('loopNodeExecute') },
    { icon: 'check_circle', label: t('loopNodeVerify') },
    { icon: 'auto_awesome', label: t('loopNodeLearn') },
  ];
  return (
    <div className="flex items-center gap-1.5 text-ds-ink-3" aria-hidden="true">
      {nodes.map(({ icon, label }, i) => (
        <span key={label} className="flex items-center gap-1.5">
          {i > 0 ? <Icon name="arrow_forward" size={12} /> : null}
          <span className="flex flex-col items-center gap-1">
            <Icon name={icon} />
            <span className="text-ds-mono-sm leading-none">{label}</span>
          </span>
        </span>
      ))}
      <Icon name="arrow_forward" size={12} />
      <span className="flex flex-col items-center gap-1">
        <Icon name="replay" />
        <span className="text-ds-mono-sm leading-none">{t('loopNodeNext')}</span>
      </span>
    </div>
  );
}

interface Loop {
  id: string;
  project_id: string;
  parent_loop_id: string | null;
  hypothesis_id: string | null;
  brief_doc_id: string | null;
  recipe_slug: string | null;
  title: string;
  goal_tags: string[];
  status: LoopStatus;
  outcome_snapshot: { hypothesis_status: 'verified' | 'falsified' } | null;
  created_at: string;
  updated_at: string;
}

const STATUS_FILTERS: (LoopStatus | 'all')[] = [
  'all', 'draft', 'briefing', 'generating', 'deciding', 'executing', 'measuring', 'closed', 'abandoned',
];

/**
 * 4911 — «전체»일 때만 상태 필드로 세 구획에 묶는다(새 호출 0 · 같은 한 번의 목록 응답). 특정 단계를 고르면 구획 없이 평평한 한 목록이다(걸러 보는 길이 «단계» 하나뿐).
 * 결정이 필요한 것(deciding) 먼저 · 진행 중(초안 · 브리핑 · 생성 중 · 실행 중 · 측정 중) · 끝난 것(종료 · 중단).
 */
const SECTIONS = [
  { id: 'decide', titleKey: 'sectionNeedsDecision', statuses: ['deciding'] },
  { id: 'progress', titleKey: 'sectionInProgress', statuses: ['draft', 'briefing', 'generating', 'executing', 'measuring'] },
  { id: 'finished', titleKey: 'sectionFinished', statuses: ['closed', 'abandoned'] },
] as const satisfies ReadonlyArray<{ id: string; titleKey: 'sectionNeedsDecision' | 'sectionInProgress' | 'sectionFinished'; statuses: readonly LoopStatus[] }>;

function LoopRow({ loop, onOpen }: { loop: Loop; onOpen: () => void }) {
  const t = useTranslations('loops');
  const lineage = loop.parent_loop_id ? t('lineageFrom', { id: loop.parent_loop_id.slice(0, 8) }) : null;
  const subtitle = [lineage, loop.recipe_slug].filter(Boolean).join(' · ');
  // 줄 전체가 «열기» 단추다(옛 role=button 그대로): 클릭 · Enter(행 부품) · Space(여기). 더블클릭은 첫 클릭이 이미 열었다.
  const onKeyUp = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === ' ' && e.target === e.currentTarget) { e.preventDefault(); onOpen(); }
  };
  return (
    <RowListItem
      role="button"
      data-testid={`loop-row-${loop.id}`}
      data-loop-row-status={loop.status}
      className={`${LOOP_ROW_FACE} ${LOOP_ROW_HOVER} cursor-pointer`}
      title={loop.title}
      subtitle={subtitle || undefined}
      statusMark={(
        <>
          <LoopStageBar status={loop.status} />
          <LoopStatusBadge status={loop.status} />
          {loop.status === 'closed' && loop.outcome_snapshot ? <OutcomeBadge hypothesisStatus={loop.outcome_snapshot.hypothesis_status} /> : null}
          {loop.goal_tags.map((tag) => <Chip key={tag}>{tag}</Chip>)}
        </>
      )}
      onClick={onOpen}
      onKeyUp={onKeyUp}
      onOpen={onOpen}
    />
  );
}

export function LoopsClient({ projectId, wsSlug, projSlug }: { projectId: string; wsSlug: string; projSlug: string }) {
  const t = useTranslations('loops');
  const tc = useTranslations('common');
  const router = useRouter();
  const [loops, setLoops] = useState<Loop[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [statusFilter, setStatusFilter] = useState<LoopStatus | 'all'>('all');
  const [createOpen, setCreateOpen] = useState(false);

  const fetchLoops = useCallback(async () => {
    try {
      const params = new URLSearchParams({ project_id: projectId, limit: '100' });
      if (statusFilter !== 'all') params.set('status', statusFilter);
      const res = await fetchWithAuth(`/api/loops?${params.toString()}`);
      if (!res.ok) throw new Error(`Failed to fetch loops: ${res.status}`);
      const data = (await res.json()) as Loop[];
      setLoops(data);
      setLoadFailed(false);
    } catch (err) {
      console.error('[loops] 목록을 불러오지 못했습니다', err);
      // 4911 — 못 불러온 것은 «실행이 없다»가 아니다: 빈 상태 문구 대신 오류 띠 + 다시 시도.
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [projectId, statusFilter]);

  useEffect(() => { void fetchLoops(); }, [fetchLoops]);

  const openLoop = (id: string) => router.push(`/${wsSlug}/${projSlug}/loops/${id}`);

  const topBar = (withActions: boolean) => (
    <TopBarSlot
      title={<LoopsTopBarTitle />}
      actions={withActions ? (
        // story #4277(민 기기 #6) — 402폭에서 «새 실행 시작하기» 글자 버튼이 상단 제목을 «실.»로 밀었다. 스프린트 상단바 관례: 폰은 아이콘만 ·
        // 글자는 sm 이상 · 접근 이름은 aria-label로 유지.
        <Button variant="primary" onClick={() => setCreateOpen(true)} aria-label={t('createLoopCta')} iconStart={<Icon name="add" />}>
          <span className="hidden sm:inline">{t('createLoopCta')}</span>
        </Button>
      ) : undefined}
      showContextChip
    />
  );

  if (loading) {
    return (
      <>
        {topBar(false)}
        <PageFrame width="wide">
          <SkeletonGroup label={t('loading')} className="space-y-2">
            {[1, 2, 3].map((i) => <Skeleton key={i} className="h-14 w-full" />)}
          </SkeletonGroup>
        </PageFrame>
      </>
    );
  }

  const grouped = statusFilter === 'all';
  const filterLabel = t('filterLabel');

  return (
    <>
      {topBar(true)}
      <LoopCreateDialog
        projectId={projectId}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(loop) => router.push(`/${wsSlug}/${projSlug}/loops/${loop.id}`)}
      />
      <PageFrame width="wide">
        {/* 옛 거르기 줄은 스크롤해도 맨 위에 남는 sticky였다(실행이 백 개여도 단계 고르기가 안 사라진다) — 그대로 둔다. 바탕은 쪽 바탕 층(LAYER.page)이라 아래로 지나가는 패널이 비치지 않는다. */}
        <div className={LOOP_FILTER_STICKY}>
        <FilterBar
          aria-label={filterLabel}
          leading={(
            <label className="flex items-center gap-2 text-ds-small text-ds-ink-3">
              <span>{filterLabel}</span>
              <NativeSelect className="w-40" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as LoopStatus | 'all')} data-testid="loops-status-filter">
                {STATUS_FILTERS.map((s) => (
                  <option key={s} value={s}>
                    {s === 'all' ? t('filterAll') : t(`status${s.charAt(0).toUpperCase()}${s.slice(1)}` as 'statusDraft')}
                  </option>
                ))}
              </NativeSelect>
            </label>
          )}
          trailing={loops.length > 0 ? (
            <span className="flex items-center gap-3 text-ds-small text-ds-ink-3" data-testid="loops-count-line">
              <span>{t('countLine', { count: loops.length })}</span>
              <span className="flex items-center gap-1 max-lg:hidden"><Kbd>↑</Kbd><Kbd>↓</Kbd> {t('hintMove')} · <Kbd>Enter</Kbd> {t('hintOpen')}</span>
            </span>
          ) : undefined}
        />
        </div>

        {loadFailed ? (
          <Banner tone="failed" action={<Button variant="secondary" onClick={() => void fetchLoops()}>{tc('retry')}</Button>}>
            {t('loadFailed')}
          </Banner>
        ) : null}

        {/* 4911 — 단계를 골랐는데 0건이면 «아직 시작한 실행이 없어요»가 아니다(다른 단계에는 있을 수 있다): 그 단계가 비었다고만 말한다. */}
        {!loadFailed && loops.length === 0 && !grouped ? (
          <EmptyState size="inline" title={t('emptyForStage')} />
        ) : null}

        {!loadFailed && loops.length === 0 && grouped ? (
          <EmptyState
            icon="science"
            title={t('noLoops')}
            description={t('noLoopsDescription')}
            action={(
              <div className="flex flex-col items-center gap-4">
                <LoopCycleFlow t={t} />
                <div className="flex flex-col items-center gap-1.5">
                  <Button variant="primary" onClick={() => setCreateOpen(true)} iconStart={<Icon name="add" />}>{t('noLoopsCta')}</Button>
                  <p className="m-0 text-ds-small text-ds-ink-3">{t('noLoopsAiHint')}</p>
                </div>
              </div>
            )}
          />
        ) : null}

        {loops.length > 0 && grouped ? SECTIONS.map((section) => {
          const rows = loops.filter((l) => (section.statuses as readonly LoopStatus[]).includes(l.status));
          if (rows.length === 0) return null;
          return (
            <RowList key={section.id} aria-label={t(section.titleKey)} data-testid={`loops-section-${section.id}`} header={{ title: t(section.titleKey), count: <CountBadge count={rows.length} />, level: 2 }}>
              {rows.map((loop) => <LoopRow key={loop.id} loop={loop} onOpen={() => openLoop(loop.id)} />)}
            </RowList>
          );
        }) : null}

        {loops.length > 0 && !grouped ? (
          <RowList aria-label={t('listLabel')} data-testid="loops-flat-list">
            {loops.map((loop) => <LoopRow key={loop.id} loop={loop} onOpen={() => openLoop(loop.id)} />)}
          </RowList>
        ) : null}
      </PageFrame>
    </>
  );
}
