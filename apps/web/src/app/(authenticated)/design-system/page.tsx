import { ShowcaseFrame } from '@/components/ds/showcase/ds-showcase';

export const metadata = { title: 'Design system' };

/**
 * UI-3(a9d56577) AC3 — 부품 견본 화면: 한 쪽에 토큰 + 모든 ds 부품 · 상태를 밝음/어둠 나란히. 다른 영역 주인이 보고 쓴다(주소: /design-system, 로그인한 사람만).
 * `today`는 서버가 정한다(UTC 날짜 — 견본이라 시간대를 따지지 않는다).
 */
export default function DesignSystemPage() {
  const today = new Date().toISOString().slice(0, 10);
  return (
    <main className="mx-auto w-full max-w-[1800px] p-4">
      <h1 className="m-0 mb-1 text-ds-title font-semibold text-ds-ink">Design system</h1>
      <p className="m-0 mb-4 text-ds-small text-ds-ink-3">토큰과 ds 부품의 상태를 밝음 · 어둠으로 나란히 보여요. 쓰는 법은 문서 ui3-component-list-v0-4-usage.</p>
      <ShowcaseFrame today={today} />
    </main>
  );
}
