import { getTranslations } from 'next-intl/server';
import { ShowcaseFrame } from '@/components/ds/showcase/ds-showcase';

const SHOWCASE_TODAY = '2026-11-11';

export async function generateMetadata() {
  const t = await getTranslations('designSystem');
  return { title: t('title') };
}

/**
 * UI-3(a9d56577) AC3 — 부품 견본 화면: 한 쪽에 토큰 + 모든 ds 부품 · 상태를 밝음/어둠 나란히. 다른 영역 주인이 보고 쓴다(주소: /design-system, 로그인한 사람만).
 * 견본의 «오늘»은 고정 예시 날짜다 — 실제 시계를 읽지 않아 시간대에 흔들리지 않고 서버 · 브라우저 렌더가 늘 같다(달력 오늘 점 · 고른 날 견본이 안정).
 */
export default async function DesignSystemPage() {
  const t = await getTranslations('designSystem');
  return (
    <main className="mx-auto w-full max-w-[1800px] p-4">
      <h1 className="m-0 mb-1 text-ds-title font-semibold text-ds-ink">{t('title')}</h1>
      <p className="m-0 mb-4 text-ds-small text-ds-ink-3">{t('lead')}</p>
      <ShowcaseFrame today={SHOWCASE_TODAY} />
    </main>
  );
}
