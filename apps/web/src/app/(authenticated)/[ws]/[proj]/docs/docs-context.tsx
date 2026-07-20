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
}

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
