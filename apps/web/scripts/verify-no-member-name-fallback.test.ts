import { describe, expect, it } from 'vitest';
import {
  compareWithBaseline,
  findMemberNameFallbacks,
  loadBaseline,
  runSelfTest,
  scanRepository,
  SELF_TEST_SAMPLES,
} from './verify-no-member-name-fallback';

const kinds = (code: string) => findMemberNameFallbacks(code, 'x.tsx').map((h) => h.kind);

describe('findMemberNameFallbacks (story #4286 regression guard)', () => {
  it('자체 점검 표본(옛 모양) 전부를 잡는다 — 양성 대조', () => {
    expect(runSelfTest()).toEqual([]);
    for (const s of SELF_TEST_SAMPLES) expect(kinds(s.code)).toContain(s.kind);
  });

  it('카드의 세 자리 옛 모양을 한 줄에서 종류별로 잡는다(이메일 앞부분 · id 조각 · «?»)', () => {
    const line = "name: (m.name?.trim() || null) ?? m.email?.split('@')[0] ?? m.user_id?.slice(0, 8) ?? '?',";
    expect(kinds(line).sort()).toEqual(['email-prefix', 'id-fragment', 'question-mark']);
  });

  it('고친 모양(헬퍼 호출)은 잡지 않는다', () => {
    expect(kinds('name: m.name?.trim() || null,')).toEqual([]);
    expect(kinds("const n = memberLookupLabel(memberNames, gate.resolver_id, tc, { loaded: memberNamesLoaded });")).toEqual([]);
    expect(kinds("name={memberDisplayLabel(member.name, tc)}")).toEqual([]);
  });

  it('구성원이 아닌 id 조각 · id 통째는 잡지 않는다(작업 항목 · 프로젝트 · 실행 id)', () => {
    expect(kinds('<p>#{gate.work_item_id.slice(0, 8)}</p>')).toEqual([]);
    expect(kinds("projectName={projects.find((p) => p.id === currentProjectId)?.name ?? currentProjectId}")).toEqual([]);
    expect(kinds("description={`${t('runId')}: ${run.id.slice(0, 8)}…`}")).toEqual([]);
  });

  it('«있는지» 조건의 이메일은 잡지 않는다 — 이름을 만드는 값 자리만(4638 trust-utils 모양)', () => {
    expect(kinds("if (name || m.email) lookup.set(m.id, { id: m.id, name, email: m.email ?? undefined, role: m.role ?? undefined });")).toEqual([]);
    expect(kinds('const label = m.name || m.email;')).toEqual(['email-whole']);
    expect(kinds('return m.display_name ?? m.email;')).toEqual(['email-whole']);
  });

  it('주석 줄은 보지 않는다', () => {
    expect(kinds("// 예전엔 m.email?.split('@')[0] ?? '?'로 지어냈다")).toEqual([]);
  });
});

describe('compareWithBaseline — 래칫(새 자리 · 낡은 줄 둘 다 FAIL)', () => {
  const hit = findMemberNameFallbacks("x ?? '?'", 'a.tsx')[0]!;
  it('기준표 밖 새 자리는 fresh', () => {
    expect(compareWithBaseline([hit], []).fresh).toHaveLength(1);
  });
  it('기준표에 있는데 소스에서 사라진 줄은 stale(목록 내리기)', () => {
    expect(compareWithBaseline([], [{ key: hit.key, reason: 'x' }]).stale).toHaveLength(1);
  });
  it('저장소 스캔이 기준표와 정확히 맞는다(새 자리 0 · 낡은 줄 0) · 기준표 줄마다 이유가 있다', () => {
    const baseline = loadBaseline();
    const { fresh, stale } = compareWithBaseline(scanRepository(), baseline);
    expect(fresh).toEqual([]);
    expect(stale).toEqual([]);
    for (const b of baseline) expect(b.reason.length).toBeGreaterThan(10);
  });
});
