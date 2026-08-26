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

// story #2969 §1.3/§2 C행(PR-6) 갱신 — Display tier 적용: font-bold(700)→
// --font-weight-editorial-heading(820)·tracking-tight→tracking-[-0.02em]
// (§1.3 Display 정의 그대로).
// story #2974 §1(PR-D0) 갱신 — 페이스(family)가 font-heading(Pretendard 고정)에서
// font-display(§1 신규 토큰, D0 값=var(--font-sans)라 시각 변화 0)로 전환.
// story #2976(근본처방) 갱신 — 무게가 인라인 style에서 유틸리티 클래스(font-editorial-heading)
// 로 복귀. cn()이 extendTailwindMerge로 이 이름을 font-weight 충돌군에 등록해 font-display와
// 안전하게 병기된다(lib/utils.ts 참고) — 더 이상 인라인 style 우회가 필요 없다.
// story #2974 D1 revert(PO 판정 2026-08-24, PR#3416) — D1이 반려돼 페이스는 다시 D0 값
// (font-display=var(--font-sans), 시각 무변화)이다.
const ORIGINAL_TITLE_CLASSES = 'font-display font-editorial-heading text-2xl tracking-[-0.02em] text-foreground md:text-3xl';

function classSet(s: string): Set<string> {
  return new Set(s.split(/\s+/).filter(Boolean));
}

describe('PageHeader size variant (story #2879)', () => {
  it('size 미지정(기존 API 그대로)이면 원본 h1 클래스 집합과 정확히 일치한다(회귀 0)', async () => {
    const { el } = await mount(<PageHeader title="제목" />);
    const h1 = el.querySelector('h1')!;
    expect(classSet(h1.className)).toEqual(classSet(ORIGINAL_TITLE_CLASSES));
  });

  // story #2976(근본처방) — 무게가 인라인 style이 아니라 font-editorial-heading 유틸리티
  // 클래스로 걸린다(twMerge가 이제 font-display와의 병기를 정확한 충돌군으로 구분해 안전).
  it('h1이 인라인 style 없이 font-editorial-heading 클래스로 무게를 받는다', async () => {
    const { el } = await mount(<PageHeader title="제목" />);
    const h1 = el.querySelector('h1')! as HTMLElement;
    expect(h1.className).toContain('font-editorial-heading');
    expect(h1.className).toContain('font-display');
    expect(h1.style.fontWeight).toBe('');
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
