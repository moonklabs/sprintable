'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronUp, Circle, CircleCheck, Loader2 } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { useActivationStatus, type ActivationState } from '@/hooks/use-activation-status';
import { createFirstInstructionConversation } from '@/lib/onboarding/first-instruction';
import { cn } from '@/lib/utils';

// story #4032(실측 — Lighthouse CI 인증화면 6곳 전부 CLS>0.1, layout-shift-elements 감사
// 상위 기여요소가 6곳 모두 이 배너 바로 아래 그리드였다) — 진짜 원인은 `useActivationStatus`
// 의 `state`가 마운트 직후 항상 `null`로 시작해(hooks/use-activation-status.ts:90) 이
// 컴포넌트가 그 순간 `null`을 반환, 부모 `<div className="px-3 pt-3 empty:hidden">`가
// 빈 채로 0높이로 접혀 있다가 `useEffect`의 비동기 fetch가 끝나 `state`가 채워지는
// 순간 실 배너가 나타나며 그 아래 전체(모든 페이지 공통 그리드)를 밀어낸다 — 화면마다
// 다른 원인이 아니라 이 배너 하나가 공통 뿌리(6곳 전부에서 거의 동일한 CLS 기여값
// 0.134로 재현). 처방: "아직 모른다"와 "완주해서 필요 없다"를 더 이상 같은 null로
// 뭉치지 않고, 전자는 실 배너와 같은 Alert 박스(테두리·패딩 동일)에 스켈레톤을 채워
// 자리를 미리 잡는다 — 그 자리가 실 콘텐츠와 같은 박스라 나타날 때 높이가 안 바뀐다.

/**
 * story #3159(retention·최소층) — 가입 후 남은 activation 단계를 상시 노출(완주 유도).
 * PO 지시(2026-08-27): 완전 소멸은 완주(all_complete) 시만 — 접기(collapse)는 허용하되
 * 접힌 상태에서도 진행률 칩은 남는다(수동 dismiss로 완전히 숨길 순 없음).
 *
 * story #3274 — fetch/skip(COMPLETE_KEY) 로직은 `useActivationStatus()`(hooks/use-
 * activation-status.ts)로 분리했다 — support-widget-launcher.tsx의 온보딩 단계 게이팅과
 * 같은 조회를 공유한다(두 벌 판별자·중복 네트워크 호출 금지, AC①).
 */
const COLLAPSE_KEY = 'sprintable_activation_checklist_collapsed';

export function ActivationChecklistBanner() {
  const t = useTranslations('activation');
  const router = useRouter();
  const { projectId } = useDashboardContext();
  const { state, allComplete } = useActivationStatus();
  const [navigatingToInstruction, setNavigatingToInstruction] = useState(false);
  const [instructionStartError, setInstructionStartError] = useState(false);
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try {
      return window.sessionStorage.getItem(COLLAPSE_KEY) === '1';
    } catch {
      return false;
    }
  });

  // story #3196 ④ — BE steps는 5개(signed_up 포함)인데 이 목록은 4개만 그려 "4/5 완료"
  // 진행률과 눈에 보이는 항목 수가 안 맞았다(5번째가 뭔지 화면이 말 안 함). signed_up은
  // 이 배너에 도달했다는 사실 자체가 이미 참(비인터랙티브 li로만 — 첫 지시 항목과 달리
  // 딥링크 대상이 없다, 이미 지난 단계).
  // story #4032 — 로딩 스켈레톤(아래)이 이 배열의 길이(5)로 자리를 잡아야 실 콘텐츠가
  // 도착했을 때 행 수가 안 바뀐다 — state 유무와 무관해 가드보다 앞으로 옮겼다(단일
  // 출처, 매직넘버 방지).
  const stepItems: { key: keyof ActivationState['steps']; label: string }[] = [
    { key: 'signed_up', label: t('stepSignedUp') },
    { key: 'email_verified', label: t('stepEmailVerified') },
    { key: 'org_created', label: t('stepOrgCreated') },
    { key: 'agent_connected', label: t('stepAgentConnected') },
    { key: 'first_roundtrip', label: t('stepFirstRoundtrip') },
  ];

  if (allComplete) return null;
  // story #4032 — "완주해서 필요 없다"(위 allComplete)와 "아직 모른다"(여기, fetch
  // 미완료)를 더 이상 같은 null로 뭉치지 않는다. 실 배너와 같은 Alert 박스에 스켈레톤을
  // 채워 자리를 미리 잡아 두면, fetch가 끝나 실 콘텐츠로 바뀔 때 박스 높이가 그대로라
  // 그 아래(모든 페이지 공통 그리드)가 밀리지 않는다.
  if (!state) {
    return (
      <Alert variant="info" className="relative" aria-busy="true">
        {/* story #4032 — 높이는 실 텍스트의 line-height에 맞춘다(폭은 CLS에 안 실린다):
            AlertTitle은 leading-5(20px), AlertDescription은 text-xs leading-relaxed
            (~19.5px→h-5로 근사), li 텍스트는 text-sm 기본 line-height(20px, story #3939가
            5행 전부를 이 box로 통일해 둔 것과 동형) — 전부 h-5로 맞추면 실 콘텐츠 교체
            시 박스 높이가 유지된다. */}
        <AlertTitle>
          <Skeleton variant="text" className="h-5 w-32" />
        </AlertTitle>
        <AlertDescription>
          <Skeleton variant="text" className="mt-1 h-5 w-48" />
        </AlertDescription>
        <ul className="col-start-2 mt-2 space-y-1.5">
          {stepItems.map(({ key }) => (
            <li key={key} className="flex items-center gap-1.5 rounded px-1 py-0.5">
              <Skeleton variant="circle" className="size-3.5 shrink-0" />
              <Skeleton variant="text" className="h-5 w-24" />
            </li>
          ))}
        </ul>
      </Alert>
    );
  }
  // story #3610(3607 잔여) CHANGES-2(유나 확認·PO 채택 2026-09-07) — orgId(계정 기본
  // org, me.org_id)와 비교하던 최초판을 폐기 — BE가 이미 "요청 org(X-Org-Id)==판정
  // org"를 판정해 낸 불리언을 그대로 쓴다(다른 프레임 값 2개를 FE가 다시 맞대지
  // 않는다). false일 때만 숨긴다 — undefined(구 응답 shape, 롤아웃 창)는 기존처럼
  // 렌더 유지(과다 은닉 방지, 3610 최초판과 동일 원칙).
  if (state.scope_is_requested_org === false) return null;

  const toggleCollapse = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      window.sessionStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
    } catch {
      // 영속 실패해도 이번 렌더는 토글 반영
    }
  };

  // story #3201(AC2) — "첫 지시…" 항목만 클릭 가능(전 항목 클릭화는 범위 밖·#3196 잔존分
  // 그대로). PO 확定 우선순위: BE first_instruction_conversation_id 있으면 그대로 이동,
  // 없으면 connect-step CTA와 동일한 신규 DM 생성 경로 재사용(제3경로 발명 금지).
  const handleFirstInstructionClick = async () => {
    if (navigatingToInstruction) return;
    if (state?.first_instruction_conversation_id) {
      router.push(`/chats/${state.first_instruction_conversation_id}`);
      return;
    }
    if (!projectId) return;
    setNavigatingToInstruction(true);
    setInstructionStartError(false);
    try {
      const convId = await createFirstInstructionConversation(projectId);
      // story #3638(유나 §8 별건) — 대화 생성 실패 시 스피너만 멈추고 조용했다(클릭했는데
      // 아무 일도 없었던 것처럼 보임). connect-step.tsx의 같은 호출은 null을 «건너뛰고
      // 진행»으로 의도적으로 쓰지만(범위 밖, 그쪽은 그대로 둠), 이 배너는 그 클릭 자체가
      // 유일한 목적이라 실패를 알려야 한다.
      if (convId) router.push(`/chats/${convId}`);
      else setInstructionStartError(true);
    } finally {
      setNavigatingToInstruction(false);
    }
  };

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={toggleCollapse}
        aria-expanded={false}
        aria-label={t('expandAria')}
        className="flex w-full items-center justify-between gap-2 rounded-lg border border-border bg-muted/50 px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
      >
        <span>{t('collapsedChip', { completed: state.completed, total: state.total })}</span>
        <ChevronDown className="size-3.5 shrink-0" />
      </button>
    );
  }

  return (
    <Alert variant="info" className="relative">
      <AlertTitle>{t('bannerTitle')}</AlertTitle>
      <AlertDescription>{t('bannerProgress', { completed: state.completed, total: state.total })}</AlertDescription>

      <ul className="col-start-2 mt-2 space-y-1.5">
        {stepItems.map(({ key, label }) => {
          const met = state.steps[key];
          // story #3181 — met 항목은 text-foreground. text-success(#1F9D57 계열색)는 info Alert의
          // blue-soft(#EAEEFF) 배경 위에서 대비 미달(≈2.8:1<4.5·axe color-contrast 신규 위반). #2420
          // 규율(tint 위 계열색 글자는 text-foreground)·완료 여부는 CircleCheck vs Circle 모양이 전달하므로
          // 색 의존을 제거해도 신호 손실 0(색맹 접근성↑). 아이콘도 li 색 상속으로 함께 정리.
          const icon = met ? <CircleCheck className="size-3.5 shrink-0" /> : <Circle className="size-3.5 shrink-0" />;
          // story #3201(AC2) — "첫 지시…" 항목만 클릭 가능(해당 대화로 이동). 다른 항목은
          // 기존 그대로 비-인터랙티브 li(스코프 밖, #3196 잔존分).
          if (key === 'first_roundtrip') {
            return (
              <li key={key}>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => void handleFirstInstructionClick()}
                  disabled={navigatingToInstruction || !projectId}
                  className={cn(
                    // story #3907(PO 눈 리뷰, 3901 캡처 그라운딩) — Button의 size="default"
                    // 변형이 min-h-11(44px)·border(형제 <Link>/<li>엔 없음)를 얹어 5번째
                    // 행만 키·아이콘 x좌표가 밀렸다. h-auto/min-w-0만으론 min-h-11이
                    // 오버라이드 안 됨(다른 CSS 속성) — min-h-0·border-0로 명시 상쇄.
                    'h-auto min-h-0 w-full min-w-0 border-0 justify-start gap-1.5 rounded px-1 py-0.5 text-left text-sm font-normal hover:underline disabled:no-underline',
                    // story #3839(critical·2pt, 카디르 QA 2026-09-14 01:18Z) — text-muted-
                    // foreground(ink-3 v3값 #6E6C67)가 이 Alert variant="info"의 blue-soft
                    // (#E7EDF7) 배경 위에서 대비 미달(4.3:1<4.5, axe color-contrast 신규
                    // 위반) — #2420 규율(tint 위 계열색·저대비 글자는 text-foreground) 그대로
                    // 적용. met/unmet 구별은 아이콘 모양(CircleCheck/Circle)이 전달하므로
                    // 색 통일에 따른 의미 손실 0(바로 위 text-success 제거 선례와 동형).
                    'text-foreground',
                  )}
                >
                  {navigatingToInstruction ? <Loader2 className="size-3.5 shrink-0 animate-spin" /> : icon}
                  <span>{label}</span>
                </Button>
                {instructionStartError ? (
                  <p role="alert" aria-live="assertive" aria-atomic="true" className="px-1 pt-0.5 text-xs text-destructive">
                    {t('firstInstructionStartFailed')}
                  </p>
                ) : null}
              </li>
            );
          }
          // story #3196 ③ 잔존分 — "에이전트 연결하기" 딥링크 부재. 워크포스 목록(#3194가
          // 이미 "연결 안 됨" 배지+연결설정 CTA를 갖춘 그 화면)으로 보낸다 — 아직 특정
          // 에이전트가 없을 수도 있어(연결 대상 자체가 미확定) agent-specific 딥링크
          // (#3194의 /organization/workforce/{id})가 아니라 리스트로(발명 0 — 새 목적지
          // 안 만듦, 기존 화면 재사용).
          if (key === 'agent_connected') {
            return (
              <li key={key}>
                <Link
                  href="/organization/workforce"
                  className={cn(
                    'flex h-auto w-full min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-left text-sm font-normal hover:underline',
                    // story #3839 — 위 first_roundtrip 분기와 동일 처방(색 통일, 아이콘이 met 전달).
                    'text-foreground',
                  )}
                >
                  {icon}
                  <span>{label}</span>
                </Link>
              </li>
            );
          }
          return (
            // story #3839 — 위 두 분기와 동일 처방(색 통일, 아이콘이 met 전달).
            // story #3939 — 클릭 가능한 두 항목(Link·Button)은 px-1 py-0.5 hit-area를 갖는데
            // 이 비-인터랙티브 항목은 안 가져 아이콘 x가 4px, 행 높이가 어긋났다(3901 캡처·
            // 라이브 실측: 아이콘 left 294 vs 298 · 행 pitch 26/28/30). 같은 box(rounded px-1
            // py-0.5)로 통일해 5항목 아이콘 x·행 pitch를 맞춘다(hover 배경은 인터랙티브 항목만).
            <li key={key} className={cn('flex items-center gap-1.5 rounded px-1 py-0.5 text-sm', 'text-foreground')}>
              {icon}
              <span>{label}</span>
            </li>
          );
        })}
      </ul>

      <Button
        variant="ghost"
        size="icon-sm"
        className="absolute right-2 top-2"
        aria-label={t('collapseAria')}
        aria-expanded={true}
        onClick={toggleCollapse}
      >
        <ChevronUp className="size-4" />
      </Button>
    </Alert>
  );
}
