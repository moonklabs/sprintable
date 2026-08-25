// story #3466(카디르 QA REQUEST_CHANGES, 2026-08-25) — WorkspaceFrameTabs에 얹은 useIsMobile()
// (story #3043 ⓐ)이 jsdom엔 없는 window.matchMedia를 직접 호출해, 이 훅을 개별 모킹하지 않은
// 다른 소비처(EpicSwimlaneBoard 등 — WorkspaceFrameTabs를 공유 컴포넌트로 임포트하는 모든 테스트)
// 31개가 "matchMedia is not a function"으로 깨졌다. 파일마다 matchMedia stub을 흩는 반창고 대신
// (다음 소비처가 또 깨지는 구조) 여기 전역 beforeEach로 기본 무결점(false=desktop) 폴리필을
// 심는다 — 기존 개별 stub(vi.stubGlobal('matchMedia', ...) 또는 vi.mock('@/hooks/use-mobile', ...))
// 을 쓰는 파일은 자기 값으로 뒤이어 덮어쓰므로 회귀 없음(전수 grep 확認, 11개 파일 전부 vi.stubGlobal
// 패턴이라 「나중 호출이 이긴다」로 충돌 0). beforeEach(최상위 아님)로 심는 이유 — 일부 파일이
// 자기 afterEach에서 vi.unstubAllGlobals()를 호출해(kanban-board.test.tsx 등) top-level 1회
// 설정은 그 파일의 2번째 테스트부터 사라진다 — 매 테스트 앞에서 다시 세워야 항상 안전하다.
import { beforeEach } from 'vitest';

beforeEach(() => {
  if (typeof window === 'undefined') return;
  if (typeof window.matchMedia === 'function') return;
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});
