import { describe, it, expect } from 'vitest';
import {
  createMemoSchema, createMemoReplySchema,
  createProjectSchema, createInvitationSchema, acceptInvitationSchema,
  createTeamMemberSchema, setCurrentProjectSchema, updateNotificationSchema,
  createEpicSchema, updateEpicSchema,
  createSprintSchema,
  createStorySchema, updateStorySchema, bulkUpdateStorySchema,
  createTaskSchema, updateTaskSchema,
  createDocSchema, createDocCommentSchema,
  saveStandupSchema,
  createStandupFeedbackSchema, updateStandupFeedbackSchema,
  createRetroSchema,
  createRewardSchema,
  createBridgeChannelSchema, updateBridgeChannelSchema,
  createBridgeUserSchema, updateBridgeUserSchema,
} from '../index';

describe('Sprintable Zod Schemas', () => {
  // ─── Memo ─────
  describe('createMemoSchema', () => {
    it('유효한 memo를 통과시켜야 함', () => {
      expect(createMemoSchema.safeParse({ content: '메모 내용' }).success).toBe(true);
    });
    it('content 없으면 실패', () => {
      expect(createMemoSchema.safeParse({}).success).toBe(false);
    });
    it('content 빈 문자열이면 실패', () => {
      expect(createMemoSchema.safeParse({ content: '' }).success).toBe(false);
    });
  });

  describe('createMemoReplySchema', () => {
    it('유효한 reply를 통과', () => {
      expect(createMemoReplySchema.safeParse({ content: '답글' }).success).toBe(true);
    });
    it('빈 content 실패', () => {
      expect(createMemoReplySchema.safeParse({ content: '' }).success).toBe(false);
    });
    it('assigned_to_ids 포함 reply 통과', () => {
      expect(createMemoReplySchema.safeParse({ content: '답글', assigned_to_ids: ['uuid-1', 'uuid-2'] }).success).toBe(true);
    });
    it('assigned_to 단일 ID 통과', () => {
      expect(createMemoReplySchema.safeParse({ content: '답글', assigned_to: 'uuid-1' }).success).toBe(true);
    });
  });

  // ─── Core write APIs ───
  describe('createProjectSchema', () => {
    it('유효한 project를 통과', () => {
      expect(createProjectSchema.safeParse({ org_id: 'org-1', name: 'Project Alpha' }).success).toBe(true);
    });
    it('name 없으면 실패', () => {
      expect(createProjectSchema.safeParse({ org_id: 'org-1' }).success).toBe(false);
    });
  });

  describe('createInvitationSchema', () => {
    it('유효한 invitation을 통과', () => {
      expect(createInvitationSchema.safeParse({ email: 'team@example.com' }).success).toBe(true);
    });
    it('잘못된 email 실패', () => {
      expect(createInvitationSchema.safeParse({ email: 'not-an-email' }).success).toBe(false);
    });
  });

  describe('acceptInvitationSchema', () => {
    it('유효한 token을 통과', () => {
      expect(acceptInvitationSchema.safeParse({ token: 'invite-token' }).success).toBe(true);
    });
    it('token 없으면 실패', () => {
      expect(acceptInvitationSchema.safeParse({ token: '' }).success).toBe(false);
    });
  });

  describe('createTeamMemberSchema', () => {
    it('human member는 user_id와 함께 통과', () => {
      expect(createTeamMemberSchema.safeParse({ project_id: 'proj-1', user_id: 'user-1' }).success).toBe(true);
    });
    it('agent member는 name 없으면 실패', () => {
      expect(createTeamMemberSchema.safeParse({ project_id: 'proj-1', type: 'agent' }).success).toBe(false);
    });
  });

  describe('setCurrentProjectSchema', () => {
    it('유효한 project_id를 통과', () => {
      expect(setCurrentProjectSchema.safeParse({ project_id: 'proj-1' }).success).toBe(true);
    });
    it('project_id 없으면 실패', () => {
      expect(setCurrentProjectSchema.safeParse({}).success).toBe(false);
    });
  });

  describe('updateNotificationSchema', () => {
    it('markAllRead 요청을 통과', () => {
      expect(updateNotificationSchema.safeParse({ markAllRead: true }).success).toBe(true);
    });
    it('단일 읽음 요청을 통과', () => {
      expect(updateNotificationSchema.safeParse({ id: 'notification-1', is_read: true }).success).toBe(true);
    });
    it('대상 없이 실패', () => {
      expect(updateNotificationSchema.safeParse({ type: 'memo' }).success).toBe(false);
    });
  });

  // ─── Epic ─────
  describe('createEpicSchema', () => {
    it('유효한 epic를 통과', () => {
      expect(createEpicSchema.safeParse({ title: 'E-015' }).success).toBe(true);
    });
    it('title 없으면 실패', () => {
      expect(createEpicSchema.safeParse({}).success).toBe(false);
    });
    it('optional 필드 포함 시 통과', () => {
      expect(createEpicSchema.safeParse({
        title: 'E-015', status: 'active', description: null,
      }).success).toBe(true);
    });
  });

  describe('updateEpicSchema', () => {
    it('부분 업데이트 통과', () => {
      expect(updateEpicSchema.safeParse({ status: 'archived' }).success).toBe(true);
    });
    it('빈 객체 통과 (모두 optional)', () => {
      expect(updateEpicSchema.safeParse({}).success).toBe(true);
    });
  });

  // ─── Sprint ───
  describe('createSprintSchema', () => {
    it('유효한 sprint를 통과', () => {
      expect(createSprintSchema.safeParse({
        title: 'Sprint 1', start_date: '2026-04-01', end_date: '2026-04-14',
      }).success).toBe(true);
    });
    it('필수 필드 누락 시 실패', () => {
      expect(createSprintSchema.safeParse({ title: 'Sprint 1' }).success).toBe(false);
    });
  });

  // ─── Story ────
  describe('createStorySchema', () => {
    it('유효한 story를 통과', () => {
      expect(createStorySchema.safeParse({ title: '기능 구현', project_id: 'proj-1', org_id: 'org-1' }).success).toBe(true);
    });
    it('title 없으면 실패', () => {
      expect(createStorySchema.safeParse({ description: '설명' }).success).toBe(false);
    });
  });

  describe('updateStorySchema — status enum', () => {
    it('유효한 status 통과', () => {
      expect(updateStorySchema.safeParse({ status: 'in-progress' }).success).toBe(true);
      expect(updateStorySchema.safeParse({ status: 'done' }).success).toBe(true);
    });
    it('존재하지 않는 status 실패', () => {
      expect(updateStorySchema.safeParse({ status: 'invalid-status' }).success).toBe(false);
      expect(updateStorySchema.safeParse({ status: 'wip' }).success).toBe(false);
    });
    it('status 없이 다른 필드만 수정 통과', () => {
      expect(updateStorySchema.safeParse({ title: '수정된 제목' }).success).toBe(true);
    });
  });

  describe('bulkUpdateStorySchema', () => {
    it('유효한 일괄 업데이트를 통과', () => {
      expect(bulkUpdateStorySchema.safeParse({
        items: [{ id: 'abc', status: 'done' }],
      }).success).toBe(true);
    });
    it('빈 items 배열 실패', () => {
      expect(bulkUpdateStorySchema.safeParse({ items: [] }).success).toBe(false);
    });
  });

  // ─── Task ─────
  describe('createTaskSchema', () => {
    it('유효한 task를 통과', () => {
      expect(createTaskSchema.safeParse({ story_id: 'abc', title: '구현' }).success).toBe(true);
    });
    it('story_id 없으면 실패', () => {
      expect(createTaskSchema.safeParse({ title: '구현' }).success).toBe(false);
    });
  });

  // ─── Doc ──────
  describe('createDocSchema', () => {
    it('유효한 doc를 통과', () => {
      expect(createDocSchema.safeParse({ title: 'PRD' }).success).toBe(true);
    });
    it('title 없으면 실패', () => {
      expect(createDocSchema.safeParse({}).success).toBe(false);
    });
  });

  describe('createDocCommentSchema', () => {
    it('유효한 코멘트를 통과', () => {
      expect(createDocCommentSchema.safeParse({ content: '좋은 문서' }).success).toBe(true);
    });
  });

  // ─── Standup ──
  describe('saveStandupSchema', () => {
    it('유효한 standup를 통과', () => {
      expect(saveStandupSchema.safeParse({
        date: '2026-04-03', done: '작업 완료', plan: '다음 작업', plan_story_ids: ['story-1'],
      }).success).toBe(true);
    });
    it('date 없으면 실패', () => {
      expect(saveStandupSchema.safeParse({ done: '작업' }).success).toBe(false);
    });
  });

  describe('createStandupFeedbackSchema', () => {
    it('유효한 feedback를 통과', () => {
      expect(createStandupFeedbackSchema.safeParse({
        standup_entry_id: 'entry-1', feedback_text: '좋은 진행', review_type: 'approve',
      }).success).toBe(true);
    });
    it('feedback_text 없으면 실패', () => {
      expect(createStandupFeedbackSchema.safeParse({ standup_entry_id: 'entry-1' }).success).toBe(false);
    });
  });

  describe('updateStandupFeedbackSchema', () => {
    it('부분 업데이트 통과', () => {
      expect(updateStandupFeedbackSchema.safeParse({ feedback_text: '수정' }).success).toBe(true);
    });
    it('빈 객체 통과', () => {
      expect(updateStandupFeedbackSchema.safeParse({}).success).toBe(true);
    });
  });

  // ─── Retro ────
  describe('createRetroSchema', () => {
    it('유효한 retro를 통과', () => {
      expect(createRetroSchema.safeParse({ sprint_id: 'abc', title: '스프린트 1 회고' }).success).toBe(true);
    });
    it('sprint_id 없으면 실패', () => {
      expect(createRetroSchema.safeParse({ title: '회고' }).success).toBe(true);
    });
    it('title 없으면 실패', () => {
      expect(createRetroSchema.safeParse({ sprint_id: 'abc' }).success).toBe(false);
    });
  });

  // ─── Rewards ──
  describe('createRewardSchema', () => {
    it('유효한 reward를 통과', () => {
      expect(createRewardSchema.safeParse({
        member_id: 'member1', amount: 100, reason: '좋은 코드 리뷰',
      }).success).toBe(true);
    });
    it('reason 없으면 실패', () => {
      expect(createRewardSchema.safeParse({ member_id: 'member1', amount: 100 }).success).toBe(false);
    });
    it('member_id 없으면 실패', () => {
      expect(createRewardSchema.safeParse({ amount: 100, reason: '리뷰' }).success).toBe(false);
    });
    it('optional reference 필드 포함 시 통과', () => {
      expect(createRewardSchema.safeParse({
        member_id: 'member1', amount: 50, reason: '리뷰',
        reference_type: 'story', reference_id: 'story-1',
      }).success).toBe(true);
    });
  });

  // ─── Messaging Bridge ──
  describe('createBridgeChannelSchema', () => {
    it('유효한 채널을 통과', () => {
      expect(createBridgeChannelSchema.safeParse({
        project_id: 'proj-1', platform: 'slack', channel_id: 'C12345',
      }).success).toBe(true);
    });
    it('platform 없으면 실패', () => {
      expect(createBridgeChannelSchema.safeParse({
        project_id: 'proj-1', channel_id: 'C12345',
      }).success).toBe(false);
    });
    it('유효하지 않은 platform 실패', () => {
      expect(createBridgeChannelSchema.safeParse({
        project_id: 'proj-1', platform: 'line', channel_id: 'C12345',
      }).success).toBe(false);
    });
    it('channel_id 빈 문자열이면 실패', () => {
      expect(createBridgeChannelSchema.safeParse({
        project_id: 'proj-1', platform: 'slack', channel_id: '',
      }).success).toBe(false);
    });
    it('env/vault 시크릿 ref config만 통과', () => {
      expect(createBridgeChannelSchema.safeParse({
        project_id: 'proj-1', platform: 'discord', channel_id: '999',
        channel_name: 'general', config: { webhook_ref: 'env:SLACK_WEBHOOK', signing_secret: 'vault:kv/slack/signing' },
      }).success).toBe(true);
    });
    it('plain secret config는 실패', () => {
      expect(createBridgeChannelSchema.safeParse({
        project_id: 'proj-1', platform: 'discord', channel_id: '999',
        config: { webhook_secret: 'plain-secret' },
      }).success).toBe(false);
    });
    it('문자열이 아닌 config 값은 실패', () => {
      expect(createBridgeChannelSchema.safeParse({
        project_id: 'proj-1', platform: 'discord', channel_id: '999',
        config: { webhook_ref: { source: 'env:SLACK_WEBHOOK' } },
      }).success).toBe(false);
    });
  });

  describe('updateBridgeChannelSchema', () => {
    it('부분 업데이트 통과', () => {
      expect(updateBridgeChannelSchema.safeParse({ is_active: false }).success).toBe(true);
    });
    it('유효한 secret ref config 업데이트 통과', () => {
      expect(updateBridgeChannelSchema.safeParse({
        config: { bot_token: 'vault:kv/slack/bot-token' },
      }).success).toBe(true);
    });
    it('raw secret 업데이트는 실패', () => {
      expect(updateBridgeChannelSchema.safeParse({
        config: { bot_token: 'xoxb-plain-token' },
      }).success).toBe(false);
    });
    it('빈 객체 통과', () => {
      expect(updateBridgeChannelSchema.safeParse({}).success).toBe(true);
    });
  });

  describe('createBridgeUserSchema', () => {
    it('유효한 사용자 매핑을 통과', () => {
      expect(createBridgeUserSchema.safeParse({
        team_member_id: 'tm-1', platform: 'slack', platform_user_id: 'U12345',
      }).success).toBe(true);
    });
    it('team_member_id 없으면 실패', () => {
      expect(createBridgeUserSchema.safeParse({
        platform: 'slack', platform_user_id: 'U12345',
      }).success).toBe(false);
    });
    it('유효하지 않은 platform 실패', () => {
      expect(createBridgeUserSchema.safeParse({
        team_member_id: 'tm-1', platform: 'whatsapp', platform_user_id: 'U12345',
      }).success).toBe(false);
    });
    it('optional display_name 포함 시 통과', () => {
      expect(createBridgeUserSchema.safeParse({
        team_member_id: 'tm-1', platform: 'teams', platform_user_id: 'U999',
        display_name: 'John',
      }).success).toBe(true);
    });
  });

  describe('updateBridgeUserSchema', () => {
    it('부분 업데이트 통과', () => {
      expect(updateBridgeUserSchema.safeParse({ display_name: 'Jane' }).success).toBe(true);
    });
    it('빈 객체 통과', () => {
      expect(updateBridgeUserSchema.safeParse({}).success).toBe(true);
    });
  });
});
