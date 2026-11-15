'use client';

import { NavRail, type NavRailProps } from '@/components/nav/nav-rail';
import { useHomeModel } from './home-model-provider';

/**
 * story #4888 (UI-5 home) — the navigation bar with its «홈» badge filled: the badge is the home model's one number (the rows in «내 손이 필요해요»), read from the SAME model the home
 * screen draws its list and header from. Before this the badge was a seam that stayed 0 while the home body showed 3.
 */
export function NavRailWithHomeBadge(props: Omit<NavRailProps, 'todayCount' | 'todayCountAtLeast'>) {
  const { model, partial } = useHomeModel();
  // a number built from an incomplete read is a minimum: the bar says «N+», not an exact N
  return <NavRail {...props} todayCount={model?.badge ?? 0} todayCountAtLeast={partial} />;
}
