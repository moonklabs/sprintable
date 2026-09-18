/**
 * story #3863 회귀가드 — verify-build-schema-integrity.ts가 route.js 「단일 파일」만 보던
 * 자리를 route.js + nft.json이 열거한 required chunk 파일들로 넓힌 것의 단위 테스트.
 * 합성 fixture(임시 디렉터리)로 .next/standalone 레이아웃을 흉내낸다 — 실 빌드(50초+)를
 * 매 케이스 반복하는 대신, PR #4272 head/develop HEAD 대조(AC2②)는 실 빌드로 별도 확인
 * (PR 본문에 근거, 이 파일은 로직 자체의 양성/음성대조).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { filesToCheckForProbe, findMissingProbeFields, loadNftRequiredChunkFiles, type Probe } from './verify-build-schema-integrity';

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'schema-guard-test-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const ROUTE_REL = 'apps/web/.next/server/app/api/stories/[id]/route.js';

function routeDir(): string {
  return path.join(root, path.dirname(ROUTE_REL));
}

function writeRoute(content: string): void {
  mkdirSync(routeDir(), { recursive: true });
  writeFileSync(path.join(root, ROUTE_REL), content);
}

function writeNft(files: string[]): void {
  writeFileSync(`${path.join(root, ROUTE_REL)}.nft.json`, JSON.stringify({ files }));
}

function writeChunk(name: string, content: string): void {
  const chunkDir = path.join(root, 'apps/web/.next/server/chunks');
  mkdirSync(chunkDir, { recursive: true });
  writeFileSync(path.join(chunkDir, name), content);
}

describe('loadNftRequiredChunkFiles', () => {
  it('nft.json의 chunks/*.js 항목만 절대경로로 뽑는다(다른 파일 종류는 무시)', () => {
    writeRoute('// route');
    writeNft(['../../../../chunks/23166.js', '../../../../chunks/31655.js', 'node_modules/foo/index.js', '../../../../server.js']);
    const routeAbs = path.join(root, ROUTE_REL);
    const chunks = loadNftRequiredChunkFiles(routeAbs);
    expect(chunks.map((c) => path.basename(c)).sort()).toEqual(['23166.js', '31655.js']);
  });

  it('nft.json이 없으면 빈 배열(가드가 헛돌지 않고 route.js 단독 검사로 낙하)', () => {
    writeRoute('// route, no nft.json');
    const routeAbs = path.join(root, ROUTE_REL);
    expect(loadNftRequiredChunkFiles(routeAbs)).toEqual([]);
  });

  it('nft.json이 깨진 JSON이면 빈 배열(가드가 죽지 않는다)', () => {
    writeRoute('// route');
    writeFileSync(`${path.join(root, ROUTE_REL)}.nft.json`, '{not valid json');
    const routeAbs = path.join(root, ROUTE_REL);
    expect(loadNftRequiredChunkFiles(routeAbs)).toEqual([]);
  });
});

describe('findMissingProbeFields — story #3863 AC1/AC2', () => {
  const probe: Probe = { routeFile: ROUTE_REL, mustContain: ['assignee_ids'] };

  // AC2② 축(합성) — 실사고(PR #4272) 재현: route.js 자체엔 필드가 없고, nft.json이 열거한
  // required chunk에만 있다 — 구 probe(route.js 단독)라면 거짓 RED였을 자리가 이제 GREEN.
  it('필드가 route.js엔 없고 required chunk에만 있어도 missing 0(호이스팅 대응, 구 probe였다면 거짓 RED)', () => {
    writeRoute('exports.GET = () => {}; // 그 필드 없음(호이스팅됨)');
    writeNft(['../../../../chunks/23166.js']);
    writeChunk('23166.js', 'const updateStorySchema = z.object({ assignee_ids: z.array(z.string()) });');

    const { missing, checkedFiles } = findMissingProbeFields(root, probe);
    expect(missing).toEqual([]);
    expect(checkedFiles.length).toBe(2); // route.js + 1개 chunk
  });

  // AC2① 축(합성) — 진짜 사각(필드가 route.js에도 required chunk 어디에도 없음)은 여전히 RED.
  // "뭐든 다 GREEN으로 뭉개는" 퇴화가 없다는 음성대조 — 원래 이 가드(d3dd358b)가 막으려던
  // 클래스(스키마가 stale dist로 번들돼 필드가 통째로 빠짐)는 이 케이스와 동형이다.
  it('필드가 route.js에도 required chunk 어디에도 없으면 여전히 missing(진짜 stale-dist 재발은 계속 RED)', () => {
    writeRoute('exports.GET = () => {}; // 그 필드 없음');
    writeNft(['../../../../chunks/23166.js']);
    writeChunk('23166.js', 'const updateStorySchema = z.object({ title: z.string() }); // 그 필드 자체가 빠짐(stale dist 재현)');

    const { missing, checkedFiles } = findMissingProbeFields(root, probe);
    expect(missing).toEqual(['assignee_ids']);
    expect(checkedFiles.length).toBe(2);
  });

  it('필드가 route.js 자체에 있으면(호이스팅 없는 경우) chunk 없이도 통과 — 기존 동작 무변', () => {
    writeRoute('const updateStorySchema = z.object({ assignee_ids: z.array(z.string()) });');
    // nft.json 자체를 안 씀 — required chunk 0개.
    const { missing, checkedFiles } = findMissingProbeFields(root, probe);
    expect(missing).toEqual([]);
    expect(checkedFiles).toEqual([path.join(root, ROUTE_REL)]);
  });

  it('nft.json이 존재하지 않는 chunk를 가리키면(빌드 산출물 불일치) 그 파일은 조용히 건너뛴다', () => {
    writeRoute('exports.GET = () => {};');
    writeNft(['../../../../chunks/does-not-exist.js']);
    // filesToCheckForProbe는 existsSync로 걸러 실존 파일만 남긴다 — route.js 1개만 남아야 한다.
    expect(filesToCheckForProbe(root, probe)).toEqual([path.join(root, ROUTE_REL)]);
  });
});
