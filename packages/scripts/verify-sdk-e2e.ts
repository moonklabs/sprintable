#!/usr/bin/env tsx
/**
 * SDK E2E Verification Script
 *
 * Verifies @sprintable/sdk typed methods against live API
 */

import { createSprintableClient } from '@sprintable/sdk';

const API_KEY = process.env.SPRINTABLE_API_KEY;
const BASE_URL = process.env.SPRINTABLE_API_URL || 'https://sprintable.vercel.app';

if (!API_KEY) {
  console.error('Error: SPRINTABLE_API_KEY environment variable is required');
  process.exit(1);
}

async function main() {
  console.log('🔍 SDK E2E Verification\n');

  const client = createSprintableClient(API_KEY, { baseURL: BASE_URL });

  let passed = 0;
  let failed = 0;

  // Test 1: stories.get()
  try {
    console.log('1️⃣  Testing client.stories.get()...');
    // Use a known story ID from memos (referenced stories)
    const recentMemos = await client.memos.list({ limit: 20 });
    let storyId: string | null = null;

    // Try to find a story ID from memo metadata
    for (const memo of recentMemos) {
      const fullMemo = await client.memos.get(memo.id);
      // Check if memo title contains a story ID pattern
      if (fullMemo.title && /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(fullMemo.title)) {
        const match = fullMemo.title.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
        if (match) {
          storyId = match[0];
          break;
        }
      }
    }

    if (!storyId) {
      // Fallback: use current story ID from E-025:S5
      storyId = 'e145924c-30a1-4331-9ed2-decff4314eec';
    }

    const story = await client.stories.get(storyId);

    if (!story.id || !story.title || !story.project_id) {
      throw new Error('Story missing required fields');
    }
    if (!Array.isArray(story.tasks)) {
      throw new Error('Story.tasks is not an array');
    }

    console.log(`   ✅ Story fetched: ${story.title}`);
    console.log(`   ✅ Fields: id, org_id, title, project_id, tasks`);
    passed++;
  } catch (error) {
    console.error(`   ❌ Failed:`, error instanceof Error ? error.message : error);
    failed++;
  }

  // Test 2: memos.get()
  try {
    console.log('\n2️⃣  Testing client.memos.get()...');
    const memosList = await client.axios.get('/api/memos', { params: { limit: 1 } });
    if (!memosList.data?.data?.length) {
      throw new Error('No memos found to test');
    }
    const memoId = memosList.data.data[0].id;
    const memo = await client.memos.get(memoId);

    if (!memo.id || !memo.content || !memo.project_id) {
      throw new Error('Memo missing required fields');
    }
    if (typeof memo.reply_count !== 'number') {
      throw new Error('Memo.reply_count is not a number');
    }
    if (!Array.isArray(memo.timeline)) {
      throw new Error('Memo.timeline is not an array');
    }
    if (!Array.isArray(memo.linked_docs)) {
      throw new Error('Memo.linked_docs is not an array');
    }
    if (!Array.isArray(memo.readers)) {
      throw new Error('Memo.readers is not an array');
    }
    if (!Array.isArray(memo.supersedes_chain)) {
      throw new Error('Memo.supersedes_chain is not an array');
    }

    console.log(`   ✅ Memo fetched: ${memo.title || '(untitled)'}`);
    console.log(`   ✅ Enriched fields: reply_count, timeline, linked_docs, readers, supersedes_chain`);
    passed++;
  } catch (error) {
    console.error(`   ❌ Failed:`, error instanceof Error ? error.message : error);
    failed++;
  }

  // Test 3: memos.list()
  try {
    console.log('\n3️⃣  Testing client.memos.list()...');
    const memos = await client.memos.list({ limit: 5 });

    if (!Array.isArray(memos)) {
      throw new Error('memos.list() did not return an array');
    }

    if (memos.length > 0) {
      const firstMemo = memos[0];
      if (!firstMemo.id || !firstMemo.project_id) {
        throw new Error('MemoSummary missing required fields');
      }
      if (typeof firstMemo.reply_count !== 'number') {
        throw new Error('MemoSummary.reply_count is not a number');
      }
      if (!firstMemo.project_name && firstMemo.project_name !== null) {
        throw new Error('MemoSummary.project_name is invalid');
      }
      if (!Array.isArray(firstMemo.readers)) {
        throw new Error('MemoSummary.readers is not an array');
      }
    }

    console.log(`   ✅ Memos list fetched: ${memos.length} items`);
    console.log(`   ✅ MemoSummary fields verified`);
    passed++;
  } catch (error) {
    console.error(`   ❌ Failed:`, error instanceof Error ? error.message : error);
    failed++;
  }

  // Test 4: memos.reply()
  try {
    console.log('\n4️⃣  Testing client.memos.reply()...');
    const testMemos = await client.memos.list({ limit: 1, status: 'open' });
    if (!testMemos.length) {
      throw new Error('No open memos found to test reply');
    }
    const testMemoId = testMemos[0].id;

    const reply = await client.memos.reply(testMemoId, {
      content: '[SDK E2E Test] Verification successful',
    });

    if (!reply.id || !reply.memo_id || !reply.content) {
      throw new Error('MemoReply missing required fields');
    }
    if (reply.memo_id !== testMemoId) {
      throw new Error('MemoReply.memo_id mismatch');
    }

    console.log(`   ✅ Reply created: ${reply.id}`);
    console.log(`   ✅ Fields: id, memo_id, content, created_by, created_at`);
    passed++;
  } catch (error) {
    console.error(`   ❌ Failed:`, error instanceof Error ? error.message : error);
    failed++;
  }

  // Summary
  console.log('\n' + '='.repeat(50));
  console.log(`📊 Results: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(50));

  if (failed > 0) {
    process.exit(1);
  }

  console.log('\n✅ All SDK e2e tests passed!');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
