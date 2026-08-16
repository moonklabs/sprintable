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
from app.models.deletion_audit import DeletionAuditLog
from app.models.dependency import ItemDependency
from app.models.device_installation import DeviceInstallation, DeviceProofChallenge
from app.models.entity_slug_history import EntitySlugHistory
from app.models.embedding import Embedding
from app.models.evidence import Evidence
from app.models.event import Event
from app.models.event_outbox import EventOutbox
from app.models.delivery_job import DeliveryJob
from app.models.gate import Gate
from app.models.github_installation import GithubInstallation, GithubInstallNonce, GithubWebhookDelivery
from app.models.hitl import HitlPolicy, HitlRequest
from app.models.judgment import Judgment
from app.models.usage_meter import UsageMeter
from app.models.user import RefreshToken, User
from app.models.workflow_version import WorkflowVersion
from app.models.api_key import ApiKey
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
from app.models.push_device import PushDevice
from app.models.doc import Doc, DocShareToken, DocSlugAlias
from app.models.mention import Mention
from app.models.reference import Reference
from app.models.reference_semantic_candidate import ReferenceSemanticCandidate
from app.models.meeting import Meeting
from app.models.conversation import Conversation, ConversationMessage, ConversationParticipant
from app.models.conversation_webhook_delivery import ConversationWebhookDelivery
from app.models.user_block import UserBlock
from app.models.notification import InboxItem, Notification, NotificationSetting
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
# fix(2026-07-28, #2201 후속 CI 적출): app/models/*.py 파일 목록 대 이 파일의 import 목록을
# 전수 대조해, `import app.models`만으로는 Base.metadata에 안 잡히는 모듈 11개를 찾았다
# (2026-07-20 hitl_config/participation 건과 동일 결함 클래스). 이 PR이 실제로 필요한 것은
# `event`(Event/"events" 테이블) 하나뿐이라 그것만 여기서 등재한다 — 나머지 10개(activity_log·
# plan_feature·project_api_key·label·onboarding_event·verdict·workflow_execution_log·
# workflow_line·workflow_template·workflow_trigger_type)는 등재 시 destructive_schema
# 테스트(101개 파일 × 파일당 create_all/drop_all) 총소요가 CI 예산(25분, 기준선 16~17분)을
# 넘겨 별도 스토리로 분리 — "[인프라·CI] 모델 하나 늘 때마다 CI가 몇 분씩 느려진다 — 집합
# 모듈 누락 10건을 «등재할 수 없는» 상태다"(id 69d7380e-9567-47ed-9194-d9784cbf637a).
# "등재를 미루는 것"이 아니라 "파일마다 전체 스키마를 create_all/drop_all하는 구조 자체를
# 먼저 손보는 것"이 그 스토리의 실제 과제.
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
    "PushDevice",
    "Doc",
    "Goal",
    "Hypothesis",
    "HypothesisEpicLink",
    "HypothesisSprintLink",
    "HypothesisStoryLink",
    "InboxItem",
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
]
