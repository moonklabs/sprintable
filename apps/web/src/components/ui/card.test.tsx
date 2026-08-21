// @vitest-environment jsdom
//
// story #2877(S1a) — Card 단일 프리미티브. SectionCard/GlassPanel이 cardVariants로 이관된 뒤
// 원래 손코딩 클래스 세트와 «값으로» 동일한지 잠근다(회귀 0 AC의 실측 근거) — 순서가 아니라
// 클래스 집합 동치를 잰다(Tailwind는 순서 무관).
import { describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { cardVariants, Card, CardHeader, CardBody, CardFooter } from './card';
import { SectionCard, SectionCardHeader, SectionCardBody } from './section-card';
import { GlassPanel } from './glass-panel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function classSet(el: Element | null): Set<string> {
  return new Set((el?.className ?? '').split(/\s+/).filter(Boolean));
}

async function mountAndGetRoot(node: React.ReactNode): Promise<{ el: HTMLElement; root: Root }> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(node); });
  return { el: container.firstElementChild as HTMLElement, root };
}

// 이관 前 손코딩 원본(section-card.tsx/glass-panel.tsx git 이력) — 정본 리터럴로 대조.
const ORIGINAL_SECTION_CARD_CLASSES = 'rounded-2xl border border-border/80 bg-card text-card-foreground shadow-sm';
const ORIGINAL_GLASS_PANEL_CLASSES =
  'rounded-2xl border border-border/80 bg-card/95 text-card-foreground shadow-sm backdrop-blur supports-[backdrop-filter]:bg-card/88';

describe('cardVariants (story #2877)', () => {
  it('surface=solid·radius=card가 SectionCard 원본 클래스 집합과 정확히 일치한다', () => {
    expect(classSet({ className: cardVariants({ surface: 'solid', radius: 'card' }) } as Element)).toEqual(
      classSet({ className: ORIGINAL_SECTION_CARD_CLASSES } as Element),
    );
  });

  it('surface=glass·radius=card가 GlassPanel 원본 클래스 집합과 정확히 일치한다', () => {
    expect(classSet({ className: cardVariants({ surface: 'glass', radius: 'card' }) } as Element)).toEqual(
      classSet({ className: ORIGINAL_GLASS_PANEL_CLASSES } as Element),
    );
  });

  it('defaultVariants가 solid·card다', () => {
    expect(classSet({ className: cardVariants({}) } as Element)).toEqual(
      classSet({ className: ORIGINAL_SECTION_CARD_CLASSES } as Element),
    );
  });
});

describe('SectionCard/GlassPanel — 얇은 alias 회귀가드 (story #2877)', () => {
  it('SectionCard가 <section> 태그와 원본 클래스 그대로 렌더된다(태그·클래스 무회귀)', async () => {
    const { el } = await mountAndGetRoot(<SectionCard>hi</SectionCard>);
    expect(el.tagName).toBe('SECTION');
    expect(el.getAttribute('data-slot')).toBe('section-card');
    expect(classSet(el)).toEqual(classSet({ className: ORIGINAL_SECTION_CARD_CLASSES } as Element));
  });

  it('GlassPanel이 <div> 태그와 원본 클래스 그대로 렌더된다(태그·클래스 무회귀)', async () => {
    const { el } = await mountAndGetRoot(<GlassPanel>hi</GlassPanel>);
    expect(el.tagName).toBe('DIV');
    expect(el.getAttribute('data-slot')).toBe('glass-panel');
    expect(classSet(el)).toEqual(classSet({ className: ORIGINAL_GLASS_PANEL_CLASSES } as Element));
  });

  it('SectionCardHeader/Body가 여전히 border-b/px-5 py-4 시맨틱을 렌더한다', async () => {
    const { el } = await mountAndGetRoot(<SectionCardHeader>h</SectionCardHeader>);
    expect(el.className).toContain('border-b');
    expect(el.className).toContain('px-5');
    const { el: bodyEl } = await mountAndGetRoot(<SectionCardBody>b</SectionCardBody>);
    expect(bodyEl.className).toContain('px-5');
    expect(bodyEl.className).not.toContain('border-b');
  });

  it('추가 className이 병합되고 원본 클래스를 지우지 않는다', async () => {
    const { el } = await mountAndGetRoot(<SectionCard className="mt-4">hi</SectionCard>);
    expect(el.className).toContain('mt-4');
    expect(el.className).toContain('rounded-2xl');
  });
});

describe('Card 신규 프리미티브 — variant·서브컴포넌트 (story #2877)', () => {
  it('subtle/plain surface와 compact/inline radius가 정확히 매핑된다', () => {
    expect(cardVariants({ surface: 'subtle', radius: 'compact' })).toContain('bg-muted/30');
    expect(cardVariants({ surface: 'subtle', radius: 'compact' })).toContain('rounded-xl');
    expect(cardVariants({ surface: 'plain', radius: 'inline' })).toContain('rounded-lg');
    expect(cardVariants({ surface: 'plain', radius: 'inline' })).not.toContain('shadow-sm');
  });

  it('Card/CardHeader/CardBody/CardFooter가 각자 올바른 data-slot으로 렌더된다', async () => {
    const { el: card } = await mountAndGetRoot(<Card>c</Card>);
    expect(card.getAttribute('data-slot')).toBe('card');
    const { el: header } = await mountAndGetRoot(<CardHeader>h</CardHeader>);
    expect(header.getAttribute('data-slot')).toBe('card-header');
    const { el: body } = await mountAndGetRoot(<CardBody>b</CardBody>);
    expect(body.getAttribute('data-slot')).toBe('card-body');
    const { el: footer } = await mountAndGetRoot(<CardFooter>f</CardFooter>);
    expect(footer.getAttribute('data-slot')).toBe('card-footer');
    expect(footer.className).toContain('border-t');
  });
});
