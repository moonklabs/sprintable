import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { SqliteInboxItemRepository } from '../SqliteInboxItemRepository';
import type {
  CreateInboxItemInput,
  InboxOption,
} from '@sprintable/core-storage';
import { NotFoundError } from '@sprintable/core-storage';

// Phase A.1 — SqliteInboxItemRepository contract test.
// PGlite migration note: when OSS storage moves to PGlite, this entire file
// gets superseded by a contract test against the IInboxItemRepository
// interface (run against PGlite). The Supabase repo test still applies.

const ORG = '11111111-1111-1111-1111-111111111111';
const PROJECT = '22222222-2222-2222-2222-222222222222';
const ASSIGNEE = '33333333-3333-3333-3333-333333333333';

function makeOption(kind: InboxOption['kind'], label: string): InboxOption {
  return { id: randomUUID(), kind, label, consequence: `${label} happens` };
}

function makeItemInput(overrides: Partial<CreateInboxItemInput> = {}): CreateInboxItemInput {
  return {
    org_id: ORG,
    project_id: PROJECT,
    assignee_member_id: ASSIGNEE,
    kind: 'approval',
    title: 'Approve PR #1284',
    context: 'Max ran 247 tests, 0 failed',
    options: [
      makeOption('approve', '승인'),
      makeOption('changes', '변경 요청'),
    ],
    source_type: 'agent_run',
    source_id: 'run_test_' + Math.random().toString(36).slice(2),
    ...overrides,
  };
}

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  // Create just the schema we need for these tests.
  db.exec(`
    CREATE TABLE IF NOT EXISTS inbox_items (
      id                  TEXT PRIMARY KEY,
      org_id              TEXT NOT NULL,
      project_id          TEXT NOT NULL,
      assignee_member_id  TEXT NOT NULL,
      kind                TEXT NOT NULL CHECK (kind IN ('approval','decision','blocker','mention')),
      title               TEXT NOT NULL,
      context             TEXT,
      agent_summary       TEXT,
      origin_chain        TEXT NOT NULL DEFAULT '[]',
      options             TEXT NOT NULL DEFAULT '[]',
      after_decision      TEXT,
      from_agent_id       TEXT,
      story_id            TEXT,
      memo_id             TEXT,
      priority            TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('high','normal')),
      state               TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','resolved','dismissed')),
      resolved_by         TEXT,
      resolved_option_id  TEXT,
      resolved_note       TEXT,
      source_type         TEXT NOT NULL CHECK (source_type IN ('agent_run','memo_mention','webhook','manual')),
      source_id           TEXT NOT NULL,
      waiting_since       TEXT NOT NULL,
      created_at          TEXT NOT NULL,
      resolved_at         TEXT,
      UNIQUE (org_id, source_type, source_id, kind)
    );
    CREATE TABLE IF NOT EXISTS inbox_outbox (
      id              TEXT PRIMARY KEY,
      org_id          TEXT NOT NULL,
      inbox_item_id   TEXT NOT NULL,
      event_type      TEXT NOT NULL,
      payload         TEXT NOT NULL,
      webhook_url     TEXT,
      status          TEXT NOT NULL DEFAULT 'pending',
      attempt_count   INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TEXT,
      next_attempt_at TEXT NOT NULL,
      last_error      TEXT,
      delivered_at    TEXT,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );
  `);
  return db;
}

describe('SqliteInboxItemRepository', () => {
  let db: DatabaseSync;
  let repo: SqliteInboxItemRepository;

  beforeEach(() => {
    db = setupDb();
    repo = new SqliteInboxItemRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('create', () => {
    it('inserts a new pending inbox item', async () => {
      const input = makeItemInput();
      const result = await repo.create(input);

      expect(result.id).toBeDefined();
      expect(result.org_id).toBe(ORG);
      expect(result.kind).toBe('approval');
      expect(result.state).toBe('pending');
      expect(result.options).toHaveLength(2);
      expect(result.options[0]?.id).toBe(input.options![0]!.id);
    });

    it('parses origin_chain and options as arrays', async () => {
      const input = makeItemInput({
        origin_chain: [
          { type: 'memo', id: 'm1' },
          { type: 'story', id: 'SPR-1' },
          { type: 'run', id: 'run_1' },
        ],
      });
      const result = await repo.create(input);
      expect(result.origin_chain).toHaveLength(3);
      expect(result.origin_chain[0]).toEqual({ type: 'memo', id: 'm1' });
    });

    it('idempotent on (org_id, source_type, source_id, kind) — returns existing', async () => {
      const input = makeItemInput({ source_id: 'run_dedupe' });
      const first = await repo.create(input);
      const second = await repo.create({ ...input, title: 'Different title' });
      expect(second.id).toBe(first.id);
      expect(second.title).toBe(first.title); // original wins
    });
  });

  describe('list', () => {
    it('returns items filtered by org + state', async () => {
      await repo.create(makeItemInput({ source_id: 'a' }));
      await repo.create(makeItemInput({ source_id: 'b' }));

      const items = await repo.list({ org_id: ORG, state: 'pending' });
      expect(items).toHaveLength(2);
    });

    it('filters by kind', async () => {
      await repo.create(makeItemInput({ source_id: 'a', kind: 'approval' }));
      await repo.create(makeItemInput({ source_id: 'b', kind: 'blocker' }));

      const blockers = await repo.list({ org_id: ORG, kind: 'blocker' });
      expect(blockers).toHaveLength(1);
      expect(blockers[0]?.kind).toBe('blocker');
    });

    it('filters by assignee_member_id', async () => {
      await repo.create(makeItemInput({ source_id: 'a' }));
      await repo.create(makeItemInput({ source_id: 'b', assignee_member_id: 'other-assignee' }));

      const mine = await repo.list({ org_id: ORG, assignee_member_id: ASSIGNEE });
      expect(mine).toHaveLength(1);
      expect(mine[0]?.assignee_member_id).toBe(ASSIGNEE);
    });

    it('respects cross-org boundary', async () => {
      await repo.create(makeItemInput({ source_id: 'a' }));
      const otherOrg = await repo.list({ org_id: 'other-org', state: 'pending' });
      expect(otherOrg).toHaveLength(0);
    });
  });

  describe('count', () => {
    it('returns total + byKind breakdown', async () => {
      await repo.create(makeItemInput({ source_id: 'a', kind: 'approval' }));
      await repo.create(makeItemInput({ source_id: 'b', kind: 'approval' }));
      await repo.create(makeItemInput({ source_id: 'c', kind: 'blocker' }));

      const counts = await repo.count({ org_id: ORG, state: 'pending' });
      expect(counts.total).toBe(3);
      expect(counts.byKind.approval).toBe(2);
      expect(counts.byKind.blocker).toBe(1);
      expect(counts.byKind.decision).toBe(0);
      expect(counts.byKind.mention).toBe(0);
    });
  });

  describe('resolve', () => {
    it('marks state=resolved and stores option id + note', async () => {
      const input = makeItemInput();
      const item = await repo.create(input);
      const optionId = item.options[0]!.id;

      const resolved = await repo.resolve(item.id, ORG, {
        resolved_by: ASSIGNEE,
        resolved_option_id: optionId,
        resolved_note: 'Looks good',
      });

      expect(resolved.state).toBe('resolved');
      expect(resolved.resolved_option_id).toBe(optionId);
      expect(resolved.resolved_note).toBe('Looks good');
      expect(resolved.resolved_at).toBeTruthy();
    });

    it('enqueues outbox row in same transaction', async () => {
      const input = makeItemInput();
      const item = await repo.create(input);
      const optionId = item.options[0]!.id;

      await repo.resolve(item.id, ORG, {
        resolved_by: ASSIGNEE,
        resolved_option_id: optionId,
      });

      const outboxRow = db.prepare(
        'SELECT event_type, status, attempt_count FROM inbox_outbox WHERE inbox_item_id = ?'
      ).get(item.id) as { event_type: string; status: string; attempt_count: number } | undefined;
      expect(outboxRow?.event_type).toBe('resolved');
      expect(outboxRow?.status).toBe('pending');
      expect(outboxRow?.attempt_count).toBe(0);
    });

    it('rejects resolve with an option_id not in options', async () => {
      const input = makeItemInput();
      const item = await repo.create(input);

      await expect(
        repo.resolve(item.id, ORG, {
          resolved_by: ASSIGNEE,
          resolved_option_id: randomUUID(), // not in item.options
        })
      ).rejects.toThrow(/Option id/);
    });

    it('rejects double-resolve (already resolved)', async () => {
      const input = makeItemInput();
      const item = await repo.create(input);
      const optionId = item.options[0]!.id;

      await repo.resolve(item.id, ORG, {
        resolved_by: ASSIGNEE,
        resolved_option_id: optionId,
      });
      await expect(
        repo.resolve(item.id, ORG, {
          resolved_by: ASSIGNEE,
          resolved_option_id: optionId,
        })
      ).rejects.toThrow(/already/);
    });

    it('throws NotFoundError for unknown id', async () => {
      const optionId = randomUUID();
      await expect(
        repo.resolve(randomUUID(), ORG, {
          resolved_by: ASSIGNEE,
          resolved_option_id: optionId,
        })
      ).rejects.toThrow(NotFoundError);
    });

    it('respects org boundary', async () => {
      const input = makeItemInput();
      const item = await repo.create(input);
      const optionId = item.options[0]!.id;

      await expect(
        repo.resolve(item.id, 'wrong-org', {
          resolved_by: ASSIGNEE,
          resolved_option_id: optionId,
        })
      ).rejects.toThrow(NotFoundError);
    });
  });

  describe('dismiss', () => {
    it('marks state=dismissed and enqueues outbox', async () => {
      const item = await repo.create(makeItemInput());
      const dismissed = await repo.dismiss(item.id, ORG, {
        resolved_by: ASSIGNEE,
        resolved_note: 'Not relevant',
      });
      expect(dismissed.state).toBe('dismissed');

      const outboxRow = db.prepare(
        'SELECT event_type FROM inbox_outbox WHERE inbox_item_id = ?'
      ).get(item.id) as { event_type: string } | undefined;
      expect(outboxRow?.event_type).toBe('dismissed');
    });
  });

  describe('reassign', () => {
    it('changes assignee + enqueues outbox', async () => {
      const item = await repo.create(makeItemInput());
      const newAssignee = '44444444-4444-4444-4444-444444444444';

      const result = await repo.reassign(item.id, ORG, {
        new_assignee_member_id: newAssignee,
        reassigned_by: ASSIGNEE,
      });
      expect(result.assignee_member_id).toBe(newAssignee);

      const outboxRow = db.prepare(
        'SELECT event_type FROM inbox_outbox WHERE inbox_item_id = ?'
      ).get(item.id) as { event_type: string } | undefined;
      expect(outboxRow?.event_type).toBe('reassigned');
    });
  });

  describe('rollback on failed resolve', () => {
    it('does not enqueue outbox if resolve validation fails', async () => {
      const item = await repo.create(makeItemInput());

      await expect(
        repo.resolve(item.id, ORG, {
          resolved_by: ASSIGNEE,
          resolved_option_id: randomUUID(),
        })
      ).rejects.toThrow();

      const outboxCount = db.prepare(
        'SELECT COUNT(*) as n FROM inbox_outbox WHERE inbox_item_id = ?'
      ).get(item.id) as { n: number };
      expect(outboxCount.n).toBe(0);

      // Item still pending
      const stillPending = await repo.get(item.id, ORG);
      expect(stillPending?.state).toBe('pending');
    });
  });
});
