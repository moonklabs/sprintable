// @vitest-environment jsdom
//
// 9449da0e — 캔버스 휴먼 진입점 회귀가드. 선생님 prod 지적("완료했다더니 하나도 보이지 않는·
// 진입점도 없는") 직결: 산출물 0일 때 `return null`이던 걸 1급 빈 상태 + "그리기" 생성 딸깍으로
// 대체한 부분만 검증(기존 items>0 렌더 경로는 이 diff가 손대지 않음 — 구조적 회귀 0).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { ArtifactSection } from './artifact-section';
import koMessagesRaw from '../../../messages/ko.json';
import enMessagesRaw from '../../../messages/en.json';

type LooseMessages = { [key: string]: string | LooseMessages };
const koMessages = koMessagesRaw as unknown as LooseMessages;
const enMessages = enMessagesRaw as unknown as LooseMessages;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  // 빈 목록 — GET /api/visual-artifacts?story_id= → {data: []}(story 귀속 산출물 0).
  fetchMock = vi.fn(async () => ({
    ok: true, status: 200, json: async () => ({ data: [] }),
  })) as unknown as ReturnType<typeof vi.fn>;
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function mount(locale: 'ko' | 'en' = 'ko') {
  const messages = locale === 'ko' ? koMessages : enMessages;
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={messages} timeZone="Asia/Seoul">
        <ArtifactSection storyId="story-1" />
      </NextIntlClientProvider>,
    );
  });
  // 산출물 목록 fetch(useEffect) 완료까지 마이크로태스크 플러시.
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe('ArtifactSection — 빈 상태 1급화 (story 9449da0e)', () => {
  it('renders a first-class empty state instead of returning null when there are 0 artifacts (ko)', async () => {
    await mount('ko');
    expect(container.textContent).toContain('산출물'); // 섹션 라벨 상시 노출
    expect(container.textContent).toContain('아직 산출물이 없습니다');
    // story 64010b05 — 임포트 co-located 이후 카피 갱신(doc SSOT).
    expect(container.textContent).toContain('직접 그리거나, 이미지·HTML을 임포트해 시작할 수 있습니다');
    const buttons = [...container.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons).toEqual(['산출물 그리기', '임포트']);
  });

  it('renders the same empty state in English (ko/en parity, AC3)', async () => {
    await mount('en');
    expect(container.textContent).toContain('Artifacts');
    expect(container.textContent).toContain('No artifacts yet');
    expect(container.textContent).toContain('Draw one yourself, or import an image or HTML to get started.');
    const buttons = [...container.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons).toEqual(['Draw artifact', 'Import']);
  });

  it('clicking "Draw artifact" enters create mode — mounts the real ArtifactEditor (no mock)', async () => {
    await mount('ko');
    const cta = container.querySelector('button');
    expect(cta).not.toBeNull();
    await act(async () => { cta!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    // 빈 상태는 사라지고 편집기(CommitBar의 "버전으로 저장" 액션)가 뜬다 — mock 0, 실 컴포넌트.
    expect(container.textContent).not.toContain('아직 산출물이 없습니다');
    expect(container.textContent).toContain('버전으로 저장');
  });

  it('clicking "임포트" opens the import dialog — co-located 2번째 입구(story 64010b05)', async () => {
    await mount('ko');
    const importButton = [...container.querySelectorAll('button')].find((b) => b.textContent === '임포트')!;
    await act(async () => { importButton.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    // base-ui Dialog는 document.body에 포탈.
    expect(document.body.textContent).toContain('산출물 임포트');
    expect(document.body.textContent).toContain('이미지');
    expect(document.body.textContent).toContain('HTML 붙여넣기');
  });
});
