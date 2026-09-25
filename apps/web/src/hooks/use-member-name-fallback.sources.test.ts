// [SID:4300] 이름만 쓰는 조직 범위 표 다섯 자리는 비활성까지 싣는 원천(ORG_NAMES_URL)을 쓴다 — 비활성 에이전트도 «목록이 거른 것»이지
// «모름»이 아니라서(유나 판정). 이 자리들의 렌더 테스트는 `/api/team-members`를 includes로 받아 원천을 되돌려도 초록이라, 원천
// 자체를 파일에서 잰다. 배정 · 고르는 목록(회고 담당 select · 스탠드업 명단 등)은 활성 목록 그대로라 이 표에 없다.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const NAME_ONLY_SITES = [
  'app/(authenticated)/content/[draftId]/page.tsx',
  'components/hypotheses/hypotheses-section.tsx',
  'components/chat/approval-request-card.tsx',
  'components/docs/doc-gate-section.tsx',
  'components/docs/doc-status-rail.tsx',
];

describe('이름만 쓰는 표의 원천([SID:4300])', () => {
  it.each(NAME_ONLY_SITES)('%s — ORG_NAMES_URL로 받고, 활성만 주는 `/api/team-members` 맨 주소를 안 쓴다', (rel) => {
    const src = readFileSync(join(SRC, rel), 'utf8');
    expect(src).toMatch(/fetchWithAuth\(ORG_NAMES_URL\)/);
    expect(src).not.toMatch(/fetchWithAuth\(\s*['"`]\/api\/team-members['"`]\s*\)/);
  });

  it('양성 대조 — 맨 주소 한 줄을 넣은 사본은 잡힌다', () => {
    const src = readFileSync(join(SRC, NAME_ONLY_SITES[0]!), 'utf8').replace('fetchWithAuth(ORG_NAMES_URL)', "fetchWithAuth('/api/team-members')");
    expect(src).not.toMatch(/fetchWithAuth\(ORG_NAMES_URL\)/);
    expect(src).toMatch(/fetchWithAuth\(\s*['"`]\/api\/team-members['"`]\s*\)/);
  });
});
