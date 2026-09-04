// @vitest-environment jsdom
//
// story #2886(S2b) — 선생님 실증(전체 제목+메타 4항이 산문을 익사시킴)에 대한 처방 회귀가드.
// default(inline) 변형은 짧은 라벨만 상시 표기하고, 격납 메타(관찰됨·form·point·status)는
// hover/focus tooltip으로만 낸다. inline-meta 변형은 기존 전개 그대로(독립 표시용 escape hatch).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { EntityChip } from './embed-card';
import { ReadingPanelProvider } from './reading-panel-context';
// story 3436(묶음 1) — DialogContent가 이제 useTranslations('common')을 쓴다. 클릭이
// 모달(Dialog 기반)을 여는 테스트만 감싼다(embed-card.link-states.test.tsx와 같은 관례).
import koMessages from '../../../messages/ko.json';

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => ({ projectMemberships: [] }),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

const LONG_LABEL = '이것은 아주 길고 상세한 스토리 제목으로 산문 속에서 문장을 익사시킬 수 있다';
const META = { form: 'mention', referencedAt: '2026-07-26T00:00:00.000Z' };

describe('EntityChip variant=inline(기본) — story #2886', () => {
  it('긴 라벨은 truncate 클래스를 갖고, referenceMeta/status가 컨테이너 텍스트에 상시 노출되지 않는다', async () => {
    await act(async () => {
      root.render(<EntityChip entityType="story" entityId="s-1" label={LONG_LABEL} href={null} referenceMeta={META} />);
    });
    const labelSpan = Array.from(container.querySelectorAll('span')).filter((s) => s.textContent === LONG_LABEL).at(-1);
    expect(labelSpan?.className).toContain('truncate');
    expect(container.textContent).not.toContain('관찰됨');
  });

  it('트리거에 포커스를 주면 tooltip(portal)에 전체 라벨+관찰됨 메타가 뜬다', async () => {
    await act(async () => {
      root.render(<EntityChip entityType="story" entityId="s-1" label={LONG_LABEL} href={null} referenceMeta={META} />);
    });
    await act(async () => { container.querySelector('button')!.focus(); });
    expect(document.body.textContent).toContain(LONG_LABEL);
    // story #2886(S2b) — 유나군 하이파이 목업 대조: 툴팁은 라벨:값 행 구조(상태·참조 형태·관찰).
    expect(document.body.textContent).toContain('참조 형태');
    expect(document.body.textContent).toContain('멘션');
    expect(document.body.textContent).toContain('관찰');
    expect(document.body.textContent).toContain('7/26');
  });

  it('격납할 메타가 없으면(referenceMeta·status 둘 다 無) tooltip을 안 씌운다', async () => {
    await act(async () => {
      root.render(<EntityChip entityType="story" entityId="s-1" label="짧은 제목" href={null} />);
    });
    const trigger = container.querySelector('button')!;
    // base-ui Tooltip.Trigger는 aria-describedby 등 트리거 전용 속성을 부여한다 — 안 씌웠으면
    // 순수 button 그대로.
    expect(trigger.tagName).toBe('BUTTON');
    await act(async () => { trigger.focus(); });
    expect(document.body.textContent).not.toContain('관찰됨');
  });

  it('전체 라벨은 native title 속성으로도 보장된다(AC3 접근성 폴백)', async () => {
    await act(async () => {
      root.render(<EntityChip entityType="story" entityId="s-1" label={LONG_LABEL} href={null} />);
    });
    const labelSpan = Array.from(container.querySelectorAll('span')).filter((s) => s.textContent === LONG_LABEL).at(-1);
    expect(labelSpan?.getAttribute('title')).toBe(LONG_LABEL);
  });
});

describe('EntityChip variant=inline-meta — 기존 전개 그대로(escape hatch)', () => {
  it('메타가 컨테이너 텍스트에 항상 인라인 표기된다(포커스 불요)', async () => {
    await act(async () => {
      root.render(<EntityChip entityType="story" entityId="s-1" label={LONG_LABEL} href={null} referenceMeta={META} variant="inline-meta" />);
    });
    expect(container.textContent).toContain('관찰됨');
    expect(container.textContent).toContain('멘션');
    expect(container.textContent).toContain('7/26');
  });

  it('라벨에 truncate 클래스가 없다(전체 제목 그대로)', async () => {
    await act(async () => {
      root.render(<EntityChip entityType="story" entityId="s-1" label={LONG_LABEL} href={null} variant="inline-meta" />);
    });
    const labelSpan = Array.from(container.querySelectorAll('span')).filter((s) => s.textContent === LONG_LABEL).at(-1);
    expect(labelSpan?.className).not.toContain('truncate');
  });
});

describe('EntityChip ghost — story #3213(미등록≠비존재, "대상이 없습니다" 정적 단정 제거)', () => {
  it('ghost는 "대상이 없습니다"를 더 이상 안 쓰고 실 라벨을 보인다', async () => {
    await act(async () => {
      root.render(<EntityChip entityType="story" entityId="s-1" label={LONG_LABEL} href={null} ghost referenceMeta={META} />);
    });
    expect(container.textContent).not.toContain('대상이 없습니다');
    expect(container.textContent).toContain(LONG_LABEL);
  });

  it('ghost도 클릭 가능(EntityPreviewModal의 실 fetch로 진짜 존재판정 위임)', async () => {
    await act(async () => {
      root.render(<EntityChip entityType="story" entityId="s-1" label="스토리 제목" href={null} ghost />);
    });
    expect(container.querySelector('button')).not.toBeNull();
  });
});

describe('EntityChip — story #3208(PO customer-zero, 카디르 QA #3611 지적) — 클릭→모달의 detail fetch는 아티팩트 자기 project로 스코프된다', () => {
  it('클릭 시 EntityPreviewModal이 preview로 해소한 project_id를 X-Project-Id로 명시 실어 detail을 조회한다 — «채팅 공유받은 사람이 클릭」한 원 시나리오', async () => {
    // 까디르 QA(PR#3611) — embed-card.link-states.test.tsx의 X-Project-Id pin은 EmbedCard의
    // 독립 썸네일 fetch(마운트 시점에 먼저 도착)에 가려 EntityChip 클릭→모달 경로(스토리 원
    // 사건: 채팅으로 공유받은 사람이 다른 project를 보다가 클릭) 자체는 pin 없이 방치될
    // 뻔했다 — 이 테스트는 EntityChip 단독(EmbedCard 썸네일 효과가 없는 컴포넌트)이라 그
    // 혼선이 구조적으로 없다.
    const calls: { url: string; headers: Record<string, string> }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
      calls.push({ url, headers });
      if (url.includes('/api/visual-artifacts/preview')) {
        return { ok: true, json: async () => ({ data: { projectId: 'p-owning' } }) };
      }
      return { ok: true, json: async () => ({ data: {} }) };
    }));
    await act(async () => {
      root.render(wrap(<EntityChip entityType="artifact" entityId="art-cross" label="크로스 목업" href={null} />));
    });
    await act(async () => { container.querySelector('button')!.click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    const detailCall = calls.find((c) => c.url === '/api/visual-artifacts/art-cross');
    expect(detailCall).toBeDefined();
    expect(detailCall!.headers['x-project-id']).toBe('p-owning');
  });
});

// story #461e9a54(P0) — 채팅 임베드는 전부 우측 ReadingPanel로(모달 0). ReadingPanelProvider
// 유무로 갈리는 두 경로를 각각 고정한다.
describe('EntityChip — story #461e9a54 ReadingPanel 라우팅', () => {
  it('ReadingPanelProvider 하위에서 클릭하면 open()이 정확한 target으로 불리고, Dialog는 안 뜬다', async () => {
    const open = vi.fn();
    await act(async () => {
      root.render(
        <ReadingPanelProvider value={{ open, close: vi.fn(), navigateTo: vi.fn() }}>
          <EntityChip entityType="story" entityId="s-1" label="스토리 제목" href="/board?story=s-1" />
        </ReadingPanelProvider>,
      );
    });
    await act(async () => { container.querySelector('button')!.click(); });
    expect(open).toHaveBeenCalledWith({
      kind: 'entity', entityType: 'story', entityId: 's-1', title: '스토리 제목', status: null, href: '/board?story=s-1',
    });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it('Provider 밖(doc-content-renderer·story-detail-panel 등)에서 클릭하면 기존 Dialog 모달이 뜬다(회귀 0)', async () => {
    await act(async () => {
      root.render(wrap(<EntityChip entityType="story" entityId="s-1" label="스토리 제목" href="/board?story=s-1" />));
    });
    await act(async () => { container.querySelector('button')!.click(); });
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
  });
});
