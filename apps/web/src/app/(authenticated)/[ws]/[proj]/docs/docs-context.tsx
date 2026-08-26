'use client';

import { createContext, useContext, type Dispatch, type SetStateAction } from 'react';

export interface Doc {
  id: string;
  parent_id: string | null;
  title: string;
  slug: string;
  icon: string | null;
  sort_order: number;
  is_folder?: boolean;
  // story #2955 §2/§6 — 지식 인덱스 상태 칩·카테고리 카운트용. BE DocSummaryResponse는
  // 이미 status를 내려주지만(story #2672 이래 draft 기본값 보장) 이 FE Doc 타입엔 없었다
  // (fetchTree가 런타임엔 그대로 들고 있었으나 접근할 타입 선언이 없었을 뿐).
  status?: string;
  // story #2167: 트리 정렬 토글("수정일순")용 — BE DocSummaryResponse는 이미 내려주지만
  // 이 FE Doc 타입엔 없었다.
  updated_at?: string;
  // story #2193 후속(시간 버킷): BE DocSummaryResponse가 #2505에서 created_at을 추가로
  // 노출하기 시작했다(migration 전 문서는 여전히 값이 있을 수 있으나, 파싱 실패/누락
  // 가능성을 doc-groups.ts의 시간 버킷 로직이 명시적으로 다룬다 — 조용히 삼키지 않는다).
  created_at?: string;
}

// story #2167: 트리 표시 정렬 모드. 'manual' = sort_order(드래그로 바뀌는 기존 기본값·
// 저장됨). 'title'/'updated_at' = 표시 전용 재정렬 — sort_order는 안 건드린다(수동 순서를
// 유지해뒀다가 다시 '수동'으로 돌아오면 그대로 남아있게).
export type DocSortMode = 'manual' | 'title' | 'updated_at';

export interface DocUpdate {
  id: string;
  title: string;
  updated_at: string;
}

interface DocsLayoutContextType {
  // story a539c649 S2: URL 경로가 가리키는 ws/proj — 내부 네비게이션(doc-project-url.ts)의
  // 유일한 project 컨텍스트 출처(#2154 흡수 — 더는 다른 곳에서 project를 추측하지 않는다).
  wsSlug: string;
  projSlug: string;
  // 타입은 옵셔널 유지(기존 소비부의 `if (!projectId) return;` 가드 전부 무변경 — layout.tsx가
  // notFound()로 항상 값 보장하지만, 방어적 가드를 걷어내는 건 이 마이그레이션 스코프 밖).
  projectId: string | undefined;
  tree: Doc[];
  setTree: Dispatch<SetStateAction<Doc[]>>;
  handleNewDoc: () => void;
  fetchTree: () => Promise<void>;
  pendingDocUpdate: DocUpdate | null;
  clearPendingDocUpdate: () => void;
  expandFolder: (id: string) => void;
  /** 박스1: 모바일 트리 드로어 열기(슬림 헤더 트리 아이콘이 consume·칩 띠 트리거 대체) */
  openTreeDrawer?: () => void;
}

export const DocsLayoutContext = createContext<DocsLayoutContextType | null>(null);

export function useDocsLayout(): DocsLayoutContextType {
  const ctx = useContext(DocsLayoutContext);
  if (!ctx) throw new Error('useDocsLayout must be used within DocsLayout');
  return ctx;
}
