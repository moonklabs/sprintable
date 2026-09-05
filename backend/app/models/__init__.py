from app.models.a2a_task import A2ATask
from app.models.agent_event_seq import AgentEventSeq
from app.models.agent_gateway import AgentEventCursor, AgentGatewaySession
from app.models.agent_deployment import AgentAuditLog, AgentDeployment, AgentPersona
from app.models.agent_routing_rule import AgentRoutingRule
from app.models.agent_run import AgentRun
from app.models.agent_session import AgentSession
from app.models.auth_identity import AuthIdentity, AuthMigration, AuthMigrationEvent
from app.models.auth_native_bootstrap import AuthNativeBootstrapCode
from app.models.oauth_handoff_code import OAuthHandoffCode
from app.models.bridge import BridgeChannelMapping, BridgeUserMapping
from app.models.chat_command_audit_log import ChatCommandAuditLog
from app.models.deletion_audit import DeletionAuditLog
from app.models.dependency import ItemDependency
from app.models.device_installation import DeviceInstallation, DeviceProofChallenge
from app.models.entity_slug_history import EntitySlugHistory
from app.models.embedding import Embedding
from app.models.evidence import Evidence
from app.models.event import Event
from app.models.event_outbox import EventOutbox
from app.models.delivery_job import DeliveryJob
from app.models.channel_connection import ChannelConnection
from app.models.channel_app_credential import ChannelAppCredentials
from app.models.gate import Gate
from app.models.gate_github_check_event import GateGithubCheckEvent
from app.models.github_installation import GithubInstallation, GithubInstallNonce, GithubWebhookDelivery
from app.models.hitl import HitlPolicy, HitlRequest
from app.models.judgment import Judgment
from app.models.usage_meter import UsageMeter
from app.models.user import RefreshToken, User
from app.models.workflow_version import WorkflowVersion
from app.models.api_key import ApiKey
from app.models.agent_auth_failure import AgentAuthFailure
from app.models.agent_api_key_usage_log import AgentApiKeyUsageLog
from app.models.human_api_key import HumanApiKey
from app.models.org_subscription import OrgSubscription
from app.models.pricing_version import PricingVersion
from app.models.offering_version import OfferingVersion
from app.models.grandfather_policy import GrandfatherPolicy
from app.models.billing_ledger_entry import BillingLedgerEntry
from app.models.plan_tier_limit import PlanTierLimit
from app.models.policy_document import PolicyDocument
from app.models.legal_document import LegalDocumentVersion
from app.models.audit import AuditLog
from app.models.webhook_config import WebhookConfig
from app.models.webhook_delivery_nonce import WebhookDeliveryNonce
from app.models.push_device import PushDevice
from app.models.doc import Doc, DocShareToken, DocSlugAlias
from app.models.mention import Mention
from app.models.reference import Reference
from app.models.reference_semantic_candidate import ReferenceSemanticCandidate
from app.models.meeting import Meeting
from app.models.conversation import Conversation, ConversationMessage, ConversationParticipant
from app.models.conversation_webhook_delivery import ConversationWebhookDelivery
from app.models.user_block import UserBlock
from app.models.notification import Notification, NotificationSetting
from app.models.notification_preference import NotificationPreference
from app.models.organization import Organization
from app.models.pm import Goal, Sprint, Story, Task
from app.models.hypothesis import (
    Hypothesis,
    HypothesisEpicLink,
    HypothesisSprintLink,
    HypothesisStoryLink,
)
from app.models.loop import LoopRun
from app.models.story_assignee import StoryAssignee
from app.models.project import OrgMember, Project
from app.models.project_setting import ProjectSetting
from app.models.pull_request_story_link import PullRequestStoryLink
from app.models.doc_chat_nudge_dispatch import DocChatNudgeDispatch
from app.models.retro import RetroAction, RetroItem, RetroSession, RetroVote
from app.models.reward import RewardLedger
from app.models.login_audit_log import LoginAuditLog
from app.models.standup import StandupEntry, StandupFeedback
from app.models.team import TeamMember
from app.models.file_lock import FileLock
from app.models.org_invite import OrgInvite
from app.models.project_access import ProjectAccess
from app.models.member import AgentProjectProfile, Member, MemberIdentityAlias
from app.models.activity_event import ActivityEvent
from app.models.asset import Asset, AssetFolder, AssetLink
from app.models.release_note import ReleaseNote
from app.models.role_template import RoleTemplate
# fix(2026-09-02, story #2255/69d7380e 완주) — #2201/PR#2554(2026-07-28)가 미룬 나머지 10개
# 등재. 재그라운딩(당시 전제 vs 지금): #2293(2026-07-28~08, PR#2576/#2583)이 destructive_schema
# 스위트를 4-way CI 샤드로 이미 쪼갰고, 최근 실측(story #2285 AC4, 2026-08-17)은 샤드당 4~6분·
# 천장 25분 대비 여유 19~21분 — #2201 당시(순차 단일잡·여유 8분)와 전혀 다른 상태. 로컬 실측
# (2026-09-02, disposable PG): 133테이블 create_all 평균 0.219s·drop_all 0.096s → 이 10개 파일
# (16개 모델 클래스) 등재 후에도 파일당 증분은 이 자릿수(초 미만)라 178개 destructive_schema
# 파일 전체로 곱해도 샤드당 여유(19~21분)를 갉아먹는 수준이 아니다(상세 수치는 PR 본문).
from app.models.activity_log import ActivityLog
from app.models.plan_feature import PlanFeature
from app.models.project_api_key import ProjectApiKey
from app.models.label import ItemLabel, Label
from app.models.onboarding_event import OnboardingEvent
from app.models.verdict import Verdict
from app.models.workflow_execution_log import WorkflowExecutionLog
from app.models.workflow_line import (
    WorkflowLineDefinition,
    WorkflowLineDefinitionVersion,
    WorkflowLineStepApproval,
    WorkflowLineStepRun,
    WorkflowLineStepRunEvent,
    WorkflowRoleAssignment,
)
from app.models.workflow_template import WorkflowTemplate
from app.models.workflow_trigger_type import WorkflowTriggerType
# fix(2026-09-02, story #2255 AC6 가드 자체 실증) — lint_model_registration_completeness.py를
# 짓고 처음 돌려보니 위 10개와 별개로 5개가 더 새 있었다(전부 최근 며칠 새 커밋 — #2201/#2255
# 결함 클래스가 그 사이 독립적으로 5번 더 재발한 것). 가드가 스스로를 증명한 사례라 여기서
# 같이 정리한다(발견 즉시 수정) — FK 의존 없음(전수 확認), 등재 저위험.
from app.models.billing_order import BillingOrder
from app.models.connector_registry import OrgConnectorRegistry
from app.models.domain_label import OrgDomainLabel
from app.models.org_billing_key import OrgBillingKey
from app.models.platform_setting import PlatformSetting
from app.models.rejected_relation import RejectedRelation
from app.models.trust_snapshot import OrgMemberTrustSnapshot
from app.models.unattached_snapshot import UnattachedStorySnapshot
from app.models.visual_artifact import ArtifactNode, ArtifactVersion, VisualArtifact
# fix(2026-07-20, #2058 후속 CI 적출): 이 두 모듈이 여기 없어 `import app.models`만으로는
# Base.metadata에 등록 안 됐다 — participation_role을 참조하는 FK(hitl_config.OrgGateOverride/
# MemberGateOverride.role_id, participation.Participation.role_id)를 가진 realdb 테스트가
# create_all() 시점에 NoReferencedTableError로 깨졌다(다른 테스트 파일과 조합 실행 시엔 그
# 파일의 import 경로로 sys.modules에 우연히 이미 로드돼 안 드러났던 것으로 추정 — CI가 파일별로
# 완전히 격리된 새 프로세스로 도는 조건에서 처음 노출).
from app.models.hitl_config import MemberGateOverride, OrgGateOverride, OrgGatePolicy
from app.models.participation import Participation, ParticipationRole
from app.models.chain_escalation_org_config import ChainEscalationOrgConfig
from app.models.chain_circuit_breaker import ChainCircuitBreaker
from app.models.event_definition import EventDefinition
from app.models.recipe_role_binding import RecipeRoleBinding
from app.models.recipe_repeat_schedule import RecipeRepeatSchedule
from app.models.org_metering_key import OrgMeteringKey
from app.models.org_pageview_daily import OrgPageviewDaily
from app.models.org_pageview_utm_daily import OrgPageviewUtmDaily
from app.models.site_post import SitePost
from app.models.site_post_draft import SitePostDraft
from app.models.site_post_version import SitePostVersion
from app.models.channel_post_draft import ChannelPostDraft
from app.models.channel_post_version import ChannelPostVersion
from app.models.channel_publication import ChannelPublication
from app.models.publication_command import PublicationCommand
from app.models.channel_post_image import ChannelPostImage
from app.models.campaign import Campaign
from app.models.org_content_rule import OrgContentRule
from app.models.publication_attempt import PublicationAttempt
from app.models.insight_snapshot import InsightSnapshot

__all__ = [
    "RoleTemplate",
    "OrgMemberTrustSnapshot",
    "AuthIdentity",
    "AuthMigration",
    "AuthMigrationEvent",
    "AuthNativeBootstrapCode",
    "OAuthHandoffCode",
    "DeviceInstallation",
    "DeviceProofChallenge",
    "ArtifactNode",
    "ArtifactVersion",
    "VisualArtifact",
    "ActivityEvent",
    "ReleaseNote",
    "Asset",
    "AssetFolder",
    "AssetLink",
    "AgentProjectProfile",
    "Member",
    "MemberIdentityAlias",
    "AgentAuditLog",
    "AgentDeployment",
    "AgentPersona",
    "AgentRoutingRule",
    "AgentRun",
    "AgentSession",
    "BridgeChannelMapping",
    "BridgeUserMapping",
    "Embedding",
    "EventOutbox",
    "DeliveryJob",
    "Gate",
    "GateGithubCheckEvent",
    "GithubInstallation",
    "GithubInstallNonce",
    "GithubWebhookDelivery",
    "HitlPolicy",
    "HitlRequest",
    "ItemDependency",
    "EntitySlugHistory",
    "Mention",
    "Reference",
    "ReferenceSemanticCandidate",
    "UsageMeter",
    "ApiKey",
    "OrgSubscription",
    "PricingVersion",
    "OfferingVersion",
    "GrandfatherPolicy",
    "BillingLedgerEntry",
    "PlanTierLimit",
    "PolicyDocument",
    "LegalDocumentVersion",
    "AuditLog",
    "WebhookConfig",
    "WebhookDeliveryNonce",
    "PushDevice",
    "Doc",
    "Goal",
    "Hypothesis",
    "HypothesisEpicLink",
    "HypothesisSprintLink",
    "HypothesisStoryLink",
    "LoopRun",
    "Meeting",
    "Notification",
    "Conversation",
    "ConversationMessage",
    "ConversationParticipant",
    "ConversationWebhookDelivery",
    "NotificationPreference",
    "NotificationSetting",
    "OrgInvite",
    "OrgMember",
    "ProjectAccess",
    "Organization",
    "Project",
    "ProjectSetting",
    "PullRequestStoryLink",
    "RetroAction",
    "RetroItem",
    "RetroSession",
    "RetroVote",
    "RewardLedger",
    "Sprint",
    "StandupEntry",
    "StandupFeedback",
    "Story",
    "StoryAssignee",
    "Task",
    "TeamMember",
    "UnattachedStorySnapshot",
    "LoginAuditLog",
    "RefreshToken",
    "User",
    "WorkflowVersion",
    "Event",
    "ActivityLog",
    "PlanFeature",
    "ProjectApiKey",
    "Label",
    "ItemLabel",
    "OnboardingEvent",
    "Verdict",
    "WorkflowExecutionLog",
    "WorkflowLineDefinition",
    "WorkflowLineDefinitionVersion",
    "WorkflowLineStepRun",
    "WorkflowLineStepApproval",
    "WorkflowLineStepRunEvent",
    "WorkflowRoleAssignment",
    "WorkflowTemplate",
    "WorkflowTriggerType",
    "BillingOrder",
    "OrgDomainLabel",
    "OrgConnectorRegistry",
    "OrgBillingKey",
    "PlatformSetting",
    "RejectedRelation",
]
