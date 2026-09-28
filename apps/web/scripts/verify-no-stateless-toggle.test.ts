import { describe, expect, it } from 'vitest';
import { applyAllow, countsOf, scanContent } from './verify-no-stateless-toggle';

// [SID:4379] 양성 대조(고치기 전 모양은 RED) + 음성 대조(상태를 알리거나 보조기기에 안 보이는 것은 통과) + 허용목록 · 기준선 셈.
const hits = (src: string) => scanContent(src, 'x.tsx').map((r) => `${r.rule}:${r.line}`);

describe('verify-no-stateless-toggle — ① 상태 없는 뒤집기', () => {
  it('뒤집기 onClick인데 상태 속성이 없으면 잡는다(고치기 전 «읽지 않은 것만» · 핀 도구 · 구성원 고르기 · handleToggleX 모양)', () => {
    const src = `function A({ on, ids, setOn, toggle, handleToggleAssignee }) {
  return (<div>
    <button onClick={() => setOn((v) => !v)}>읽지 않은 것만</button>
    <button onClick={() => setOn(!on)}>핀</button>
    <button onClick={() => toggle(ids[0])}>구성원</button>
    <Button onClick={() => void handleToggleAssignee(ids[0])}>담당</Button>
    <button onClick={toggle}>접기</button>
  </div>);
}`;
    expect(hits(src)).toEqual(['stateless-toggle:3', 'stateless-toggle:4', 'stateless-toggle:5', 'stateless-toggle:6', 'stateless-toggle:7']);
  });

  it('상태 속성 · 역할 · 상태 prop · aria-hidden · {...props} · 뒤집기 아닌 onClick은 통과', () => {
    const src = `function A({ on, setOn, props, save }) {
  return (<div>
    <button onClick={() => setOn((v) => !v)} aria-pressed={on}>a</button>
    <button onClick={() => setOn((v) => !v)} aria-expanded={on}>b</button>
    <button onClick={() => setOn((v) => !v)} role="switch" aria-checked={on}>c</button>
    <div role="checkbox" onClick={() => setOn(!on)} />
    <BubbleButton active={on} onClick={() => setOn(!on)}>d</BubbleButton>
    <button aria-hidden="true" tabIndex={-1} onClick={() => setOn((v) => !v)} />
    <button {...props} onClick={() => setOn((v) => !v)}>e</button>
    <button onClick={() => void save()}>f</button>
  </div>);
}`;
    expect(hits(src)).toEqual([]);
  });
});

describe('verify-no-stateless-toggle — ② 스위치 모양', () => {
  it('스위치 모양 클릭 요소는 role="switch" + aria-checked가 둘 다 있어야 한다(고치기 전 설정 «앱 내» 토글 모양)', () => {
    const src = `function A({ on, save }) {
  return (<div>
    <button onClick={() => void save(on)} className={\`relative h-6 w-11 rounded-full \${on ? 'bg-primary' : 'bg-muted'}\`}><span /></button>
    <button onClick={() => void save(on)} role="switch" className={\`relative h-6 w-11 rounded-full\`}><span /></button>
    <button onClick={() => void save(on)} role="switch" aria-checked={on} className={\`relative h-6 w-11 rounded-full\`}><span /></button>
  </div>);
}`;
    expect(hits(src)).toEqual(['switch-shape:3', 'switch-shape:4']);
  });
});

describe('verify-no-stateless-toggle — 허용목록 · 기준선 셈', () => {
  const refs = [
    { rule: 'stateless-toggle' as const, file: 'a.tsx', line: 1, tag: 'button', onClick: '() => setShowArchived((v) => !v)' },
    { rule: 'stateless-toggle' as const, file: 'a.tsx', line: 9, tag: 'button', onClick: '() => setEditing((v) => !v)' },
    { rule: 'stateless-toggle' as const, file: 'a.tsx', line: 20, tag: 'button', onClick: '() => setEditing((v) => !v)' },
    { rule: 'stateless-toggle' as const, file: 'b.tsx', line: 3, tag: 'button', onClick: '() => setExpanded((v) => !v)' },
    { rule: 'switch-shape' as const, file: 'c.tsx', line: 4, tag: 'button', onClick: '() => save()' },
  ];

  it('허용목록은 파일 + onClick 조각으로 정해진 개수만 빼고, 모자라면 stale로 알린다 · 스위치 모양은 허용목록으로 못 뺀다', () => {
    const { rest, stale } = applyAllow(refs, [
      { file: 'a.tsx', match: 'setShowArchived', count: 1, why: '' },
      { file: 'a.tsx', match: 'setEditing', count: 1, why: '' },
      { file: 'b.tsx', match: 'setGone', count: 1, why: '' },
      { file: 'c.tsx', match: 'save', count: 1, why: '' },
    ]);
    expect(rest.map((r) => `${r.file}:${r.line}`)).toEqual(['a.tsx:20', 'b.tsx:3', 'c.tsx:4']);
    expect(stale.map((a) => a.match)).toEqual(['setGone', 'save']);
    expect(Object.fromEntries(countsOf(rest))).toEqual({ 'a.tsx': 1, 'b.tsx': 1 });
  });
});
