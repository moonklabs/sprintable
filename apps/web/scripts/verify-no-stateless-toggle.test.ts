import { describe, expect, it } from 'vitest';
import { applyAllow, countsOf, equalitySelection, scanContent } from './verify-no-stateless-toggle';

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

describe('verify-no-stateless-toggle — ③ 고름/지금 상태 클래스([SID:4380])', () => {
  it('className이 고름/지금 상태로 갈리는데 상태 속성이 없는 단추를 잡는다(고치기 전 빵부스러기 · 동그라미 고르기 모양)', () => {
    const src = `function A({ isCurrent, selected, go }) {
  return (<div>
    <button onClick={go} className={\`px-2 \${isCurrent ? 'font-bold' : ''}\`}>지금 문서</button>
    <Button onClick={go} className={cn('p-2', selected && 'border-primary')}>고름</Button>
  </div>);
}`;
    expect(hits(src)).toEqual(['selection-class:3', 'selection-class:4']);
  });

  it('aria-current · aria-pressed · role=radio + aria-checked · role=tab · onClick 없는 요소는 통과', () => {
    const src = `function A({ isCurrent, selected, go }) {
  return (<div>
    <button onClick={go} aria-current={isCurrent ? 'page' : undefined} className={isCurrent ? 'a' : 'b'}>a</button>
    <button onClick={go} aria-pressed={selected} className={selected ? 'a' : 'b'}>b</button>
    <button onClick={go} role="radio" aria-checked={selected} className={selected ? 'a' : 'b'}>c</button>
    <button onClick={go} role="tab" aria-selected={selected} className={selected ? 'a' : 'b'}>d</button>
    <span className={selected ? 'a' : 'b'}>e</span>
  </div>);
}`;
    expect(hits(src)).toEqual([]);
  });
});

describe('verify-no-stateless-toggle — ③-같음 비교([SID:4380] · PO 09:44Z)', () => {
  it('className 삼항 `A === B ?`이고 A나 B가 onClick 인자면 잡는다(고치기 전 «기본 알림 레벨» · 보기 방식 · 탭 · 열 수 모양)', () => {
    const src = `function A({ level, setLevel, save, viewMode, setViewMode, tab, setTab, cols, switchTo, sel, setSel }) {
  return (<div>
    {LEVELS.map((l) => <button onClick={() => void save(l)} className={\`px-2 \${level === l ? 'bg-primary' : 'bg-muted'}\`}>{l}</button>)}
    {MODES.map((mode) => <button onClick={() => setViewMode(mode)} className={cn('p-1', viewMode === mode ? 'a' : 'b')}>{mode}</button>)}
    <button onClick={() => setTab('basic')} className={tab === 'basic' ? 'a' : 'b'}>기본</button>
    <button onClick={() => switchTo(2)} className={cols === 2 ? 'a' : 'b'}>2열</button>
    {ITEMS.map((m) => <Button onClick={() => setSel((prev) => (prev === m.id ? null : m.id))} className={sel === m.id ? 'a' : 'b'}>{m.name}</Button>)}
  </div>);
}`;
    expect(hits(src)).toEqual(['selection-class:3', 'selection-class:4', 'selection-class:5', 'selection-class:6', 'selection-class:7']);
  });

  it('상태 속성이 있거나, 비교 값이 onClick 인자가 아니거나(다른 곳에서 고름), 비교가 className 밖이면 통과', () => {
    const src = `function A({ level, setLevel, save, status, open, other }) {
  return (<div>
    {LEVELS.map((l) => <button onClick={() => void save(l)} aria-pressed={level === l} className={level === l ? 'a' : 'b'}>{l}</button>)}
    <button onClick={() => open()} className={status === 'done' ? 'text-success' : ''}>열기</button>
    <button onClick={() => save(other)} className={level === 'all' ? 'a' : 'b'}>저장</button>
    <button onClick={() => save(level === 'all' ? 1 : 2)} className="p-2">x</button>
  </div>);
}`;
    expect(hits(src)).toEqual([]);
  });

  it('인자 자리만 본다 — 이름 일부 · 속성 끝 겹침은 같은 값으로 안 친다', () => {
    expect(equalitySelection(`\${a === lv ? 'x' : 'y'}`, '() => setLevel(level)')).toBe(false);
    expect(equalitySelection(`\${a === id ? 'x' : 'y'}`, '() => pick(row.id)')).toBe(false);
    expect(equalitySelection(`\${a === row.id ? 'x' : 'y'}`, '() => pick(row.id)')).toBe(true);
    expect(equalitySelection(`\${a === v ? 'x' : 'y'}`, '() => handle(a0, v)')).toBe(true);
  });

  it('오탐은 allow `"rule": "selection-class"`로만 빠진다 — rule 없는 항목(①)은 ③ 요소를 안 뺀다', () => {
    const src = `function A({ copiedId, copy, inv }) {
  return (<Button onClick={() => void copy(inv.id, inv.url)} className={copiedId === inv.id ? 'bg-success' : ''}>링크</Button>);
}`;
    const refs = scanContent(src, 'm.tsx');
    expect(refs.map((r) => r.rule)).toEqual(['selection-class']);
    const base = { file: 'm.tsx', match: 'copy(', count: 1, why: '복사됨 표시' };
    expect(applyAllow(refs, [base]).rest).toHaveLength(1);
    expect(applyAllow(refs, [{ ...base, rule: 'selection-class' as const }]).rest).toHaveLength(0);
  });
});
