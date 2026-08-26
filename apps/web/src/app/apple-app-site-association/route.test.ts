// 루트 폴백이 .well-known과 완전히 동일한 핸들러를 재수출하는지 확인 — 두 파일이 갈라져
// 하나만 고쳐지는 드리프트를 막는다.
import { describe, expect, it } from 'vitest';
import { GET as rootGet } from './route';
import { GET as wellKnownGet } from '../.well-known/apple-app-site-association/route';

describe('GET /apple-app-site-association (root fallback)', () => {
  it('re-exports the same handler as .well-known/apple-app-site-association', () => {
    expect(rootGet).toBe(wellKnownGet);
  });
});
