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
-- Data for Name: plan_features; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.plan_features VALUES ('6931f97c-3c8c-4e15-9db9-b40065c72585', '00000000-0000-0000-0000-000000000a01', 'kanban', true, NULL);
INSERT INTO public.plan_features VALUES ('d0fcd323-43fd-4c54-8342-bf470e980966', '00000000-0000-0000-0000-000000000a01', 'memos', true, NULL);
INSERT INTO public.plan_features VALUES ('a111560c-1902-4691-a363-7b1c0a77fc83', '00000000-0000-0000-0000-000000000a01', 'mcp_server', true, NULL);
INSERT INTO public.plan_features VALUES ('3c3f6de1-36ad-4338-91b5-33416c438082', '00000000-0000-0000-0000-000000000a01', 'agent_orchestration', false, NULL);
INSERT INTO public.plan_features VALUES ('51921b7e-4aba-44e3-a5ff-809b578683c0', '00000000-0000-0000-0000-000000000a01', 'sso', false, NULL);
INSERT INTO public.plan_features VALUES ('8b2dc4d0-1f15-4156-9f78-65eead930899', '00000000-0000-0000-0000-000000000a02', 'kanban', true, NULL);
INSERT INTO public.plan_features VALUES ('c95f9995-0cc8-4763-9f0d-170a6daa4be6', '00000000-0000-0000-0000-000000000a02', 'memos', true, NULL);
INSERT INTO public.plan_features VALUES ('18254da2-0ef7-48e6-98fa-6055d3577f89', '00000000-0000-0000-0000-000000000a02', 'mcp_server', true, NULL);
INSERT INTO public.plan_features VALUES ('191a2c30-cae2-4134-bfda-e2c87efdc06d', '00000000-0000-0000-0000-000000000a02', 'agent_orchestration', true, NULL);
INSERT INTO public.plan_features VALUES ('4ea5f40b-fde7-479c-a8be-267a29b6e685', '00000000-0000-0000-0000-000000000a02', 'sso', false, NULL);
INSERT INTO public.plan_features VALUES ('162f432a-a371-4ba5-86b5-21c7f5e32a7e', '00000000-0000-0000-0000-000000000a03', 'kanban', true, NULL);
INSERT INTO public.plan_features VALUES ('27633097-bd8f-4bd5-9206-61ae1c70e1b3', '00000000-0000-0000-0000-000000000a03', 'memos', true, NULL);
INSERT INTO public.plan_features VALUES ('a1584bda-9e89-4021-8e92-a49afbba0aae', '00000000-0000-0000-0000-000000000a03', 'mcp_server', true, NULL);
INSERT INTO public.plan_features VALUES ('775016f4-e409-479f-acae-140b472e9e4f', '00000000-0000-0000-0000-000000000a03', 'agent_orchestration', true, NULL);
INSERT INTO public.plan_features VALUES ('fc3568c9-35b6-4300-a595-a8ead297354a', '00000000-0000-0000-0000-000000000a03', 'sso', true, NULL);
INSERT INTO public.plan_features VALUES ('819b5365-7d47-4049-ad9e-abd09a66467e', '00000000-0000-0000-0000-000000000a01', 'max_stories', true, 50);
INSERT INTO public.plan_features VALUES ('98c142eb-e934-499b-b030-e4aa255a814f', '00000000-0000-0000-0000-000000000a01', 'max_docs', true, 10);
INSERT INTO public.plan_features VALUES ('c8f3ced3-0d8f-41f4-87b0-0910dffb850a', '00000000-0000-0000-0000-000000000a01', 'max_mockups', true, 5);
INSERT INTO public.plan_features VALUES ('aa5350fa-09f4-4f1a-90d4-3416cc0dc2ca', '00000000-0000-0000-0000-000000000a01', 'byoa_agents', true, 1);
INSERT INTO public.plan_features VALUES ('95f4b083-1204-42ae-8dde-f0dc7ecdbf42', '00000000-0000-0000-0000-000000000a02', 'max_stories', true, NULL);
INSERT INTO public.plan_features VALUES ('2365832d-4620-4a5b-8bd9-f9ef52e13cff', '00000000-0000-0000-0000-000000000a02', 'max_docs', true, NULL);
INSERT INTO public.plan_features VALUES ('9e16d5d3-c00e-42e4-ab90-6dd126b1b2fb', '00000000-0000-0000-0000-000000000a02', 'max_mockups', true, NULL);
INSERT INTO public.plan_features VALUES ('b9703534-000c-4542-9c4b-e273d3265152', '00000000-0000-0000-0000-000000000a02', 'byoa_agents', true, NULL);
INSERT INTO public.plan_features VALUES ('2f4bfe90-8e01-4ca4-a55d-2c31145d25ac', '00000000-0000-0000-0000-000000000a03', 'max_stories', true, NULL);
INSERT INTO public.plan_features VALUES ('67f15030-1583-4e63-9fc8-23ad2005bbb3', '00000000-0000-0000-0000-000000000a03', 'max_docs', true, NULL);
INSERT INTO public.plan_features VALUES ('98525daa-c9ff-49d1-9c20-8a59fa206c19', '00000000-0000-0000-0000-000000000a03', 'max_mockups', true, NULL);
INSERT INTO public.plan_features VALUES ('c8cd65d6-c905-4fd8-966d-e1d162e098d0', '00000000-0000-0000-0000-000000000a03', 'byoa_agents', true, NULL);


--
-- Data for Name: workflow_templates; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.workflow_templates VALUES ('8e24a670-88c1-40f0-b1eb-563a2ba60edf', 'solo', 'Solo', '1인 작업자. 할당 → 완료.', 1, '[{"pattern": "assign", "role_ref": "step_1", "default_label": "Worker"}]', '{"writer": {"step_1": "Writer"}, "designer": {"step_1": "Designer"}, "developer": {"step_1": "Developer"}}', '[{"name": "{step_1} auto-assign on kickoff", "action": {"side_effects": [{"type": "auto_assign", "assign_to_role": "step_1"}], "auto_reply_mode": "process_and_report"}, "priority": 10, "role_ref": "step_1", "conditions": {"memo_type": ["task"], "trigger_type_slugs": ["kickoff"]}, "match_type": "event"}]', true, true, '2026-05-09 17:02:32.825968+00', '2026-05-09 17:02:32.825968+00');
INSERT INTO public.workflow_templates VALUES ('e9af7016-f527-499b-aab8-b12a59e793bb', 'two-step', 'Two-Step Review', '제출 → 검토. 코드 리뷰, 디자인 검토, 원고 편집, 승인 등.', 2, '[{"pattern": "assign", "role_ref": "step_1", "default_label": "Maker"}, {"pattern": "submit", "role_ref": "step_1"}, {"pattern": "review", "role_ref": "step_2", "default_label": "Reviewer"}]', '{"approval": {"step_1": "Requester", "step_2": "Approver"}, "dev-review": {"step_1": "Developer", "step_2": "Tech Lead"}, "content-edit": {"step_1": "Writer", "step_2": "Editor"}, "design-review": {"step_1": "Designer", "step_2": "Art Director"}}', '[{"name": "{step_1} auto-assign on kickoff", "action": {"side_effects": [{"type": "auto_assign", "assign_to_role": "step_1"}], "auto_reply_mode": "process_and_report"}, "priority": 10, "role_ref": "step_1", "conditions": {"memo_type": ["task"], "trigger_type_slugs": ["kickoff"]}, "match_type": "event"}, {"name": "{step_1} submit → {step_2} review + status in-review", "action": {"side_effects": [{"type": "update_status", "target_status": "in-review"}], "auto_reply_mode": "process_and_report"}, "priority": 20, "role_ref": "step_2", "conditions": {"event_params": {"reply_author_role": ["step_1"]}, "trigger_type_slugs": ["review_request"]}, "match_type": "event"}, {"name": "{step_2} approve → {step_1} complete notify", "action": {"side_effects": [{"type": "update_status", "target_status": "done"}], "auto_reply_mode": "process_and_report"}, "priority": 30, "role_ref": "step_1", "conditions": {"event_params": {"review_type": ["approve"], "reply_author_role": ["step_2"]}, "trigger_type_slugs": ["review_request"]}, "match_type": "event"}]', true, true, '2026-05-09 17:02:32.825968+00', '2026-05-09 17:02:32.825968+00');
INSERT INTO public.workflow_templates VALUES ('110835c3-a390-43e1-92bb-f8e7131352ca', 'three-step', 'Three-Step Pipeline', '제출 → 1차 검토 → 2차 검토. PO-Dev-QA, 작성-편집-발행 등.', 3, '[{"pattern": "assign", "role_ref": "step_1", "default_label": "Executor"}, {"pattern": "submit", "role_ref": "step_1"}, {"pattern": "review", "role_ref": "step_2", "default_label": "Reviewer"}, {"pattern": "review", "role_ref": "step_3", "default_label": "Approver"}]', '{"campaign": {"step_1": "Planner", "step_2": "Executor", "step_3": "Reviewer"}, "po-dev-qa": {"step_1": "Developer", "step_2": "Product Owner", "step_3": "QA"}, "content-publish": {"step_1": "Writer", "step_2": "Editor", "step_3": "Publisher"}}', '[{"name": "{step_1} auto-assign on kickoff", "action": {"side_effects": [{"type": "auto_assign", "assign_to_role": "step_1"}], "auto_reply_mode": "process_and_report"}, "priority": 10, "role_ref": "step_1", "conditions": {"memo_type": ["task"], "trigger_type_slugs": ["kickoff"]}, "match_type": "event"}, {"name": "{step_1} submit → {step_2} review + in-review", "action": {"side_effects": [{"type": "update_status", "target_status": "in-review"}], "auto_reply_mode": "process_and_report"}, "priority": 20, "role_ref": "step_2", "conditions": {"event_params": {"reply_author_role": ["step_1"]}, "trigger_type_slugs": ["review_request"]}, "match_type": "event"}, {"name": "{step_2} approve → {step_3} final review", "action": {"side_effects": [], "auto_reply_mode": "process_and_report"}, "priority": 30, "role_ref": "step_3", "conditions": {"event_params": {"review_type": ["approve"], "reply_author_role": ["step_2"]}, "trigger_type_slugs": ["review_request"]}, "match_type": "event"}, {"name": "{step_3} approve → {step_2} complete notify", "action": {"side_effects": [{"type": "update_status", "target_status": "done"}], "auto_reply_mode": "process_and_report"}, "priority": 40, "role_ref": "step_2", "conditions": {"event_params": {"review_type": ["approve"], "reply_author_role": ["step_3"]}, "trigger_type_slugs": ["qa_request"]}, "match_type": "event"}]', true, true, '2026-05-09 17:02:32.825968+00', '2026-05-09 17:02:32.825968+00');
INSERT INTO public.workflow_templates VALUES ('d5f2969f-16fa-4e47-ab5e-d5b8146b8337', 'kanban', 'Kanban Flow', '상태 전이 기반 알림. 역할 구분 없이 상태 변경 시 팀 알림.', 0, '[{"pattern": "assign", "role_ref": "step_1", "default_label": "Member"}]', '{}', '[{"name": "Status in-review → team notify", "action": {"side_effects": [], "auto_reply_mode": "process_and_report"}, "priority": 10, "role_ref": "step_1", "conditions": {"event_params": {"new_status": ["in-review"]}, "trigger_type_slugs": ["status_changed"]}, "match_type": "event"}, {"name": "Status done → team notify", "action": {"side_effects": [], "auto_reply_mode": "process_and_report"}, "priority": 20, "role_ref": "step_1", "conditions": {"event_params": {"new_status": ["done"]}, "trigger_type_slugs": ["status_changed"]}, "match_type": "event"}]', true, true, '2026-05-09 17:02:32.825968+00', '2026-05-09 17:02:32.825968+00');


--
-- PostgreSQL database dump complete
--


