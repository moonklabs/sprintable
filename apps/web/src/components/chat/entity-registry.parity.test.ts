/**
 * story #2302 AC2·AC5(story #2888 S2a — entity-registry.tsx로 이관 후 파일명·소스경로만 갱신,
 * 대조 로직·단언은 그대로) — ENTITY_ICONS/ENTITY_COLORS/getEntityHref가 BE
 * `reference_registry.py::ENTITY_RESOLVERS`와 어긋나면(등록된 종류를 FE가 모르는 채로 남으면)
 * CI가 코드스캔으로 잡는다. 완전 동일은 요구하지 않는다 — `asset`은 registry 밖 FE 전용 타입
 * (명시 예외, 이 파일에 그대로 선언). 가드가 자기 재료(backend 파일)를 못 찾으면 skip이 아니라
 * 실패해야 한다(#2600에서 실제로 걸렸던 경로 — findRepoRoot는 그 교훈 그대로 재사용).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ENTITY_ICONS } from './entity-registry';

function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'backend', 'app', 'services', 'reference_registry.py'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`레포 루트(backend/app/services/reference_registry.py를 포함하는 조상)를 ${startDir}에서 못 찾았다`);
}

function parseBackendEntityResolvers(): Set<string> {
  const repoRoot = findRepoRoot(process.cwd());
  const path = resolve(repoRoot, 'backend/app/services/reference_registry.py');
  const source = readFileSync(path, 'utf-8');
  const m = source.match(/ENTITY_RESOLVERS:\s*dict\[str,\s*EntityExistsResolver\]\s*=\s*\{([^}]*)\}/);
  if (!m) throw new Error('ENTITY_RESOLVERS 정의를 reference_registry.py에서 못 찾았다 — 이 테스트 자체가 오탐 아닌지 먼저 확인');
  const keys = [...m[1]!.matchAll(/"([^"]+)"\s*:/g)].map((mm) => mm[1]!);
  return new Set(keys);
}

function parseFeSwitchKeys(source: string, functionSignature: RegExp): Set<string> {
  const m = source.match(functionSignature);
  if (!m) throw new Error('대상 함수 정의를 embed-card.tsx에서 못 찾았다 — 리팩터로 형태가 바뀌었으면 이 정규식도 갱신');
  return new Set([...m[1]!.matchAll(/case '([^']+)':/g)].map((mm) => mm[1]!));
}

// asset은 BE reference_registry.py 밖의 FE 전용 타입(entity-registry.tsx 주석 — 채팅 첨부는
// mention_parser.py write-path가 하드코딩 source_type으로 직접 다뤄 target-resolver가 없다).
const FE_ONLY_TYPES = new Set(['asset']);

describe('entity-registry.tsx 엔티티 키 집합 ↔ BE ENTITY_RESOLVERS 코드스캔 동기화', () => {
  it('BE에 등록된 종류를 ENTITY_ICONS가 전부 안다(asset은 의도적 예외 — 아이콘 없이 글자로)', () => {
    const backendTypes = parseBackendEntityResolvers();
    const feIconTypes = new Set(Object.keys(ENTITY_ICONS));
    // ENTITY_ICONS는 asset을 일부러 안 갖는다(entity-registry.tsx 상단 주석) — 그래서 정확히 BE와 같아야 한다.
    expect(feIconTypes).toEqual(backendTypes);
  });

  it('BE에 등록된 종류를 ENTITY_COLORS가 전부 안다(+ asset 예외 포함)', () => {
    const backendTypes = parseBackendEntityResolvers();
    const source = readFileSync(resolve(__dirname, 'entity-registry.tsx'), 'utf-8');
    const m = source.match(/export const ENTITY_COLORS: Record<string, string> = \{([\s\S]*?)\n\};/);
    if (!m) throw new Error('ENTITY_COLORS 정의를 entity-registry.tsx에서 못 찾았다 — 리팩터로 형태가 바뀌었으면 이 정규식도 갱신');
    const feColorTypes = new Set([...m[1]!.matchAll(/^\s*(\w+):/gm)].map((mm) => mm[1]!));
    for (const t of backendTypes) expect(feColorTypes.has(t)).toBe(true);
    expect(feColorTypes).toEqual(new Set([...backendTypes, ...FE_ONLY_TYPES]));
  });

  it('BE에 등록된 종류를 getEntityHref가 전부 안다(+ asset 예외 포함) — default 캐치올로 몰래 넘기지 않는다', () => {
    const backendTypes = parseBackendEntityResolvers();
    const source = readFileSync(resolve(__dirname, 'embed-card.tsx'), 'utf-8');
    const feHrefTypes = parseFeSwitchKeys(
      source,
      /export function getEntityHref\(entityType: string, entityId: string\): string \| null \{\s*switch \(entityType\) \{([\s\S]*?)\n {4}default:/,
    );
    for (const t of backendTypes) expect(feHrefTypes.has(t)).toBe(true);
    expect(feHrefTypes).toEqual(new Set([...backendTypes, ...FE_ONLY_TYPES]));
  });
});
