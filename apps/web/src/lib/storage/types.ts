/**
 * E-STORAGE S5 — Storage UI 계약 타입.
 * 계약 SSOT: 핸드오프 doc `e-storage-s5-storage-ui-handoff` §8 (S2 read-path `/api/v2/assets`·`/api/v2/folders`).
 */

/** 자산이 쓰이는 곳 한 건. manual은 deeplink 없음(평문). */
export type AssetSourceLinkType = 'story' | 'doc' | 'conversation_message' | 'manual';

/**
 * 딥링크 — BE 계약상 type별 형상이 다르다(라이브 dev /api/v2/assets 확인).
 * - string: 이미 완성된 경로.
 * - conversation_message: `{ conversation_id, message_id? }` 객체.
 * - story/doc: `{ story_id }` / `{ doc_slug }` 객체일 수 있음.
 * - manual: 항상 null(평문, arrow 없음).
 * 형상이 늘어날 수 있어 `Record<string,string>` 로 보수적 허용 → resolveDeeplinkHref 가 흡수.
 */
export type AssetDeeplink =
  | string
  | { conversation_id: string; message_id?: string }
  | { story_id: string }
  | { doc_slug: string }
  | Record<string, string>
  | null;

export interface AssetSourceLink {
  type: AssetSourceLinkType;
  /** 원본 엔티티 id (story_id·doc_slug·conversation_id 등 — type별 의미). */
  id: string;
  /**
   * 표시 제목 = 컨텐츠 본문. type별 의미:
   * story/doc → 엔티티 제목, conversation_message → 80자 메시지 스니펫, manual → 파일명.
   */
  title: string;
  /** 딥링크. manual·링크 불가 시 null → UI는 평문(arrow 제거). */
  deeplink: AssetDeeplink;
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
