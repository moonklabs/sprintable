import { describe, expect, it } from 'vitest';
import { findRawErrorSites } from './verify-no-raw-error-message';

describe('findRawErrorSites — 양성대조: .code 분기 없는 raw 노출은 잡혀야 한다', () => {
  it('error?.message가 근처 .code 없이 쓰이면 잡힌다', () => {
    const content = `
function f() {
  setError(json.error?.message ?? t('fallback'));
}
`;
    const findings = findRawErrorSites([{ relPath: 'src/app/x.tsx', content }]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.relPath).toBe('src/app/x.tsx');
  });

  it('json.detail이 근처 .code 없이 쓰이면 잡힌다', () => {
    const content = `
function f() {
  throw new Error(json?.detail?.message ?? 'x');
}
`;
    const findings = findRawErrorSites([{ relPath: 'src/app/y.tsx', content }]);
    expect(findings).toHaveLength(1);
  });

  it('음성대조 — 근처(15줄 이내)에 .code 분기가 있으면 안 잡힌다(code로 갈랐다고 봄)', () => {
    const content = `
function f() {
  if (json.error?.code === 'KNOWN') {
    setError(t('known'));
    return;
  }
  setError(json.error?.message ?? t('fallback'));
}
`;
    const findings = findRawErrorSites([{ relPath: 'src/app/z.tsx', content }]);
    expect(findings).toHaveLength(0);
  });

  it('.code 분기가 15줄보다 멀리 있으면 다시 잡힌다(창 밖)', () => {
    const filler = Array.from({ length: 20 }, () => '  // filler').join('\n');
    const content = `
function f() {
  if (json.error?.code === 'KNOWN') {
    return;
  }
${filler}
  setError(json.error?.message ?? t('fallback'));
}
`;
    const findings = findRawErrorSites([{ relPath: 'src/app/w.tsx', content }]);
    expect(findings).toHaveLength(1);
  });
});
