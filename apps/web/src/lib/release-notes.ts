export interface ReleaseNoteItem {
  text: string;
  href?: string;
}

export interface ReleaseNote {
  id: string;
  version: string;
  /** 표시용 문자열 (정렬/비교는 배열 순서·id로) */
  publishedAt: string;
  title: string;
  summary: string;
  items: ReleaseNoteItem[];
}

/**
 * newest-first. ⚠️ 어느 릴리즈를 어떤 문구로 알릴지는 PO/product 콜 — 아래는 대표 시드(구조 검증용).
 * id = 가시성 비교 키(localStorage seen 과 대조). 실제 노트 추가/문구는 PO가 갱신.
 */
export const RELEASE_NOTES: ReleaseNote[] = [
  {
    id: '2026-06-v1-4',
    version: 'v1.4',
    publishedAt: '2026년 6월',
    title: '멀티계정 전환과 알림 도달 확인이 생겼어요',
    summary: '로그아웃 없이 계정을 오가고, 알림이 실제로 도달했는지 한눈에 확인하세요.',
    items: [
      { text: '여러 계정을 추가해 로그아웃 없이 전환합니다.' },
      { text: '알림 목적지를 한 화면에서 보고·끄고·실제 도달을 테스트합니다.' },
      { text: '에이전트 추가를 모달 한 곳에서 끝냅니다.' },
    ],
  },
  {
    id: '2026-06-v1-3',
    version: 'v1.3',
    publishedAt: '2026년 6월',
    title: '온보딩이 2분이면 끝나요',
    summary: '설정 하나를 붙여넣고, 실제로 작동하는지 바로 확인합니다.',
    items: [
      { text: '에이전트 연결 설정을 한 번에 복사합니다.' },
      { text: '연결 확인 레일로 실제 동작을 직접 검증합니다.' },
    ],
  },
  {
    id: '2026-05-v1-2',
    version: 'v1.2',
    publishedAt: '2026년 5월',
    title: '보드가 더 부드러워졌어요',
    summary: '칸반 보드 드래그와 모바일 사용성을 개선했습니다.',
    items: [
      { text: '카드 드래그·드롭 정확도를 높였습니다.' },
      { text: '모바일에서 보드 스크롤이 매끄러워졌습니다.' },
    ],
  },
];

export const LATEST_RELEASE_NOTE_ID = RELEASE_NOTES[0]?.id ?? null;
