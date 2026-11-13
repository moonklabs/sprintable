'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { MoreHorizontal, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useToast } from '@/components/ui/toast';
import { NativeSelect } from '@/components/ds/select';
import { Button } from '@/components/ds/button';
import { normalizeAssigneePatch } from '@/components/kanban/types';
import { useOrgSyncVersion } from '@/lib/project-context-client';
import { fetchWithAuth } from '@/lib/db/client';
import { isSystemPublisher } from '@/lib/runtime-capabilities';
import { memberRowLabels } from '@/lib/member-display';
import { AnchoredPopover, isOutsidePress, usePortalMenuKeys } from '@/components/shared/anchored-popover';

interface TeamMember {
  id: string;
  name: string;
  type: 'human' | 'agent';
  is_active: boolean;
  // story #3997 CHANGES(페드루 PO 지적 2026-09-17) — 이 자리가 실은 진짜 "담당자
  // 선택"(스토리·doc·에픽 배정+디스패치)이라 「시스템 발행」을 걸러야 한다.
  runtime_type?: string | null;
}

interface EntityDispatchPanelProps {
  entityType: 'doc' | 'epic' | 'story';
  entityId: string;
  projectId: string;
  currentAssigneeId?: string | null;
  onAssigneePatched?: (assigneeId: string) => void;
  mobileMode?: 'full' | 'assignee-only';
}

export function EntityDispatchPanel({
  entityType,
  entityId,
  projectId,
  currentAssigneeId,
  onAssigneePatched,
  mobileMode,
}: EntityDispatchPanelProps) {
  const [members, setMembers] = useState<TeamMember[]>([]);
  // story #4311 — 같은 이름 구성원이 한 목록에서 갈리게 행 라벨은 memberRowLabels(member-display 한 곳의 꼬리 규칙)로.
  const tc = useTranslations('common');
  const rowLabels = useMemo(() => memberRowLabels(members, tc, () => ''), [members, tc]);

  const [assigneeId, setAssigneeId] = useState<string>(currentAssigneeId ?? '');
  const [dispatching, setDispatching] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  // story #4349(전수 8번) — «더 보기» 메뉴는 스토리 상세 스크롤 면(`overflow-y-auto`) 안이라 면 아래 끝에서 잘린 채였다 → body로 포털
  // (AnchoredPopover · 아래 모자라면 위로 · 가로는 4342 클램프 그대로). 포털이라 바깥 클릭 판정에 메뉴도 «안»으로 센다.
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  // 포털이라 DOM 순서상 «더 보기» 뒤가 아니다 → 열면 항목에 초점 · Tab 넘김/Esc = 닫고 «더 보기»로(공용 훅).
  const closeMore = useCallback(() => setMoreOpen(false), []);
  const moreKeys = usePortalMenuKeys({ open: moreOpen, onClose: closeMore, popoverRef: moreMenuRef, triggerRef: moreBtnRef, kind: 'menu' });
  const { addToast } = useToast();
  const t = useTranslations('board');
  // story #4357(유나 공통 모양 · 4348과 같은 결) — 담당자가 없어 꺼진 까닭은 title(호버)이 아니라 **보이는 한 줄**. 버튼은
  // aria-disabled(탭 순서에 남아 초점 · 화면 읽기가 닿음) + aria-describedby로 그 줄을 가리키고, 누름은 handleDispatch 첫 줄이 막는다.
  // 전달 중(dispatching)은 잠깐 꺼지는 것이라 까닭 줄 없이 네이티브 disabled. 켜져 있을 때 title은 «무엇을 하나» 설명(f5ae74e4 · Kickoff와 구분).
  // 까디르(4761 비차단 ①) — 전달 중에 고르개를 비우면 네이티브 disabled(바쁨)와 까닭 줄이 같이 섰다. 바쁨이 이긴다(«busy 줄 없음»).
  const needsAssignee = !assigneeId && !dispatching;
  const reasonId = useId();
  const menuReasonId = useId();
  // story #2545(카디르 라이브 재QA 5단계) — org 불일치 자동교정(switch-org) 성공 直後 아래
  // members 로드 effect가 재요청되게 얹는다(다른 opt-in 컴포넌트와 동일 패턴).
  const orgSyncVersion = useOrgSyncVersion();

  // 84f57f97 fix①: currentAssigneeId prop 변경(낙관 배정·재fetch) 시 local assigneeId 동기화.
  // 미동기화 시 stale 상태로 dispatch→BE가 직전 배정 못 봐 core flow 막힘(prod 버그 근본 1).
  useEffect(() => {
    setAssigneeId(currentAssigneeId ?? '');
  }, [currentAssigneeId]);

  useEffect(() => {
    if (!moreOpen) return;
    const handler = (e: MouseEvent | TouchEvent) => {
      // 포털된 메뉴(moreMenuRef)는 body 직속 — 공용 규칙이 포털 팝오버 안을 «안»으로 센다.
      if (isOutsidePress(moreRef.current, e.target)) setMoreOpen(false);
    };
    document.addEventListener('mousedown', handler as EventListener);
    document.addEventListener('touchstart', handler as EventListener);
    return () => {
      document.removeEventListener('mousedown', handler as EventListener);
      document.removeEventListener('touchstart', handler as EventListener);
    };
  }, [moreOpen]);

  useEffect(() => {
    fetchWithAuth(`/api/members?project_id=${projectId}`)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((json) => {
        const data = (json?.data ?? json) as TeamMember[];
        setMembers(data.filter((m) => m.is_active && !isSystemPublisher(m.runtime_type)));
      })
      .catch(() => {});
  }, [projectId, orgSyncVersion]);

  const handleDispatch = useCallback(async () => {
    if (!assigneeId || dispatching) return;
    setDispatching(true);
    try {
      // 84f57f97 fix②: dispatch 前 assignee를 전 entity type 영속화(이전엔 story만 스킵→미영속→
      // BE dispatch가 담당자 못 봐 core flow 막힘). story=assignee_ids 배열·doc/epic=assignee_id.
      // story #2133: 두 필드를 손으로 나눠 쓰지 않고 normalizeAssigneePatch에서 파생.
      const patchPath = entityType === 'doc' ? `/api/docs/${entityId}`
        : entityType === 'epic' ? `/api/goals/${entityId}`
        : `/api/stories/${entityId}`;
      const assigneePatch = normalizeAssigneePatch({ assignee_id: assigneeId });
      const patchBody = entityType === 'story'
        ? { assignee_ids: assigneePatch.assignee_ids }
        : { assignee_id: assigneePatch.assignee_id };
      const patchRes = await fetch(patchPath, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patchBody),
      });
      if (!patchRes.ok) throw new Error('assignee patch failed');
      onAssigneePatched?.(assigneeId);

      const dispatchRes = await fetch('/api/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entity_type: entityType, entity_id: entityId, project_id: projectId }),
      });
      // 7f8066a3: 실패 사유 구분(reason 매트릭스) — 서버 오류 vs 담당자 미지정을 분리 안내한다.
      if (!dispatchRes.ok) {
        addToast({ type: 'error', title: t('dispatchFailedTitle'), body: t('dispatchFailedBody') });
        return;
      }
      // 까심군 QA 회귀(2026-07-21) — /api/dispatch(route.ts)가 apiSuccess()로 응답을
      // {data:{dispatched,...}} 로 감싸는데 여기서 flat({dispatched})으로 읽고 있었다
      // ("fastapi-proxy envelope 경계" 버그클래스). 실제로는 항상 dispatched=undefined라
      // 서버가 200 성공을 반환해도 매번 "담당자 미지정" 토스트가 떴다(4/4 재현).
      const dispatchJson = await dispatchRes.json().catch(() => ({})) as { data?: { dispatched?: boolean } };
      const dispatchData = dispatchJson.data ?? {};
      if (!dispatchData.dispatched) {
        // 담당자가 지정되지 않아 전달 대상이 없는 경우 — 오류가 아니라 안내(info)로 처리한다.
        addToast({ type: 'info', title: t('assigneeNotSetTitle'), body: t('assigneeNotSetBody') });
        return;
      }
      addToast({ type: 'success', title: t('dispatchSuccessTitle') });
    } catch {
      addToast({ type: 'error', title: t('dispatchFailedTitle'), body: t('dispatchFailedBody') });
    } finally {
      setDispatching(false);
    }
  }, [assigneeId, dispatching, entityType, entityId, projectId, onAssigneePatched, addToast, t]);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <NativeSelect
          value={assigneeId}
          onChange={(e) => setAssigneeId(e.target.value)}
          // 4908 — ds NativeSelect(경계 line-control · 바탕 sunk · 초점 링). 폭 16rem 속성 칸에서 고르기 칸이 «담당자 선…»으로 잘리던 것: 틀(className은 바깥 틀에 걸린다)이 11rem(min-w-44) 밑으로는 줄지 않는다 — 모자라면 «이벤트 전달» 단추가 아래 줄로 내려가고 고르기 칸이 줄 전체를 쓴다(넓은 곳에서는 예전처럼 한 줄).
          className="min-w-44 flex-1"
        >
          <option value="">{t('assigneeSelectPlaceholder')}</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {rowLabels.get(m.id)}
            </option>
          ))}
        </NativeSelect>
        <Button
          type="button"
          variant="primary"
          disabled={dispatching}
          aria-disabled={needsAssignee || undefined}
          aria-describedby={needsAssignee ? reasonId : undefined}
          onClick={() => void handleDispatch()}
          title={needsAssignee ? undefined : t('dispatchTooltip')}
          iconStart={<Zap className="size-3.5" />}
          // 4908 — ds Button(주 단추 · 비활성 = 점선 윤곽). 담당자가 없으면 눌러도 안 가는 «꺼진» 모양(aria-disabled)이고 까닭 줄이 아래에 선다.
          className={cn('shrink-0', mobileMode === 'assignee-only' ? 'hidden md:inline-flex' : 'inline-flex')}
        >
          {dispatching ? t('dispatching') : t('dispatch')}
        </Button>
        {mobileMode === 'assignee-only' && (
          <div ref={moreRef} className="relative md:hidden">
            <Button
              ref={moreBtnRef}
              {...moreKeys.triggerProps}
              type="button"
              variant="secondary"
              onClick={() => setMoreOpen((o) => !o)}
              // story #4355 — 열린 채 초점이 트리거에 남아도(포인터로 연 뒤 등) Esc로 닫힘 · Tab은 메뉴로(공용 훅).
              onKeyDown={moreKeys.onTriggerKeyDown}
              className="px-2"
              aria-label={t('moreOptionsAria')}
            >
              <MoreHorizontal className="size-4" />
            </Button>
            {/* story #3007(로드맵 P2·PR-E, L1) — 드롭다운은 floating이라 --elev-overlay. */}
            {moreOpen && (
              <AnchoredPopover anchorRef={moreRef} popoverRef={moreMenuRef} align="end" gap={4} onKeyDown={moreKeys.onPopoverKeyDown} {...moreKeys.popoverProps} data-dropdown-panel="dispatch-more" className="z-50 min-w-[140px] max-w-[calc(100vw-1rem)] rounded-ds-panel border border-ds-line-control bg-ds-surface-raised py-1 text-ds-ink shadow-ds-overlay">
                <button
                  type="button"
                  role="menuitem"
                  disabled={dispatching}
                  aria-disabled={needsAssignee || undefined}
                  aria-describedby={needsAssignee ? menuReasonId : undefined}
                  // 꺼진 채 누르면 메뉴를 닫지 않는다 — 까닭 줄을 읽을 수 있게(4348 메뉴 항목과 같게).
                  onClick={() => { if (needsAssignee) return; void handleDispatch(); setMoreOpen(false); }}
                  title={needsAssignee ? undefined : t('dispatchTooltip')}
                  className={cn(
                    'flex w-full items-center gap-1.5 px-3 py-2 text-sm transition',
                    assigneeId && !dispatching
                      ? 'text-ds-ink hover:bg-ds-surface-high'
                      : 'cursor-not-allowed text-muted-foreground',
                  )}
                >
                  <Zap className="size-3.5" />
                  {dispatching ? t('dispatching') : t('dispatch')}
                </button>
                {needsAssignee && (
                  // 까디르(4761 비차단 ②) — role=menu 안의 자식은 menuitem · group · separator뿐 → 까닭 줄은 role="none"(읽기는 describedby로).
                  <p id={menuReasonId} role="none" className="mt-1 break-keep border-t border-ds-line px-3 pb-1 pt-1.5 text-editorial-meta text-muted-foreground">{t('dispatchNeedsAssignee')}</p>
                )}
              </AnchoredPopover>
            )}
          </div>
        )}
      </div>
      {/* 고르개+버튼 줄 아래 한 줄 · 꺼져 있는 동안만. «담당자만» 모드의 좁은 화면은 버튼이 숨고 «더 보기» 메뉴 안 줄이 대신한다. */}
      {needsAssignee && (
        <p id={reasonId} className={cn('mt-1 break-keep text-xs text-muted-foreground', mobileMode === 'assignee-only' && 'hidden md:block')}>
          {t('dispatchNeedsAssignee')}
        </p>
      )}
    </div>
  );
}
