'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { useSupportWidgetSession } from '@/hooks/use-support-widget-session';
import { SupportWidgetPanelBody } from '@/components/support-widget/support-widget-panel';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';

/**
 * story #3274(지원v1·후속, 선생님 확定 2026-09-01) — 상시 플로팅 폐기 후 "일반 상황"의
 * 유일한 상담 진입점. 설정 > 문의 탭(settings/page.tsx `support` 탭 콘텐츠)에 위젯 세션
 * 훅+패널 body를 그대로 인라인 임베드한다(#3260 자산 재사용 — 발명 0, support-widget-
 * launcher.tsx의 오버레이 chrome/닫기 버튼만 빼고 body는 완전히 동일 컴포넌트).
 *
 * 탭이 활성화될 때만 마운트된다(TabsContent의 base-ui Tabs.Panel 기본값 keepMounted=false
 * — 비활성 탭은 아예 언마운트) — 그래서 이 컴포넌트의 mount effect 1회 connect()가 곧
 * "탭을 열 때만 세션 발급"과 정확히 대응한다(런처의 open→connect 패턴과 동형, 사용자가
 * 안 연 탭에서 미리 토큰을 발급하지 않는다).
 */
export function SupportSettingsTabPanel() {
  const t = useTranslations('supportWidget');
  const session = useSupportWidgetSession();

  useEffect(() => {
    session.connect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 마운트 1회만(런처의 [open] 패턴과 동형, session 참조 변경에 재발화 금지 — story #3260 2차 재시도 스톰 교훈 그대로 적용)
  }, []);

  return (
    <SectionCard>
      <SectionCardHeader>
        <h2 className="text-sm font-semibold text-foreground">{t('panelTitle')}</h2>
        <p className="text-xs text-muted-foreground">{t('panelSubtitle')}</p>
      </SectionCardHeader>
      <SectionCardBody className="p-0">
        <div className="flex h-[32rem] flex-col overflow-hidden rounded-b-[inherit] border-t border-border">
          <SupportWidgetPanelBody session={session} />
        </div>
      </SectionCardBody>
    </SectionCard>
  );
}
