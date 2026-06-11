-- 0114 PRIMARY KEY 복원 — preflight (스토리 e491d087 머지 게이트)
--
-- real dev/prod 양쪽에 실행. ADD PRIMARY KEY는 대상 컬럼에 NULL 또는 중복이 있으면 실패하므로,
-- 0114 머지/적용 전 이 쿼리로 39개 테이블을 전수 점검한다. null_cnt>0 또는 dup_groups>0 인
-- 행이 하나라도 있으면 그 테이블은 데이터 정리 선행이 필요(머지 블로커). 전 행 0이면 GO.
--
-- 실행: psql "$PROD_OR_DEV_URL" -f backend/scripts/preflight/0114_missing_pk_preflight.sql
-- (cloud-sql-proxy 경유 — reference_prod_db_query 참조. 인프라 lane.)

\pset format aligned
SELECT * FROM (
  SELECT 'agent_api_keys' AS tbl, 'id' AS pk,
    (SELECT count(*) FROM agent_api_keys WHERE "id" IS NULL) AS null_cnt,
    (SELECT count(*) FROM (SELECT "id" FROM agent_api_keys GROUP BY "id" HAVING count(*) > 1) d) AS dup_groups
  UNION ALL
  SELECT 'agent_audit_logs' AS tbl, 'id' AS pk,
    (SELECT count(*) FROM agent_audit_logs WHERE "id" IS NULL) AS null_cnt,
    (SELECT count(*) FROM (SELECT "id" FROM agent_audit_logs GROUP BY "id" HAVING count(*) > 1) d) AS dup_groups
  UNION ALL
  SELECT 'agent_deployments' AS tbl, 'id' AS pk,
    (SELECT count(*) FROM agent_deployments WHERE "id" IS NULL) AS null_cnt,
    (SELECT count(*) FROM (SELECT "id" FROM agent_deployments GROUP BY "id" HAVING count(*) > 1) d) AS dup_groups
  UNION ALL
  SELECT 'agent_hitl_policies' AS tbl, 'id' AS pk,
    (SELECT count(*) FROM agent_hitl_policies WHERE "id" IS NULL) AS null_cnt,
    (SELECT count(*) FROM (SELECT "id" FROM agent_hitl_policies GROUP BY "id" HAVING count(*) > 1) d) AS dup_groups
  UNION ALL
  SELECT 'agent_hitl_requests' AS tbl, 'id' AS pk,
    (SELECT count(*) FROM agent_hitl_requests WHERE "id" IS NULL) AS null_cnt,
    (SELECT count(*) FROM (SELECT "id" FROM agent_hitl_requests GROUP BY "id" HAVING count(*) > 1) d) AS dup_groups
  UNION ALL
  SELECT 'agent_personas' AS tbl, 'id' AS pk,
    (SELECT count(*) FROM agent_personas WHERE "id" IS NULL) AS null_cnt,
    (SELECT count(*) FROM (SELECT "id" FROM agent_personas GROUP BY "id" HAVING count(*) > 1) d) AS dup_groups
  UNION ALL
  SELECT 'agent_routing_rules' AS tbl, 'id' AS pk,
    (SELECT count(*) FROM agent_routing_rules WHERE "id" IS NULL) AS null_cnt,
    (SELECT count(*) FROM (SELECT "id" FROM agent_routing_rules GROUP BY "id" HAVING count(*) > 1) d) AS dup_groups
  UNION ALL
  SELECT 'agent_runs' AS tbl, 'id' AS pk,
    (SELECT count(*) FROM agent_runs WHERE "id" IS NULL) AS null_cnt,
    (SELECT count(*) FROM (SELECT "id" FROM agent_runs GROUP BY "id" HAVING count(*) > 1) d) AS dup_groups
  UNION ALL
  SELECT 'agent_sessions' AS tbl, 'id' AS pk,
    (SELECT count(*) FROM agent_sessions WHERE "id" IS NULL) AS null_cnt,
    (SELECT count(*) FROM (SELECT "id" FROM agent_sessions GROUP BY "id" HAVING count(*) > 1) d) AS dup_groups
  UNION ALL
  SELECT 'doc_comments' AS tbl, 'id' AS pk,
    (SELECT count(*) FROM doc_comments WHERE "id" IS NULL) AS null_cnt,
    (SELECT count(*) FROM (SELECT "id" FROM doc_comments GROUP BY "id" HAVING count(*) > 1) d) AS dup_groups
  UNION ALL
  SELECT 'doc_revisions' AS tbl, 'id' AS pk,
    (SELECT count(*) FROM doc_revisions WHERE "id" IS NULL) AS null_cnt,
    (SELECT count(*) FROM (SELECT "id" FROM doc_revisions GROUP BY "id" HAVING count(*) > 1) d) AS dup_groups
  UNION ALL
  SELECT 'inbox_items' AS tbl, 'id' AS pk,
    (SELECT count(*) FROM inbox_items WHERE "id" IS NULL) AS null_cnt,
    (SELECT count(*) FROM (SELECT "id" FROM inbox_items GROUP BY "id" HAVING count(*) > 1) d) AS dup_groups
  UNION ALL
  SELECT 'meetings' AS tbl, 'id' AS pk,
    (SELECT count(*) FROM meetings WHERE "id" IS NULL) AS null_cnt,
    (SELECT count(*) FROM (SELECT "id" FROM meetings GROUP BY "id" HAVING count(*) > 1) d) AS dup_groups
  UNION ALL
  SELECT 'messaging_bridge_channels' AS tbl, 'id' AS pk,
    (SELECT count(*) FROM messaging_bridge_channels WHERE "id" IS NULL) AS null_cnt,
    (SELECT count(*) FROM (SELECT "id" FROM messaging_bridge_channels GROUP BY "id" HAVING count(*) > 1) d) AS dup_groups
  UNION ALL
  SELECT 'messaging_bridge_users' AS tbl, 'id' AS pk,
    (SELECT count(*) FROM messaging_bridge_users WHERE "id" IS NULL) AS null_cnt,
    (SELECT count(*) FROM (SELECT "id" FROM messaging_bridge_users GROUP BY "id" HAVING count(*) > 1) d) AS dup_groups
  UNION ALL
  SELECT 'mockup_components' AS tbl, 'id' AS pk,
    (SELECT count(*) FROM mockup_components WHERE "id" IS NULL) AS null_cnt,
    (SELECT count(*) FROM (SELECT "id" FROM mockup_components GROUP BY "id" HAVING count(*) > 1) d) AS dup_groups
  UNION ALL
  SELECT 'mockup_pages' AS tbl, 'id' AS pk,
    (SELECT count(*) FROM mockup_pages WHERE "id" IS NULL) AS null_cnt,
    (SELECT count(*) FROM (SELECT "id" FROM mockup_pages GROUP BY "id" HAVING count(*) > 1) d) AS dup_groups
  UNION ALL
  SELECT 'mockup_scenarios' AS tbl, 'id' AS pk,
    (SELECT count(*) FROM mockup_scenarios WHERE "id" IS NULL) AS null_cnt,
    (SELECT count(*) FROM (SELECT "id" FROM mockup_scenarios GROUP BY "id" HAVING count(*) > 1) d) AS dup_groups
  UNION ALL
  SELECT 'mockup_versions' AS tbl, 'id' AS pk,
    (SELECT count(*) FROM mockup_versions WHERE "id" IS NULL) AS null_cnt,
    (SELECT count(*) FROM (SELECT "id" FROM mockup_versions GROUP BY "id" HAVING count(*) > 1) d) AS dup_groups
  UNION ALL
  SELECT 'notification_settings' AS tbl, 'id' AS pk,
    (SELECT count(*) FROM notification_settings WHERE "id" IS NULL) AS null_cnt,
    (SELECT count(*) FROM (SELECT "id" FROM notification_settings GROUP BY "id" HAVING count(*) > 1) d) AS dup_groups
  UNION ALL
  SELECT 'notifications' AS tbl, 'id' AS pk,
    (SELECT count(*) FROM notifications WHERE "id" IS NULL) AS null_cnt,
    (SELECT count(*) FROM (SELECT "id" FROM notifications GROUP BY "id" HAVING count(*) > 1) d) AS dup_groups
  UNION ALL
  SELECT 'org_subscriptions' AS tbl, 'id' AS pk,
    (SELECT count(*) FROM org_subscriptions WHERE "id" IS NULL) AS null_cnt,
    (SELECT count(*) FROM (SELECT "id" FROM org_subscriptions GROUP BY "id" HAVING count(*) > 1) d) AS dup_groups
  UNION ALL
  SELECT 'permission_audit_logs' AS tbl, 'id' AS pk,
    (SELECT count(*) FROM permission_audit_logs WHERE "id" IS NULL) AS null_cnt,
    (SELECT count(*) FROM (SELECT "id" FROM permission_audit_logs GROUP BY "id" HAVING count(*) > 1) d) AS dup_groups
  UNION ALL
  SELECT 'policy_documents' AS tbl, 'id' AS pk,
    (SELECT count(*) FROM policy_documents WHERE "id" IS NULL) AS null_cnt,
    (SELECT count(*) FROM (SELECT "id" FROM policy_documents GROUP BY "id" HAVING count(*) > 1) d) AS dup_groups
  UNION ALL
  SELECT 'project_settings' AS tbl, 'project_id' AS pk,
    (SELECT count(*) FROM project_settings WHERE "project_id" IS NULL) AS null_cnt,
    (SELECT count(*) FROM (SELECT "project_id" FROM project_settings GROUP BY "project_id" HAVING count(*) > 1) d) AS dup_groups
  UNION ALL
  SELECT 'retro_actions' AS tbl, 'id' AS pk,
    (SELECT count(*) FROM retro_actions WHERE "id" IS NULL) AS null_cnt,
    (SELECT count(*) FROM (SELECT "id" FROM retro_actions GROUP BY "id" HAVING count(*) > 1) d) AS dup_groups
  UNION ALL
  SELECT 'retro_items' AS tbl, 'id' AS pk,
    (SELECT count(*) FROM retro_items WHERE "id" IS NULL) AS null_cnt,
    (SELECT count(*) FROM (SELECT "id" FROM retro_items GROUP BY "id" HAVING count(*) > 1) d) AS dup_groups
  UNION ALL
  SELECT 'retro_sessions' AS tbl, 'id' AS pk,
    (SELECT count(*) FROM retro_sessions WHERE "id" IS NULL) AS null_cnt,
    (SELECT count(*) FROM (SELECT "id" FROM retro_sessions GROUP BY "id" HAVING count(*) > 1) d) AS dup_groups
  UNION ALL
  SELECT 'retro_votes' AS tbl, 'id' AS pk,
    (SELECT count(*) FROM retro_votes WHERE "id" IS NULL) AS null_cnt,
    (SELECT count(*) FROM (SELECT "id" FROM retro_votes GROUP BY "id" HAVING count(*) > 1) d) AS dup_groups
  UNION ALL
  SELECT 'reward_ledger' AS tbl, 'id' AS pk,
    (SELECT count(*) FROM reward_ledger WHERE "id" IS NULL) AS null_cnt,
    (SELECT count(*) FROM (SELECT "id" FROM reward_ledger GROUP BY "id" HAVING count(*) > 1) d) AS dup_groups
  UNION ALL
  SELECT 'sprints' AS tbl, 'id' AS pk,
    (SELECT count(*) FROM sprints WHERE "id" IS NULL) AS null_cnt,
    (SELECT count(*) FROM (SELECT "id" FROM sprints GROUP BY "id" HAVING count(*) > 1) d) AS dup_groups
  UNION ALL
  SELECT 'standup_entries' AS tbl, 'id' AS pk,
    (SELECT count(*) FROM standup_entries WHERE "id" IS NULL) AS null_cnt,
    (SELECT count(*) FROM (SELECT "id" FROM standup_entries GROUP BY "id" HAVING count(*) > 1) d) AS dup_groups
  UNION ALL
  SELECT 'standup_feedback' AS tbl, 'id' AS pk,
    (SELECT count(*) FROM standup_feedback WHERE "id" IS NULL) AS null_cnt,
    (SELECT count(*) FROM (SELECT "id" FROM standup_feedback GROUP BY "id" HAVING count(*) > 1) d) AS dup_groups
  UNION ALL
  SELECT 'story_activities' AS tbl, 'id' AS pk,
    (SELECT count(*) FROM story_activities WHERE "id" IS NULL) AS null_cnt,
    (SELECT count(*) FROM (SELECT "id" FROM story_activities GROUP BY "id" HAVING count(*) > 1) d) AS dup_groups
  UNION ALL
  SELECT 'story_comments' AS tbl, 'id' AS pk,
    (SELECT count(*) FROM story_comments WHERE "id" IS NULL) AS null_cnt,
    (SELECT count(*) FROM (SELECT "id" FROM story_comments GROUP BY "id" HAVING count(*) > 1) d) AS dup_groups
  UNION ALL
  SELECT 'tasks' AS tbl, 'id' AS pk,
    (SELECT count(*) FROM tasks WHERE "id" IS NULL) AS null_cnt,
    (SELECT count(*) FROM (SELECT "id" FROM tasks GROUP BY "id" HAVING count(*) > 1) d) AS dup_groups
  UNION ALL
  SELECT 'usage_meters' AS tbl, 'id' AS pk,
    (SELECT count(*) FROM usage_meters WHERE "id" IS NULL) AS null_cnt,
    (SELECT count(*) FROM (SELECT "id" FROM usage_meters GROUP BY "id" HAVING count(*) > 1) d) AS dup_groups
  UNION ALL
  SELECT 'webhook_configs' AS tbl, 'id' AS pk,
    (SELECT count(*) FROM webhook_configs WHERE "id" IS NULL) AS null_cnt,
    (SELECT count(*) FROM (SELECT "id" FROM webhook_configs GROUP BY "id" HAVING count(*) > 1) d) AS dup_groups
  UNION ALL
  SELECT 'workflow_versions' AS tbl, 'id' AS pk,
    (SELECT count(*) FROM workflow_versions WHERE "id" IS NULL) AS null_cnt,
    (SELECT count(*) FROM (SELECT "id" FROM workflow_versions GROUP BY "id" HAVING count(*) > 1) d) AS dup_groups
) chk
WHERE null_cnt > 0 OR dup_groups > 0   -- 블로커만 출력. 0행이면 전부 깨끗 = GO.
ORDER BY tbl;
