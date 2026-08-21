// @vitest-environment jsdom
//
// story #2879(S1b) — PageHeader size variant(cva). 기존 API(eyebrow/title/description/
// actions·size 미지정)는 원본 클래스와 값으로 동일해야 한다(회귀 0).
import { describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PageHeader } from './page-header';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function mount(node: React.ReactNode): Promise<{ el: HTMLElement; root: Root }> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(node); });
  return { el: container.firstElementChild as HTMLElement, root };
}

const ORIGINAL_TITLE_CLASSES = 'font-heading text-2xl font-bold tracking-tight text-foreground md:text-3xl';

function classSet(s: string): Set<string> {
  return new Set(s.split(/\s+/).filter(Boolean));
}

describe('PageHeader size variant (story #2879)', () => {
  it('size 미지정(기존 API 그대로)이면 원본 h1 클래스 집합과 정확히 일치한다(회귀 0)', async () => {
    const { el } = await mount(<PageHeader title="제목" />);
    const h1 = el.querySelector('h1')!;
    expect(classSet(h1.className)).toEqual(classSet(ORIGINAL_TITLE_CLASSES));
  });

  it('size=page가 기존과 동일하다', async () => {
    const { el } = await mount(<PageHeader title="제목" size="page" />);
    const h1 = el.querySelector('h1')!;
    expect(classSet(h1.className)).toEqual(classSet(ORIGINAL_TITLE_CLASSES));
  });

  it('size=section이 text-xl을 렌더한다', async () => {
    const { el } = await mount(<PageHeader title="제목" size="section" />);
    const h1 = el.querySelector('h1')!;
    expect(h1.className).toContain('text-xl');
    expect(h1.className).not.toContain('text-2xl');
    expect(h1.className).not.toContain('md:text-3xl');
  });

  it('size=compact가 text-lg를 렌더한다', async () => {
    const { el } = await mount(<PageHeader title="제목" size="compact" />);
    const h1 = el.querySelector('h1')!;
    expect(h1.className).toContain('text-lg');
  });

  it('eyebrow·description·actions가 기존과 동일하게 렌더된다', async () => {
    const { el } = await mount(
      <PageHeader eyebrow="여정" title="제목" description="설명" actions={<button>액션</button>} />,
    );
    expect(el.textContent).toContain('여정');
    expect(el.textContent).toContain('설명');
    expect(el.textContent).toContain('액션');
  });
});
