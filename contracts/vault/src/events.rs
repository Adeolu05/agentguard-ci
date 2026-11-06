//! NEP-297 events. Each is written to the log as
//! `EVENT_JSON:{"standard":"agentguard_vault","version":"1.0.0","event":"<name>","data":[...]}`.

use near_sdk::json_types::U128;
use near_sdk::{near, AccountId};

use crate::types::{Decision, RequestStatus};

#[near(serializers = [json])]
pub struct PaymentDecisionLog {
    pub key: String,
    pub request_id: String,
    pub recipient_id: String,
    pub amount: U128,
    pub decision: Decision,
    pub reason_codes: Vec<String>,
    pub replay: bool,
    pub memo: Option<String>,
}

#[near(serializers = [json])]
pub struct PaymentSettledLog {
    pub key: String,
    pub status: RequestStatus,
    pub recipient_id: AccountId,
    pub amount: U128,
    pub reason_codes: Vec<String>,
}

#[near(serializers = [json])]
pub struct ApprovalLog {
    pub key: String,
    /// APPROVED, REJECTED, EXPIRED or NOT_APPROVED.
    pub outcome: String,
    pub reason_codes: Vec<String>,
}

/// Expired pending requests that were removed. Only the keys are logged: 50 keys of 136
/// characters fit in NEAR's 16 KiB log limit even if every character needs escaping.
#[near(serializers = [json])]
pub struct PendingExpiredLog {
    pub keys: Vec<String>,
}

#[near(serializers = [json])]
pub struct PolicyUpdatedLog {
    pub policy_hash: String,
}

#[near(serializers = [json])]
pub struct AgentChangedLog {
    pub old_agent_id: AccountId,
    pub new_agent_id: AccountId,
}

#[near(serializers = [json])]
pub struct OwnerActionLog {
    pub owner_id: AccountId,
}

#[near(serializers = [json])]
pub struct WithdrawnLog {
    pub owner_id: AccountId,
    pub amount: U128,
}

#[near(event_json(standard = "agentguard_vault"))]
pub enum VaultEvent {
    #[event_version("1.0.0")]
    PaymentDecision(Vec<PaymentDecisionLog>),
    #[event_version("1.0.0")]
    PaymentSettled(Vec<PaymentSettledLog>),
    #[event_version("1.0.0")]
    ApprovalDecision(Vec<ApprovalLog>),
    #[event_version("1.0.0")]
    PendingExpired(Vec<PendingExpiredLog>),
    #[event_version("1.0.0")]
    PolicyUpdated(Vec<PolicyUpdatedLog>),
    #[event_version("1.0.0")]
    AgentChanged(Vec<AgentChangedLog>),
    #[event_version("1.0.0")]
    Paused(Vec<OwnerActionLog>),
    #[event_version("1.0.0")]
    Unpaused(Vec<OwnerActionLog>),
    #[event_version("1.0.0")]
    Withdrawn(Vec<WithdrawnLog>),
}
