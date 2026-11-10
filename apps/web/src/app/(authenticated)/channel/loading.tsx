import { useTranslations } from 'next-intl';
import { RouteTopBarFallback } from '@/components/nav/flat-tab-top-bar';
import { Skeleton } from '@/components/ui/skeleton';

export default function Loading() {
  // story #4885(UI-2 AC4 PR 1) — «전체» 맨 아래 «그 밖»에 입구가 생긴 화면이라 chats와 같게 «불러오는 중»을 화면 읽기 프로그램에 상태로 알린다(loading-coverage 가드).
  const t = useTranslations('common');
  return (
    <div className="flex min-h-0 flex-1 flex-col" role="status" aria-busy="true">
      {/* story #4326 — 불러오는 동안 상단바 제목 · 칩이 비지 않게(경로 → 제목 표). */}
      <RouteTopBarFallback route="channel" />
      <span className="sr-only">{t('loading')}</span>
      <div className="border-b border-border px-4 py-3">
        <Skeleton className="h-6 w-40" />
      </div>
      <div className="flex-1 space-y-4 overflow-hidden p-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className={i % 2 === 0 ? 'flex justify-start' : 'flex justify-end'}>
            <Skeleton className={`h-16 rounded-xl ${i % 2 === 0 ? 'w-2/3' : 'w-1/2'}`} />
          </div>
        ))}
      </div>
      <div className="border-t border-border p-3">
        <Skeleton className="h-12 w-full rounded-lg" />
      </div>
    </div>
  );
}
