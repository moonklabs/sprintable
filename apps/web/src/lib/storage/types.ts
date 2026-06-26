/**
 * E-STORAGE S5 — Storage UI 계약 타입.
 * 계약 SSOT: 핸드오프 doc `e-storage-s5-storage-ui-handoff` §8 (S2 read-path `/api/v2/assets`·`/api/v2/folders`).
 */

/** 자산이 쓰이는 곳 한 건. manual은 deeplink 없음(평문). conversation_message는 snippet 노출. */
export type AssetSourceLinkType = 'story' | 'doc' | 'conversation_message' | 'manual';

export interface AssetSourceLink {
  type: AssetSourceLinkType;
  /** 원본 엔티티 id (story_id·doc_slug·conversation_id 등 — type별 의미). */
  id: string;
  /** 표시 제목(스토리/문서 제목, conversation은 발신자·스레드명). */
  title: string;
  /** 딥링크 경로. manual·링크 불가 시 null → UI는 평문(arrow 제거). */
  deeplink: string | null;
  /** conversation_message 스니펫(≤80자). 그 외 타입은 보통 null. */
  snippet?: string | null;
}

/** 업로더 enrich. team_members 뷰 기준 — avatar_url nullable, name NOT NULL. 객체 자체 null = 시스템 업로드. */
export interface AssetCreatedBy {
  id: string;
  name: string;
  avatar_url: string | null;
}

export interface Asset {
  id: string;
  org_id: string;
  project_id: string;
  folder_id: string | null;
  container: string;
  object_path: string;
  name: string;
  content_type: string;
  size_bytes: number;
  created_at: string;
  updated_at: string;
  created_by: AssetCreatedBy | null;
  source_links: AssetSourceLink[];
}

export interface Folder {
  id: string;
  name: string;
  parent_id: string | null;
  project_id: string;
}

/** GET /api/assets 응답 (cursor keyset pagination). */
export interface AssetListResponse {
  items: Asset[];
  next_cursor: string | null;
}

export type AssetSort = 'date' | 'name' | 'size';
export type SortOrder = 'asc' | 'desc';
export type StorageViewMode = 'list' | 'grid';
