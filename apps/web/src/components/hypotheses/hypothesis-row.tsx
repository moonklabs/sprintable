'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Play } from 'lucide-react';
import { Button } from '@/components/ds/button';
import { Chip } from '@/components/ds/chip';
import { IconButton } from '@/components/ds/icon-button';
import type { IconName } from '@/components/ds/icon-paths';
import { ListRow } from '@/components/ds/list-row';
import { ContextMenu, ContextMenuTrigger, Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ds/menu';
import { cn } from '@/lib/utils';
import type { Hypothesis } from '@sprintable/core-storage';
import { HypothesisStatusBadge } from './hypothesis-status-badge';

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

export interface HypothesisRowActions {
  onConfirmDraft: (h: Hypothesis) => void;
  onActivate: (h: Hypothesis) => void;
  onLinkStory: (h: Hypothesis) => void;
  onKill: (h: Hypothesis) => void;
  // story #2036 — measuring 가설을 사람이 달성/반증으로 닫는 진입점(다이얼로그는 호출부가 연다).
  onResolve: (h: Hypothesis, target: 'verified' | 'falsified') => void;
  // story #2053 — active→measuring 전이 동선이 화면에 아예 없어 종결 메뉴(measuring 전용)에
  // 도달할 수 없던 결함. 서버(hypothesis.py transition_hypothesis)엔 이 전이에 measure_after/
  // 지표정의 요건이 없다(실측 확認) — 그냥 시작되면 되므로 별도 입력 다이얼로그 없이 1스텝.
  onStartMeasuring: (h: Hypothesis) => void;
}

/** one entry of the row's menu — the ⋯ button's menu and the Mac right-click menu are the SAME list of the SAME functions (never a right-click-only action) */
interface HypothesisMenuEntry { id: 'link' | 'verify' | 'falsify' | 'kill'; icon: IconName; label: string; danger?: boolean; onSelect: () => void }

/**
 * Compact in-flight / terminal row (§4.2). verified/falsified use the VerdictCard instead.
 * 4909 AC3 (가설 칸 2단계): the row speaks the ds ListRow grammar — the status chip (+ the «초안» pin) · the statement on up to two lines · a mono second line «지표 · 날짜 · 🔗 연결 수 · @담당» · the ONE action of the moment on the right
 * (초안 확인 / 활성화 / 측정 시작) and the ⋯ menu; the «measuring starts…» hint stays a line of the row. The same menu opens with a right-click (Mac / desktop) — the same entries, the same functions.
 * There is no «open» for a hypothesis (it has no page of its own), so a double-click is not wired to anything: binding the row's transition button to it would make an accidental transition one slip away.
 */
export function HypothesisRow({
  hypothesis,
  actions,
  resolveName = () => '',
}: {
  hypothesis: Hypothesis;
  actions: HypothesisRowActions;
  // [SID:4286] 주인 칸 — 구성원 id 조각(@앞 8자)을 이름으로 싣지 않는다. 부모의 이름 표로 푼다(없으면 빈 칸).
  resolveName?: (memberId: string) => string;
}) {
  const t = useTranslations('hypotheses');
  const md = hypothesis.metric_definition;
  // 초안 = AI 템플릿 초안(draft_metadata.template===true)·아직 미확인. 핸드오프 §5 ⓐ 기준
  // (PO 콜: FE 인터임 hack 금지. BE가 HypothesisResponse에 draft_metadata/drafted_by를
  // additive 노출). 필드 노출 전엔 template이 undefined라 모든 proposed가 비-draft로 떨어져
  // [활성화] flow가 정상 동작하고, 노출되면 AI 초안만 핀/확인이 자연히 살아난다(revert 불필요).
  const draftMeta = hypothesis.draft_metadata as { template?: boolean; confirmed?: boolean } | null;
  const needsConfirm =
    hypothesis.status === 'proposed' && draftMeta?.template === true && draftMeta?.confirmed !== true;
  // §12.2ⓑ: 확인 직후(또는 휴먼 proposed) 같은 자리에 [활성화]를 인라인 연속 노출.
  const canActivateInline = hypothesis.status === 'proposed' && !needsConfirm;
  // story #2053 — active 가설에서 measuring으로 옮기는 동선. §12.2ⓑ [활성화]와 동일하게
  // row 인라인 연속 노출(사람이 찾을 수 있는 자리, AC1) — ⋯ 메뉴에 숨기지 않는다.
  const canStartMeasuringInline = hypothesis.status === 'active';
  const linkedCount = hypothesis.story_ids?.length ?? 0;
  const killed = hypothesis.status === 'killed';
  const startHint = hypothesis.measure_after ? t('startMeasuringHintWithDate', { date: hypothesis.measure_after.slice(0, 10) }) : t('startMeasuringHint');

  // 활성화는 §12.2ⓑ대로 row 인라인에 노출(연속 흐름) — 메뉴엔 연결/kill/달성/반증만.
  const canKill = hypothesis.status === 'proposed' || hypothesis.status === 'active' || hypothesis.status === 'measuring';
  // story #2036 — 달성/반증은 measuring 상태에서만 열린다(BE 합법 전이가 measuring→verified|falsified뿐).
  const canResolve = hypothesis.status === 'measuring';
  const entries: HypothesisMenuEntry[] = [
    { id: 'link', icon: 'link', label: t('linkStory'), onSelect: () => actions.onLinkStory(hypothesis) },
    ...(canResolve ? [
      { id: 'verify' as const, icon: 'check_circle' as const, label: t('resolveVerify'), onSelect: () => actions.onResolve(hypothesis, 'verified') },
      { id: 'falsify' as const, icon: 'do_not_disturb_on' as const, label: t('resolveFalsify'), onSelect: () => actions.onResolve(hypothesis, 'falsified') },
    ] : []),
    ...(canKill ? [{ id: 'kill' as const, icon: 'close' as const, label: t('kill'), danger: true, onSelect: () => actions.onKill(hypothesis) }] : []),
  ];
  const items = (): ReactNode => entries.map((e) => (
    <MenuItem key={e.id} icon={e.icon} variant={e.danger ? 'danger' : 'default'} onClick={e.onSelect}>{e.label}</MenuItem>
  ));

  const inlineAction = needsConfirm ? (
    <Button type="button" variant="secondary" onClick={() => actions.onConfirmDraft(hypothesis)}>{t('confirmDraft')}</Button>
  ) : canActivateInline ? (
    <Button type="button" variant="secondary" onClick={() => actions.onActivate(hypothesis)} iconStart={<Play className="size-3" aria-hidden />}>{t('activate')}</Button>
  ) : canStartMeasuringInline ? (
    <Button type="button" variant="secondary" onClick={() => actions.onStartMeasuring(hypothesis)} title={startHint} iconStart={<Play className="size-3" aria-hidden />}>{t('startMeasuring')}</Button>
  ) : null;

  // the second line's pieces: «지표 · 날짜 · 🔗 연결 수 · @담당» — each piece after the first carries its own dot and never splits from it (a wrapped line starts with a piece, not with a stray «·»)
  const pieces: ReactNode[] = [
    ...(md?.metric ? [<span key="m" className="tabular-nums">📈 {md.metric} {md.direction === 'down' ? '≤' : '≥'} {fmt(md.target)}</span>] : []),
    ...(hypothesis.measure_after ? [<span key="d">{hypothesis.measure_after.slice(0, 10)}</span>] : []),
    ...(linkedCount > 0 ? [<span key="l">🔗 {linkedCount}</span>] : []),
    <span key="o">@{hypothesis.owner_member_id ? resolveName(hypothesis.owner_member_id) : t('owner')}</span>,
  ];

  return (
    <div data-testid="hypothesis-row" data-status={hypothesis.status} className="overflow-hidden rounded-ds-control border border-ds-line">
      <ContextMenu>
        {/* the whole row (text AND its action cluster) is the right-click target; the cluster sits to the right of the text when the card is wide and under it when it is narrow (container query — a goal card can be as narrow as a phone) */}
        <ContextMenuTrigger render={<div className="@container" />}>
          <div className="flex flex-col @lg:flex-row @lg:items-start">
            <ListRow
              className="min-w-0 flex-1 items-start border-b-0"
              leading={(
                <span className="flex flex-wrap items-center gap-1.5">
                  <HypothesisStatusBadge status={hypothesis.status} />
                  {needsConfirm ? <Chip tone="neutral" className="border-dashed">{t('draftPin')}</Chip> : null}
                </span>
              )}
              title={<span className={cn('line-clamp-2 whitespace-normal font-normal leading-6', killed && 'text-ds-ink-3 line-through')}>{hypothesis.statement}</span>}
              subtitle={(
                <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 whitespace-normal">
                  {pieces.map((piece, i) => (i === 0 ? piece : <span key={`p${i}`} className="whitespace-nowrap"><span aria-hidden>· </span>{piece}</span>))}
                </span>
              )}
            />
            <div className="flex shrink-0 items-center gap-2 px-4 pb-2 @lg:py-2 @lg:pl-0 @lg:pr-3">
              {inlineAction}
              <Menu>
                <MenuTrigger render={<IconButton icon="more_horiz" label={t('actions')} />} />
                <MenuContent align="end">{items()}</MenuContent>
              </Menu>
            </div>
          </div>
          {/* AC2: 동선의 의미를 문구로 — "측정 시작"이 언제부터 재는지 사람이 알 수 있게(행 안의 한 줄 — 우클릭 대상 안, codex 1차). */}
          {canStartMeasuringInline ? <p data-testid="hypothesis-start-hint" className="border-t border-ds-line px-4 py-1.5 text-ds-small text-ds-ink-3">{startHint}</p> : null}
        </ContextMenuTrigger>
        <MenuContent align="start">{items()}</MenuContent>
      </ContextMenu>
    </div>
  );
}
