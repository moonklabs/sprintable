import { describe, expect, it } from 'vitest';
import { scanContent } from './verify-no-title-only-disabled-reason';

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
