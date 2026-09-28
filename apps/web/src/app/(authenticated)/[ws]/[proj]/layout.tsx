import type { ReactNode } from 'react';
import { WorkTabsFrame } from '@/components/workspace/work-tabs-frame';

// story #4291 — 일감 여섯 탭의 탭 줄을 이 레이아웃이 쥔다(형제 탭 이동에서 다시 그려지지 않게 · 한 자리). 여섯 탭 목록 화면이 아니면 띠 없음.
export default function ProjectLayout({ children }: { children: ReactNode }) {
  return <WorkTabsFrame>{children}</WorkTabsFrame>;
}
