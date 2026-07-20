'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  FolderKanban,
  CalendarRange,
  Layers,
  Compass,
  FlaskConical,
  Users,
  RotateCcw,
  Activity,
  FileText,
  Image,
  HardDrive,
  Settings,
} from 'lucide-react';

// story #1958(P2-S2) "전체" 탭의 임시 스텁 — blueprint §3.2가 모바일 사이드바(Sheet·햄버거)
// 폐기 방향이라 기존 GNB Sheet를 탭에 매달지 않고, 최소 목록 라우트로 대신한다. 정식 목록화는
// P2-S9(story #1965)가 담당 — 이 페이지는 그때 교체된다(오르테가군 확定, 2026-07-17).
// bare 경로만 씀 — 미들웨어의 bare→쿠키 default 해소 301 안전망이 ws/proj slug를 채운다
// (app-sidebar.tsx의 resourceLink()와 동형 전제).
const ITEMS = [
  { href: '/board', icon: FolderKanban, labelKey: 'board' as const },
  { href: '/sprints', icon: CalendarRange, labelKey: 'sprints' as const },
  { href: '/goals', icon: Layers, labelKey: 'goals' as const },
  { href: '/loops', icon: FlaskConical, labelKey: 'loops' as const },
  { href: '/standup', icon: Users, labelKey: 'standup' as const },
  { href: '/retro', icon: RotateCcw, labelKey: 'retro' as const },
  { href: '/activity', icon: Activity, labelKey: 'activity' as const },
  { href: '/docs', icon: FileText, labelKey: 'docs' as const },
  { href: '/artifacts', icon: Image, labelKey: 'artifacts' as const },
  { href: '/storage', icon: HardDrive, labelKey: 'storage' as const },
  { href: '/dashboard', icon: Compass, labelKey: 'dashboard' as const },
  { href: '/settings', icon: Settings, labelKey: 'settings' as const },
] as const;

export default function MorePage() {
  const t = useTranslations('nav');
  const tMore = useTranslations('mobileTabBar');

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
      <h1 className="mb-1 text-lg font-semibold text-foreground">{tMore('more')}</h1>
      <p className="mb-4 text-xs text-muted-foreground">{tMore('moreTempNotice')}</p>
      <ul className="divide-y divide-border rounded-xl border border-border">
        {ITEMS.map(({ href, icon: Icon, labelKey }) => (
          <li key={href}>
            <Link
              href={href}
              className="flex min-h-12 items-center gap-3 px-4 py-3 text-sm text-foreground hover:bg-muted"
            >
              <Icon className="size-[18px] shrink-0 text-muted-foreground" strokeWidth={1.8} />
              {t(labelKey)}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
