'use client';

import { useEffect, type ReactNode } from 'react';
import { useTopBar } from './top-bar-context';

/**
 * story #2879(S1b) — top-bar ↔ PageHeader(`components/ui/page-header.tsx`) 역할 규칙
 * 전문은 그쪽 파일 주석 참고. 요지: 이 `title`과 PageHeader의 `title`을 같은 화면에서
 * 동시에 쓰지 않는다 — 화면 타입별로 title을 갖는 표면을 하나만 고른다.
 *
 * story #3945/#3946(유나 확認·페드루 정정) — 「TopBarSlot 제목은 그 화면에 다른 제목이
 * 없을 때만 h1」. 이 `title`을 `<h1>`로 감쌀지 판단하는 정본 규칙 — 그 화면 본문에
 * 별도 마스트헤드(다른 h1)가 있으면 이 자리는 비-헤딩(`<p>`/`<button>` 등)으로 낮추고,
 * 본문 h1이 없으면 이 자리의 `<h1>`이 그대로 그 페이지의 유일한 h1이라 정답이다(칩-단독
 * 14개 라우트가 이 경우 — 새 h1을 더 만들지 않는다, 과교정). 또한 조건부 렌더(로딩/빈
 * 상태)로 이 `title`이 잠깐 비-헤딩(Skeleton 등)이 되는 화면은 그 상태에도 h1이 0개가
 * 되지 않도록 sr-only h1 자리표시자를 같이 둔다(goals/docs/chats·retro/[id] 선례).
 */
interface TopBarSlotProps {
  title: ReactNode;
  actions?: ReactNode;
  /** 근본 재구현(2076 회귀 후속) — 기본 false(칩 숨김). 이 화면이 조직/프로젝트 컨텍스트를
   * "훑는" 루트 화면(보드·목표목록·독립 리스트 등)이면 true로 명시해 칩을 켠다. 상세/단일
   * 항목 화면은 아무것도 안 해도(기본값) 칩이 안 뜬다 — hideContextChip 방식(숨길 것 명시)의
   * fail-open 구조적 약점(새 상세 화면마다 빠뜨리기 쉬움, 유나양 규격)을 뒤집은 것. */
  showContextChip?: boolean;
}

export function TopBarSlot({ title, actions = null, showContextChip = false }: TopBarSlotProps) {
  const { setSlot, clearSlot } = useTopBar();
  useEffect(() => {
    setSlot({ title, actions, showContextChip });
    return clearSlot;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, actions, showContextChip]);
  return null;
}
