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
// --font-weight-editorial-heading(820, 인라인 style — 과거 font-editorial-heading
// 유틸리티가 tailwind-merge와 충돌해 font-heading을 지우던 것을 회피)·
// tracking-tight→tracking-[-0.02em](§1.3 Display 정의 그대로).
// story #2974 §1(PR-D0) 갱신 — 페이스(family)가 font-heading(Pretendard 고정)에서
// font-display(§1 신규 토큰, D0 값=var(--font-sans)라 시각 변화 0)로 전환.
// story #2974(PR-D1 delta, PO 확定 2026-08-24 ③) — D1 한정 제외: 이 컴포넌트 실사용처가
// doc의 "대표 1~2화면"(docs·goals)이 아니라서 font-heading으로 되돌림. D0 원복이 아니라
// "세리프 적용 대상에서만 제외" — D2(선생님 라이브 감 confirm 後)에서 font-display로 복귀.
const ORIGINAL_TITLE_CLASSES = 'font-heading text-2xl tracking-[-0.02em] text-foreground md:text-3xl';

function classSet(s: string): Set<string> {
  return new Set(s.split(/\s+/).filter(Boolean));
}

describe('PageHeader size variant (story #2879)', () => {
  it('size 미지정(기존 API 그대로)이면 원본 h1 클래스 집합과 정확히 일치한다(회귀 0)', async () => {
    const { el } = await mount(<PageHeader title="제목" />);
    const h1 = el.querySelector('h1')!;
    expect(classSet(h1.className)).toEqual(classSet(ORIGINAL_TITLE_CLASSES));
  });

  // story #2969 §1.3(PR-6) — Display tier 무게(820)가 인라인 style로 걸린다(tailwind-merge
  // 충돌 회피, 위 주석 참고).
  it('h1이 --font-weight-editorial-heading을 인라인 font-weight로 갖는다', async () => {
    const { el } = await mount(<PageHeader title="제목" />);
    const h1 = el.querySelector('h1')! as HTMLElement;
    expect(h1.style.fontWeight).toBe('var(--font-weight-editorial-heading)');
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
