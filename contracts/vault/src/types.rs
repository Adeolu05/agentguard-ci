//! Data types stored by the vault and returned by its methods.

use near_sdk::json_types::{U128, U64};
use near_sdk::{near, AccountId};

/// At most this many allowlisted recipients (bounds the gas of every membership check).
pub const MAX_RECIPIENTS: usize = 100;
/// At most this many requests may wait for approval at once (bounds storage and the owner's queue).
pub const MAX_PENDING: u32 = 50;
/// Identifiers (request IDs, idempotency keys): 1 to 128 printable ASCII characters,
/// the same rule as the AgentGuard core engine.
pub const MAX_IDENTIFIER_LEN: usize = 128;
/// Memos: at most 256 characters, the same limit as the core engine.
pub const MAX_MEMO_CHARS: usize = 256;
/// Daily window offsets, in minutes: -14:00 to +14:00, as in the YAML policy.
pub const MAX_OFFSET_MINUTES: i32 = 14 * 60;
/// Approval lifetime bounds: 1 second to 7 days, as in the YAML policy.
pub const MAX_APPROVAL_TTL_SECONDS: u32 = 7 * 24 * 3600;
/// Maximum length of the recorded source-policy hash.
pub const MAX_POLICY_HASH_LEN: usize = 128;

/// Reason codes. Names shared with `@agentguard/core` mean the same rule.
pub mod reason {
    pub const REQUEST_ID_INVALID: &str = "REQUEST_ID_INVALID";
    pub const RECIPIENT_INVALID: &str = "RECIPIENT_INVALID";
    pub const IDEMPOTENCY_KEY_INVALID: &str = "IDEMPOTENCY_KEY_INVALID";
    pub const MEMO_INVALID: &str = "MEMO_INVALID";
    pub const AMOUNT_ZERO: &str = "AMOUNT_ZERO";
    pub const AGENT_NOT_RECOGNISED: &str = "AGENT_NOT_RECOGNISED";
    pub const RECIPIENT_NOT_ALLOWED: &str = "RECIPIENT_NOT_ALLOWED";
    pub const AMOUNT_EXCEEDS_TRANSACTION_LIMIT: &str = "AMOUNT_EXCEEDS_TRANSACTION_LIMIT";
    pub const DAILY_SPEND_LIMIT_EXCEEDED: &str = "DAILY_SPEND_LIMIT_EXCEEDED";
    pub const DAILY_COUNT_LIMIT_EXCEEDED: &str = "DAILY_COUNT_LIMIT_EXCEEDED";
    pub const APPROVAL_REQUIRED_AMOUNT: &str = "APPROVAL_REQUIRED_AMOUNT";
    pub const APPROVAL_REQUIRED_UNKNOWN_RECIPIENT: &str = "APPROVAL_REQUIRED_UNKNOWN_RECIPIENT";
    pub const APPROVAL_EXPIRED: &str = "APPROVAL_EXPIRED";
    pub const IDEMPOTENT_REPLAY: &str = "IDEMPOTENT_REPLAY";
    pub const IDEMPOTENCY_KEY_CONFLICT: &str = "IDEMPOTENCY_KEY_CONFLICT";
    pub const IDEMPOTENCY_KEY_FINALISED: &str = "IDEMPOTENCY_KEY_FINALISED";
    // Vault-only codes.
    pub const VAULT_PAUSED: &str = "VAULT_PAUSED";
    pub const PENDING_LIMIT_REACHED: &str = "PENDING_LIMIT_REACHED";
    pub const INSUFFICIENT_VAULT_BALANCE: &str = "INSUFFICIENT_VAULT_BALANCE";
    pub const REQUEST_NOT_PENDING: &str = "REQUEST_NOT_PENDING";
    pub const TRANSFER_FAILED: &str = "TRANSFER_FAILED";
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RecipientMode {
    /// Unknown recipients are blocked.
    Allowlist,
    /// Unknown recipients need the owner's approval.
    AllowlistOrApproval,
}

/// The vault's policy. Amounts are yoctoNEAR. Every limit is compared with exact integers.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VaultPolicy {
    /// A single payment strictly greater than this is blocked.
    pub max_transaction: U128,
    /// Payments in one daily window may not add up to more than this.
    pub max_daily_spend: U128,
    /// At most this many payments per daily window.
    pub max_daily_count: u32,
    /// Payments strictly greater than this need the owner's approval.
    pub approval_required_above: Option<U128>,
    pub recipient_mode: RecipientMode,
    pub allowed_recipients: Vec<AccountId>,
    /// The daily window is the calendar day at this fixed UTC offset.
    pub daily_window_utc_offset_minutes: i32,
    pub allow_zero_amount: bool,
    /// A pending request must be approved within this many seconds.
    pub approval_ttl_seconds: u32,
    /// Hash of the source YAML policy (for example "sha256:..."), for traceability.
    pub policy_hash: String,
}

impl VaultPolicy {
    pub fn validate(&self) -> Result<(), String> {
        if self.allowed_recipients.len() > MAX_RECIPIENTS {
            return Err(format!("at most {MAX_RECIPIENTS} allowed recipients"));
        }
        for (i, a) in self.allowed_recipients.iter().enumerate() {
            if self.allowed_recipients[..i].contains(a) {
                return Err(format!("duplicate allowed recipient {a}"));
            }
        }
        if self.daily_window_utc_offset_minutes.abs() > MAX_OFFSET_MINUTES {
            return Err("daily_window_utc_offset_minutes must be between -840 and 840".into());
        }
        if self.approval_ttl_seconds == 0 || self.approval_ttl_seconds > MAX_APPROVAL_TTL_SECONDS {
            return Err(format!(
                "approval_ttl_seconds must be between 1 and {MAX_APPROVAL_TTL_SECONDS}"
            ));
        }
        if self.policy_hash.len() > MAX_POLICY_HASH_LEN
            || !self.policy_hash.bytes().all(|b| (0x21..=0x7e).contains(&b))
        {
            return Err(
                "policy_hash must be printable ASCII without spaces, at most 128 characters".into(),
            );
        }
        Ok(())
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RequestStatus {
    /// Waiting for the owner's approval. Not counted toward the limits.
    Pending,
    /// The transfer is scheduled. Counted toward the limits until it is known to have failed.
    Submitted,
    Paid,
    /// The transfer failed (the receiver does not exist). Its budget was released.
    Failed,
    Rejected,
    /// Reported by `approve` for a request whose approval period has passed. Expired
    /// requests are deleted, never stored with this status.
    Expired,
}

/// A stored request. Blocked requests are never stored.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Request {
    pub request_id: String,
    pub recipient_id: AccountId,
    pub amount: u128,
    pub status: RequestStatus,
    pub created_at_ns: u64,
    /// Daily window the request counts in (set when it is submitted for payment).
    pub window: i64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RequestView {
    pub key: String,
    pub request_id: String,
    pub recipient_id: AccountId,
    pub amount: U128,
    pub status: RequestStatus,
    pub created_at_ns: U64,
    /// For a pending request: true once its approval period has passed.
    pub expired: bool,
}

#[near(serializers = [json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Decision {
    Allow,
    Block,
    RequireApproval,
}

/// Returned by `request_payment`. A blocked request returns normally (it does not panic),
/// so its event stays in the transaction's logs.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaymentDecision {
    pub decision: Decision,
    pub reason_codes: Vec<String>,
    pub replay: bool,
    pub key: String,
    /// The stored status after this call, if a request is stored under `key`.
    pub status: Option<RequestStatus>,
}

/// Returned by `approve` and `reject`.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApprovalOutcome {
    pub key: String,
    /// True only if this call moved the request out of PENDING as asked.
    pub done: bool,
    pub reason_codes: Vec<String>,
    pub status: Option<RequestStatus>,
}

/// Spending in the current daily window.
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Usage {
    pub window: i64,
    pub spent: u128,
    pub count: u32,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UsageView {
    /// The window the counters belong to. If it is not the current window, nothing has been spent in the current one.
    pub window: i64,
    pub current_window: i64,
    pub spent: U128,
    pub count: u32,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfigView {
    pub owner_id: AccountId,
    pub agent_id: AccountId,
    pub paused: bool,
    pub pending_count: u32,
}

/// Request IDs and idempotency keys: 1 to 128 printable ASCII characters, no spaces.
pub fn is_identifier(s: &str) -> bool {
    !s.is_empty() && s.len() <= MAX_IDENTIFIER_LEN && s.bytes().all(|b| (0x21..=0x7e).contains(&b))
}

/// Shortens attacker-controlled text before it is written to a log.
pub fn clip(s: &str, max_chars: usize) -> String {
    s.chars().take(max_chars).collect()
}
