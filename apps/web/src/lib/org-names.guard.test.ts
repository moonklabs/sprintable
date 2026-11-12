// 4913(UI-R5 · 한 쪽 틀 B판) — 이름 통일 가드(PO 11-12): 사이드바 이름 = 화면 제목 한 가지, 옛 낱말 «연산»이 한국어 화면 글에 안 남는다.
//   생성 연결(옛 «연산 커넥터») · 성과 보드(옛 «결과») · 레시피 역할 «생성»(옛 «연산»). 키 · 주소는 그대로.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ko = JSON.parse(readFileSync(join(__dirname, '../../messages/ko.json'), 'utf8')) as Record<string, Record<string, string>>;

describe('조직 구역 이름 통일(4913 ③)', () => {
  it('⭐생성 연결 — 사이드바 이름 = 화면 제목 = «생성 연결»', () => {
    expect(ko.nav!.orgGenerationConnectors).toBe('생성 연결');
    expect(ko.organization!.gcTitle).toBe(ko.nav!.orgGenerationConnectors);
  });
  it('⭐성과 보드 — 사이드바 이름 «성과 보드»(옛 «결과»)', () => {
    expect(ko.nav!.navResults).toBe('성과 보드');
  });
  it('⭐레시피 역할 이름 «생성»(옛 «연산») · 레시피 카드 연결 이름 «생성 연결»', () => {
    expect(ko.organization!.stageRoleLabelCompute).toBe('생성');
    expect(ko.organization!.recipeCardConnectionGenerator).toBe('생성 연결');
  });
  it('⭐서버 문구 사전(적용 경고에 실리는 역할 이름)도 같은 낱말 — backend i18n_catalog의 Compute ko 라벨 = ko.json의 stageRoleLabelCompute(codex 검수 4913B)', () => {
    const catalog = readFileSync(join(__dirname, '../../../../backend/app/services/i18n_catalog.py'), 'utf8');
    const m = /"events\.stage_role\.Compute":\s*\{"ko":\s*"([^"]+)"/.exec(catalog);
    expect(m?.[1]).toBe(ko.organization!.stageRoleLabelCompute);
  });
  it('⭐서버 문구 사전 전체에서 사용자에게 가는 글에 «연산»이 없다(적용 경고 · 능력 안내 문구까지 — codex 재검 4913B)', () => {
    const catalog = readFileSync(join(__dirname, '../../../../backend/app/services/i18n_catalog.py'), 'utf8');
    const literals = catalog.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    expect(literals).not.toContain('연산');
  });
  it('⭐옛 낱말 «연산»이 ko.json 어디에도 없다(화면에 새는 길 전수)', () => {
    const hits: string[] = [];
    for (const [ns, bag] of Object.entries(ko)) for (const [k, v] of Object.entries(bag)) if (typeof v === 'string' && v.includes('연산')) hits.push(`${ns}.${k}`);
    expect(hits).toEqual([]);
  });
});
