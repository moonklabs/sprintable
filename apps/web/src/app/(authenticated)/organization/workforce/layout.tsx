import type { ReactNode } from 'react';
import { WorkforceFrame } from '@/components/agents/workforce-frame';

// story 5035 (C5) — 에이전트 1뎁스: 옛 «팀» 탭줄(일곱 링크) 자리에 «목록 → 상세» 한 틀이 선다. 주소는 하나도 안 바뀐다 — 틀이 주소를 읽어 «목록 + 상세»(관리 · 에이전트 상세) 또는 «전체 보기»(실행 기록 · 키 · 통계 · 접근표 · 영입)를 정한다.
// 레이아웃이라 목록 ↔ 상세를 오가도 목록이 다시 그려지지 않는다. «사람» 칸은 members 쪽 «팀» 줄에 그대로 있다.
export default function WorkforceLayout({ children }: { children: ReactNode }) {
  return <WorkforceFrame>{children}</WorkforceFrame>;
}
