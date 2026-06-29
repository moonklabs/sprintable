export interface ReleaseNoteItem {
  text: string;
  href?: string;
}

export interface ReleaseNote {
  id: string;
  version: string;
  /** 표시용 문자열 (정렬/비교는 서버 published_at·id로) */
  publishedAt: string;
  title: string;
  summary: string;
  items: ReleaseNoteItem[];
}

/**
 * 릴리즈 노트는 BE(`release_notes` 테이블)에서 데이터주도로 제공된다(de-hardcode·story 53bc0945).
 * `GET /api/release-notes` → newest-first published. id = 가시성 비교 키(localStorage seen 과 대조).
 * 노트 추가/문구는 관리 CRUD(또는 시드)로 — 코드 편집/배포 불필요.
 * 실패/빈 응답은 `[]` (호출부가 빈상태 graceful·gate auto-open 안 함).
 */
export async function fetchReleaseNotes(): Promise<ReleaseNote[]> {
  try {
    const res = await fetch('/api/release-notes', { credentials: 'same-origin' });
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: ReleaseNote[] };
    return Array.isArray(body?.data) ? body.data : [];
  } catch {
    return [];
  }
}
