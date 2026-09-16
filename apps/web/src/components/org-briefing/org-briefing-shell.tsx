'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { EMPTY_TODAY_SNAPSHOT, useTodaySnapshot } from './use-today-snapshot';
import { AgentProgressSection, NeedsMeSection, PublishedSection } from './today-sections';

// story #3831(UX-v3·FE 3·오늘, 페드루 PO 確定 2026-09-13) — 옛 조직 브리핑(NowFace·
// LoopFace·WorkforceFace, 각자 다른 BFF 4종 조합)을 시안 v3(오늘 1caf61fe)로 흡수한다.
// 수의 출처는 story #3823 `GET /api/v2/today` 단 하나(자체 집계 0) — 3구역(사람 손이
// 필요한 일·에이전트가 하는 일·오늘 나간 것) + 하단 지시 한 줄. §② 흡수 지도대로
// 실험실/워크포스는 이 화면에서 완전히 걷힌다(다른 자리로 흡수 — 삭제 아님).
//
// project 배너: 옛 로직은 `!projectId`(로컬 LoopFace/WorkforceFace가 project 없인 못 그려
// 스켈레톤을 대신 그리던 시절)도 배너 조건이었다 — today route는 org 스코프뿐이라(project_id
// 파라미터 자체가 없다) 그 조건은 이제 거짓이 된다(项目 없어도 내용은 뜬다). `next`(#2212
// 리다이렉트 복귀 안내)만 남긴다.

function InstructionInput({ autoFocus }: { autoFocus: boolean }) {
  const t = useTranslations('orgBriefing');
  const router = useRouter();
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // story #3831 후속(페드루 PO 確定, 2026-09-13 14:22Z) — 컴패니언 단축키가 `?focus=compose`
  // 딥링크로 이 화면을 열면 하단 지시 한 줄에 바로 포커스한다(웹은 포커스만 — 단축키 자체는
  // 3832, 데스크톱 전용 축).
  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    // story #3831 PO 確定(c)(2026-09-13 14:04Z) — 수신자 발명 0. 「대화」의 기존 두 경로
    // (최근 대화 프리필 / 0건이면 새 대화 모달, chat-list-view.tsx 참고)로 위임만 한다.
    router.push(`/chats?compose=${encodeURIComponent(trimmed)}`);
  };

  return (
    <form onSubmit={handleSubmit} className="flex items-center gap-2 border-t border-border pt-4">
      <Input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={t('instructionInputPlaceholder')}
        aria-label={t('instructionInputPlaceholder')}
        data-testid="today-instruction-input"
      />
      <Button type="submit" size="sm" disabled={!value.trim()}>{t('instructionSendButton')}</Button>
    </form>
  );
}

export function OrgBriefingShell() {
  const t = useTranslations('orgBriefing');
  const tc = useTranslations('common');
  const locale = useLocale();
  const { projectId: _projectId } = useDashboardContext();
  void _projectId; // today route는 org 스코프뿐 — 이 화면 자체는 project를 더는 안 쓴다.
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const nextTarget = searchParams.get('next');
  const { data, loadError, retry } = useTodaySnapshot();
  const snapshot = data ?? EMPTY_TODAY_SNAPSHOT;

  // story #3831 후속(페드루 PO 確定, 2026-09-13 14:22Z) — `?focus=compose` 딥링크(컴패니언
  // 단축키, story #3832)는 소비 뒤 URL에서 지운다(뒤로가기·새로고침마다 재포커스되면
  // 사용자가 타이핑 중이던 걸 매번 뺏는 결함이 된다).
  const shouldAutoFocusInstruction = searchParams.get('focus') === 'compose';
  useEffect(() => {
    if (!shouldAutoFocusInstruction) return;
    const next = new URLSearchParams(searchParams);
    next.delete('focus');
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 마운트 시 1회만(그 뒤 focus는 이미 지워짐).
  }, []);

  const today = new Date();
  const dateLabel = new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric', weekday: 'long' }).format(today);

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4 lg:p-6">
      {nextTarget ? (
        <Alert role="status">
          <AlertDescription>{t('projectRequiredBannerNext')}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-foreground">{t('title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{dateLabel}</p>
        </div>
        {data && snapshot.needsMeCount > 0 ? (
          // story #3853(§③ 토큰 표 「사람 손 필요=경고 amber」) — 하드코딩 bg-primary/10
          // (파랑)을 캐노니컬 Badge variant="warning"으로 교체(badge.tsx 기존 변형, 새
          // 토큰 발명 0). data-testid는 org-briefing-shell.test.tsx가 그대로 쓴다.
          <Badge variant="warning" data-testid="needs-me-header-badge" className="shrink-0">
            {t('needsMeBadge', { count: snapshot.needsMeCount })}
          </Badge>
        ) : null}
      </div>

      {loadError ? (
        <div className="flex flex-col items-center gap-3 py-10 text-center">
          <p role="alert" className="text-sm text-destructive">{t('loadErrorTitle')}</p>
          <Button size="sm" variant="outline" onClick={retry}>{tc('retry')}</Button>
        </div>
      ) : !data ? (
        <div className="space-y-3" aria-hidden="true">
          <Card className="h-24 animate-pulse bg-muted/30" />
          <Card className="h-24 animate-pulse bg-muted/30" />
        </div>
      ) : (
        <div className="space-y-6">
          <NeedsMeSection items={snapshot.needsMe} count={snapshot.needsMeCount} />
          <AgentProgressSection items={snapshot.agentProgress} />
          <PublishedSection published={snapshot.published} usage={snapshot.usage} />
        </div>
      )}

      {/* 페드루 PO CHANGES(2026-09-14 00:58Z, PR #4256) — 1440×900에서 이 입력이 스크롤
          없이는 안 보이던 결함(「오늘」의 주 액션이라 접혀선 안 된다) → 본문 pane
          (dashboard-shell.tsx의 overflow-y-auto 스크롤 조상) 하단에 sticky. -mx/px로
          부모의 좌우 패딩을 상쇄해 배경이 그 폭 그대로 깔린다(border-t는 InstructionInput
          자신의 form에 이미 있음 — 경계선 중복 0). */}
      <div className="sticky bottom-0 -mx-4 bg-background px-4 pb-4 lg:-mx-6 lg:px-6">
        <InstructionInput autoFocus={shouldAutoFocusInstruction} />
      </div>
    </div>
  );
}
