"""story #4224(까디르 QA 4588 [P2] · PO 판단 2026-09-23 23:25Z) — 플랫폼 프리셋 단계 메타에 **에이전트 지시용** en action.

에이전트 본문의 «To do:»는 에이전트 지시라 원천이 시드다(화면용 FE 문안과 목적이 다른 문안). 시드 `stage_metadata[stage].action`(ko)은
그대로 두고, `stage_metadata[stage].action_i18n.en`을 더한다. en은 ko action의 도구·게이트·필드 이름(`doc_approval` · `loop_artifacts` ·
`outcome_snapshot` · `claim` · `APPROVE/REJECT` 등 영문 토큰)을 전부 유지한다 — 가드: tests/test_4224_preset_action_i18n_realdb.py.
대상은 org_id IS NULL(플랫폼 프리셋)이고 그 단계가 있을 때만 쓴다(없으면 no-op). 조직 커스텀 정의는 건드리지 않는다.
"""
from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0400"
down_revision = "0399"
branch_labels = None
depends_on = None

EN_ACTIONS: dict[tuple[str, str], str] = {
    ("preset.marketing.blog_article", "planning"): "Plan the topic and keywords (title candidates and outline)",
    ("preset.marketing.blog_article", "concept_confirmed"): "Approve the concept (check the topic, keywords, and outline)",
    ("preset.marketing.blog_article", "writing"): "Write the blog draft",
    ("preset.marketing.blog_article", "verification"): "Review against the content rules, then submit the draft",
    ("preset.marketing.blog_article", "pending_approval"): "Wait until the submitted draft is approved for publishing (approval happens on the draft in Approvals)",
    ("preset.marketing.blog_article", "published"): "The approved draft is published to the blog automatically (no agent task)",
    ("preset.marketing.blog_article", "publish_checked"): "Check the published result at its public URL",
    ("preset.marketing.newsletter", "collect"): "Collect material for the newsletter",
    ("preset.marketing.newsletter", "draft"): "Write the newsletter draft",
    ("preset.marketing.newsletter", "review"): "Review the content, then approve creating the campaign",
    ("preset.marketing.newsletter", "campaign_created"): "Create the Stibee campaign from the approved draft",
    ("preset.marketing.newsletter", "send_requested"): "Set the recipients and send time, then request send approval",
    ("preset.marketing.newsletter", "send_checked"): "Check the send result",
    ("preset.marketing.social_card_news", "draft"): "Write the planning draft (topic, message, card structure)",
    ("preset.marketing.social_card_news", "concept_confirmed"): "Approve the concept (check the message and card structure)",
    ("preset.marketing.social_card_news", "budget_approved"): "Decide which images to generate and the budget, then approve paid generation",
    ("preset.marketing.social_card_news", "live_generation"): "Run the paid image generation",
    ("preset.marketing.social_card_news", "editing"): "Attach the images and write the caption",
    ("preset.marketing.social_card_news", "verification"): "Fill in the verification sheet (check text inside images and brand notation)",
    ("preset.marketing.social_card_news", "pending_approval"): "Final publish approval (right before external publishing)",
    ("preset.marketing.social_card_news", "published"): "Post to the approved channel",
    ("preset.marketing.social_text_post", "draft"): "Write the post draft (topic, message)",
    ("preset.marketing.social_text_post", "concept_confirmed"): "Approve the concept (check the message and tone)",
    ("preset.marketing.social_text_post", "editing"): "Polish the post (length, hashtags, links)",
    ("preset.marketing.social_text_post", "pending_approval"): "Final publish approval (right before external publishing)",
    ("preset.marketing.social_text_post", "published"): "Post to the approved channel",
    ("preset.marketing.video_production", "draft"): "Write the logline and concept draft",
    ("preset.marketing.video_production", "concept_confirmed"): "Approve the concept (check that the story fits the product value)",
    ("preset.marketing.video_production", "animatic"): "Make the animatic (free stills, subtitles, narration), then request a structure review",
    ("preset.marketing.video_production", "structure_passed"): "After confirming the structure, decide what to generate and the budget, then approve paid generation",
    ("preset.marketing.video_production", "live_generation"): "Run paid generation (key cuts, video, voice, lip sync)",
    ("preset.marketing.video_production", "editing"): "Finish editing (color, background music, subtitle size)",
    ("preset.marketing.video_production", "verification"): "Fill in the verification sheet (check picture and sound via frames and subtitle transcription)",
    ("preset.marketing.video_production", "pending_approval"): "Final publish approval (right before external publishing)",
    ("preset.marketing.video_production", "published"): "Post to the approved channel",
    ("preset.workflow.agent_solo", "received"): "Receive the event and understand the context",
    ("preset.workflow.agent_solo", "execute"): "Do the task and produce the result",
    ("preset.workflow.agent_solo", "report"): "Summarize the result and report it in chat or a memo",
    ("preset.workflow.kanban", "assign_step_1"): "Assign an owner",
    ("preset.workflow.kanban_simple", "task_created"): "Pick a task from the backlog and claim it",
    ("preset.workflow.kanban_simple", "in_progress"): "Do the work and update its progress",
    ("preset.workflow.kanban_simple", "done_check"): "Check that the done criteria are met",
    ("preset.workflow.loop_agency", "goal_hypothesis"): "Define the loop's goal, performance hypothesis, and metric",
    ("preset.workflow.loop_agency", "brief_doc_approval"): "Write the execution plan as a brief doc and pass the doc_approval gate",
    ("preset.workflow.loop_agency", "generate_variants"): "Generate several variants from the brief and register them as loop_artifacts",
    ("preset.workflow.loop_agency", "loop_decision"): "Choose one variant (choose) and record why; reject the rest (reject) with reasons",
    ("preset.workflow.loop_agency", "execute"): "Run the selected variant externally (campaign publishing, deployment, etc.)",
    ("preset.workflow.loop_agency", "track_and_learn"): (
        "Measure performance (GA4, etc.) and attribute it to outcome_snapshot, so this loop's choices, reasons, "
        "and results feed the next loop's Context Pack as learning evidence"
    ),
    ("preset.workflow.scrum_3step", "kickoff"): "Write the feature spec and AC",
    ("preset.workflow.scrum_3step", "implementation"): "Write the code and submit a PR",
    ("preset.workflow.scrum_3step", "qa_review"): "Verify against the AC checklist, then APPROVE/REJECT",
    ("preset.workflow.solo", "assign_step_1"): "Assign an owner",
    ("preset.workflow.two_step", "assign_step_1"): "Assign an owner",
    ("preset.workflow.two_step", "submit_step_1"): "Submit",
    ("preset.workflow.two_step", "review_step_2"): "Review",
    ("preset.workflow.three_step", "assign_step_1"): "Assign an owner",
    ("preset.workflow.three_step", "submit_step_1"): "Submit",
    ("preset.workflow.three_step", "review_step_2"): "Review",
    ("preset.workflow.three_step", "review_step_3"): "Review",
}


def upgrade() -> None:
    bind = op.get_bind()
    for (key, stage), en in EN_ACTIONS.items():
        bind.execute(
            sa.text(
                "UPDATE event_definitions "
                "SET stage_metadata = jsonb_set(stage_metadata, CAST(:path AS text[]), jsonb_build_object('en', CAST(:en AS text)), true) "
                "WHERE key = :key AND org_id IS NULL AND stage_metadata ? :stage"
            ),
            {"path": "{" + stage + ",action_i18n}", "en": en, "key": key, "stage": stage},
        )


def downgrade() -> None:
    bind = op.get_bind()
    for (key, stage) in EN_ACTIONS:
        bind.execute(
            sa.text(
                "UPDATE event_definitions SET stage_metadata = stage_metadata #- CAST(:path AS text[]) "
                "WHERE key = :key AND org_id IS NULL AND stage_metadata ? :stage"
            ),
            {"path": "{" + stage + ",action_i18n}", "key": key, "stage": stage},
        )
