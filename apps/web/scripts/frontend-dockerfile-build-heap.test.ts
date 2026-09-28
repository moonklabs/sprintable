// story #4225(dev 배포 19 실사고, 2026-09-23 build b6c4ff7d · 재실행도 같은 OOM) — frontend 이미지 `pnpm build`가 webpack
// 컴파일 중 `JavaScript heap out of memory`로 죽었다. Node 힙 상한 미지정 → 머신 메모리 기준 기본값(8GB에서 ≈2GB)에
// 기대 왔던 것. builder 스테이지에만 상한을 주고, 런타임 이미지엔 새지 않게 이 테스트로 고정한다.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');
const dockerfile = readFileSync(path.join(repoRoot, 'apps/web/Dockerfile'), 'utf8');
const cloudbuild = readFileSync(path.join(repoRoot, 'cloudbuild.yaml'), 'utf8');

/** `FROM … AS name` 기준으로 스테이지 본문을 나눈다(주석 줄 제외). */
function stages(src: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  let current = '';
  for (const raw of src.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const from = /^FROM\s+\S+\s+AS\s+(\S+)/i.exec(line);
    if (from) {
      current = from[1]!;
      out[current] = [];
      continue;
    }
    if (current) out[current]!.push(line);
  }
  return out;
}

describe('frontend Dockerfile 빌드 힙 상한(story #4225)', () => {
  const s = stages(dockerfile);

  it('⭐builder 스테이지가 `pnpm build` 전에 힙 상한을 정한다(기본 ≈2GB보다 크고 8GB 머신에 여유를 남기는 값)', () => {
    const builder = s['builder'] ?? [];
    const envIdx = builder.findIndex((l) => /^ENV\s+NODE_OPTIONS=.*--max-old-space-size=\d+/.test(l));
    const buildIdx = builder.findIndex((l) => l === 'RUN pnpm build');
    expect(envIdx).toBeGreaterThanOrEqual(0);
    expect(buildIdx).toBeGreaterThan(envIdx);
    const mb = Number(/--max-old-space-size=(\d+)/.exec(builder[envIdx]!)![1]);
    expect(mb).toBeGreaterThan(4096);
    expect(mb).toBeLessThanOrEqual(7168);
  });

  it('⭐런타임(runner) 이미지엔 NODE_OPTIONS가 없다(빌드용 상한이 서버 프로세스에 새지 않음)', () => {
    expect(s['runner']).toBeDefined();
    expect((s['runner'] ?? []).filter((l) => /NODE_OPTIONS/.test(l))).toEqual([]);
    // runner는 builder에서 파생되지 않는 별도 FROM이어야 ENV가 안 물려받아진다.
    expect(dockerfile).toMatch(/^FROM\s+mirror\.gcr\.io\/library\/node:\S+\s+AS runner$/m);
  });

  it('값의 근거인 Cloud Build 머신(E2_HIGHCPU_8 = 8GB)이 그대로다 — 바뀌면 이 상한도 다시 정한다', () => {
    expect(cloudbuild).toMatch(/^\s+machineType:\s+E2_HIGHCPU_8\s*$/m);
  });
});
