/**
 * PO 지적(2026-07-28, #2600 리뷰) — "맵의 키 = 서버 허용목록"이 주석으로만 묶여 있으면
 * 아무도 안 지킨다. 코드스캔으로 양쪽을 실제로 묶는다(디디군 #2599 AC1과 같은 방식 —
 * "테스트로 묶기"): BE `backlinks.py::BACKLINKS_ALLOWED_TARGET_TYPES`를 텍스트로 파싱해
 * FE `ENTITY_ROUTE_SEGMENT`의 키 집합과 비교한다. 이게 있어야 두 방향 다 잡힌다 —
 * ㉠서버가 새 종류의 게이트를 세워 허용목록을 늘렸는데 화면이 안 따라오는 경우
 * ㉡화면이 먼저 늘려서 아직 없는 라우트를 부르게 되는 경우.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function parseBackendAllowedTargetTypes(): Set<string> {
  // vitest CWD는 apps/web(이 프로젝트의 관례) — backend는 두 단계 위.
  const path = resolve(process.cwd(), '../../backend/app/services/backlinks.py');
  const source = readFileSync(path, 'utf-8');
  const m = source.match(/BACKLINKS_ALLOWED_TARGET_TYPES\s*=\s*frozenset\(\{([^}]*)\}\)/);
  if (!m) throw new Error('BACKLINKS_ALLOWED_TARGET_TYPES 정의를 backlinks.py에서 못 찾았다 — 이 테스트 자체가 오탐 아닌지 먼저 확인');
  const types = [...m[1]!.matchAll(/"([^"]+)"/g)].map((mm) => mm[1]!);
  return new Set(types);
}

describe('ENTITY_ROUTE_SEGMENT 키 집합 ↔ BE BACKLINKS_ALLOWED_TARGET_TYPES 코드스캔 동기화', () => {
  it('FE 맵의 키와 BE 허용목록이 정확히 같은 집합이다', async () => {
    const backendTypes = parseBackendAllowedTargetTypes();
    // private(모듈에 export 안 된) 상수라 소스를 직접 읽어 키만 추출한다 — 별도 export 신설 금지
    // (컴포넌트 공개 API에 테스트 전용 필드를 얹지 않는다).
    const source = readFileSync(
      resolve(__dirname, 'entity-backlinks-section.tsx'), 'utf-8',
    );
    const m = source.match(/const ENTITY_ROUTE_SEGMENT = \{([\s\S]*?)\} as const/);
    if (!m) throw new Error('ENTITY_ROUTE_SEGMENT 정의를 못 찾았다 — 리팩터로 형태가 바뀌었으면 이 정규식도 갱신');
    const feKeys = [...m[1]!.matchAll(/^\s*(\w+):/gm)].map((mm) => mm[1]!);

    expect(new Set(feKeys)).toEqual(backendTypes);
  });
});
