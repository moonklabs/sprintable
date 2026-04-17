/**
 * SID:361 — 장사왕 spec-site(Turso) → Sprintable(Supabase) 데이터 마이그레이션
 *
 * Usage:
 *   npx tsx packages/scripts/migrate-from-specsite.ts [--dry-run]
 *
 * Env:
 *   TURSO_URL, TURSO_AUTH_TOKEN — spec-site Turso DB
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — Sprintable Supabase
 *   TARGET_ORG_ID, TARGET_PROJECT_ID — 대상 조직/프로젝트 UUID
 */

import { createClient } from '@supabase/supabase-js';

const DRY_RUN = process.argv.includes('--dry-run');

const TURSO_URL = process.env.TURSO_URL!;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN!;
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ORG_ID = process.env.TARGET_ORG_ID!;
const PROJECT_ID = process.env.TARGET_PROJECT_ID!;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ID 매핑
const idMap = { epics: {} as Record<string, string>, stories: {} as Record<string, string>, tasks: {} as Record<string, string>, memos: {} as Record<string, string>, members: {} as Record<string, string> };
// 이름 → member UUID
const memberByName: Record<string, string> = {};

// Turso HTTP API
async function tursoQuery<T = Record<string, unknown>>(sql: string, args: (string | number | null)[] = []): Promise<T[]> {
  const resp = await fetch(TURSO_URL + '/v2/pipeline', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TURSO_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: [
        { type: 'execute', stmt: { sql, args: args.map(v => v === null ? { type: 'null' } : typeof v === 'number' ? { type: 'integer', value: String(v) } : { type: 'text', value: String(v) }) } },
        { type: 'close' },
      ],
    }),
  });
  const data = await resp.json() as { results: Array<{ type: string; response?: { result?: { cols: Array<{ name: string }>; rows: Array<Array<{ type: string; value?: string }>> } } }> };
  const result = data.results[0]?.response?.result;
  if (!result) return [];
  const cols = result.cols.map(c => c.name);
  return result.rows.map(row => {
    const obj: Record<string, unknown> = {};
    cols.forEach((col, i) => { const cell = row[i]; obj[col] = cell.type === 'null' ? null : cell.type === 'integer' ? Number(cell.value) : cell.value; });
    return obj as T;
  });
}

function log(msg: string) { console.log(`[${DRY_RUN ? 'DRY' : 'LIVE'}] ${msg}`); }

const unresolvedMembers = new Set<string>();

function resolveMember(name: string | null): string | null {
  if (!name) return null;
  const alias = NAME_ALIASES[name] ?? NAME_ALIASES[name.trim()];
  if (alias === '__SKIP__') return null;
  const lookup = alias ?? name;
  const resolved = memberByName[lookup] ?? memberByName[lookup.trim()] ?? null;
  // Handle compound assignees like '최하록,이수민' — take first
  if (!resolved && lookup.includes(',')) {
    const first = lookup.split(',')[0].trim();
    const firstResolved = memberByName[first] ?? null;
    if (firstResolved) return firstResolved;
  }
  if (!resolved) unresolvedMembers.add(name);
  return resolved;
}

// Name aliases for variant forms in source data
const NAME_ALIASES: Record<string, string> = {
  '오르테가': '파울로 오르테가',
  '은와추쿠 디디': '디디 은와추쿠',
  'Oscar': '오스카',
  '': '__SKIP__',
  'undefined': '__SKIP__',
};

// 1. Members — pre-load existing team_members, then create missing ones
async function migrateMembers() {
  // Pre-load existing team_members in Supabase (manually created)
  const { data: existing } = await supabase.from('team_members')
    .select('id, name').eq('org_id', ORG_ID);
  if (existing) {
    for (const e of existing) {
      memberByName[e.name] = e.id;
      log(`  ♻️ Existing member: ${e.name} → ${e.id}`);
    }
  }

  const members = await tursoQuery<{ id: number; display_name: string; member_type: string }>('SELECT id, display_name, member_type FROM members');
  log(`Members: ${members.length}건 (existing: ${existing?.length ?? 0})`);
  for (const m of members) {
    // Already mapped from existing?
    if (memberByName[m.display_name]) {
      idMap.members[String(m.id)] = memberByName[m.display_name];
      log(`  ♻️ Reuse ${m.display_name} → ${memberByName[m.display_name]}`);
      continue;
    }
    if (DRY_RUN) { idMap.members[String(m.id)] = `dry-${m.id}`; memberByName[m.display_name] = `dry-${m.id}`; continue; }
    const { data, error } = await supabase.from('team_members').insert({
      org_id: ORG_ID, project_id: PROJECT_ID,
      type: m.member_type === 'agent' ? 'agent' : 'human',
      name: m.display_name, role: 'member',
      agent_config: m.member_type === 'agent' ? { source: 'spec-site', legacy_id: m.id } : null,
    }).select('id').single();
    if (error) { log(`  ⚠️ Member ${m.display_name}: ${error.message}`); continue; }
    idMap.members[String(m.id)] = data.id;
    memberByName[m.display_name] = data.id;
    log(`  ✅ Member ${m.display_name} → ${data.id}`);
  }
}

// 2. Epics (pm_epics 테이블)
async function migrateEpics() {
  const epics = await tursoQuery<{ id: number; title: string; description: string; status: string; owner: string }>('SELECT id, title, description, status, owner FROM pm_epics');
  log(`Epics: ${epics.length}건`);
  for (const e of epics) {
    if (DRY_RUN) { idMap.epics[String(e.id)] = `dry-${e.id}`; continue; }
    const { data, error } = await supabase.from('epics').insert({
      org_id: ORG_ID, project_id: PROJECT_ID, title: e.title, description: e.description,
      status: mapEpicStatus(e.status),
    }).select('id').single();
    if (error) { log(`  ⚠️ Epic #${e.id}: ${error.message}`); continue; }
    idMap.epics[String(e.id)] = data.id;
    log(`  ✅ Epic #${e.id} ${e.title} → ${data.id}`);
  }
}

// 3. Stories
async function migrateStories() {
  const stories = await tursoQuery<{
    id: number; title: string; description: string; status: string;
    priority: string; story_points: number; assignee: string; sprint: string;
    epic_id: number; created_at: string;
  }>('SELECT * FROM pm_stories ORDER BY id');
  log(`Stories: ${stories.length}건`);
  for (const s of stories) {
    if (DRY_RUN) { idMap.stories[String(s.id)] = `dry-${s.id}`; continue; }
    const { data, error } = await supabase.from('stories').insert({
      org_id: ORG_ID, project_id: PROJECT_ID,
      title: s.title, description: s.description,
      status: mapStoryStatus(s.status), priority: s.priority ?? 'medium',
      story_points: s.story_points,
      epic_id: s.epic_id ? (idMap.epics[String(s.epic_id)] ?? null) : null,
      assignee_id: resolveMember(s.assignee),
    }).select('id').single();
    if (error) { log(`  ⚠️ Story #${s.id}: ${error.message}`); continue; }
    idMap.stories[String(s.id)] = data.id;
    log(`  ✅ Story #${s.id} → ${data.id}`);
  }
}

function mapStoryStatus(s: string): string {
  const m: Record<string, string> = { todo: 'backlog', backlog: 'backlog', draft: 'backlog', 'in-progress': 'in-progress', review: 'in-review', qa: 'in-review', done: 'done', 'ready-for-dev': 'ready-for-dev' };
  return m[s] ?? 'backlog';
}

function mapTaskStatus(s: string): string {
  const m: Record<string, string> = { todo: 'todo', backlog: 'todo', draft: 'todo', 'in-progress': 'in-progress', done: 'done', review: 'in-progress', qa: 'in-progress', blocked: 'todo' };
  return m[s] ?? 'todo';
}

function mapEpicStatus(s: string): string {
  if (s === 'closed' || s === 'done') return 'closed';
  return 'active';
}

// 4. Tasks (pm_tasks)
async function migrateTasks() {
  const tasks = await tursoQuery<{
    id: number; story_id: number; title: string; status: string;
    assignee: string; story_points: number;
  }>('SELECT * FROM pm_tasks ORDER BY id');
  log(`Tasks: ${tasks.length}건`);
  for (const t of tasks) {
    const newStoryId = idMap.stories[String(t.story_id)];
    if (!newStoryId) { log(`  ⚠️ Task #${t.id}: story ${t.story_id} not mapped`); continue; }
    if (DRY_RUN) { idMap.tasks[String(t.id)] = `dry-${t.id}`; continue; }
    const { data, error } = await supabase.from('tasks').insert({
      org_id: ORG_ID,
      story_id: newStoryId, title: t.title,
      status: mapTaskStatus(t.status ?? 'todo'),
      assignee_id: resolveMember(t.assignee),
      story_points: t.story_points,
    }).select('id').single();
    if (error) { log(`  ⚠️ Task #${t.id}: ${error.message}`); continue; }
    idMap.tasks[String(t.id)] = data.id;
    log(`  ✅ Task #${t.id} → ${data.id}`);
  }
}

// 5. Memos
async function migrateMemos() {
  const memos = await tursoQuery<{
    id: number; content: string; memo_type: string; status: string;
    created_by: string; assigned_to: string; title: string; created_at: string;
  }>('SELECT * FROM memos_v2 ORDER BY id');
  log(`Memos: ${memos.length}건`);
  for (const m of memos) {
    if (DRY_RUN) { idMap.memos[String(m.id)] = `dry-${m.id}`; continue; }
    const authorId = resolveMember(m.created_by);
    if (!authorId) { log(`  ⚠️ Memo #${m.id}: created_by '${m.created_by}' not mapped, skipping`); continue; }
    const { data, error } = await supabase.from('memos').insert({
      org_id: ORG_ID, project_id: PROJECT_ID, title: m.title, content: m.content,
      memo_type: m.memo_type ?? 'memo', status: m.status ?? 'open',
      created_by: authorId,
    }).select('id').single();
    if (error) { log(`  ⚠️ Memo #${m.id}: ${error.message}`); continue; }
    idMap.memos[String(m.id)] = data.id;
    log(`  ✅ Memo #${m.id} → ${data.id}`);
  }
}

// 6. Memo Replies
async function migrateMemoReplies() {
  const replies = await tursoQuery<{
    id: number; memo_id: number; content: string; created_by: string;
    review_type: string; created_at: string;
  }>('SELECT * FROM memo_replies ORDER BY id');
  log(`Memo Replies: ${replies.length}건`);
  for (const r of replies) {
    const newMemoId = idMap.memos[String(r.memo_id)];
    if (!newMemoId) { log(`  ⚠️ Reply #${r.id}: memo ${r.memo_id} not mapped`); continue; }
    if (DRY_RUN) continue;
    const replyAuthor = resolveMember(r.created_by);
    if (!replyAuthor) { log(`  ⚠️ Reply #${r.id}: created_by '${r.created_by}' not mapped, skipping`); continue; }
    const { error } = await supabase.from('memo_replies').insert({
      memo_id: newMemoId, content: r.content,
      created_by: replyAuthor,
      review_type: r.review_type ?? 'comment',
    });
    if (error) { log(`  ⚠️ Reply #${r.id}: ${error.message}`); continue; }
    log(`  ✅ Reply #${r.id}`);
  }
}

// 7. Standups
async function migrateStandups() {
  const entries = await tursoQuery<{
    id: number; sprint: string; entry_date: string; user_name: string;
    done_text: string; plan_text: string; blockers_text: string;
  }>('SELECT * FROM pm_standup_entries ORDER BY id');
  log(`Standup Entries: ${entries.length}건`);
  for (const e of entries) {
    if (DRY_RUN) continue;
    const authorId = resolveMember(e.user_name);
    if (!authorId) { log(`  ⚠️ Standup #${e.id}: user ${e.user_name} not mapped`); continue; }
    const { error } = await supabase.from('standup_entries').insert({
      org_id: ORG_ID, project_id: PROJECT_ID,
      author_id: authorId, date: e.entry_date,
      done: e.done_text, plan: e.plan_text, blockers: e.blockers_text,
    });
    if (error) { log(`  ⚠️ Standup #${e.id}: ${error.message}`); continue; }
    log(`  ✅ Standup #${e.id}`);
  }
}

// 8. 카운트 검증
async function verify() {
  const src = {
    epics: (await tursoQuery<{ c: number }>('SELECT COUNT(*) as c FROM pm_epics'))[0]?.c ?? 0,
    stories: (await tursoQuery<{ c: number }>('SELECT COUNT(*) as c FROM pm_stories'))[0]?.c ?? 0,
    tasks: (await tursoQuery<{ c: number }>('SELECT COUNT(*) as c FROM pm_tasks'))[0]?.c ?? 0,
    memos: (await tursoQuery<{ c: number }>('SELECT COUNT(*) as c FROM memos_v2'))[0]?.c ?? 0,
    replies: (await tursoQuery<{ c: number }>('SELECT COUNT(*) as c FROM memo_replies'))[0]?.c ?? 0,
    standups: (await tursoQuery<{ c: number }>('SELECT COUNT(*) as c FROM pm_standup_entries'))[0]?.c ?? 0,
  };

  const dst = {
    epics: (await supabase.from('epics').select('id', { count: 'exact', head: true }).eq('org_id', ORG_ID)).count ?? 0,
    stories: (await supabase.from('stories').select('id', { count: 'exact', head: true }).eq('org_id', ORG_ID)).count ?? 0,
    tasks: (await supabase.from('tasks').select('id', { count: 'exact', head: true })).count ?? 0,
    memos: (await supabase.from('memos').select('id', { count: 'exact', head: true }).eq('org_id', ORG_ID)).count ?? 0,
    replies: (await supabase.from('memo_replies').select('id', { count: 'exact', head: true })).count ?? 0,
    standups: (await supabase.from('standup_entries').select('id', { count: 'exact', head: true }).eq('org_id', ORG_ID)).count ?? 0,
  };

  log('─── 카운트 검증 ───');
  for (const key of Object.keys(src) as Array<keyof typeof src>) {
    const match = src[key] === dst[key] ? '✅' : '❌';
    log(`${key}: src=${src[key]} → dst=${dst[key]} ${match}`);
  }
}

async function main() {
  log('=== 마이그레이션 시작 ===');
  log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  log(`Target: org=${ORG_ID} project=${PROJECT_ID}`);

  // Preflight: 모든 write 전에 source 데이터 검증
  log('─── Preflight: 작성자 매핑 검증 ───');
  // source members 목록 수집 (display_name → 매핑용)
  const srcMembers = await tursoQuery<{ display_name: string }>('SELECT display_name FROM members');
  const srcMemberNames = new Set(srcMembers.map(m => m.display_name));

  // source 전체 creator/assignee/user_name 수집
  const allCreators = new Set<string>();
  (await tursoQuery<{ created_by: string }>('SELECT DISTINCT created_by FROM memos_v2 WHERE created_by IS NOT NULL')).forEach(r => allCreators.add(r.created_by));
  (await tursoQuery<{ created_by: string }>('SELECT DISTINCT created_by FROM memo_replies WHERE created_by IS NOT NULL')).forEach(r => allCreators.add(r.created_by));
  (await tursoQuery<{ user_name: string }>('SELECT DISTINCT user_name FROM pm_standup_entries WHERE user_name IS NOT NULL')).forEach(r => allCreators.add(r.user_name));
  (await tursoQuery<{ assignee: string }>('SELECT DISTINCT assignee FROM pm_stories WHERE assignee IS NOT NULL')).forEach(r => allCreators.add(r.assignee));
  (await tursoQuery<{ assignee: string }>('SELECT DISTINCT assignee FROM pm_tasks WHERE assignee IS NOT NULL')).forEach(r => allCreators.add(r.assignee));

  // members 테이블에 없는 creator 확인
  const unmappedCreators = [...allCreators].filter(name => {
    if (NAME_ALIASES[name] === '__SKIP__' || NAME_ALIASES[name.trim()] === '__SKIP__') return false;
    const alias = NAME_ALIASES[name] ?? NAME_ALIASES[name.trim()] ?? name;
    if (srcMemberNames.has(alias) || srcMemberNames.has(alias.trim())) return false;
    // Compound assignees
    if (name.includes(',') && name.split(',').every(n => srcMemberNames.has(n.trim()))) return false;
    return true;
  });
  if (unmappedCreators.length > 0 && !DRY_RUN) {
    log(`❌ Preflight FAIL: source members에 없는 작성자 ${unmappedCreators.length}건: ${unmappedCreators.join(', ')}`);
    log('모든 write 전 중단. source members 테이블을 먼저 확인하세요.');
    process.exit(1);
  }
  if (unmappedCreators.length > 0) {
    log(`⚠️ Preflight WARNING (dry-run): 미매핑 ${unmappedCreators.length}건: ${unmappedCreators.join(', ')}`);
  } else {
    log(`✅ Preflight PASS: ${allCreators.size}명 전원 source members에 존재.`);
  }

  // 이제 write 시작
  await migrateMembers();
  await migrateEpics();
  await migrateStories();
  await migrateTasks();
  await migrateMemos();
  await migrateMemoReplies();
  await migrateStandups();
  await verify();

  log('=== 마이그레이션 완료 ===');
  log(`ID 매핑: ${JSON.stringify(Object.fromEntries(Object.entries(idMap).map(([k, v]) => [k, Object.keys(v).length])))}`);

  // 미매핑 작성자 리포트
  if (unresolvedMembers.size > 0) {
    log(`❌ 미매핑 작성자 ${unresolvedMembers.size}건: ${[...unresolvedMembers].join(', ')}`);
    if (!DRY_RUN) {
      log('⚠️ 라이브 실행에서 미매핑 작성자 발견. exit code 1로 종료.');
      process.exit(1);
    }
  } else {
    log('✅ 모든 작성자 매핑 성공.');
  }
}

main().catch(err => { console.error('Migration failed:', err); process.exit(1); });
