/**
 * Supabase database types
 *
 * TODO: supabase gen types typescript로 자동 생성 후 교체
 */

export type MessagingBridgePlatform = 'slack' | 'discord' | 'teams' | 'telegram';
export type MessagingBridgeSecretRef = `env:${string}` | `vault:${string}`;

export interface Database {
  public: {
    Tables: {
      organizations: {
        Row: {
          id: string;
          name: string;
          slug: string;
          plan: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          slug: string;
          plan?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          name?: string;
          slug?: string;
          plan?: string;
          updated_at?: string;
        };
      };
      org_members: {
        Row: {
          id: string;
          org_id: string;
          user_id: string;
          role: 'owner' | 'admin' | 'member';
          created_at: string;
        };
        Insert: {
          id?: string;
          org_id: string;
          user_id: string;
          role?: 'owner' | 'admin' | 'member';
          created_at?: string;
        };
        Update: {
          role?: 'owner' | 'admin' | 'member';
        };
      };
      projects: {
        Row: {
          id: string;
          org_id: string;
          name: string;
          description: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          org_id: string;
          name: string;
          description?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          name?: string;
          description?: string | null;
          updated_at?: string;
        };
      };
      team_members: {
        Row: {
          id: string;
          project_id: string;
          org_id: string;
          type: 'human' | 'agent';
          user_id: string | null;
          name: string;
          role: string;
          avatar_url: string | null;
          agent_config: Record<string, unknown> | null;
          webhook_url: string | null;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          project_id: string;
          org_id: string;
          type: 'human' | 'agent';
          user_id?: string | null;
          name: string;
          role?: string;
          avatar_url?: string | null;
          agent_config?: Record<string, unknown> | null;
          webhook_url?: string | null;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          name?: string;
          role?: string;
          avatar_url?: string | null;
          agent_config?: Record<string, unknown> | null;
          webhook_url?: string | null;
          is_active?: boolean;
          updated_at?: string;
        };
      };
      sprints: {
        Row: {
          id: string;
          org_id: string;
          project_id: string;
          title: string;
          status: 'planning' | 'active' | 'closed';
          start_date: string | null;
          end_date: string | null;
          velocity: number | null;
          team_size: number | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          org_id: string;
          project_id: string;
          title: string;
          status?: 'planning' | 'active' | 'closed';
          start_date?: string | null;
          end_date?: string | null;
          velocity?: number | null;
          team_size?: number | null;
        };
        Update: {
          title?: string;
          status?: 'planning' | 'active' | 'closed';
          start_date?: string | null;
          end_date?: string | null;
          velocity?: number | null;
          team_size?: number | null;
        };
      };
      epics: {
        Row: {
          id: string;
          org_id: string;
          project_id: string;
          title: string;
          status: string;
          priority: string;
          description: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          org_id: string;
          project_id: string;
          title: string;
          status?: string;
          priority?: string;
          description?: string | null;
        };
        Update: {
          title?: string;
          status?: string;
          priority?: string;
          description?: string | null;
        };
      };
      stories: {
        Row: {
          id: string;
          org_id: string;
          project_id: string;
          epic_id: string | null;
          sprint_id: string | null;
          assignee_id: string | null;
          title: string;
          status: 'backlog' | 'ready-for-dev' | 'in-progress' | 'in-review' | 'done';
          priority: string;
          story_points: number | null;
          description: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          org_id: string;
          project_id: string;
          epic_id?: string | null;
          sprint_id?: string | null;
          assignee_id?: string | null;
          title: string;
          status?: 'backlog' | 'ready-for-dev' | 'in-progress' | 'in-review' | 'done';
          priority?: string;
          story_points?: number | null;
          description?: string | null;
        };
        Update: {
          title?: string;
          status?: 'backlog' | 'ready-for-dev' | 'in-progress' | 'in-review' | 'done';
          priority?: string;
          story_points?: number | null;
          description?: string | null;
          epic_id?: string | null;
          sprint_id?: string | null;
          assignee_id?: string | null;
        };
      };
      tasks: {
        Row: {
          id: string;
          org_id: string;
          story_id: string;
          assignee_id: string | null;
          title: string;
          status: 'todo' | 'in-progress' | 'done';
          story_points: number | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          org_id: string;
          story_id: string;
          assignee_id?: string | null;
          title: string;
          status?: 'todo' | 'in-progress' | 'done';
          story_points?: number | null;
        };
        Update: {
          title?: string;
          status?: 'todo' | 'in-progress' | 'done';
          story_points?: number | null;
          assignee_id?: string | null;
        };
      };
      standup_entries: {
        Row: {
          id: string;
          org_id: string;
          project_id: string;
          sprint_id: string | null;
          author_id: string;
          date: string;
          done: string | null;
          plan: string | null;
          blockers: string | null;
          plan_story_ids: string[];
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          org_id: string;
          project_id: string;
          sprint_id?: string | null;
          author_id: string;
          date: string;
          done?: string | null;
          plan?: string | null;
          blockers?: string | null;
          plan_story_ids?: string[];
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          sprint_id?: string | null;
          date?: string;
          done?: string | null;
          plan?: string | null;
          blockers?: string | null;
          plan_story_ids?: string[];
          updated_at?: string;
        };
      };
      standup_feedback: {
        Row: {
          id: string;
          org_id: string;
          project_id: string;
          sprint_id: string | null;
          standup_entry_id: string;
          feedback_by_id: string;
          review_type: 'comment' | 'approve' | 'request_changes';
          feedback_text: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          org_id: string;
          project_id: string;
          sprint_id?: string | null;
          standup_entry_id: string;
          feedback_by_id: string;
          review_type?: 'comment' | 'approve' | 'request_changes';
          feedback_text: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          sprint_id?: string | null;
          review_type?: 'comment' | 'approve' | 'request_changes';
          feedback_text?: string;
          updated_at?: string;
        };
      };
      memos: {
        Row: {
          id: string;
          org_id: string;
          project_id: string;
          memo_type: string;
          title: string | null;
          content: string;
          created_by: string | null;
          assigned_to: string | null;
          status: 'open' | 'resolved' | 'rejected';
          supersedes_id: string | null;
          resolved_by: string | null;
          resolved_at: string | null;
          metadata: Record<string, unknown>;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          org_id: string;
          project_id: string;
          memo_type?: string;
          title?: string | null;
          content: string;
          created_by: string | null;
          assigned_to?: string | null;
          status?: 'open' | 'resolved' | 'rejected';
          supersedes_id?: string | null;
          metadata?: Record<string, unknown>;
        };
        Update: {
          title?: string | null;
          content?: string;
          assigned_to?: string | null;
          status?: 'open' | 'resolved' | 'rejected';
          resolved_by?: string | null;
          resolved_at?: string | null;
          metadata?: Record<string, unknown>;
        };
      };
      memo_replies: {
        Row: {
          id: string;
          memo_id: string;
          content: string;
          created_by: string | null;
          review_type: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          memo_id: string;
          content: string;
          created_by: string | null;
          review_type?: string;
        };
        Update: {
          content?: string;
        };
      };
      memo_doc_links: {
        Row: {
          id: string;
          memo_id: string;
          doc_id: string;
          created_by: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          memo_id: string;
          doc_id: string;
          created_by?: string | null;
          created_at?: string;
        };
        Update: {
          created_by?: string | null;
        };
      };
      memo_reads: {
        Row: {
          id: string;
          memo_id: string;
          team_member_id: string;
          read_at: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          memo_id: string;
          team_member_id: string;
          read_at?: string;
          created_at?: string;
        };
        Update: {
          read_at?: string;
        };
      };
      notifications: {
        Row: {
          id: string;
          org_id: string;
          user_id: string;
          type: string;
          title: string;
          body: string | null;
          is_read: boolean;
          reference_type: string | null;
          reference_id: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          org_id: string;
          user_id: string;
          type?: string;
          title: string;
          body?: string | null;
          is_read?: boolean;
          reference_type?: string | null;
          reference_id?: string | null;
        };
        Update: {
          is_read?: boolean;
        };
      };
      agent_runs: {
        Row: {
          id: string;
          org_id: string;
          project_id: string;
          agent_id: string;
          deployment_id: string | null;
          session_id: string | null;
          story_id: string | null;
          memo_id: string | null;
          dispatch_key: string | null;
          source_updated_at: string | null;
          llm_call_count: number;
          tool_call_history: unknown;
          output_memo_ids: string[];
          last_error_code: string | null;
          error_message: string | null;
          retry_count: number;
          max_retries: number;
          next_retry_at: string | null;
          parent_run_id: string | null;
          failure_disposition: 'retry_scheduled' | 'retry_launched' | 'retry_exhausted' | 'non_retryable' | null;
          trigger: string;
          model: string | null;
          llm_provider: 'managed' | 'byom' | null;
          llm_provider_key: 'openai' | 'anthropic' | 'google' | 'groq' | 'openai-compatible' | null;
          input_tokens: number | null;
          output_tokens: number | null;
          cost_usd: number | null;
          computed_cost_cents: number;
          per_run_cap_cents: number | null;
          billing_notes: string[];
          status: 'queued' | 'held' | 'running' | 'hitl_pending' | 'completed' | 'failed';
          result_summary: string | null;
          duration_ms: number | null;
          restored_memory_count: number | null;
          memory_diagnostics: Record<string, unknown> | null;
          started_at: string | null;
          finished_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          org_id: string;
          project_id: string;
          agent_id: string;
          deployment_id?: string | null;
          session_id?: string | null;
          story_id?: string | null;
          memo_id?: string | null;
          dispatch_key?: string | null;
          source_updated_at?: string | null;
          llm_call_count?: number;
          tool_call_history?: unknown;
          output_memo_ids?: string[];
          last_error_code?: string | null;
          error_message?: string | null;
          retry_count?: number;
          max_retries?: number;
          next_retry_at?: string | null;
          parent_run_id?: string | null;
          failure_disposition?: 'retry_scheduled' | 'retry_launched' | 'retry_exhausted' | 'non_retryable' | null;
          trigger?: string;
          model?: string | null;
          llm_provider?: 'managed' | 'byom' | null;
          llm_provider_key?: 'openai' | 'anthropic' | 'google' | 'groq' | 'openai-compatible' | null;
          input_tokens?: number | null;
          output_tokens?: number | null;
          cost_usd?: number | null;
          computed_cost_cents?: number;
          per_run_cap_cents?: number | null;
          billing_notes?: string[];
          status?: 'queued' | 'held' | 'running' | 'hitl_pending' | 'completed' | 'failed';
          result_summary?: string | null;
          restored_memory_count?: number | null;
          memory_diagnostics?: Record<string, unknown> | null;
          started_at?: string | null;
          finished_at?: string | null;
        };
        Update: {
          deployment_id?: string | null;
          session_id?: string | null;
          dispatch_key?: string | null;
          source_updated_at?: string | null;
          llm_call_count?: number;
          tool_call_history?: unknown;
          output_memo_ids?: string[];
          last_error_code?: string | null;
          error_message?: string | null;
          retry_count?: number;
          max_retries?: number;
          next_retry_at?: string | null;
          parent_run_id?: string | null;
          failure_disposition?: 'retry_scheduled' | 'retry_launched' | 'retry_exhausted' | 'non_retryable' | null;
          status?: 'queued' | 'held' | 'running' | 'hitl_pending' | 'completed' | 'failed';
          result_summary?: string | null;
          restored_memory_count?: number | null;
          memory_diagnostics?: Record<string, unknown> | null;
          started_at?: string | null;
          finished_at?: string | null;
          model?: string | null;
          llm_provider?: 'managed' | 'byom' | null;
          llm_provider_key?: 'openai' | 'anthropic' | 'google' | 'groq' | 'openai-compatible' | null;
          input_tokens?: number | null;
          output_tokens?: number | null;
          cost_usd?: number | null;
          computed_cost_cents?: number;
          per_run_cap_cents?: number | null;
          billing_notes?: string[];
        };
      };
      agent_personas: {
        Row: {
          id: string;
          org_id: string;
          project_id: string;
          agent_id: string;
          name: string;
          slug: string;
          description: string | null;
          system_prompt: string;
          style_prompt: string | null;
          model: string | null;
          config: unknown;
          is_builtin: boolean;
          is_default: boolean;
          created_by: string | null;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          org_id: string;
          project_id: string;
          agent_id: string;
          name: string;
          slug: string;
          description?: string | null;
          system_prompt?: string;
          style_prompt?: string | null;
          model?: string | null;
          config?: unknown;
          is_builtin?: boolean;
          is_default?: boolean;
          created_by?: string | null;
          deleted_at?: string | null;
        };
        Update: {
          name?: string;
          slug?: string;
          description?: string | null;
          system_prompt?: string;
          style_prompt?: string | null;
          model?: string | null;
          config?: unknown;
          is_builtin?: boolean;
          is_default?: boolean;
          created_by?: string | null;
          deleted_at?: string | null;
        };
      };
      agent_deployments: {
        Row: {
          id: string;
          org_id: string;
          project_id: string;
          agent_id: string;
          persona_id: string | null;
          name: string;
          runtime: string;
          model: string | null;
          version: string | null;
          status: 'DEPLOYING' | 'ACTIVE' | 'SUSPENDED' | 'TERMINATED' | 'DEPLOY_FAILED';
          config: unknown;
          last_deployed_at: string | null;
          failure_code: string | null;
          failure_message: string | null;
          failure_detail: unknown;
          failed_at: string | null;
          created_by: string | null;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          org_id: string;
          project_id: string;
          agent_id: string;
          persona_id?: string | null;
          name: string;
          runtime?: string;
          model?: string | null;
          version?: string | null;
          status?: 'DEPLOYING' | 'ACTIVE' | 'SUSPENDED' | 'TERMINATED' | 'DEPLOY_FAILED';
          config?: unknown;
          last_deployed_at?: string | null;
          failure_code?: string | null;
          failure_message?: string | null;
          failure_detail?: unknown;
          failed_at?: string | null;
          created_by?: string | null;
          deleted_at?: string | null;
        };
        Update: {
          persona_id?: string | null;
          name?: string;
          runtime?: string;
          model?: string | null;
          version?: string | null;
          status?: 'DEPLOYING' | 'ACTIVE' | 'SUSPENDED' | 'TERMINATED' | 'DEPLOY_FAILED';
          config?: unknown;
          last_deployed_at?: string | null;
          failure_code?: string | null;
          failure_message?: string | null;
          failure_detail?: unknown;
          failed_at?: string | null;
          deleted_at?: string | null;
        };
      };
      agent_sessions: {
        Row: {
          id: string;
          org_id: string;
          project_id: string;
          agent_id: string;
          persona_id: string | null;
          deployment_id: string | null;
          session_key: string;
          channel: string;
          title: string | null;
          status: 'active' | 'idle' | 'suspended' | 'terminated';
          context_window_tokens: number | null;
          metadata: unknown;
          context_snapshot: unknown;
          created_by: string | null;
          started_at: string;
          last_activity_at: string;
          idle_at: string | null;
          suspended_at: string | null;
          ended_at: string | null;
          terminated_at: string | null;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          org_id: string;
          project_id: string;
          agent_id: string;
          persona_id?: string | null;
          deployment_id?: string | null;
          session_key: string;
          channel?: string;
          title?: string | null;
          status?: 'active' | 'idle' | 'suspended' | 'terminated';
          context_window_tokens?: number | null;
          metadata?: unknown;
          context_snapshot?: unknown;
          created_by?: string | null;
          started_at?: string;
          last_activity_at?: string;
          idle_at?: string | null;
          suspended_at?: string | null;
          ended_at?: string | null;
          terminated_at?: string | null;
          deleted_at?: string | null;
        };
        Update: {
          persona_id?: string | null;
          deployment_id?: string | null;
          session_key?: string;
          channel?: string;
          title?: string | null;
          status?: 'active' | 'idle' | 'suspended' | 'terminated';
          context_window_tokens?: number | null;
          metadata?: unknown;
          context_snapshot?: unknown;
          last_activity_at?: string;
          idle_at?: string | null;
          suspended_at?: string | null;
          ended_at?: string | null;
          terminated_at?: string | null;
          deleted_at?: string | null;
        };
      };
      agent_session_memories: {
        Row: {
          id: string;
          org_id: string;
          project_id: string;
          agent_id: string;
          session_id: string;
          run_id: string | null;
          memory_type: 'context' | 'summary' | 'decision' | 'todo' | 'fact';
          importance: number;
          content: string;
          metadata: unknown;
          token_count: number | null;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          org_id: string;
          project_id: string;
          agent_id: string;
          session_id: string;
          run_id?: string | null;
          memory_type?: 'context' | 'summary' | 'decision' | 'todo' | 'fact';
          importance?: number;
          content: string;
          metadata?: unknown;
          token_count?: number | null;
          deleted_at?: string | null;
        };
        Update: {
          run_id?: string | null;
          memory_type?: 'context' | 'summary' | 'decision' | 'todo' | 'fact';
          importance?: number;
          content?: string;
          metadata?: unknown;
          token_count?: number | null;
          deleted_at?: string | null;
        };
      };
      agent_long_term_memories: {
        Row: {
          id: string;
          org_id: string;
          project_id: string;
          agent_id: string;
          deployment_id: string | null;
          source_run_id: string | null;
          source_session_id: string | null;
          memory_type: string;
          importance: number;
          content: string;
          metadata: unknown;
          embedding: unknown | null;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          org_id: string;
          project_id: string;
          agent_id: string;
          deployment_id?: string | null;
          source_run_id?: string | null;
          source_session_id?: string | null;
          memory_type?: string;
          importance?: number;
          content: string;
          metadata?: unknown;
          embedding?: unknown | null;
          deleted_at?: string | null;
        };
        Update: {
          deployment_id?: string | null;
          source_run_id?: string | null;
          source_session_id?: string | null;
          memory_type?: string;
          importance?: number;
          content?: string;
          metadata?: unknown;
          embedding?: unknown | null;
          deleted_at?: string | null;
        };
      };
      agent_routing_rules: {
        Row: {
          id: string;
          org_id: string;
          project_id: string;
          agent_id: string;
          persona_id: string | null;
          deployment_id: string | null;
          name: string;
          priority: number;
          match_type: 'event' | 'channel' | 'project' | 'manual' | 'fallback';
          conditions: unknown;
          action: unknown;
          target_runtime: string;
          target_model: string | null;
          is_enabled: boolean;
          metadata: unknown;
          created_by: string | null;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          org_id: string;
          project_id: string;
          agent_id: string;
          persona_id?: string | null;
          deployment_id?: string | null;
          name: string;
          priority?: number;
          match_type?: 'event' | 'channel' | 'project' | 'manual' | 'fallback';
          conditions?: unknown;
          action?: unknown;
          target_runtime?: string;
          target_model?: string | null;
          is_enabled?: boolean;
          metadata?: unknown;
          created_by?: string | null;
          deleted_at?: string | null;
        };
        Update: {
          persona_id?: string | null;
          deployment_id?: string | null;
          name?: string;
          priority?: number;
          match_type?: 'event' | 'channel' | 'project' | 'manual' | 'fallback';
          conditions?: unknown;
          action?: unknown;
          target_runtime?: string;
          target_model?: string | null;
          is_enabled?: boolean;
          metadata?: unknown;
          created_by?: string | null;
          deleted_at?: string | null;
        };
      };
      agent_hitl_requests: {
        Row: {
          id: string;
          org_id: string;
          project_id: string;
          agent_id: string;
          deployment_id: string | null;
          session_id: string | null;
          run_id: string | null;
          request_type: 'approval' | 'input' | 'confirmation' | 'escalation';
          title: string;
          prompt: string;
          requested_for: string;
          status: 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled' | 'resolved';
          response_text: string | null;
          responded_by: string | null;
          responded_at: string | null;
          expires_at: string | null;
          reminder_sent_at: string | null;
          expired_at: string | null;
          metadata: unknown;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          org_id: string;
          project_id: string;
          agent_id: string;
          deployment_id?: string | null;
          session_id?: string | null;
          run_id?: string | null;
          request_type?: 'approval' | 'input' | 'confirmation' | 'escalation';
          title: string;
          prompt: string;
          requested_for: string;
          status?: 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled' | 'resolved';
          response_text?: string | null;
          responded_by?: string | null;
          responded_at?: string | null;
          expires_at?: string | null;
          reminder_sent_at?: string | null;
          expired_at?: string | null;
          metadata?: unknown;
          deleted_at?: string | null;
        };
        Update: {
          deployment_id?: string | null;
          session_id?: string | null;
          run_id?: string | null;
          request_type?: 'approval' | 'input' | 'confirmation' | 'escalation';
          title?: string;
          prompt?: string;
          requested_for?: string;
          status?: 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled' | 'resolved';
          response_text?: string | null;
          responded_by?: string | null;
          responded_at?: string | null;
          expires_at?: string | null;
          reminder_sent_at?: string | null;
          expired_at?: string | null;
          metadata?: unknown;
          deleted_at?: string | null;
        };
      };
      agent_hitl_policies: {
        Row: {
          id: string;
          org_id: string;
          project_id: string;
          config: unknown;
          created_by: string | null;
          updated_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          org_id: string;
          project_id: string;
          config?: unknown;
          created_by?: string | null;
          updated_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          config?: unknown;
          created_by?: string | null;
          updated_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
      };
      agent_audit_logs: {
        Row: {
          id: string;
          org_id: string;
          project_id: string;
          agent_id: string;
          deployment_id: string | null;
          session_id: string | null;
          run_id: string | null;
          event_type: string;
          severity: 'debug' | 'info' | 'warn' | 'error' | 'security';
          summary: string;
          payload: unknown;
          created_by: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          org_id: string;
          project_id: string;
          agent_id: string;
          deployment_id?: string | null;
          session_id?: string | null;
          run_id?: string | null;
          event_type: string;
          severity?: 'debug' | 'info' | 'warn' | 'error' | 'security';
          summary: string;
          payload?: unknown;
          created_by?: string | null;
        };
        Update: {
          deployment_id?: string | null;
          session_id?: string | null;
          run_id?: string | null;
          event_type?: string;
          severity?: 'debug' | 'info' | 'warn' | 'error' | 'security';
          summary?: string;
          payload?: unknown;
          created_by?: string | null;
        };
      };
      messaging_bridge_channels: {
        Row: {
          id: string;
          org_id: string;
          project_id: string;
          platform: MessagingBridgePlatform;
          channel_id: string;
          channel_name: string | null;
          config: Record<string, MessagingBridgeSecretRef>;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          org_id: string;
          project_id: string;
          platform: MessagingBridgePlatform;
          channel_id: string;
          channel_name?: string | null;
          config?: Record<string, MessagingBridgeSecretRef>;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          platform?: MessagingBridgePlatform;
          channel_id?: string;
          channel_name?: string | null;
          config?: Record<string, MessagingBridgeSecretRef>;
          is_active?: boolean;
          updated_at?: string;
        };
      };
      messaging_bridge_users: {
        Row: {
          id: string;
          org_id: string;
          team_member_id: string;
          platform: MessagingBridgePlatform;
          platform_user_id: string;
          display_name: string | null;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          org_id: string;
          team_member_id: string;
          platform: MessagingBridgePlatform;
          platform_user_id: string;
          display_name?: string | null;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          team_member_id?: string;
          platform?: MessagingBridgePlatform;
          platform_user_id?: string;
          display_name?: string | null;
          is_active?: boolean;
          updated_at?: string;
        };
      };
      messaging_bridge_org_auths: {
        Row: {
          id: string;
          org_id: string;
          platform: MessagingBridgePlatform;
          access_token_ref: MessagingBridgeSecretRef;
          expires_at: string | null;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          org_id: string;
          platform: MessagingBridgePlatform;
          access_token_ref: MessagingBridgeSecretRef;
          expires_at?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          platform?: MessagingBridgePlatform;
          access_token_ref?: MessagingBridgeSecretRef;
          expires_at?: string | null;
          created_by?: string | null;
          updated_at?: string;
        };
      };
      messaging_bridge_reply_dispatches: {
        Row: {
          id: string;
          org_id: string;
          project_id: string;
          memo_id: string;
          reply_id: string;
          platform: MessagingBridgePlatform;
          status: 'pending' | 'sent' | 'failed';
          attempt_count: number;
          claim_token: string | null;
          claimed_at: string | null;
          sent_at: string | null;
          error_message: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          org_id: string;
          project_id: string;
          memo_id: string;
          reply_id: string;
          platform: MessagingBridgePlatform;
          status?: 'pending' | 'sent' | 'failed';
          attempt_count?: number;
          claim_token?: string | null;
          claimed_at?: string | null;
          sent_at?: string | null;
          error_message?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          platform?: MessagingBridgePlatform;
          status?: 'pending' | 'sent' | 'failed';
          attempt_count?: number;
          claim_token?: string | null;
          claimed_at?: string | null;
          sent_at?: string | null;
          error_message?: string | null;
          updated_at?: string;
        };
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
  };
}
