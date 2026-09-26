// [SID:4311 PR 3 · 유나 1440 실측] 부류 가드 — 꼬리 붙은 행 라벨(«· ID 앞 8자» 꼬리 헬퍼 결과 `…Labels.get(`)을 한 덩어리 `truncate` 요소에 바로 넣으면
// 긴 이름에서 꼬리가 말줄임에 먹힌다(동명이인을 가르는 글자가 사라짐) → RowName(이름만 truncate · 꼬리 shrink-0)으로 그린다.
// 원천 글자 스캔이라 한계가 있다: 라벨을 prop · 변수로 한 번 옮겨 담은 뒤 truncate에 넣는 모양은 못 본다(그 자리들은 렌더 테스트가 핀 — 인계 승인자 등).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '../..');
const BAD = /className="[^"]*\btruncate\b[^"]*"[^>]*>\s*\{[^}]*\b\w*Labels?(?:ById)?\.get\(/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) { if (ent.name !== 'node_modules') walk(p, out); }
    else if (p.endsWith('.tsx') && !p.includes('.test.')) out.push(p);
  }
  return out;
}

describe('RowName 부류 가드([SID:4311 PR 3])', () => {
  it('양성 대조 — 한 덩어리 truncate에 꼬리 라벨을 바로 넣는 모양을 잡는다', () => {
    const samples = [
      '<span className="flex-1 truncate">{rowLabels.get(m.id) ?? memberDisplayLabel(m.name, tc)}</span>',
      '<div className="truncate text-sm font-semibold">{rowLabels.get(agent.id)}</div>',
      '<span className="min-w-0 flex-1 truncate">{webhookRowLabels.get(member.id)}</span>',
      '<span className="truncate">{actorLabelById.get(x.id)}</span>',
    ];
    for (const s of samples) expect(s.match(BAD), s).not.toBeNull();
    expect('<RowName className="flex-1" label={rowLabels.get(m.id)} id={m.id} />'.match(BAD)).toBeNull();
  });

  it('src 전체 .tsx에 한 덩어리 truncate + 꼬리 라벨 0곳', () => {
    const files = walk(SRC);
    expect(files.length, '스캔 재료가 비지 않았다(조용한 0 방지)').toBeGreaterThan(300);
    const hits: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      for (const m of src.matchAll(BAD)) hits.push(`${path.relative(SRC, f)}:${src.slice(0, m.index).split('\n').length}`);
    }
    expect(hits).toEqual([]);
  });
});
