/**
 * story #2416 (1단계) — 파괴 확認 native confirm() 3건을 앱 Dialog로 대체했다. 이 테스트는
 * 그 3곳이 다시 confirm()/window.confirm()으로 되돌아가는 회귀를 pin한다(판정을 테스트로 고정
 * — feedback_pin_declarations_as_tests). 나머지(입력 prompt() 5건 등)는 별건이라 여기서 안 잰다.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const TARGET_FILES = [
  'src/components/agents/agent-api-key-manager.tsx',
  'src/components/docs/doc-tree.tsx',
  'src/components/kanban/story-card.tsx',
];

function readSource(relPath: string): string {
  return readFileSync(join(__dirname, '..', '..', relPath), 'utf-8');
}

// native confirm() 호출을 잡는 검출 로직 자체 — 아래 두 describe 블록이 이걸 공유한다.
// 주석 속 "confirm()" 언급(이 스토리 자신의 설명 주석 포함)까지 실 호출로 오탐하면 안 되니
// 라인코멘트는 먼저 걷어낸다(자기 자신의 흔적 주석에 걸려 넘어진 게 이 로직의 첫 버전이었다).
function stripLineComments(source: string): string {
  return source
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

function hasNativeConfirmCall(source: string): boolean {
  const code = stripLineComments(source);
  return /(?<!\.)\bconfirm\s*\(/.test(code) || /window\.confirm\s*\(/.test(code);
}

describe('#2416 1단계 — native confirm() 회귀 pin', () => {
  it.each(TARGET_FILES)('%s 은 더 이상 native confirm()을 쓰지 않는다', (relPath) => {
    const source = readSource(relPath);
    expect(hasNativeConfirmCall(source)).toBe(false);
  });

  it('세 파일 모두 ConfirmDialog(앱 Dialog 원시 위)를 실제로 쓴다', () => {
    for (const relPath of TARGET_FILES) {
      const source = readSource(relPath);
      expect(source).toContain('ConfirmDialog');
    }
  });
});

// 양성대조 — 검출 로직 자체가 실제로 confirm()을 잡아내는지(못 잡으면 위 pin이 공허통과).
describe('hasNativeConfirmCall — 검출 로직 자체 검증', () => {
  it('confirm(...) 호출이 있으면 true', () => {
    expect(hasNativeConfirmCall('if (!confirm("Sure?")) return;')).toBe(true);
  });

  it('window.confirm(...) 호출이 있으면 true', () => {
    expect(hasNativeConfirmCall('if (window.confirm("Sure?")) {}')).toBe(true);
  });

  it('confirm()이 없으면(ConfirmDialog만 있으면) false', () => {
    expect(hasNativeConfirmCall('<ConfirmDialog open={x} onConfirm={y} />')).toBe(false);
  });

  it('`onConfirm=` 같은 접두 매칭(confirm이 포함된 다른 식별자)로 오탐하지 않는다', () => {
    expect(hasNativeConfirmCall('const onConfirm = () => setOpen(false);')).toBe(false);
  });

  it('설명 주석 속 "confirm()" 언급은 실 호출로 오탐하지 않는다(이 파일이 처음 걸렸던 자리)', () => {
    expect(hasNativeConfirmCall('// story #2416 — native confirm() 대체.\nconst x = 1;')).toBe(false);
  });

  it('같은 줄 뒤쪽 주석에 딸려 있어도 앞쪽의 실 호출은 여전히 잡는다', () => {
    expect(hasNativeConfirmCall('if (confirm("Sure?")) {} // native confirm() 대체 예정')).toBe(true);
  });
});
