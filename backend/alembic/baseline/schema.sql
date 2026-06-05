--
-- PostgreSQL database dump
--


-- Dumped from database version 15.17
-- Dumped by pg_dump version 16.14 (Debian 16.14-1.pgdg13+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: vector; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;


--
-- Name: EXTENSION vector; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION vector IS 'vector data type and ivfflat and hnsw access methods';


--
-- Name: meeting_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.meeting_type AS ENUM (
    'standup',
    'retro',
    'general',
    'review'
);


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: activity_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.activity_logs (
    id uuid NOT NULL,
    org_id uuid NOT NULL,
    project_id uuid,
    actor_id uuid,
    actor_type text NOT NULL,
    action text NOT NULL,
    entity_type text,
    entity_id uuid,
    context jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_activity_logs_actor_type CHECK ((actor_type = ANY (ARRAY['agent'::text, 'human'::text])))
);


--
-- Name: agent_api_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_api_keys (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_member_id uuid NOT NULL,
    key_prefix text NOT NULL,
    key_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    last_used_at timestamp with time zone,
    expires_at timestamp with time zone,
    scope text[] DEFAULT '{read,write}'::text[],
    member_id uuid
);


--
-- Name: agent_audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_audit_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    project_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    deployment_id uuid,
    session_id uuid,
    run_id uuid,
    event_type text NOT NULL,
    severity text DEFAULT 'info'::text NOT NULL,
    summary text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_audit_logs_severity_check CHECK ((severity = ANY (ARRAY['debug'::text, 'info'::text, 'warn'::text, 'error'::text, 'security'::text])))
);


--
-- Name: agent_deployments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_deployments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    project_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    name text NOT NULL,
    runtime text DEFAULT 'openclaw'::text NOT NULL,
    model text,
    version text,
    status text DEFAULT 'draft'::text NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    last_deployed_at timestamp with time zone,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    persona_id uuid,
    failure_code text,
    failure_message text,
    failure_detail jsonb,
    failed_at timestamp with time zone,
    CONSTRAINT agent_deployments_status_check CHECK ((status = ANY (ARRAY['DEPLOYING'::text, 'ACTIVE'::text, 'SUSPENDED'::text, 'TERMINATED'::text, 'DEPLOY_FAILED'::text])))
);


--
-- Name: agent_endpoints; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_endpoints (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    team_member_id uuid NOT NULL,
    delivery_method text DEFAULT 'push'::text NOT NULL,
    webhook_url text,
    webhook_secret text DEFAULT replace((gen_random_uuid())::text, '-'::text, ''::text) NOT NULL,
    bridge_type text,
    bridge_config jsonb,
    poll_interval_sec integer DEFAULT 30 NOT NULL,
    last_seen_at timestamp with time zone,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_endpoints_bridge_type_check CHECK ((bridge_type = ANY (ARRAY['discord'::text, 'slack'::text]))),
    CONSTRAINT agent_endpoints_delivery_method_check CHECK ((delivery_method = ANY (ARRAY['push'::text, 'poll'::text, 'bridge'::text]))),
    CONSTRAINT agent_endpoints_status_check CHECK ((status = ANY (ARRAY['active'::text, 'inactive'::text, 'error'::text])))
);


--
-- Name: agent_event_cursors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_event_cursors (
    agent_id uuid NOT NULL,
    acked_seq bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: agent_event_seqs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_event_seqs (
    recipient_id uuid NOT NULL,
    last_seq bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: agent_gateway_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_gateway_sessions (
    id uuid NOT NULL,
    agent_id uuid NOT NULL,
    connected_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_ack_seq bigint DEFAULT 0 NOT NULL
);


--
-- Name: agent_hitl_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_hitl_policies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    project_id uuid NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by uuid,
    updated_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_hitl_policies_config_is_object CHECK ((jsonb_typeof(config) = 'object'::text))
);


--
-- Name: agent_hitl_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_hitl_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    project_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    deployment_id uuid,
    session_id uuid,
    run_id uuid,
    request_type text DEFAULT 'approval'::text NOT NULL,
    title text NOT NULL,
    prompt text NOT NULL,
    requested_for uuid NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    response_text text,
    responded_by uuid,
    responded_at timestamp with time zone,
    expires_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    reminder_sent_at timestamp with time zone,
    expired_at timestamp with time zone,
    CONSTRAINT agent_hitl_requests_request_type_check CHECK ((request_type = ANY (ARRAY['approval'::text, 'input'::text, 'confirmation'::text, 'escalation'::text]))),
    CONSTRAINT agent_hitl_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'expired'::text, 'cancelled'::text, 'resolved'::text])))
);


--
-- Name: agent_long_term_memories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_long_term_memories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    project_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    deployment_id uuid,
    source_run_id uuid,
    content text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    embedding public.vector(1536),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    source_session_id uuid,
    memory_type text DEFAULT 'fact'::text NOT NULL,
    importance smallint DEFAULT 50 NOT NULL,
    CONSTRAINT chk_agent_long_term_memories_importance_range CHECK (((importance >= 0) AND (importance <= 100))),
    CONSTRAINT chk_agent_long_term_memories_memory_type CHECK ((memory_type = ANY (ARRAY['context'::text, 'summary'::text, 'decision'::text, 'todo'::text, 'fact'::text])))
);


--
-- Name: agent_message_allowlist; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_message_allowlist (
    id uuid NOT NULL,
    agent_member_id uuid NOT NULL,
    allowed_id uuid NOT NULL,
    org_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: agent_personas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_personas (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    project_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    description text,
    system_prompt text DEFAULT ''::text NOT NULL,
    style_prompt text,
    model text,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    is_builtin boolean DEFAULT false NOT NULL
);


--
-- Name: agent_project_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_project_profiles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    member_id uuid NOT NULL,
    project_id uuid NOT NULL,
    agent_config jsonb,
    webhook_url text,
    agent_role text,
    fakechat_port integer,
    last_seen_at timestamp with time zone,
    active_story_id uuid,
    agent_status text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: agent_routing_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_routing_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    project_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    persona_id uuid,
    deployment_id uuid,
    name text NOT NULL,
    priority integer DEFAULT 100 NOT NULL,
    match_type text DEFAULT 'event'::text NOT NULL,
    conditions jsonb DEFAULT '{}'::jsonb NOT NULL,
    target_runtime text DEFAULT 'openclaw'::text NOT NULL,
    target_model text,
    is_enabled boolean DEFAULT true NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    action jsonb DEFAULT '{"auto_reply_mode": "process_and_report"}'::jsonb NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT agent_routing_rules_match_type_check CHECK ((match_type = ANY (ARRAY['event'::text, 'channel'::text, 'project'::text, 'manual'::text, 'fallback'::text])))
);


--
-- Name: agent_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    story_id uuid,
    memo_id uuid,
    trigger text DEFAULT 'manual'::text NOT NULL,
    model text,
    input_tokens integer,
    output_tokens integer,
    cost_usd numeric(10,6),
    status text DEFAULT 'running'::text NOT NULL,
    result_summary text,
    duration_ms_legacy integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    project_id uuid NOT NULL,
    deployment_id uuid,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    duration_ms integer GENERATED ALWAYS AS (
CASE
    WHEN ((finished_at IS NOT NULL) AND (started_at IS NOT NULL)) THEN GREATEST(((EXTRACT(epoch FROM (finished_at - started_at)) * (1000)::numeric))::integer, 0)
    WHEN (duration_ms_legacy IS NOT NULL) THEN duration_ms_legacy
    ELSE NULL::integer
END) STORED,
    session_id uuid,
    dispatch_key text,
    source_updated_at timestamp with time zone,
    llm_call_count integer DEFAULT 0 NOT NULL,
    tool_call_history jsonb DEFAULT '[]'::jsonb NOT NULL,
    output_memo_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    last_error_code text,
    llm_provider text,
    computed_cost_cents integer DEFAULT 0 NOT NULL,
    per_run_cap_cents integer,
    billing_notes text[] DEFAULT '{}'::text[] NOT NULL,
    retry_count integer DEFAULT 0 NOT NULL,
    max_retries integer DEFAULT 3 NOT NULL,
    next_retry_at timestamp with time zone,
    parent_run_id uuid,
    error_message text,
    failure_disposition text,
    llm_provider_key text,
    restored_memory_count integer,
    memory_diagnostics jsonb,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT agent_runs_failure_disposition_check CHECK (((failure_disposition = ANY (ARRAY['retry_scheduled'::text, 'retry_launched'::text, 'retry_exhausted'::text, 'non_retryable'::text])) OR (failure_disposition IS NULL))),
    CONSTRAINT agent_runs_llm_provider_check CHECK ((llm_provider = ANY (ARRAY['managed'::text, 'byom'::text]))),
    CONSTRAINT agent_runs_llm_provider_key_check CHECK ((llm_provider_key = ANY (ARRAY['openai'::text, 'anthropic'::text, 'google'::text, 'groq'::text, 'openai-compatible'::text]))),
    CONSTRAINT agent_runs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'held'::text, 'running'::text, 'hitl_pending'::text, 'completed'::text, 'failed'::text])))
);


--
-- Name: agent_session_memories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_session_memories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    project_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    session_id uuid NOT NULL,
    run_id uuid,
    memory_type text DEFAULT 'context'::text NOT NULL,
    importance smallint DEFAULT 50 NOT NULL,
    content text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    token_count integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT agent_session_memories_importance_check CHECK (((importance >= 0) AND (importance <= 100))),
    CONSTRAINT agent_session_memories_memory_type_check CHECK ((memory_type = ANY (ARRAY['context'::text, 'summary'::text, 'decision'::text, 'todo'::text, 'fact'::text]))),
    CONSTRAINT agent_session_memories_token_count_check CHECK (((token_count IS NULL) OR (token_count >= 0)))
);


--
-- Name: agent_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    project_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    persona_id uuid,
    deployment_id uuid,
    session_key text NOT NULL,
    channel text DEFAULT 'internal'::text NOT NULL,
    title text,
    status text DEFAULT 'active'::text NOT NULL,
    context_window_tokens integer,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by uuid,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    last_activity_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    context_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    idle_at timestamp with time zone,
    suspended_at timestamp with time zone,
    terminated_at timestamp with time zone,
    CONSTRAINT agent_sessions_context_window_tokens_check CHECK (((context_window_tokens IS NULL) OR (context_window_tokens > 0))),
    CONSTRAINT agent_sessions_status_check CHECK ((status = ANY (ARRAY['active'::text, 'idle'::text, 'suspended'::text, 'terminated'::text])))
);


--
-- Name: analytics_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.analytics_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    project_id uuid NOT NULL,
    event_name text NOT NULL,
    step integer,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: api_key_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_key_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    api_key_id uuid NOT NULL,
    org_id uuid NOT NULL,
    endpoint text NOT NULL,
    ip_address text,
    status_code integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: approved_mcp_servers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.approved_mcp_servers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    server_key text NOT NULL,
    display_name text NOT NULL,
    provider text NOT NULL,
    auth_strategy text NOT NULL,
    gateway_url_env text NOT NULL,
    token_header_name text DEFAULT 'Authorization'::text NOT NULL,
    token_scheme text DEFAULT 'bearer'::text NOT NULL,
    oauth_authorize_url text,
    oauth_token_url text,
    oauth_client_id_env text,
    oauth_client_secret_env text,
    oauth_redirect_uri_env text,
    oauth_scopes text[] DEFAULT '{}'::text[] NOT NULL,
    tool_cache_ttl_seconds integer DEFAULT 3600 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT approved_mcp_servers_auth_strategy_check CHECK ((auth_strategy = ANY (ARRAY['oauth'::text, 'api_key'::text, 'api_token'::text]))),
    CONSTRAINT approved_mcp_servers_provider_check CHECK ((provider = ANY (ARRAY['github'::text, 'linear'::text, 'jira'::text]))),
    CONSTRAINT approved_mcp_servers_token_scheme_check CHECK ((token_scheme = ANY (ARRAY['bearer'::text, 'plain'::text]))),
    CONSTRAINT approved_mcp_servers_tool_cache_ttl_seconds_check CHECK ((tool_cache_ttl_seconds > 0))
);


--
-- Name: billing_limit_alerts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.billing_limit_alerts (
    org_id uuid NOT NULL,
    usage_month date NOT NULL,
    alert_type text NOT NULL,
    threshold_pct integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_billing_limit_alerts_threshold_range CHECK (((threshold_pct IS NULL) OR ((threshold_pct >= 1) AND (threshold_pct <= 100))))
);


--
-- Name: billing_limits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.billing_limits (
    org_id uuid NOT NULL,
    monthly_cap_cents integer,
    daily_cap_cents integer,
    alert_threshold_pct integer DEFAULT 80 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_billing_limits_non_negative CHECK ((((monthly_cap_cents IS NULL) OR (monthly_cap_cents >= 0)) AND ((daily_cap_cents IS NULL) OR (daily_cap_cents >= 0)))),
    CONSTRAINT chk_billing_limits_threshold_range CHECK (((alert_threshold_pct >= 1) AND (alert_threshold_pct <= 100)))
);


--
-- Name: conversation_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversation_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    conversation_id uuid NOT NULL,
    sender_id uuid,
    content text NOT NULL,
    mentioned_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    thread_id uuid,
    reply_count integer DEFAULT 0 NOT NULL,
    last_reply_at timestamp with time zone,
    review_type text,
    metadata jsonb,
    attachments jsonb DEFAULT '[]'::jsonb
);


--
-- Name: conversation_participants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversation_participants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    conversation_id uuid NOT NULL,
    member_id uuid NOT NULL,
    joined_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: conversation_webhook_deliveries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversation_webhook_deliveries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    message_id uuid NOT NULL,
    webhook_config_id uuid,
    status text DEFAULT 'pending'::text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    org_id uuid NOT NULL,
    type text DEFAULT 'group'::text NOT NULL,
    title text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    resolved_by uuid,
    resolved_at timestamp with time zone
);


--
-- Name: doc_comments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.doc_comments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    doc_id uuid NOT NULL,
    content text NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: doc_revisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.doc_revisions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    doc_id uuid NOT NULL,
    content text NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    content_format text DEFAULT 'markdown'::text NOT NULL,
    CONSTRAINT doc_revisions_content_format_check CHECK ((content_format = ANY (ARRAY['markdown'::text, 'html'::text])))
);


--
-- Name: docs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.docs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    project_id uuid NOT NULL,
    parent_id uuid,
    title text NOT NULL,
    slug text NOT NULL,
    content text DEFAULT ''::text NOT NULL,
    icon text,
    sort_order integer DEFAULT 0 NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    content_format text DEFAULT 'markdown'::text NOT NULL,
    is_folder boolean DEFAULT false NOT NULL,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    doc_type text DEFAULT 'general'::text NOT NULL,
    assignee_id uuid,
    search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, ((COALESCE(title, ''::text) || ' '::text) || COALESCE(content, ''::text)))) STORED,
    CONSTRAINT docs_doc_type_check CHECK ((doc_type = ANY (ARRAY['prd'::text, 'ac'::text, 'spec'::text, 'policy'::text, 'general'::text, 'page'::text, 'sprint_report'::text])))
);


--
-- Name: epic_docs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.epic_docs (
    epic_id uuid NOT NULL,
    doc_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: epics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.epics (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    project_id uuid NOT NULL,
    title text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    priority text DEFAULT 'medium'::text NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    objective text,
    success_criteria text,
    target_sp integer,
    target_date date,
    assignee_id uuid,
    success_hypothesis text,
    metric_definition jsonb,
    measure_after timestamp with time zone,
    outcome_status character varying(20) DEFAULT 'n_a'::character varying NOT NULL,
    outcome_result jsonb,
    CONSTRAINT epics_priority_check CHECK ((priority = ANY (ARRAY['critical'::text, 'high'::text, 'medium'::text, 'low'::text]))),
    CONSTRAINT epics_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'active'::text, 'done'::text, 'archived'::text])))
);


--
-- Name: events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.events (
    id uuid NOT NULL,
    org_id uuid NOT NULL,
    project_id uuid NOT NULL,
    event_type text NOT NULL,
    source_entity_type text,
    source_entity_id uuid,
    sender_id uuid,
    recipient_id uuid NOT NULL,
    recipient_type text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    delivered_at timestamp with time zone,
    read_at timestamp with time zone,
    recipient_seq bigint
);


--
-- Name: file_locks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.file_locks (
    id uuid NOT NULL,
    org_id uuid NOT NULL,
    project_id uuid NOT NULL,
    member_id uuid NOT NULL,
    story_id uuid,
    file_path text NOT NULL,
    locked_at timestamp with time zone DEFAULT now() NOT NULL,
    released_at timestamp with time zone
);


--
-- Name: gate; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gate (
    id uuid NOT NULL,
    org_id uuid NOT NULL,
    work_item_id uuid NOT NULL,
    work_item_type character varying(20) NOT NULL,
    gate_type character varying(50) NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    resolver_id uuid,
    resolved_at timestamp with time zone,
    neutral_facts jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    resolution_note text
);


--
-- Name: inbox_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inbox_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    project_id uuid NOT NULL,
    assignee_member_id uuid NOT NULL,
    kind text NOT NULL,
    title text NOT NULL,
    context text,
    agent_summary text,
    origin_chain jsonb DEFAULT '[]'::jsonb NOT NULL,
    options jsonb DEFAULT '[]'::jsonb NOT NULL,
    after_decision text,
    from_agent_id uuid,
    story_id uuid,
    memo_id uuid,
    priority text DEFAULT 'normal'::text NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    resolved_by uuid,
    resolved_option_id uuid,
    resolved_note text,
    source_type text NOT NULL,
    source_id text NOT NULL,
    waiting_since timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    CONSTRAINT inbox_items_kind_check CHECK ((kind = ANY (ARRAY['approval'::text, 'decision'::text, 'blocker'::text, 'mention'::text]))),
    CONSTRAINT inbox_items_priority_check CHECK ((priority = ANY (ARRAY['high'::text, 'normal'::text]))),
    CONSTRAINT inbox_items_source_type_check CHECK ((source_type = ANY (ARRAY['agent_run'::text, 'memo_mention'::text, 'webhook'::text, 'manual'::text]))),
    CONSTRAINT inbox_items_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'resolved'::text, 'dismissed'::text])))
);


--
-- Name: inbox_outbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inbox_outbox (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    inbox_item_id uuid NOT NULL,
    event_type text NOT NULL,
    payload jsonb NOT NULL,
    webhook_url text,
    status text DEFAULT 'pending'::text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    last_attempt_at timestamp with time zone,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    last_error text,
    delivered_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT inbox_outbox_event_type_check CHECK ((event_type = ANY (ARRAY['resolved'::text, 'dismissed'::text, 'reassigned'::text]))),
    CONSTRAINT inbox_outbox_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'in_flight'::text, 'delivered'::text, 'failed'::text, 'dead'::text])))
);


--
-- Name: invitations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invitations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    email text NOT NULL,
    token text DEFAULT replace((gen_random_uuid())::text, '-'::text, ''::text) NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '7 days'::interval) NOT NULL,
    accepted_at timestamp with time zone,
    invited_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    project_id uuid,
    status text DEFAULT 'pending'::text NOT NULL,
    email_sent_at timestamp with time zone,
    email_error text,
    CONSTRAINT invitations_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'revoked'::text])))
);


--
-- Name: item_dependency; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.item_dependency (
    id uuid NOT NULL,
    org_id uuid NOT NULL,
    from_id uuid NOT NULL,
    to_id uuid NOT NULL,
    dep_type character varying(20) NOT NULL,
    item_type character varying(20) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: item_label; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.item_label (
    id uuid NOT NULL,
    org_id uuid NOT NULL,
    label_id uuid NOT NULL,
    item_id uuid NOT NULL,
    item_type character varying(20) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: label; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.label (
    id uuid NOT NULL,
    org_id uuid NOT NULL,
    name text NOT NULL,
    color character varying(20),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: llm_pricing_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.llm_pricing_config (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider text NOT NULL,
    model text NOT NULL,
    input_cost_per_million_tokens_usd numeric(12,6) NOT NULL,
    output_cost_per_million_tokens_usd numeric(12,6) NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT llm_pricing_config_input_cost_per_million_tokens_usd_check CHECK ((input_cost_per_million_tokens_usd >= (0)::numeric)),
    CONSTRAINT llm_pricing_config_output_cost_per_million_tokens_usd_check CHECK ((output_cost_per_million_tokens_usd >= (0)::numeric)),
    CONSTRAINT llm_pricing_config_provider_check CHECK ((provider = ANY (ARRAY['openai'::text, 'anthropic'::text, 'google'::text, 'groq'::text, 'openai-compatible'::text])))
);


--
-- Name: login_audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.login_audit_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_type text NOT NULL,
    user_id uuid,
    email text,
    ip_address text,
    user_agent text,
    detail text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: mcp_connection_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mcp_connection_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    project_id uuid NOT NULL,
    requested_by uuid NOT NULL,
    server_name text NOT NULL,
    server_url text NOT NULL,
    notes text,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mcp_connection_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])))
);


--
-- Name: meetings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.meetings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    title text NOT NULL,
    meeting_type public.meeting_type DEFAULT 'general'::public.meeting_type NOT NULL,
    date timestamp with time zone DEFAULT now() NOT NULL,
    duration_min integer,
    participants jsonb DEFAULT '[]'::jsonb NOT NULL,
    raw_transcript text,
    ai_summary text,
    decisions jsonb DEFAULT '[]'::jsonb NOT NULL,
    action_items jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: member_gate_override; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.member_gate_override (
    id uuid NOT NULL,
    org_id uuid NOT NULL,
    member_id uuid NOT NULL,
    gate_type character varying(50) NOT NULL,
    disposition character varying(20) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: member_identity_aliases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.member_identity_aliases (
    alias_id uuid NOT NULL,
    member_id uuid NOT NULL,
    org_id uuid NOT NULL,
    project_id uuid,
    alias_source text NOT NULL
);


--
-- Name: members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.members (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    type text NOT NULL,
    user_id uuid,
    owner_member_id uuid,
    name text NOT NULL,
    avatar_url text,
    org_role text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    message_policy_mode text DEFAULT 'creator_only'::text NOT NULL,
    CONSTRAINT members_type_check CHECK ((type = ANY (ARRAY['human'::text, 'agent'::text])))
);


--
-- Name: memo_assignees; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memo_assignees (
    memo_id uuid NOT NULL,
    member_id uuid NOT NULL,
    assigned_at timestamp with time zone DEFAULT now() NOT NULL,
    assigned_by uuid
);


--
-- Name: memo_doc_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memo_doc_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    memo_id uuid NOT NULL,
    doc_id uuid NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: memo_entity_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memo_entity_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    memo_id uuid NOT NULL,
    entity_type character varying(32) NOT NULL,
    entity_id uuid NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_mel_entity_type CHECK (((entity_type)::text = ANY ((ARRAY['story'::character varying, 'doc'::character varying, 'epic'::character varying, 'task'::character varying])::text[])))
);


--
-- Name: memo_mentions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memo_mentions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    memo_id uuid NOT NULL,
    mentioned_user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: memo_reads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memo_reads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    memo_id uuid NOT NULL,
    team_member_id uuid NOT NULL,
    read_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: memo_replies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memo_replies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    memo_id uuid NOT NULL,
    content text NOT NULL,
    created_by uuid NOT NULL,
    review_type text DEFAULT 'comment'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    attachments jsonb DEFAULT '[]'::jsonb NOT NULL
);


--
-- Name: memos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memos (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    project_id uuid NOT NULL,
    memo_type text DEFAULT 'memo'::text NOT NULL,
    title text,
    content text NOT NULL,
    created_by uuid NOT NULL,
    assigned_to uuid,
    status text DEFAULT 'open'::text NOT NULL,
    supersedes_id uuid,
    resolved_by uuid,
    resolved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    search_vector tsvector,
    archived_at timestamp with time zone,
    CONSTRAINT memos_status_check CHECK ((status = ANY (ARRAY['open'::text, 'resolved'::text, 'rejected'::text]))),
    CONSTRAINT memos_type_check CHECK ((memo_type = ANY (ARRAY['memo'::text, 'task'::text, 'checklist'::text, 'decision'::text, 'request'::text, 'handoff'::text, 'feedback'::text, 'announcement'::text, 'general'::text, 'system_workflow_update'::text])))
);


--
-- Name: messaging_bridge_channels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messaging_bridge_channels (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    project_id uuid NOT NULL,
    platform text NOT NULL,
    channel_id text NOT NULL,
    channel_name text,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT messaging_bridge_channels_platform_check CHECK ((platform = ANY (ARRAY['slack'::text, 'discord'::text, 'teams'::text, 'telegram'::text])))
);


--
-- Name: messaging_bridge_org_auths; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messaging_bridge_org_auths (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    platform text NOT NULL,
    access_token_ref text NOT NULL,
    expires_at timestamp with time zone,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT messaging_bridge_org_auths_access_token_ref_check CHECK ((access_token_ref ~ '^(env|vault):[^[:space:]]+$'::text)),
    CONSTRAINT messaging_bridge_org_auths_platform_check CHECK ((platform = ANY (ARRAY['slack'::text, 'discord'::text, 'teams'::text, 'telegram'::text])))
);


--
-- Name: messaging_bridge_reply_dispatches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messaging_bridge_reply_dispatches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    project_id uuid NOT NULL,
    memo_id uuid NOT NULL,
    reply_id uuid NOT NULL,
    platform text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    claim_token uuid,
    claimed_at timestamp with time zone,
    sent_at timestamp with time zone,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT messaging_bridge_reply_dispatches_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT messaging_bridge_reply_dispatches_platform_check CHECK ((platform = ANY (ARRAY['slack'::text, 'discord'::text, 'teams'::text, 'telegram'::text]))),
    CONSTRAINT messaging_bridge_reply_dispatches_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sent'::text, 'failed'::text])))
);


--
-- Name: messaging_bridge_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messaging_bridge_users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    team_member_id uuid NOT NULL,
    platform text NOT NULL,
    platform_user_id text NOT NULL,
    display_name text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT messaging_bridge_users_platform_check CHECK ((platform = ANY (ARRAY['slack'::text, 'discord'::text, 'teams'::text, 'telegram'::text])))
);


--
-- Name: mockup_components; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mockup_components (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    page_id uuid NOT NULL,
    parent_id uuid,
    component_type text NOT NULL,
    props jsonb DEFAULT '{}'::jsonb NOT NULL,
    spec_description text,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: mockup_pages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mockup_pages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    org_id uuid NOT NULL,
    slug text NOT NULL,
    title text NOT NULL,
    category text DEFAULT 'general'::text,
    viewport text DEFAULT 'desktop'::text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT mockup_pages_viewport_check CHECK ((viewport = ANY (ARRAY['mobile'::text, 'desktop'::text])))
);


--
-- Name: mockup_scenarios; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mockup_scenarios (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    page_id uuid NOT NULL,
    name text NOT NULL,
    override_props jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: mockup_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mockup_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    page_id uuid NOT NULL,
    version integer NOT NULL,
    snapshot jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: notification_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_preferences (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    member_id uuid NOT NULL,
    scope_type text NOT NULL,
    scope_id uuid,
    channel text NOT NULL,
    level text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: notification_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    member_id uuid NOT NULL,
    channel text DEFAULT 'in_app'::text NOT NULL,
    event_type text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    CONSTRAINT notification_settings_channel_check CHECK ((channel = ANY (ARRAY['in_app'::text, 'email'::text, 'webhook'::text, 'slack'::text, 'discord'::text])))
);


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    user_id uuid NOT NULL,
    type text DEFAULT 'info'::text NOT NULL,
    title text NOT NULL,
    body text,
    is_read boolean DEFAULT false NOT NULL,
    reference_type text,
    reference_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: org_gate_override; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_gate_override (
    id uuid NOT NULL,
    org_id uuid NOT NULL,
    role_id uuid NOT NULL,
    gate_type character varying(50) NOT NULL,
    disposition character varying(20) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: org_gate_policy; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_gate_policy (
    id uuid NOT NULL,
    org_id uuid NOT NULL,
    posture character varying(20) DEFAULT 'balanced'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: org_integrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_integrations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    project_id uuid NOT NULL,
    integration_type text DEFAULT 'byom_api_key'::text NOT NULL,
    provider text NOT NULL,
    secret_last4 text,
    kms_status text DEFAULT 'active'::text NOT NULL,
    rotation_requested_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    encrypted_secret text,
    kms_provider text DEFAULT 'local'::text NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    validated_at timestamp with time zone,
    last_error text,
    tool_cache jsonb DEFAULT '[]'::jsonb NOT NULL,
    tool_cache_expires_at timestamp with time zone,
    CONSTRAINT org_integrations_config_is_object CHECK ((jsonb_typeof(config) = 'object'::text)),
    CONSTRAINT org_integrations_kms_provider_check CHECK ((kms_provider = ANY (ARRAY['local'::text, 'gcp'::text, 'vault'::text]))),
    CONSTRAINT org_integrations_kms_status_check CHECK ((kms_status = ANY (ARRAY['active'::text, 'rotation_requested'::text]))),
    CONSTRAINT org_integrations_provider_check CHECK ((provider = ANY (ARRAY['openai'::text, 'anthropic'::text, 'google'::text, 'groq'::text, 'openai-compatible'::text, 'github'::text, 'linear'::text, 'jira'::text]))),
    CONSTRAINT org_integrations_status_check CHECK ((status = ANY (ARRAY['active'::text, 'error'::text, 'pending_oauth'::text]))),
    CONSTRAINT org_integrations_tool_cache_is_array CHECK ((jsonb_typeof(tool_cache) = 'array'::text))
);


--
-- Name: org_invites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_invites (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    email text NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    token text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    accepted_at timestamp with time zone,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    email_sent_at timestamp with time zone,
    email_error text
);


--
-- Name: org_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_members (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT org_members_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text])))
);


--
-- Name: org_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    polar_customer_id text NOT NULL,
    polar_subscription_id text,
    tier text DEFAULT 'free'::text NOT NULL,
    billing_cycle text,
    status text DEFAULT 'active'::text NOT NULL,
    current_period_start timestamp with time zone,
    current_period_end timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    grace_until timestamp with time zone
);


--
-- Name: org_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_usage (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    period text NOT NULL,
    stories integer DEFAULT 0 NOT NULL,
    memos integer DEFAULT 0 NOT NULL,
    docs integer DEFAULT 0 NOT NULL,
    api_calls integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: organizations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organizations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    plan text DEFAULT 'free'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: participation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.participation (
    id uuid NOT NULL,
    org_id uuid NOT NULL,
    story_id uuid NOT NULL,
    member_id uuid NOT NULL,
    role_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: participation_role; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.participation_role (
    id uuid NOT NULL,
    org_id uuid NOT NULL,
    key character varying(50) NOT NULL,
    label text NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: permission_audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.permission_audit_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    action text NOT NULL,
    target_user_id uuid,
    old_role text,
    new_role text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT permission_audit_logs_action_check CHECK ((action = ANY (ARRAY['member_added'::text, 'member_removed'::text, 'role_changed'::text])))
);


--
-- Name: plan_features; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plan_features (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tier_id uuid NOT NULL,
    feature_key text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    limit_value integer
);


--
-- Name: plan_offerings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plan_offerings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tier_id uuid NOT NULL,
    label text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL
);


--
-- Name: plan_tiers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plan_tiers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    display_name text NOT NULL,
    price_monthly numeric(10,2) DEFAULT 0 NOT NULL,
    price_yearly numeric(10,2),
    max_members integer,
    max_projects integer,
    max_storage_gb integer,
    is_active boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    paddle_price_id text,
    toss_product_id text
);


--
-- Name: polar_webhook_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.polar_webhook_events (
    event_id text NOT NULL,
    event_type text NOT NULL,
    processed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: policy_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.policy_documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    project_id uuid NOT NULL,
    sprint_id uuid NOT NULL,
    epic_id uuid NOT NULL,
    title text NOT NULL,
    content text DEFAULT ''::text NOT NULL,
    legacy_sprint_key text,
    legacy_epic_key text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: project_access; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_access (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    org_member_id uuid,
    permission text DEFAULT 'granted'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    member_id uuid,
    role text DEFAULT 'member'::text NOT NULL,
    color text DEFAULT '#3385f8'::text NOT NULL,
    can_manage_members boolean DEFAULT false NOT NULL,
    access_source text DEFAULT 'direct'::text NOT NULL,
    inherited_from_member_id uuid
);


--
-- Name: project_ai_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_ai_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    project_id uuid NOT NULL,
    provider text DEFAULT 'openai'::text NOT NULL,
    api_key text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    llm_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT project_ai_settings_llm_config_is_object CHECK ((jsonb_typeof(llm_config) = 'object'::text)),
    CONSTRAINT project_ai_settings_provider_check CHECK ((provider = ANY (ARRAY['openai'::text, 'anthropic'::text, 'google'::text, 'groq'::text, 'openai-compatible'::text])))
);


--
-- Name: project_api_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_api_keys (
    id uuid NOT NULL,
    project_id uuid NOT NULL,
    created_by uuid,
    name text NOT NULL,
    key_prefix text NOT NULL,
    key_hash text NOT NULL,
    scope text[],
    plan_feature_ids uuid[],
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: project_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_settings (
    project_id uuid NOT NULL,
    standup_deadline time without time zone DEFAULT '09:00:00'::time without time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: projects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.projects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    violation_level character varying(10) DEFAULT 'warn'::character varying NOT NULL
);


--
-- Name: refresh_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.refresh_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    token_hash text NOT NULL,
    org_id uuid,
    project_id uuid,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: retro_actions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.retro_actions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid NOT NULL,
    title text NOT NULL,
    assignee_id uuid,
    status text DEFAULT 'open'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT retro_actions_status_check CHECK ((status = ANY (ARRAY['open'::text, 'done'::text])))
);


--
-- Name: retro_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.retro_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid NOT NULL,
    category text NOT NULL,
    text text NOT NULL,
    author_id uuid,
    vote_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT retro_items_category_check CHECK ((category = ANY (ARRAY['good'::text, 'bad'::text, 'improve'::text])))
);


--
-- Name: retro_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.retro_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    project_id uuid NOT NULL,
    sprint_id uuid,
    title text NOT NULL,
    phase text DEFAULT 'collect'::text NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT retro_sessions_phase_check CHECK ((phase = ANY (ARRAY['collect'::text, 'group'::text, 'vote'::text, 'discuss'::text, 'action'::text, 'closed'::text])))
);


--
-- Name: retro_votes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.retro_votes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    item_id uuid NOT NULL,
    voter_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: reward_ledger; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reward_ledger (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    project_id uuid NOT NULL,
    member_id uuid NOT NULL,
    amount numeric(12,2) NOT NULL,
    currency text DEFAULT 'TJSB'::text NOT NULL,
    reason text NOT NULL,
    reference_type text,
    reference_id uuid,
    granted_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_reward_amount_nonzero CHECK ((amount <> (0)::numeric)),
    CONSTRAINT chk_reward_currency CHECK ((currency = 'TJSB'::text)),
    CONSTRAINT chk_reward_reference_type CHECK (((reference_type IS NULL) OR (reference_type = ANY (ARRAY['story'::text, 'sprint'::text, 'epic'::text, 'manual'::text]))))
);


--
-- Name: sprints; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sprints (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    project_id uuid NOT NULL,
    title text NOT NULL,
    status text DEFAULT 'planning'::text NOT NULL,
    start_date date,
    end_date date,
    velocity integer,
    team_size integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    duration integer DEFAULT 14 NOT NULL,
    report_doc_id uuid,
    success_hypothesis text,
    metric_definition jsonb,
    measure_after timestamp with time zone,
    outcome_status character varying(20) DEFAULT 'n_a'::character varying NOT NULL,
    outcome_result jsonb,
    goal text,
    capacity integer,
    CONSTRAINT sprints_date_check CHECK ((start_date < end_date)),
    CONSTRAINT sprints_status_check CHECK ((status = ANY (ARRAY['planning'::text, 'active'::text, 'closed'::text])))
);


--
-- Name: standup_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.standup_entries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    project_id uuid NOT NULL,
    sprint_id uuid,
    author_id uuid NOT NULL,
    date date NOT NULL,
    done text,
    plan text,
    blockers text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    plan_story_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL
);


--
-- Name: standup_feedback; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.standup_feedback (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    project_id uuid NOT NULL,
    sprint_id uuid,
    standup_entry_id uuid NOT NULL,
    feedback_by_id uuid NOT NULL,
    review_type text DEFAULT 'comment'::text NOT NULL,
    feedback_text text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT standup_feedback_review_type_check CHECK ((review_type = ANY (ARRAY['comment'::text, 'approve'::text, 'request_changes'::text])))
);


--
-- Name: stories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    project_id uuid NOT NULL,
    epic_id uuid,
    sprint_id uuid,
    assignee_id uuid,
    title text NOT NULL,
    status text DEFAULT 'backlog'::text NOT NULL,
    priority text DEFAULT 'medium'::text NOT NULL,
    story_points integer,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    meeting_id uuid,
    acceptance_criteria text,
    "position" bigint,
    success_hypothesis text,
    metric_definition jsonb,
    measure_after timestamp with time zone,
    outcome_status character varying(20) DEFAULT 'n_a'::character varying NOT NULL,
    outcome_result jsonb,
    is_excluded boolean DEFAULT false NOT NULL,
    attachments jsonb DEFAULT '[]'::jsonb,
    CONSTRAINT stories_priority_check CHECK ((priority = ANY (ARRAY['critical'::text, 'high'::text, 'medium'::text, 'low'::text]))),
    CONSTRAINT stories_sp_check CHECK (((story_points IS NULL) OR (story_points = ANY (ARRAY[1, 2, 3, 5, 8, 13, 21])))),
    CONSTRAINT stories_status_check CHECK ((status = ANY (ARRAY['backlog'::text, 'ready-for-dev'::text, 'in-progress'::text, 'in-review'::text, 'done'::text])))
);


--
-- Name: story_activities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.story_activities (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    story_id uuid NOT NULL,
    org_id uuid NOT NULL,
    project_id uuid NOT NULL,
    activity_type text NOT NULL,
    old_value text,
    new_value text,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: story_assignees; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.story_assignees (
    id uuid NOT NULL,
    org_id uuid NOT NULL,
    story_id uuid NOT NULL,
    member_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: story_comments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.story_comments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    story_id uuid NOT NULL,
    org_id uuid NOT NULL,
    project_id uuid NOT NULL,
    content text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: story_docs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.story_docs (
    story_id uuid NOT NULL,
    doc_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: subscription_checkout_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscription_checkout_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    requested_tier_id uuid NOT NULL,
    provider text NOT NULL,
    price_id text,
    provider_transaction_id text NOT NULL,
    provider_subscription_id text,
    status text DEFAULT 'pending'::text NOT NULL,
    checkout_url text,
    last_webhook_event_id text,
    last_webhook_event_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT subscription_checkout_sessions_provider_check CHECK ((provider = ANY (ARRAY['paddle'::text, 'toss'::text]))),
    CONSTRAINT subscription_checkout_sessions_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'completed'::text, 'failed'::text, 'canceled'::text])))
);


--
-- Name: subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    tier_id uuid NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    current_period_start timestamp with time zone,
    current_period_end timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    offering_snapshot_id uuid,
    payment_provider text,
    provider_subscription_id text,
    canceled_at timestamp with time zone,
    grace_period_end timestamp with time zone,
    last_webhook_event_id text,
    last_webhook_event_at timestamp with time zone,
    CONSTRAINT subscriptions_payment_provider_check CHECK ((payment_provider = ANY (ARRAY['paddle'::text, 'toss'::text]))),
    CONSTRAINT subscriptions_status_check CHECK ((status = ANY (ARRAY['active'::text, 'canceled'::text, 'past_due'::text, 'trialing'::text])))
);


--
-- Name: tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tasks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    story_id uuid NOT NULL,
    assignee_id uuid,
    title text NOT NULL,
    status text DEFAULT 'todo'::text NOT NULL,
    story_points integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT tasks_status_check CHECK ((status = ANY (ARRAY['todo'::text, 'in-progress'::text, 'done'::text])))
);


--
-- Name: team_members; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.team_members AS
 SELECT m.id,
    pa.project_id,
    m.org_id,
    m.user_id,
    m.type,
    m.name,
    pa.role,
    m.avatar_url,
    NULL::jsonb AS agent_config,
    NULL::text AS webhook_url,
    m.is_active,
    pa.color,
    NULL::text AS agent_role,
    NULL::integer AS fakechat_port,
    owner.user_id AS created_by,
    NULL::timestamp with time zone AS last_seen_at,
    NULL::uuid AS active_story_id,
    NULL::text AS agent_status,
    pa.can_manage_members,
    m.message_policy_mode,
    m.created_at,
    m.updated_at
   FROM ((public.members m
     JOIN public.project_access pa ON ((pa.member_id = m.id)))
     LEFT JOIN public.members owner ON ((owner.id = m.owner_member_id)))
  WHERE ((m.type = 'human'::text) AND (m.deleted_at IS NULL))
UNION ALL
 SELECT m.id,
    app.project_id,
    m.org_id,
    m.user_id,
    m.type,
    m.name,
    COALESCE(pa.role, 'member'::text) AS role,
    m.avatar_url,
    app.agent_config,
    app.webhook_url,
    m.is_active,
    COALESCE(pa.color, '#3385f8'::text) AS color,
    app.agent_role,
    app.fakechat_port,
    owner.user_id AS created_by,
    app.last_seen_at,
    app.active_story_id,
    app.agent_status,
    COALESCE(pa.can_manage_members, false) AS can_manage_members,
    m.message_policy_mode,
    m.created_at,
    m.updated_at
   FROM (((public.members m
     JOIN public.agent_project_profiles app ON ((app.member_id = m.id)))
     LEFT JOIN public.project_access pa ON (((pa.member_id = m.id) AND (pa.project_id = app.project_id))))
     LEFT JOIN public.members owner ON ((owner.id = m.owner_member_id)))
  WHERE ((m.type = 'agent'::text) AND (m.deleted_at IS NULL));


--
-- Name: team_members_legacy; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_members_legacy (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    org_id uuid NOT NULL,
    type text NOT NULL,
    user_id uuid,
    name text NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    avatar_url text,
    agent_config jsonb,
    webhook_url text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    color text DEFAULT '#3385f8'::text NOT NULL,
    agent_role text,
    created_by uuid,
    fakechat_port integer,
    last_seen_at timestamp with time zone,
    active_story_id uuid,
    agent_status character varying(20),
    can_manage_members boolean DEFAULT false NOT NULL,
    CONSTRAINT chk_agent_has_config CHECK (((type <> 'agent'::text) OR (agent_config IS NOT NULL))),
    CONSTRAINT chk_human_has_user_id CHECK (((type <> 'human'::text) OR (user_id IS NOT NULL))),
    CONSTRAINT team_members_agent_role_only_for_agents CHECK ((((type = 'agent'::text) AND ((agent_role IS NULL) OR (agent_role = ANY (ARRAY['backend'::text, 'frontend'::text, 'qa'::text, 'design'::text, 'pm'::text, 'api'::text])))) OR ((type <> 'agent'::text) AND (agent_role IS NULL)))),
    CONSTRAINT team_members_color_hex_check CHECK ((color ~ '^#[0-9a-fA-F]{6}$'::text)),
    CONSTRAINT team_members_type_check CHECK ((type = ANY (ARRAY['human'::text, 'agent'::text])))
);


--
-- Name: usage_meters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.usage_meters (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    meter_type text NOT NULL,
    current_value integer DEFAULT 0 NOT NULL,
    limit_value integer,
    period_start timestamp with time zone NOT NULL,
    period_end timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT usage_meters_meter_type_check CHECK ((meter_type = ANY (ARRAY['ai_calls'::text, 'storage_mb'::text, 'members'::text, 'agents'::text, 'stt_minutes'::text])))
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    hashed_password text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    totp_secret text,
    totp_enabled boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    google_id text,
    github_id text,
    totp_last_timestep integer,
    totp_fail_count integer DEFAULT 0 NOT NULL,
    totp_locked_until timestamp with time zone,
    email_verified boolean NOT NULL,
    login_fail_count integer DEFAULT 0 NOT NULL,
    login_locked_until timestamp with time zone,
    tos_accepted_at timestamp with time zone,
    last_project_id uuid,
    display_name text
);


--
-- Name: verdict; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.verdict (
    id uuid NOT NULL,
    org_id uuid NOT NULL,
    participation_id uuid NOT NULL,
    source character varying(50) NOT NULL,
    result character varying(20),
    rounds integer,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: webhook_configs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.webhook_configs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    member_id uuid NOT NULL,
    url text NOT NULL,
    secret text,
    events text[] DEFAULT '{}'::text[] NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    project_id uuid,
    channel text DEFAULT 'generic'::text NOT NULL,
    CONSTRAINT webhook_configs_channel_check CHECK ((channel = ANY (ARRAY['discord'::text, 'slack'::text, 'google'::text, 'generic'::text])))
);


--
-- Name: webhook_deliveries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.webhook_deliveries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    webhook_config_id uuid,
    event_type text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    delivered_at timestamp with time zone,
    CONSTRAINT webhook_deliveries_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'success'::text, 'failed'::text])))
);


--
-- Name: workflow_change_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_change_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    project_id uuid NOT NULL,
    workflow_version_id uuid,
    notified_agent_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    memo_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workflow_contracts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_contracts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    name text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    mode text DEFAULT 'evaluate'::text NOT NULL,
    definition jsonb DEFAULT '{}'::jsonb NOT NULL,
    entity_type text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    project_id uuid,
    parent_contract_id uuid,
    CONSTRAINT workflow_contracts_mode_check CHECK ((mode = ANY (ARRAY['evaluate'::text, 'enforce'::text])))
);


--
-- Name: workflow_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    instance_id uuid NOT NULL,
    event_type text NOT NULL,
    from_state text,
    to_state text,
    actor_id uuid,
    tool_name text,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workflow_execution_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_execution_logs (
    id uuid NOT NULL,
    org_id uuid NOT NULL,
    project_id uuid NOT NULL,
    rule_id uuid,
    event_type text NOT NULL,
    trigger_type_slug text,
    event_context jsonb DEFAULT '{}'::jsonb NOT NULL,
    action jsonb,
    target_agent_id uuid,
    status text DEFAULT 'matched'::text NOT NULL,
    error_message text,
    duration_ms integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone
);


--
-- Name: workflow_executions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_executions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    rule_id uuid NOT NULL,
    event_id text NOT NULL,
    event_type text NOT NULL,
    event_payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    actions_executed jsonb DEFAULT '[]'::jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    retry_count integer DEFAULT 0 NOT NULL,
    delivery_method text DEFAULT 'push'::text NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    next_retry_at timestamp with time zone,
    CONSTRAINT workflow_executions_delivery_method_check CHECK ((delivery_method = ANY (ARRAY['push'::text, 'poll_fallback'::text]))),
    CONSTRAINT workflow_executions_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'success'::text, 'failed'::text, 'skipped'::text])))
);


--
-- Name: workflow_instances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_instances (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    contract_id uuid NOT NULL,
    entity_id uuid NOT NULL,
    current_state text NOT NULL,
    context jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    parent_instance_id uuid,
    hitl_pending_to_state text,
    CONSTRAINT workflow_instances_status_check CHECK ((status = ANY (ARRAY['active'::text, 'completed'::text, 'cancelled'::text])))
);


--
-- Name: workflow_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    project_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    event_type text NOT NULL,
    conditions jsonb DEFAULT '{}'::jsonb NOT NULL,
    actions jsonb DEFAULT '[]'::jsonb NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    template_id uuid,
    priority integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workflow_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_templates (
    id uuid NOT NULL,
    slug character varying(100) NOT NULL,
    name character varying(200) NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    chain_length integer NOT NULL,
    steps jsonb DEFAULT '[]'::jsonb NOT NULL,
    presets jsonb DEFAULT '{}'::jsonb NOT NULL,
    rules_template jsonb DEFAULT '[]'::jsonb NOT NULL,
    is_system boolean DEFAULT true NOT NULL,
    is_enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workflow_timers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_timers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    execution_id uuid,
    story_id uuid,
    event_type text DEFAULT 'timer.expired'::text NOT NULL,
    fires_at timestamp with time zone NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workflow_timers_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'fired'::text, 'cancelled'::text])))
);


--
-- Name: workflow_trigger_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_trigger_types (
    id uuid NOT NULL,
    org_id uuid NOT NULL,
    slug text NOT NULL,
    label text NOT NULL,
    description text,
    is_system boolean DEFAULT false NOT NULL,
    is_enabled boolean DEFAULT true NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workflow_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    project_id uuid NOT NULL,
    version integer NOT NULL,
    snapshot jsonb DEFAULT '[]'::jsonb NOT NULL,
    change_summary jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: activity_logs activity_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activity_logs
    ADD CONSTRAINT activity_logs_pkey PRIMARY KEY (id);


--
-- Name: agent_event_cursors agent_event_cursors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_event_cursors
    ADD CONSTRAINT agent_event_cursors_pkey PRIMARY KEY (agent_id);


--
-- Name: agent_event_seqs agent_event_seqs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_event_seqs
    ADD CONSTRAINT agent_event_seqs_pkey PRIMARY KEY (recipient_id);


--
-- Name: agent_gateway_sessions agent_gateway_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_gateway_sessions
    ADD CONSTRAINT agent_gateway_sessions_pkey PRIMARY KEY (id);


--
-- Name: agent_message_allowlist agent_message_allowlist_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_message_allowlist
    ADD CONSTRAINT agent_message_allowlist_pkey PRIMARY KEY (id);


--
-- Name: agent_project_profiles agent_project_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_project_profiles
    ADD CONSTRAINT agent_project_profiles_pkey PRIMARY KEY (id);


--
-- Name: conversation_messages conversation_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_messages
    ADD CONSTRAINT conversation_messages_pkey PRIMARY KEY (id);


--
-- Name: conversation_participants conversation_participants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_participants
    ADD CONSTRAINT conversation_participants_pkey PRIMARY KEY (id);


--
-- Name: conversation_webhook_deliveries conversation_webhook_deliveries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_webhook_deliveries
    ADD CONSTRAINT conversation_webhook_deliveries_pkey PRIMARY KEY (id);


--
-- Name: conversations conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_pkey PRIMARY KEY (id);


--
-- Name: events events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_pkey PRIMARY KEY (id);


--
-- Name: file_locks file_locks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_locks
    ADD CONSTRAINT file_locks_pkey PRIMARY KEY (id);


--
-- Name: gate gate_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gate
    ADD CONSTRAINT gate_pkey PRIMARY KEY (id);


--
-- Name: item_dependency item_dependency_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dependency
    ADD CONSTRAINT item_dependency_pkey PRIMARY KEY (id);


--
-- Name: item_label item_label_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_label
    ADD CONSTRAINT item_label_pkey PRIMARY KEY (id);


--
-- Name: label label_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.label
    ADD CONSTRAINT label_pkey PRIMARY KEY (id);


--
-- Name: login_audit_logs login_audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.login_audit_logs
    ADD CONSTRAINT login_audit_logs_pkey PRIMARY KEY (id);


--
-- Name: member_gate_override member_gate_override_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member_gate_override
    ADD CONSTRAINT member_gate_override_pkey PRIMARY KEY (id);


--
-- Name: member_identity_aliases member_identity_aliases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member_identity_aliases
    ADD CONSTRAINT member_identity_aliases_pkey PRIMARY KEY (alias_id);


--
-- Name: members members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.members
    ADD CONSTRAINT members_pkey PRIMARY KEY (id);


--
-- Name: memo_entity_links memo_entity_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memo_entity_links
    ADD CONSTRAINT memo_entity_links_pkey PRIMARY KEY (id);


--
-- Name: memos memos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memos
    ADD CONSTRAINT memos_pkey PRIMARY KEY (id);


--
-- Name: notification_preferences notification_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_preferences
    ADD CONSTRAINT notification_preferences_pkey PRIMARY KEY (id);


--
-- Name: org_gate_override org_gate_override_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_gate_override
    ADD CONSTRAINT org_gate_override_pkey PRIMARY KEY (id);


--
-- Name: org_gate_policy org_gate_policy_org_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_gate_policy
    ADD CONSTRAINT org_gate_policy_org_id_key UNIQUE (org_id);


--
-- Name: org_gate_policy org_gate_policy_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_gate_policy
    ADD CONSTRAINT org_gate_policy_pkey PRIMARY KEY (id);


--
-- Name: org_invites org_invites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_invites
    ADD CONSTRAINT org_invites_pkey PRIMARY KEY (id);


--
-- Name: org_invites org_invites_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_invites
    ADD CONSTRAINT org_invites_token_key UNIQUE (token);


--
-- Name: org_members org_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_members
    ADD CONSTRAINT org_members_pkey PRIMARY KEY (id);


--
-- Name: organizations organizations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_pkey PRIMARY KEY (id);


--
-- Name: participation participation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.participation
    ADD CONSTRAINT participation_pkey PRIMARY KEY (id);


--
-- Name: participation_role participation_role_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.participation_role
    ADD CONSTRAINT participation_role_pkey PRIMARY KEY (id);


--
-- Name: polar_webhook_events polar_webhook_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.polar_webhook_events
    ADD CONSTRAINT polar_webhook_events_pkey PRIMARY KEY (event_id);


--
-- Name: project_access project_access_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_access
    ADD CONSTRAINT project_access_pkey PRIMARY KEY (id);


--
-- Name: project_api_keys project_api_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_api_keys
    ADD CONSTRAINT project_api_keys_pkey PRIMARY KEY (id);


--
-- Name: projects projects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (id);


--
-- Name: refresh_tokens refresh_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_pkey PRIMARY KEY (id);


--
-- Name: stories stories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stories
    ADD CONSTRAINT stories_pkey PRIMARY KEY (id);


--
-- Name: story_assignees story_assignees_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.story_assignees
    ADD CONSTRAINT story_assignees_pkey PRIMARY KEY (id);


--
-- Name: team_members_legacy team_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_members_legacy
    ADD CONSTRAINT team_members_pkey PRIMARY KEY (id);


--
-- Name: agent_message_allowlist uq_agent_message_allowlist_pair; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_message_allowlist
    ADD CONSTRAINT uq_agent_message_allowlist_pair UNIQUE (agent_member_id, allowed_id);


--
-- Name: agent_project_profiles uq_agent_project_profiles_proj_member; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_project_profiles
    ADD CONSTRAINT uq_agent_project_profiles_proj_member UNIQUE (project_id, member_id);


--
-- Name: conversation_participants uq_conversation_participant; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_participants
    ADD CONSTRAINT uq_conversation_participant UNIQUE (conversation_id, member_id);


--
-- Name: gate uq_gate_work_item_gate_type; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gate
    ADD CONSTRAINT uq_gate_work_item_gate_type UNIQUE (org_id, work_item_id, work_item_type, gate_type);


--
-- Name: item_dependency uq_item_dependency_edge; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_dependency
    ADD CONSTRAINT uq_item_dependency_edge UNIQUE (org_id, from_id, to_id, item_type);


--
-- Name: item_label uq_item_label_edge; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_label
    ADD CONSTRAINT uq_item_label_edge UNIQUE (org_id, label_id, item_id, item_type);


--
-- Name: label uq_label_org_name; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.label
    ADD CONSTRAINT uq_label_org_name UNIQUE (org_id, name);


--
-- Name: member_gate_override uq_member_gate_override; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member_gate_override
    ADD CONSTRAINT uq_member_gate_override UNIQUE (org_id, member_id, gate_type);


--
-- Name: memo_entity_links uq_memo_entity_links; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memo_entity_links
    ADD CONSTRAINT uq_memo_entity_links UNIQUE (memo_id, entity_type, entity_id);


--
-- Name: org_gate_override uq_org_gate_override; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_gate_override
    ADD CONSTRAINT uq_org_gate_override UNIQUE (org_id, role_id, gate_type);


--
-- Name: org_members uq_org_members_org_user; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_members
    ADD CONSTRAINT uq_org_members_org_user UNIQUE (org_id, user_id);


--
-- Name: participation_role uq_participation_role_org_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.participation_role
    ADD CONSTRAINT uq_participation_role_org_key UNIQUE (org_id, key);


--
-- Name: participation uq_participation_story_member_role; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.participation
    ADD CONSTRAINT uq_participation_story_member_role UNIQUE (story_id, member_id, role_id);


--
-- Name: project_access uq_project_access_project_member; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_access
    ADD CONSTRAINT uq_project_access_project_member UNIQUE (project_id, org_member_id);


--
-- Name: story_assignees uq_story_assignees_story_member; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.story_assignees
    ADD CONSTRAINT uq_story_assignees_story_member UNIQUE (story_id, member_id);


--
-- Name: verdict uq_verdict_participation_source; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verdict
    ADD CONSTRAINT uq_verdict_participation_source UNIQUE (participation_id, source);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: verdict verdict_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verdict
    ADD CONSTRAINT verdict_pkey PRIMARY KEY (id);


--
-- Name: workflow_execution_logs workflow_execution_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_execution_logs
    ADD CONSTRAINT workflow_execution_logs_pkey PRIMARY KEY (id);


--
-- Name: workflow_templates workflow_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_templates
    ADD CONSTRAINT workflow_templates_pkey PRIMARY KEY (id);


--
-- Name: workflow_trigger_types workflow_trigger_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_trigger_types
    ADD CONSTRAINT workflow_trigger_types_pkey PRIMARY KEY (id);


--
-- Name: analytics_events_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX analytics_events_created_at_idx ON public.analytics_events USING btree (created_at DESC);


--
-- Name: analytics_events_org_event_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX analytics_events_org_event_name_idx ON public.analytics_events USING btree (org_id, event_name);


--
-- Name: analytics_events_project_step_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX analytics_events_project_step_idx ON public.analytics_events USING btree (project_id, step);


--
-- Name: docs_project_slug_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX docs_project_slug_active ON public.docs USING btree (project_id, slug) WHERE (deleted_at IS NULL);


--
-- Name: idx_agent_api_keys_key_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_api_keys_key_hash ON public.agent_api_keys USING btree (key_hash) WHERE (revoked_at IS NULL);


--
-- Name: idx_agent_api_keys_team_member_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_api_keys_team_member_id ON public.agent_api_keys USING btree (team_member_id);


--
-- Name: idx_agent_audit_logs_event_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_audit_logs_event_type ON public.agent_audit_logs USING btree (event_type, created_at DESC);


--
-- Name: idx_agent_audit_logs_org_project_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_audit_logs_org_project_created ON public.agent_audit_logs USING btree (org_id, project_id, created_at DESC);


--
-- Name: idx_agent_audit_logs_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_audit_logs_run ON public.agent_audit_logs USING btree (run_id, created_at DESC) WHERE (run_id IS NOT NULL);


--
-- Name: idx_agent_audit_logs_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_audit_logs_session ON public.agent_audit_logs USING btree (session_id, created_at DESC) WHERE (session_id IS NOT NULL);


--
-- Name: idx_agent_deployments_agent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_deployments_agent ON public.agent_deployments USING btree (agent_id, created_at DESC);


--
-- Name: idx_agent_deployments_org_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_deployments_org_project ON public.agent_deployments USING btree (org_id, project_id, created_at DESC);


--
-- Name: idx_agent_deployments_persona; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_deployments_persona ON public.agent_deployments USING btree (persona_id, created_at DESC) WHERE (persona_id IS NOT NULL);


--
-- Name: idx_agent_deployments_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_deployments_status ON public.agent_deployments USING btree (status, created_at DESC);


--
-- Name: idx_agent_endpoints_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_endpoints_org_id ON public.agent_endpoints USING btree (org_id);


--
-- Name: idx_agent_endpoints_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_endpoints_status ON public.agent_endpoints USING btree (status);


--
-- Name: idx_agent_endpoints_team_member_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_endpoints_team_member_id ON public.agent_endpoints USING btree (team_member_id);


--
-- Name: idx_agent_hitl_policies_org_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_hitl_policies_org_project ON public.agent_hitl_policies USING btree (org_id, project_id);


--
-- Name: idx_agent_hitl_requests_pending_reminder; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_hitl_requests_pending_reminder ON public.agent_hitl_requests USING btree (status, reminder_sent_at, expires_at) WHERE (deleted_at IS NULL);


--
-- Name: idx_agent_hitl_requests_pending_timeout; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_hitl_requests_pending_timeout ON public.agent_hitl_requests USING btree (status, expired_at, expires_at) WHERE (deleted_at IS NULL);


--
-- Name: idx_agent_hitl_requests_pending_timeout_v2; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_hitl_requests_pending_timeout_v2 ON public.agent_hitl_requests USING btree (expires_at) WHERE ((status = 'pending'::text) AND (expired_at IS NULL) AND (expires_at IS NOT NULL));


--
-- Name: idx_agent_hitl_requests_requested_for; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_hitl_requests_requested_for ON public.agent_hitl_requests USING btree (requested_for, status, created_at DESC);


--
-- Name: idx_agent_hitl_requests_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_hitl_requests_run ON public.agent_hitl_requests USING btree (run_id) WHERE (run_id IS NOT NULL);


--
-- Name: idx_agent_hitl_requests_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_hitl_requests_session ON public.agent_hitl_requests USING btree (session_id, created_at DESC) WHERE (session_id IS NOT NULL);


--
-- Name: idx_agent_hitl_requests_status_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_hitl_requests_status_expires ON public.agent_hitl_requests USING btree (org_id, status, expires_at);


--
-- Name: idx_agent_long_term_memories_agent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_long_term_memories_agent ON public.agent_long_term_memories USING btree (agent_id, created_at DESC);


--
-- Name: idx_agent_long_term_memories_embedding; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_long_term_memories_embedding ON public.agent_long_term_memories USING ivfflat (embedding public.vector_cosine_ops) WITH (lists='100');


--
-- Name: idx_agent_long_term_memories_org_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_long_term_memories_org_project ON public.agent_long_term_memories USING btree (org_id, project_id, created_at DESC);


--
-- Name: idx_agent_long_term_memories_source_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_long_term_memories_source_run ON public.agent_long_term_memories USING btree (source_run_id) WHERE (source_run_id IS NOT NULL);


--
-- Name: idx_agent_long_term_memories_source_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_long_term_memories_source_session ON public.agent_long_term_memories USING btree (source_session_id) WHERE (source_session_id IS NOT NULL);


--
-- Name: idx_agent_long_term_memories_type_importance; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_long_term_memories_type_importance ON public.agent_long_term_memories USING btree (agent_id, memory_type, importance DESC, created_at DESC);


--
-- Name: idx_agent_personas_agent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_personas_agent ON public.agent_personas USING btree (agent_id, created_at DESC);


--
-- Name: idx_agent_personas_builtin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_personas_builtin ON public.agent_personas USING btree (project_id, agent_id, is_builtin) WHERE ((is_builtin = true) AND (deleted_at IS NULL));


--
-- Name: idx_agent_personas_org_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_personas_org_project ON public.agent_personas USING btree (org_id, project_id, created_at DESC);


--
-- Name: idx_agent_routing_rules_agent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_routing_rules_agent ON public.agent_routing_rules USING btree (agent_id, created_at DESC);


--
-- Name: idx_agent_routing_rules_deployment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_routing_rules_deployment ON public.agent_routing_rules USING btree (deployment_id, created_at DESC) WHERE (deployment_id IS NOT NULL);


--
-- Name: idx_agent_routing_rules_priority; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_routing_rules_priority ON public.agent_routing_rules USING btree (org_id, project_id, is_enabled, priority, created_at DESC);


--
-- Name: idx_agent_runs_agent_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_runs_agent_id ON public.agent_runs USING btree (agent_id);


--
-- Name: idx_agent_runs_deployment_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_runs_deployment_created ON public.agent_runs USING btree (deployment_id, created_at DESC) WHERE (deployment_id IS NOT NULL);


--
-- Name: idx_agent_runs_deployment_status_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_runs_deployment_status_created ON public.agent_runs USING btree (deployment_id, status, created_at DESC) WHERE (deployment_id IS NOT NULL);


--
-- Name: idx_agent_runs_dispatch_key_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_agent_runs_dispatch_key_unique ON public.agent_runs USING btree (dispatch_key) WHERE (dispatch_key IS NOT NULL);


--
-- Name: idx_agent_runs_failure_disposition; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_runs_failure_disposition ON public.agent_runs USING btree (org_id, failure_disposition, created_at DESC) WHERE (status = 'failed'::text);


--
-- Name: idx_agent_runs_memo_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_runs_memo_id ON public.agent_runs USING btree (memo_id) WHERE (memo_id IS NOT NULL);


--
-- Name: idx_agent_runs_next_retry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_runs_next_retry ON public.agent_runs USING btree (next_retry_at) WHERE ((status = 'failed'::text) AND (next_retry_at IS NOT NULL) AND (retry_count < max_retries));


--
-- Name: idx_agent_runs_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_runs_org_id ON public.agent_runs USING btree (org_id);


--
-- Name: idx_agent_runs_org_status_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_runs_org_status_created ON public.agent_runs USING btree (org_id, status, created_at DESC);


--
-- Name: idx_agent_runs_output_memo_ids_gin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_runs_output_memo_ids_gin ON public.agent_runs USING gin (output_memo_ids);


--
-- Name: idx_agent_runs_project_agent_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_runs_project_agent_created ON public.agent_runs USING btree (project_id, agent_id, created_at DESC);


--
-- Name: idx_agent_runs_session_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_runs_session_created ON public.agent_runs USING btree (session_id, created_at DESC) WHERE (session_id IS NOT NULL);


--
-- Name: idx_agent_runs_session_status_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_runs_session_status_created ON public.agent_runs USING btree (session_id, status, created_at DESC) WHERE (session_id IS NOT NULL);


--
-- Name: idx_agent_runs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_runs_status ON public.agent_runs USING btree (status);


--
-- Name: idx_agent_runs_story_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_runs_story_id ON public.agent_runs USING btree (story_id) WHERE (story_id IS NOT NULL);


--
-- Name: idx_agent_runs_trigger_memo_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_runs_trigger_memo_created ON public.agent_runs USING btree (trigger, memo_id, created_at DESC) WHERE (memo_id IS NOT NULL);


--
-- Name: idx_agent_session_memories_agent_type_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_session_memories_agent_type_created ON public.agent_session_memories USING btree (agent_id, memory_type, created_at DESC);


--
-- Name: idx_agent_session_memories_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_session_memories_run ON public.agent_session_memories USING btree (run_id) WHERE (run_id IS NOT NULL);


--
-- Name: idx_agent_session_memories_session_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_session_memories_session_created ON public.agent_session_memories USING btree (session_id, created_at DESC);


--
-- Name: idx_agent_sessions_agent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_sessions_agent ON public.agent_sessions USING btree (agent_id, created_at DESC);


--
-- Name: idx_agent_sessions_agent_status_activity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_sessions_agent_status_activity ON public.agent_sessions USING btree (agent_id, status, last_activity_at DESC) WHERE (deleted_at IS NULL);


--
-- Name: idx_agent_sessions_deployment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_sessions_deployment ON public.agent_sessions USING btree (deployment_id, created_at DESC) WHERE (deployment_id IS NOT NULL);


--
-- Name: idx_agent_sessions_org_project_status_activity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_sessions_org_project_status_activity ON public.agent_sessions USING btree (org_id, project_id, status, last_activity_at DESC) WHERE (deleted_at IS NULL);


--
-- Name: idx_api_key_logs_key_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_api_key_logs_key_id ON public.api_key_logs USING btree (api_key_id, created_at DESC);


--
-- Name: idx_api_key_logs_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_api_key_logs_org_id ON public.api_key_logs USING btree (org_id, created_at DESC);


--
-- Name: idx_approved_mcp_servers_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_approved_mcp_servers_active ON public.approved_mcp_servers USING btree (is_active, provider);


--
-- Name: idx_billing_limit_alerts_org_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_billing_limit_alerts_org_created ON public.billing_limit_alerts USING btree (org_id, created_at DESC);


--
-- Name: idx_bridge_channels_org_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bridge_channels_org_project ON public.messaging_bridge_channels USING btree (org_id, project_id);


--
-- Name: idx_bridge_channels_platform; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bridge_channels_platform ON public.messaging_bridge_channels USING btree (platform, is_active) WHERE (is_active = true);


--
-- Name: idx_bridge_org_auths_org_platform; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bridge_org_auths_org_platform ON public.messaging_bridge_org_auths USING btree (org_id, platform);


--
-- Name: idx_bridge_reply_dispatches_memo_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bridge_reply_dispatches_memo_id ON public.messaging_bridge_reply_dispatches USING btree (memo_id);


--
-- Name: idx_bridge_reply_dispatches_status_claimed_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bridge_reply_dispatches_status_claimed_at ON public.messaging_bridge_reply_dispatches USING btree (platform, status, claimed_at);


--
-- Name: idx_bridge_users_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bridge_users_org ON public.messaging_bridge_users USING btree (org_id);


--
-- Name: idx_bridge_users_platform_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bridge_users_platform_lookup ON public.messaging_bridge_users USING btree (platform, platform_user_id) WHERE (is_active = true);


--
-- Name: idx_bridge_users_team_member; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bridge_users_team_member ON public.messaging_bridge_users USING btree (team_member_id);


--
-- Name: idx_doc_comments_doc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_doc_comments_doc ON public.doc_comments USING btree (doc_id);


--
-- Name: idx_doc_revisions_doc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_doc_revisions_doc ON public.doc_revisions USING btree (doc_id);


--
-- Name: idx_docs_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_docs_parent ON public.docs USING btree (parent_id);


--
-- Name: idx_docs_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_docs_project ON public.docs USING btree (project_id);


--
-- Name: idx_docs_search_vector; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_docs_search_vector ON public.docs USING gin (search_vector);


--
-- Name: idx_docs_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_docs_slug ON public.docs USING btree (project_id, slug);


--
-- Name: idx_docs_tags_gin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_docs_tags_gin ON public.docs USING gin (tags);


--
-- Name: idx_epic_docs_doc_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_epic_docs_doc_id ON public.epic_docs USING btree (doc_id);


--
-- Name: idx_epic_docs_epic_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_epic_docs_epic_id ON public.epic_docs USING btree (epic_id);


--
-- Name: idx_epics_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_epics_org_id ON public.epics USING btree (org_id);


--
-- Name: idx_epics_project_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_epics_project_id ON public.epics USING btree (project_id);


--
-- Name: idx_inbox_items_assignee; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inbox_items_assignee ON public.inbox_items USING btree (assignee_member_id);


--
-- Name: idx_inbox_items_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inbox_items_created_at ON public.inbox_items USING btree (created_at DESC);


--
-- Name: idx_inbox_items_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inbox_items_kind ON public.inbox_items USING btree (kind);


--
-- Name: idx_inbox_items_options_gin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inbox_items_options_gin ON public.inbox_items USING gin (options);


--
-- Name: idx_inbox_items_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inbox_items_org_id ON public.inbox_items USING btree (org_id);


--
-- Name: idx_inbox_items_origin_chain_gin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inbox_items_origin_chain_gin ON public.inbox_items USING gin (origin_chain);


--
-- Name: idx_inbox_items_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inbox_items_pending ON public.inbox_items USING btree (state) WHERE (state = 'pending'::text);


--
-- Name: idx_inbox_items_project_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inbox_items_project_id ON public.inbox_items USING btree (project_id);


--
-- Name: idx_inbox_outbox_inbox_item_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inbox_outbox_inbox_item_id ON public.inbox_outbox USING btree (inbox_item_id);


--
-- Name: idx_inbox_outbox_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inbox_outbox_org_id ON public.inbox_outbox USING btree (org_id);


--
-- Name: idx_inbox_outbox_pending_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inbox_outbox_pending_due ON public.inbox_outbox USING btree (next_attempt_at) WHERE ((status = 'pending'::text) OR (status = 'in_flight'::text));


--
-- Name: idx_inbox_outbox_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inbox_outbox_status ON public.inbox_outbox USING btree (status);


--
-- Name: idx_invitations_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invitations_email ON public.invitations USING btree (email);


--
-- Name: idx_invitations_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invitations_org ON public.invitations USING btree (org_id);


--
-- Name: idx_invitations_pending_project_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invitations_pending_project_lookup ON public.invitations USING btree (org_id, email, project_id) WHERE ((accepted_at IS NULL) AND (project_id IS NOT NULL));


--
-- Name: idx_invitations_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invitations_project ON public.invitations USING btree (project_id) WHERE (project_id IS NOT NULL);


--
-- Name: idx_invitations_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invitations_token ON public.invitations USING btree (token);


--
-- Name: idx_mcp_connection_requests_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mcp_connection_requests_project ON public.mcp_connection_requests USING btree (org_id, project_id, status, created_at DESC);


--
-- Name: idx_meetings_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_meetings_date ON public.meetings USING btree (date DESC);


--
-- Name: idx_meetings_deleted; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_meetings_deleted ON public.meetings USING btree (deleted_at) WHERE (deleted_at IS NULL);


--
-- Name: idx_meetings_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_meetings_project ON public.meetings USING btree (project_id);


--
-- Name: idx_memo_assignees_member_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memo_assignees_member_id ON public.memo_assignees USING btree (member_id);


--
-- Name: idx_memo_assignees_memo_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memo_assignees_memo_id ON public.memo_assignees USING btree (memo_id);


--
-- Name: idx_memo_doc_links_doc_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memo_doc_links_doc_id ON public.memo_doc_links USING btree (doc_id);


--
-- Name: idx_memo_doc_links_memo_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memo_doc_links_memo_id ON public.memo_doc_links USING btree (memo_id);


--
-- Name: idx_memo_mentions_memo_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memo_mentions_memo_id ON public.memo_mentions USING btree (memo_id);


--
-- Name: idx_memo_mentions_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memo_mentions_user_id ON public.memo_mentions USING btree (mentioned_user_id);


--
-- Name: idx_memo_reads_memo_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memo_reads_memo_id ON public.memo_reads USING btree (memo_id);


--
-- Name: idx_memo_reads_team_member_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memo_reads_team_member_id ON public.memo_reads USING btree (team_member_id);


--
-- Name: idx_memo_replies_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memo_replies_created_by ON public.memo_replies USING btree (created_by);


--
-- Name: idx_memo_replies_memo_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memo_replies_memo_id ON public.memo_replies USING btree (memo_id);


--
-- Name: idx_memos_archived_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memos_archived_at ON public.memos USING btree (archived_at) WHERE (archived_at IS NOT NULL);


--
-- Name: idx_memos_assigned_to; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memos_assigned_to ON public.memos USING btree (assigned_to) WHERE (assigned_to IS NOT NULL);


--
-- Name: idx_memos_bridge_source_event_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_memos_bridge_source_event_unique ON public.memos USING btree (org_id, project_id, ((metadata ->> 'source'::text)), ((metadata ->> 'event_id'::text))) WHERE ((metadata ? 'source'::text) AND (metadata ? 'event_id'::text));


--
-- Name: idx_memos_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memos_created_by ON public.memos USING btree (created_by);


--
-- Name: idx_memos_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memos_org_id ON public.memos USING btree (org_id);


--
-- Name: idx_memos_project_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memos_project_id ON public.memos USING btree (project_id);


--
-- Name: idx_memos_search_vector; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memos_search_vector ON public.memos USING gin (search_vector);


--
-- Name: idx_memos_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memos_status ON public.memos USING btree (status);


--
-- Name: idx_mockup_components_page; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mockup_components_page ON public.mockup_components USING btree (page_id);


--
-- Name: idx_mockup_components_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mockup_components_parent ON public.mockup_components USING btree (parent_id);


--
-- Name: idx_mockup_pages_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mockup_pages_org ON public.mockup_pages USING btree (org_id);


--
-- Name: idx_mockup_pages_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mockup_pages_project ON public.mockup_pages USING btree (project_id);


--
-- Name: idx_mockup_scenarios_page; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mockup_scenarios_page ON public.mockup_scenarios USING btree (page_id);


--
-- Name: idx_mockup_versions_page; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mockup_versions_page ON public.mockup_versions USING btree (page_id);


--
-- Name: idx_notification_settings_member; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notification_settings_member ON public.notification_settings USING btree (member_id);


--
-- Name: idx_notifications_is_read; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notifications_is_read ON public.notifications USING btree (is_read) WHERE (is_read = false);


--
-- Name: idx_notifications_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notifications_org_id ON public.notifications USING btree (org_id);


--
-- Name: idx_notifications_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notifications_user_id ON public.notifications USING btree (user_id);


--
-- Name: idx_org_integrations_org_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_org_integrations_org_project ON public.org_integrations USING btree (org_id, project_id);


--
-- Name: idx_org_integrations_project_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_org_integrations_project_type ON public.org_integrations USING btree (project_id, integration_type);


--
-- Name: idx_org_members_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_org_members_org_id ON public.org_members USING btree (org_id);


--
-- Name: idx_org_members_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_org_members_user_id ON public.org_members USING btree (user_id);


--
-- Name: idx_permission_audit_logs_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_permission_audit_logs_org_id ON public.permission_audit_logs USING btree (org_id, created_at DESC);


--
-- Name: idx_plan_features_tier; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_plan_features_tier ON public.plan_features USING btree (tier_id);


--
-- Name: idx_plan_offerings_tier; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_plan_offerings_tier ON public.plan_offerings USING btree (tier_id);


--
-- Name: idx_policy_documents_epic; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_policy_documents_epic ON public.policy_documents USING btree (epic_id);


--
-- Name: idx_policy_documents_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_policy_documents_project ON public.policy_documents USING btree (project_id);


--
-- Name: idx_policy_documents_sprint; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_policy_documents_sprint ON public.policy_documents USING btree (sprint_id);


--
-- Name: idx_project_ai_settings_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_project_ai_settings_project ON public.project_ai_settings USING btree (project_id);


--
-- Name: idx_projects_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_projects_org_id ON public.projects USING btree (org_id);


--
-- Name: idx_retro_actions_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_retro_actions_session ON public.retro_actions USING btree (session_id);


--
-- Name: idx_retro_items_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_retro_items_session ON public.retro_items USING btree (session_id);


--
-- Name: idx_retro_sessions_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_retro_sessions_project ON public.retro_sessions USING btree (project_id);


--
-- Name: idx_retro_sessions_sprint; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_retro_sessions_sprint ON public.retro_sessions USING btree (sprint_id);


--
-- Name: idx_reward_ledger_member; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reward_ledger_member ON public.reward_ledger USING btree (member_id);


--
-- Name: idx_reward_ledger_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reward_ledger_org ON public.reward_ledger USING btree (org_id);


--
-- Name: idx_reward_ledger_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reward_ledger_project ON public.reward_ledger USING btree (project_id);


--
-- Name: idx_sprints_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sprints_org_id ON public.sprints USING btree (org_id);


--
-- Name: idx_sprints_project_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sprints_project_id ON public.sprints USING btree (project_id);


--
-- Name: idx_standup_entries_author; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_standup_entries_author ON public.standup_entries USING btree (author_id);


--
-- Name: idx_standup_entries_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_standup_entries_date ON public.standup_entries USING btree (date);


--
-- Name: idx_standup_entries_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_standup_entries_project ON public.standup_entries USING btree (project_id);


--
-- Name: idx_standup_feedback_author; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_standup_feedback_author ON public.standup_feedback USING btree (feedback_by_id);


--
-- Name: idx_standup_feedback_entry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_standup_feedback_entry ON public.standup_feedback USING btree (standup_entry_id);


--
-- Name: idx_standup_feedback_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_standup_feedback_project ON public.standup_feedback USING btree (project_id);


--
-- Name: idx_standup_feedback_sprint; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_standup_feedback_sprint ON public.standup_feedback USING btree (sprint_id);


--
-- Name: idx_stories_assignee_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stories_assignee_id ON public.stories USING btree (assignee_id);


--
-- Name: idx_stories_epic_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stories_epic_id ON public.stories USING btree (epic_id);


--
-- Name: idx_stories_meeting; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stories_meeting ON public.stories USING btree (meeting_id) WHERE (meeting_id IS NOT NULL);


--
-- Name: idx_stories_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stories_org_id ON public.stories USING btree (org_id);


--
-- Name: idx_stories_project_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stories_project_id ON public.stories USING btree (project_id);


--
-- Name: idx_stories_sprint_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stories_sprint_id ON public.stories USING btree (sprint_id);


--
-- Name: idx_story_activities_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_story_activities_org_id ON public.story_activities USING btree (org_id);


--
-- Name: idx_story_activities_story_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_story_activities_story_id ON public.story_activities USING btree (story_id, created_at DESC);


--
-- Name: idx_story_activities_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_story_activities_type ON public.story_activities USING btree (activity_type);


--
-- Name: idx_story_comments_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_story_comments_created_by ON public.story_comments USING btree (created_by);


--
-- Name: idx_story_comments_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_story_comments_org_id ON public.story_comments USING btree (org_id);


--
-- Name: idx_story_comments_story_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_story_comments_story_id ON public.story_comments USING btree (story_id, created_at DESC);


--
-- Name: idx_story_docs_doc_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_story_docs_doc_id ON public.story_docs USING btree (doc_id);


--
-- Name: idx_story_docs_story_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_story_docs_story_id ON public.story_docs USING btree (story_id);


--
-- Name: idx_subscription_checkout_sessions_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subscription_checkout_sessions_org ON public.subscription_checkout_sessions USING btree (org_id, updated_at DESC);


--
-- Name: idx_subscription_checkout_sessions_provider_sub; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subscription_checkout_sessions_provider_sub ON public.subscription_checkout_sessions USING btree (provider, provider_subscription_id) WHERE (provider_subscription_id IS NOT NULL);


--
-- Name: idx_subscriptions_last_webhook_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subscriptions_last_webhook_at ON public.subscriptions USING btree (last_webhook_event_at);


--
-- Name: idx_subscriptions_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subscriptions_org ON public.subscriptions USING btree (org_id);


--
-- Name: idx_subscriptions_provider_sub; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subscriptions_provider_sub ON public.subscriptions USING btree (payment_provider, provider_subscription_id);


--
-- Name: idx_subscriptions_tier; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subscriptions_tier ON public.subscriptions USING btree (tier_id);


--
-- Name: idx_tasks_assignee_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_assignee_id ON public.tasks USING btree (assignee_id);


--
-- Name: idx_tasks_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_org_id ON public.tasks USING btree (org_id);


--
-- Name: idx_tasks_story_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_story_id ON public.tasks USING btree (story_id);


--
-- Name: idx_team_members_human_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_team_members_human_unique ON public.team_members_legacy USING btree (project_id, user_id) WHERE ((type = 'human'::text) AND (user_id IS NOT NULL));


--
-- Name: idx_team_members_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_team_members_org_id ON public.team_members_legacy USING btree (org_id);


--
-- Name: idx_team_members_project_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_team_members_project_id ON public.team_members_legacy USING btree (project_id);


--
-- Name: idx_team_members_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_team_members_user_id ON public.team_members_legacy USING btree (user_id) WHERE (user_id IS NOT NULL);


--
-- Name: idx_usage_meters_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_usage_meters_org ON public.usage_meters USING btree (org_id);


--
-- Name: idx_usage_meters_period; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_usage_meters_period ON public.usage_meters USING btree (org_id, meter_type, period_end);


--
-- Name: idx_webhook_configs_default; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_webhook_configs_default ON public.webhook_configs USING btree (org_id, member_id) WHERE (project_id IS NULL);


--
-- Name: idx_webhook_configs_member; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_webhook_configs_member ON public.webhook_configs USING btree (member_id);


--
-- Name: idx_webhook_configs_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_webhook_configs_unique ON public.webhook_configs USING btree (org_id, member_id, project_id) WHERE (project_id IS NOT NULL);


--
-- Name: idx_webhook_deliveries_config_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_webhook_deliveries_config_id ON public.webhook_deliveries USING btree (webhook_config_id) WHERE (webhook_config_id IS NOT NULL);


--
-- Name: idx_webhook_deliveries_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_webhook_deliveries_org_id ON public.webhook_deliveries USING btree (org_id);


--
-- Name: idx_webhook_deliveries_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_webhook_deliveries_status ON public.webhook_deliveries USING btree (status) WHERE (status <> 'success'::text);


--
-- Name: idx_workflow_change_events_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_change_events_org_id ON public.workflow_change_events USING btree (org_id);


--
-- Name: idx_workflow_change_events_project_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_change_events_project_id ON public.workflow_change_events USING btree (project_id, created_at DESC);


--
-- Name: idx_workflow_contracts_org_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_contracts_org_active ON public.workflow_contracts USING btree (org_id, is_active, entity_type);


--
-- Name: idx_workflow_contracts_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_contracts_parent ON public.workflow_contracts USING btree (parent_contract_id) WHERE (parent_contract_id IS NOT NULL);


--
-- Name: idx_workflow_contracts_project_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_contracts_project_active ON public.workflow_contracts USING btree (org_id, project_id, is_active, entity_type) WHERE (project_id IS NOT NULL);


--
-- Name: idx_workflow_events_instance; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_events_instance ON public.workflow_events USING btree (instance_id, created_at DESC);


--
-- Name: idx_workflow_executions_event_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_executions_event_id ON public.workflow_executions USING btree (event_id);


--
-- Name: idx_workflow_executions_next_retry_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_executions_next_retry_at ON public.workflow_executions USING btree (next_retry_at) WHERE ((status = 'pending'::text) AND (next_retry_at IS NOT NULL));


--
-- Name: idx_workflow_executions_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_executions_org_id ON public.workflow_executions USING btree (org_id);


--
-- Name: idx_workflow_executions_rule_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_executions_rule_id ON public.workflow_executions USING btree (rule_id);


--
-- Name: idx_workflow_executions_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_executions_status ON public.workflow_executions USING btree (status);


--
-- Name: idx_workflow_instances_contract; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_instances_contract ON public.workflow_instances USING btree (contract_id, status);


--
-- Name: idx_workflow_instances_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_instances_entity ON public.workflow_instances USING btree (entity_id, status);


--
-- Name: idx_workflow_instances_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_instances_parent ON public.workflow_instances USING btree (parent_instance_id) WHERE (parent_instance_id IS NOT NULL);


--
-- Name: idx_workflow_rules_enabled; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_rules_enabled ON public.workflow_rules USING btree (enabled);


--
-- Name: idx_workflow_rules_event_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_rules_event_type ON public.workflow_rules USING btree (event_type);


--
-- Name: idx_workflow_rules_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_rules_org_id ON public.workflow_rules USING btree (org_id);


--
-- Name: idx_workflow_rules_project_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_rules_project_id ON public.workflow_rules USING btree (project_id);


--
-- Name: idx_workflow_timers_poll; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_timers_poll ON public.workflow_timers USING btree (fires_at) WHERE (status = 'pending'::text);


--
-- Name: idx_workflow_timers_story; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_timers_story ON public.workflow_timers USING btree (story_id) WHERE (status = 'pending'::text);


--
-- Name: idx_workflow_versions_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_versions_org_id ON public.workflow_versions USING btree (org_id);


--
-- Name: idx_workflow_versions_project_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_versions_project_id ON public.workflow_versions USING btree (project_id, version DESC);


--
-- Name: ix_activity_logs_actor_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_activity_logs_actor_created ON public.activity_logs USING btree (actor_id, created_at);


--
-- Name: ix_activity_logs_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_activity_logs_entity ON public.activity_logs USING btree (entity_type, entity_id);


--
-- Name: ix_activity_logs_org_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_activity_logs_org_created ON public.activity_logs USING btree (org_id, created_at);


--
-- Name: ix_agent_api_keys_member_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_api_keys_member_id ON public.agent_api_keys USING btree (member_id);


--
-- Name: ix_agent_gateway_sessions_agent_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_gateway_sessions_agent_id ON public.agent_gateway_sessions USING btree (agent_id);


--
-- Name: ix_agent_message_allowlist_agent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_message_allowlist_agent ON public.agent_message_allowlist USING btree (agent_member_id);


--
-- Name: ix_agent_profiles_member; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_profiles_member ON public.agent_project_profiles USING btree (member_id);


--
-- Name: ix_agent_profiles_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_profiles_project ON public.agent_project_profiles USING btree (project_id);


--
-- Name: ix_conv_wh_deliveries_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_conv_wh_deliveries_status ON public.conversation_webhook_deliveries USING btree (status, created_at);


--
-- Name: ix_conversation_messages_conversation_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_conversation_messages_conversation_id ON public.conversation_messages USING btree (conversation_id);


--
-- Name: ix_conversation_messages_thread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_conversation_messages_thread ON public.conversation_messages USING btree (thread_id, created_at) WHERE (thread_id IS NOT NULL);


--
-- Name: ix_conversation_messages_top_level; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_conversation_messages_top_level ON public.conversation_messages USING btree (conversation_id, created_at) WHERE (thread_id IS NULL);


--
-- Name: ix_conversation_participants_conversation_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_conversation_participants_conversation_id ON public.conversation_participants USING btree (conversation_id);


--
-- Name: ix_conversation_webhook_deliveries_message_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_conversation_webhook_deliveries_message_id ON public.conversation_webhook_deliveries USING btree (message_id);


--
-- Name: ix_conversation_webhook_deliveries_webhook_config_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_conversation_webhook_deliveries_webhook_config_id ON public.conversation_webhook_deliveries USING btree (webhook_config_id);


--
-- Name: ix_conversations_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_conversations_org_id ON public.conversations USING btree (org_id);


--
-- Name: ix_conversations_org_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_conversations_org_project ON public.conversations USING btree (org_id, project_id);


--
-- Name: ix_conversations_project_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_conversations_project_id ON public.conversations USING btree (project_id);


--
-- Name: ix_conversations_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_conversations_status ON public.conversations USING btree (org_id, project_id, status);


--
-- Name: ix_events_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_events_org_id ON public.events USING btree (org_id);


--
-- Name: ix_events_project_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_events_project_created_at ON public.events USING btree (project_id, created_at);


--
-- Name: ix_events_project_recipient_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_events_project_recipient_status ON public.events USING btree (project_id, recipient_id, status);


--
-- Name: ix_events_recipient_seq; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_events_recipient_seq ON public.events USING btree (recipient_id, recipient_seq);


--
-- Name: ix_file_locks_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_file_locks_active ON public.file_locks USING btree (file_path, released_at);


--
-- Name: ix_file_locks_file_path; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_file_locks_file_path ON public.file_locks USING btree (file_path);


--
-- Name: ix_file_locks_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_file_locks_org_id ON public.file_locks USING btree (org_id);


--
-- Name: ix_file_locks_project_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_file_locks_project_id ON public.file_locks USING btree (project_id);


--
-- Name: ix_gate_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_gate_org_id ON public.gate USING btree (org_id);


--
-- Name: ix_gate_work_item_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_gate_work_item_id ON public.gate USING btree (work_item_id);


--
-- Name: ix_item_dependency_from_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_item_dependency_from_id ON public.item_dependency USING btree (from_id);


--
-- Name: ix_item_dependency_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_item_dependency_org_id ON public.item_dependency USING btree (org_id);


--
-- Name: ix_item_dependency_to_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_item_dependency_to_id ON public.item_dependency USING btree (to_id);


--
-- Name: ix_item_label_item_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_item_label_item_id ON public.item_label USING btree (item_id);


--
-- Name: ix_item_label_label_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_item_label_label_id ON public.item_label USING btree (label_id);


--
-- Name: ix_item_label_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_item_label_org_id ON public.item_label USING btree (org_id);


--
-- Name: ix_label_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_label_org_id ON public.label USING btree (org_id);


--
-- Name: ix_login_audit_logs_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_login_audit_logs_created_at ON public.login_audit_logs USING btree (created_at);


--
-- Name: ix_login_audit_logs_event_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_login_audit_logs_event_type ON public.login_audit_logs USING btree (event_type);


--
-- Name: ix_login_audit_logs_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_login_audit_logs_user_id ON public.login_audit_logs USING btree (user_id);


--
-- Name: ix_member_aliases_member; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_member_aliases_member ON public.member_identity_aliases USING btree (member_id);


--
-- Name: ix_member_aliases_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_member_aliases_org ON public.member_identity_aliases USING btree (org_id);


--
-- Name: ix_member_gate_override_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_member_gate_override_org_id ON public.member_gate_override USING btree (org_id);


--
-- Name: ix_members_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_members_org_id ON public.members USING btree (org_id);


--
-- Name: ix_members_owner_member_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_members_owner_member_id ON public.members USING btree (owner_member_id);


--
-- Name: ix_members_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_members_user_id ON public.members USING btree (user_id);


--
-- Name: ix_memo_entity_links_memo_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_memo_entity_links_memo_id ON public.memo_entity_links USING btree (memo_id);


--
-- Name: ix_notif_pref_member; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_notif_pref_member ON public.notification_preferences USING btree (member_id, scope_type);


--
-- Name: ix_org_gate_override_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_org_gate_override_org_id ON public.org_gate_override USING btree (org_id);


--
-- Name: ix_org_gate_policy_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_org_gate_policy_org_id ON public.org_gate_policy USING btree (org_id);


--
-- Name: ix_org_invites_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_org_invites_created_by ON public.org_invites USING btree (created_by);


--
-- Name: ix_org_invites_organization_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_org_invites_organization_id ON public.org_invites USING btree (organization_id);


--
-- Name: ix_participation_member_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_participation_member_id ON public.participation USING btree (member_id);


--
-- Name: ix_participation_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_participation_org_id ON public.participation USING btree (org_id);


--
-- Name: ix_participation_role_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_participation_role_org_id ON public.participation_role USING btree (org_id);


--
-- Name: ix_participation_story_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_participation_story_id ON public.participation USING btree (story_id);


--
-- Name: ix_project_access_member_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_project_access_member_id ON public.project_access USING btree (member_id);


--
-- Name: ix_project_access_org_member_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_project_access_org_member_id ON public.project_access USING btree (org_member_id);


--
-- Name: ix_project_access_project_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_project_access_project_id ON public.project_access USING btree (project_id);


--
-- Name: ix_project_api_keys_project_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_project_api_keys_project_id ON public.project_api_keys USING btree (project_id);


--
-- Name: ix_refresh_tokens_token_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ix_refresh_tokens_token_hash ON public.refresh_tokens USING btree (token_hash);


--
-- Name: ix_refresh_tokens_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_refresh_tokens_user_id ON public.refresh_tokens USING btree (user_id);


--
-- Name: ix_stories_is_excluded; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_stories_is_excluded ON public.stories USING btree (is_excluded);


--
-- Name: ix_story_assignees_member_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_story_assignees_member_id ON public.story_assignees USING btree (member_id);


--
-- Name: ix_story_assignees_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_story_assignees_org_id ON public.story_assignees USING btree (org_id);


--
-- Name: ix_story_assignees_story_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_story_assignees_story_id ON public.story_assignees USING btree (story_id);


--
-- Name: ix_users_email; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ix_users_email ON public.users USING btree (email);


--
-- Name: ix_users_github_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_users_github_id ON public.users USING btree (github_id);


--
-- Name: ix_users_google_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_users_google_id ON public.users USING btree (google_id);


--
-- Name: ix_verdict_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_verdict_org_id ON public.verdict USING btree (org_id);


--
-- Name: ix_verdict_participation_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_verdict_participation_id ON public.verdict USING btree (participation_id);


--
-- Name: ix_workflow_execution_logs_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_workflow_execution_logs_created_at ON public.workflow_execution_logs USING btree (created_at);


--
-- Name: ix_workflow_execution_logs_org_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_workflow_execution_logs_org_project ON public.workflow_execution_logs USING btree (org_id, project_id);


--
-- Name: ix_workflow_templates_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ix_workflow_templates_slug ON public.workflow_templates USING btree (slug);


--
-- Name: ix_workflow_trigger_types_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_workflow_trigger_types_org_id ON public.workflow_trigger_types USING btree (org_id);


--
-- Name: sprints_active_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sprints_active_unique ON public.sprints USING btree (project_id) WHERE ((status = 'active'::text) AND (deleted_at IS NULL));


--
-- Name: uq_agent_deployments_live_per_agent; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_agent_deployments_live_per_agent ON public.agent_deployments USING btree (org_id, project_id, agent_id) WHERE ((deleted_at IS NULL) AND (status = ANY (ARRAY['DEPLOYING'::text, 'ACTIVE'::text, 'SUSPENDED'::text])));


--
-- Name: uq_agent_personas_agent_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_agent_personas_agent_slug ON public.agent_personas USING btree (project_id, agent_id, slug) WHERE (deleted_at IS NULL);


--
-- Name: uq_agent_personas_default; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_agent_personas_default ON public.agent_personas USING btree (project_id, agent_id) WHERE ((is_default = true) AND (deleted_at IS NULL));


--
-- Name: uq_agent_profiles_proj_port; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_agent_profiles_proj_port ON public.agent_project_profiles USING btree (project_id, fakechat_port) WHERE (fakechat_port IS NOT NULL);


--
-- Name: uq_agent_routing_rules_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_agent_routing_rules_name ON public.agent_routing_rules USING btree (project_id, agent_id, name) WHERE (deleted_at IS NULL);


--
-- Name: uq_agent_sessions_project_session_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_agent_sessions_project_session_key ON public.agent_sessions USING btree (project_id, session_key) WHERE (deleted_at IS NULL);


--
-- Name: uq_members_active_human; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_members_active_human ON public.members USING btree (org_id, user_id) WHERE ((type = 'human'::text) AND (deleted_at IS NULL));


--
-- Name: uq_notif_pref_global; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_notif_pref_global ON public.notification_preferences USING btree (member_id, scope_type, channel) WHERE (scope_id IS NULL);


--
-- Name: uq_notif_pref_scoped; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_notif_pref_scoped ON public.notification_preferences USING btree (member_id, scope_type, scope_id, channel) WHERE (scope_id IS NOT NULL);


--
-- Name: uq_org_invites_org_email_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_org_invites_org_email_pending ON public.org_invites USING btree (organization_id, email) WHERE (status = 'pending'::text);


--
-- Name: uq_project_access_project_member_v2; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_project_access_project_member_v2 ON public.project_access USING btree (project_id, member_id) WHERE (member_id IS NOT NULL);


--
-- Name: uq_team_members_project_fakechat_port; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_team_members_project_fakechat_port ON public.team_members_legacy USING btree (project_id, fakechat_port) WHERE (fakechat_port IS NOT NULL);


--
-- Name: uq_users_github_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_users_github_id ON public.users USING btree (github_id);


--
-- Name: uq_users_google_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_users_google_id ON public.users USING btree (google_id);


--
-- Name: uq_workflow_trigger_types_org_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_workflow_trigger_types_org_slug ON public.workflow_trigger_types USING btree (org_id, slug) WHERE (deleted_at IS NULL);


--
-- Name: agent_project_profiles agent_project_profiles_active_story_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_project_profiles
    ADD CONSTRAINT agent_project_profiles_active_story_id_fkey FOREIGN KEY (active_story_id) REFERENCES public.stories(id) ON DELETE SET NULL;


--
-- Name: agent_project_profiles agent_project_profiles_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_project_profiles
    ADD CONSTRAINT agent_project_profiles_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.members(id) ON DELETE CASCADE;


--
-- Name: agent_project_profiles agent_project_profiles_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_project_profiles
    ADD CONSTRAINT agent_project_profiles_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: conversation_messages conversation_messages_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_messages
    ADD CONSTRAINT conversation_messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;


--
-- Name: conversation_messages conversation_messages_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_messages
    ADD CONSTRAINT conversation_messages_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.conversation_messages(id) ON DELETE SET NULL;


--
-- Name: conversation_participants conversation_participants_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_participants
    ADD CONSTRAINT conversation_participants_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;


--
-- Name: conversation_webhook_deliveries conversation_webhook_deliveries_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_webhook_deliveries
    ADD CONSTRAINT conversation_webhook_deliveries_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.conversation_messages(id) ON DELETE CASCADE;


--
-- Name: conversations conversations_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: events events_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: file_locks file_locks_story_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_locks
    ADD CONSTRAINT file_locks_story_id_fkey FOREIGN KEY (story_id) REFERENCES public.stories(id) ON DELETE SET NULL;


--
-- Name: agent_api_keys fk_agent_api_keys_member_id_members; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_api_keys
    ADD CONSTRAINT fk_agent_api_keys_member_id_members FOREIGN KEY (member_id) REFERENCES public.members(id) ON DELETE SET NULL;


--
-- Name: project_access fk_project_access_inherited_member; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_access
    ADD CONSTRAINT fk_project_access_inherited_member FOREIGN KEY (inherited_from_member_id) REFERENCES public.members(id) ON DELETE SET NULL;


--
-- Name: project_access fk_project_access_member; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_access
    ADD CONSTRAINT fk_project_access_member FOREIGN KEY (member_id) REFERENCES public.members(id) ON DELETE CASCADE;


--
-- Name: team_members_legacy fk_team_members_active_story_id_stories; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_members_legacy
    ADD CONSTRAINT fk_team_members_active_story_id_stories FOREIGN KEY (active_story_id) REFERENCES public.stories(id) ON DELETE SET NULL;


--
-- Name: member_identity_aliases member_identity_aliases_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member_identity_aliases
    ADD CONSTRAINT member_identity_aliases_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.members(id) ON DELETE CASCADE;


--
-- Name: members members_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.members
    ADD CONSTRAINT members_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: members members_owner_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.members
    ADD CONSTRAINT members_owner_member_id_fkey FOREIGN KEY (owner_member_id) REFERENCES public.members(id) ON DELETE SET NULL;


--
-- Name: members members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.members
    ADD CONSTRAINT members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: memo_entity_links memo_entity_links_memo_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memo_entity_links
    ADD CONSTRAINT memo_entity_links_memo_id_fkey FOREIGN KEY (memo_id) REFERENCES public.memos(id) ON DELETE CASCADE;


--
-- Name: org_gate_override org_gate_override_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_gate_override
    ADD CONSTRAINT org_gate_override_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.participation_role(id) ON DELETE CASCADE;


--
-- Name: org_invites org_invites_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_invites
    ADD CONSTRAINT org_invites_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: org_invites org_invites_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_invites
    ADD CONSTRAINT org_invites_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: participation participation_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.participation
    ADD CONSTRAINT participation_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.participation_role(id) ON DELETE CASCADE;


--
-- Name: participation participation_story_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.participation
    ADD CONSTRAINT participation_story_id_fkey FOREIGN KEY (story_id) REFERENCES public.stories(id) ON DELETE CASCADE;


--
-- Name: project_access project_access_org_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_access
    ADD CONSTRAINT project_access_org_member_id_fkey FOREIGN KEY (org_member_id) REFERENCES public.org_members(id) ON DELETE CASCADE;


--
-- Name: project_access project_access_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_access
    ADD CONSTRAINT project_access_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: project_api_keys project_api_keys_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_api_keys
    ADD CONSTRAINT project_api_keys_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: project_api_keys project_api_keys_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_api_keys
    ADD CONSTRAINT project_api_keys_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: refresh_tokens refresh_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: story_assignees story_assignees_story_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.story_assignees
    ADD CONSTRAINT story_assignees_story_id_fkey FOREIGN KEY (story_id) REFERENCES public.stories(id) ON DELETE CASCADE;


--
-- Name: team_members_legacy team_members_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_members_legacy
    ADD CONSTRAINT team_members_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: users users_last_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_last_project_id_fkey FOREIGN KEY (last_project_id) REFERENCES public.projects(id) ON DELETE SET NULL;


--
-- Name: verdict verdict_participation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verdict
    ADD CONSTRAINT verdict_participation_id_fkey FOREIGN KEY (participation_id) REFERENCES public.participation(id) ON DELETE CASCADE;


--
-- Name: workflow_trigger_types workflow_trigger_types_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_trigger_types
    ADD CONSTRAINT workflow_trigger_types_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--


