import { describe, expect, it } from 'vitest';
import { compare, countByKey, scanContent } from './verify-no-title-only-disabled-reason';

// story #4357 — 양성 대조(실사고 모양: 디스패치 «에이전트를 먼저 선택하세요») + 음성 대조(4348 처방 모양 · title 없음 · 스프레드).
describe('verify-no-title-only-disabled-reason', () => {
  it('⭐disabled + title + aria-describedby 없음을 잡는다', () => {
    const src = `const A = ({ t, ok }: any) => <button disabled={!ok} title={ok ? undefined : t('dispatchSelectAgentFirst')}>go</button>;`;
    expect(scanContent(src, 'x.tsx').map((r) => r.tag)).toEqual(['button']);
  });

  it('보이는 글 + aria-describedby(4348 모양) · title 없음 · 스프레드 속성은 걸리지 않는다', () => {
    const src = `
      const A = ({ t }: any) => <><button aria-disabled disabled title={t('x')} aria-describedby="why">go</button><p id="why">{t('x')}</p></>;
      const B = () => <button disabled>go</button>;
      const C = (p: any) => <button {...p} disabled title="x">go</button>;`;
    expect(scanContent(src, 'x.tsx')).toEqual([]);
  });
});

// 까디르(4742 P2 · P3) — baseline은 키별 개수: 같은 키 자리가 하나 늘면 RED(집합이면 한 키로 뭉쳐 초록이었다) · 줄면 stale RED.
describe('verify-no-title-only-disabled-reason — 개수 비교', () => {
  const one = `const A = ({ t }: any) => <Button disabled title={t('send')}>x</Button>;`;
  const two = `${one}\nconst B = ({ t }: any) => <Button disabled title={t('send')}>y</Button>;`;
  const base = countByKey(scanContent(one, 'app/channel/page.tsx'));

  it('⭐같은 파일에 같은 모양이 하나 더 생기면 늘어남(RED)', () => {
    const { grown, shrunk } = compare(countByKey(scanContent(two, 'app/channel/page.tsx')), base);
    expect(grown).toHaveLength(1);
    expect(shrunk).toEqual([]);
  });

  it('⭐고쳐서 자리가 줄면 줄어듦(stale RED) — baseline을 줄이라는 신호', () => {
    const { grown, shrunk } = compare(countByKey(scanContent('const A = () => <button>x</button>;', 'app/channel/page.tsx')), base);
    expect(grown).toEqual([]);
    expect(shrunk).toHaveLength(1);
  });

  it('⭐baseline에서 한 줄이 빠지면(자리는 그대로) 늘어남(RED)', () => {
    const { grown } = compare(countByKey(scanContent(one, 'app/channel/page.tsx')), new Map());
    expect(grown).toHaveLength(1);
  });

  it('같은 수면 둘 다 없음', () => {
    expect(compare(countByKey(scanContent(two, 'x.tsx')), countByKey(scanContent(two, 'x.tsx')))).toEqual({ grown: [], shrunk: [] });
  });
});
