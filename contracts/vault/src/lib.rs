//! AgentGuard Vault: an on-chain spending guard for an AI agent on NEAR.
//!
//! The vault holds the funds. The agent account calls `request_payment` (ideally with a
//! function-call key limited to that one method), and the vault enforces the policy
//! itself: recipient allowlist, per-transaction and daily limits, owner approval above a
//! threshold (with expiry), idempotency and a pause switch. Owner methods require exactly
//! 1 yoctoNEAR, which a function-call key cannot attach. See docs/vault-design.md.

use near_sdk::json_types::U128;
use near_sdk::store::{IterableSet, LookupMap};
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError,
};

pub mod events;
pub mod types;

use events::*;
use types::reason::*;
use types::*;

/// Gas reserved for the settlement callback.
pub const CALLBACK_GAS: Gas = Gas::from_tgas(10);
/// `request_payment` refuses to start with less prepaid gas than this, so it can never
/// record a payment and then fail to schedule its transfer and callback.
pub const MIN_REQUEST_GAS: Gas = Gas::from_tgas(30);
/// Storage kept free for the record a call may add (bytes).
const STORAGE_HEADROOM_BYTES: u128 = 1_000;
const NS_PER_SECOND: u64 = 1_000_000_000;
const DAY_NS: i128 = 86_400 * NS_PER_SECOND as i128;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Requests,
    Pending,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Vault {
    owner_id: AccountId,
    agent_id: AccountId,
    paused: bool,
    policy: VaultPolicy,
    usage: Usage,
    /// Every request that was not blocked, by idempotency key. Kept permanently so a key
    /// can never be paid twice.
    requests: LookupMap<String, Request>,
    /// Keys of requests waiting for approval.
    pending: IterableSet<String>,
}

/// Index of the daily window that contains `ts_ns`, for a fixed UTC offset.
pub fn window_at(ts_ns: u64, offset_minutes: i32) -> i64 {
    let shifted = ts_ns as i128 + offset_minutes as i128 * 60 * NS_PER_SECOND as i128;
    shifted.div_euclid(DAY_NS) as i64
}

struct Checks {
    blocking: Vec<&'static str>,
    approval: Vec<&'static str>,
}

#[near]
impl Vault {
    /// Called by the vault account itself, in the same transaction that deploys the code.
    #[init]
    #[private]
    pub fn new(owner_id: AccountId, agent_id: AccountId, policy: VaultPolicy) -> Self {
        let me = env::current_account_id();
        require!(
            owner_id != agent_id && owner_id != me && agent_id != me,
            "owner, agent and vault must be three different accounts"
        );
        if let Err(e) = policy.validate() {
            env::panic_str(&format!("invalid policy: {e}"));
        }
        Self {
            owner_id,
            agent_id,
            paused: false,
            policy,
            usage: Usage::default(),
            requests: LookupMap::new(StorageKey::Requests),
            pending: IterableSet::new(StorageKey::Pending),
        }
    }

    // ---------------------------------------------------------------- agent

    /// Ask the vault to pay `amount` yoctoNEAR to `recipient_id`. Only the agent account may
    /// call it, and it accepts no deposit. A blocked request returns normally with
    /// `decision: BLOCK`, so its event is kept in the logs.
    pub fn request_payment(
        &mut self,
        request_id: String,
        recipient_id: String,
        amount: U128,
        idempotency_key: Option<String>,
        memo: Option<String>,
    ) -> PaymentDecision {
        require!(
            env::predecessor_account_id() == self.agent_id,
            "AGENT_NOT_RECOGNISED: only the configured agent account can request payments"
        );
        require!(
            env::prepaid_gas() >= MIN_REQUEST_GAS,
            "NOT_ENOUGH_GAS: attach at least 30 TGas"
        );
        let amount = amount.0;
        let key = idempotency_key
            .clone()
            .unwrap_or_else(|| format!("request:{request_id}"));
        let memo_ok = memo
            .as_ref()
            .is_none_or(|m| m.chars().count() <= MAX_MEMO_CHARS);
        let log = DecisionContext {
            key: clip(&key, MAX_IDENTIFIER_LEN + 8),
            request_id: clip(&request_id, MAX_IDENTIFIER_LEN),
            recipient_id: clip(&recipient_id, 64),
            amount,
            memo: if memo_ok { memo.clone() } else { None },
        };

        // 1. Input checks.
        let recipient = recipient_id.parse::<AccountId>().ok();
        let mut invalid = Vec::new();
        if !is_identifier(&request_id) {
            invalid.push(REQUEST_ID_INVALID);
        }
        if idempotency_key
            .as_deref()
            .is_some_and(|k| !is_identifier(k))
        {
            invalid.push(IDEMPOTENCY_KEY_INVALID);
        }
        if recipient.is_none() {
            invalid.push(RECIPIENT_INVALID);
        }
        if !memo_ok {
            invalid.push(MEMO_INVALID);
        }
        let Some(recipient) = recipient.filter(|_| invalid.is_empty()) else {
            return log.decide(Decision::Block, invalid, false, None);
        };

        // 2. Static rules.
        let mut checks = self.static_checks(&recipient, amount);

        // 3. Idempotency, before any budget is counted (same rules as the core engine).
        if let Some(existing) = self.requests.get(&key) {
            let status = existing.status;
            let same = existing.request_id == request_id
                && existing.recipient_id == recipient
                && existing.amount == amount;
            if !same {
                return log.decide(
                    Decision::Block,
                    vec![IDEMPOTENCY_KEY_CONFLICT],
                    false,
                    Some(status),
                );
            }
            return match status {
                RequestStatus::Failed | RequestStatus::Rejected | RequestStatus::Expired => log
                    .decide(
                        Decision::Block,
                        vec![IDEMPOTENCY_KEY_FINALISED],
                        false,
                        Some(status),
                    ),
                _ if !checks.blocking.is_empty() => {
                    checks.blocking.push(IDEMPOTENT_REPLAY);
                    log.decide(Decision::Block, checks.blocking, true, Some(status))
                }
                RequestStatus::Pending => {
                    checks.approval.push(IDEMPOTENT_REPLAY);
                    log.decide(
                        Decision::RequireApproval,
                        checks.approval,
                        true,
                        Some(status),
                    )
                }
                RequestStatus::Submitted | RequestStatus::Paid => {
                    log.decide(Decision::Allow, vec![IDEMPOTENT_REPLAY], true, Some(status))
                }
            };
        }

        // 4. Daily limits.
        let now = env::block_timestamp();
        let window = window_at(now, self.policy.daily_window_utc_offset_minutes);
        self.limit_checks(window, amount, &mut checks.blocking);

        // 5. Decision.
        if !checks.blocking.is_empty() {
            let mut reasons = checks.blocking;
            reasons.extend(checks.approval);
            return log.decide(Decision::Block, reasons, false, None);
        }
        if !checks.approval.is_empty() {
            if self.pending.len() >= MAX_PENDING {
                let mut reasons = vec![PENDING_LIMIT_REACHED];
                reasons.extend(checks.approval);
                return log.decide(Decision::Block, reasons, false, None);
            }
            self.store(
                &key,
                request_id,
                recipient,
                amount,
                RequestStatus::Pending,
                now,
                window,
            );
            self.pending.insert(key);
            return log.decide(
                Decision::RequireApproval,
                checks.approval,
                false,
                Some(RequestStatus::Pending),
            );
        }
        if self.available() < amount {
            return log.decide(
                Decision::Block,
                vec![INSUFFICIENT_VAULT_BALANCE],
                false,
                None,
            );
        }
        self.store(
            &key,
            request_id,
            recipient.clone(),
            amount,
            RequestStatus::Submitted,
            now,
            window,
        );
        self.count_spend(window, amount);
        let decision = log.decide(
            Decision::Allow,
            vec![],
            false,
            Some(RequestStatus::Submitted),
        );
        Self::schedule_transfer(key, recipient, amount);
        decision
    }

    // ---------------------------------------------------------------- owner

    /// Pay a pending request, at most once, with its stored recipient and amount. Every rule
    /// except the approval threshold is checked again, under the current policy and time.
    #[payable]
    pub fn approve(&mut self, key: String) -> ApprovalOutcome {
        self.assert_owner();
        let Some(mut req) = self.pending_request(&key) else {
            return self.approval_outcome(key, "NOT_APPROVED", false, vec![REQUEST_NOT_PENDING]);
        };
        let now = env::block_timestamp();
        if self.is_expired(&req, now) {
            req.status = RequestStatus::Expired;
            self.requests.insert(key.clone(), req);
            self.pending.remove(&key);
            return self.approval_outcome(key, "EXPIRED", false, vec![APPROVAL_EXPIRED]);
        }
        let window = window_at(now, self.policy.daily_window_utc_offset_minutes);
        let mut blocking = self.static_checks(&req.recipient_id, req.amount).blocking;
        self.limit_checks(window, req.amount, &mut blocking);
        if blocking.is_empty() && self.available() < req.amount {
            blocking.push(INSUFFICIENT_VAULT_BALANCE);
        }
        if !blocking.is_empty() {
            return self.approval_outcome(key, "NOT_APPROVED", false, blocking);
        }
        req.status = RequestStatus::Submitted;
        req.window = window;
        let (recipient, amount) = (req.recipient_id.clone(), req.amount);
        self.requests.insert(key.clone(), req);
        self.pending.remove(&key);
        self.count_spend(window, amount);
        let outcome = self.approval_outcome(key.clone(), "APPROVED", true, vec![]);
        Self::schedule_transfer(key, recipient, amount);
        outcome
    }

    /// Reject a pending request. It can never be paid afterwards.
    #[payable]
    pub fn reject(&mut self, key: String) -> ApprovalOutcome {
        self.assert_owner();
        let Some(mut req) = self.pending_request(&key) else {
            return self.approval_outcome(key, "NOT_REJECTED", false, vec![REQUEST_NOT_PENDING]);
        };
        req.status = RequestStatus::Rejected;
        self.requests.insert(key.clone(), req);
        self.pending.remove(&key);
        self.approval_outcome(key, "REJECTED", true, vec![])
    }

    #[payable]
    pub fn set_policy(&mut self, policy: VaultPolicy) {
        self.assert_owner();
        if let Err(e) = policy.validate() {
            env::panic_str(&format!("invalid policy: {e}"));
        }
        let policy_hash = policy.policy_hash.clone();
        self.policy = policy;
        VaultEvent::PolicyUpdated(vec![PolicyUpdatedLog { policy_hash }]).emit();
    }

    /// Point the vault at a different agent account. The old agent's keys can no longer get
    /// anything paid, whatever keys its account holds.
    #[payable]
    pub fn set_agent(&mut self, agent_id: AccountId) {
        self.assert_owner();
        require!(
            agent_id != self.owner_id && agent_id != env::current_account_id(),
            "the agent must differ from the owner and the vault"
        );
        let old_agent_id = std::mem::replace(&mut self.agent_id, agent_id.clone());
        VaultEvent::AgentChanged(vec![AgentChangedLog {
            old_agent_id,
            new_agent_id: agent_id,
        }])
        .emit();
    }

    #[payable]
    pub fn pause(&mut self) {
        self.assert_owner();
        self.paused = true;
        VaultEvent::Paused(vec![OwnerActionLog {
            owner_id: self.owner_id.clone(),
        }])
        .emit();
    }

    #[payable]
    pub fn unpause(&mut self) {
        self.assert_owner();
        self.paused = false;
        VaultEvent::Unpaused(vec![OwnerActionLog {
            owner_id: self.owner_id.clone(),
        }])
        .emit();
    }

    /// Send `amount` to the owner. Never more than the balance not needed for storage.
    #[payable]
    pub fn withdraw(&mut self, amount: U128) -> Promise {
        self.assert_owner();
        require!(
            amount.0 <= self.available(),
            "INSUFFICIENT_VAULT_BALANCE: amount exceeds the available balance"
        );
        VaultEvent::Withdrawn(vec![WithdrawnLog {
            owner_id: self.owner_id.clone(),
            amount,
        }])
        .emit();
        Promise::new(self.owner_id.clone()).transfer(NearToken::from_yoctonear(amount.0))
    }

    // ---------------------------------------------------------------- callback

    /// Records the transfer's outcome. Never panics: if it cannot run at all, the request
    /// stays SUBMITTED and keeps counting toward the limits (fail closed).
    #[private]
    pub fn on_transfer_settled(&mut self, key: String) {
        if env::promise_results_count() != 1 {
            return;
        }
        let succeeded = !matches!(
            env::promise_result_checked(0, 64),
            Err(PromiseError::Failed)
        );
        let Some(mut req) = self.requests.get(&key).cloned() else {
            return;
        };
        if req.status != RequestStatus::Submitted {
            return;
        }
        let mut reason_codes = vec![];
        if succeeded {
            req.status = RequestStatus::Paid;
        } else {
            req.status = RequestStatus::Failed;
            reason_codes.push(TRANSFER_FAILED.to_string());
            if self.usage.window == req.window {
                self.usage.spent = self.usage.spent.saturating_sub(req.amount);
                self.usage.count = self.usage.count.saturating_sub(1);
            }
        }
        let log = PaymentSettledLog {
            key: key.clone(),
            status: req.status,
            recipient_id: req.recipient_id.clone(),
            amount: U128(req.amount),
            reason_codes,
        };
        self.requests.insert(key, req);
        VaultEvent::PaymentSettled(vec![log]).emit();
    }

    // ---------------------------------------------------------------- views

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            owner_id: self.owner_id.clone(),
            agent_id: self.agent_id.clone(),
            paused: self.paused,
            pending_count: self.pending.len(),
        }
    }

    pub fn get_policy(&self) -> VaultPolicy {
        self.policy.clone()
    }

    pub fn get_usage(&self) -> UsageView {
        UsageView {
            window: self.usage.window,
            current_window: window_at(
                env::block_timestamp(),
                self.policy.daily_window_utc_offset_minutes,
            ),
            spent: U128(self.usage.spent),
            count: self.usage.count,
        }
    }

    pub fn get_request(&self, key: String) -> Option<RequestView> {
        self.requests.get(&key).map(|r| self.view(&key, r))
    }

    pub fn list_pending(&self, from_index: u32, limit: u32) -> Vec<RequestView> {
        self.pending
            .iter()
            .skip(from_index as usize)
            .take(limit.min(MAX_PENDING) as usize)
            .filter_map(|k| self.requests.get(k).map(|r| self.view(k, r)))
            .collect()
    }

    /// Balance that can be paid out: the account balance minus the storage stake.
    pub fn available_balance(&self) -> U128 {
        U128(self.available())
    }
}

/// What a `payment_decision` event and the returned `PaymentDecision` are built from.
struct DecisionContext {
    key: String,
    request_id: String,
    recipient_id: String,
    amount: u128,
    memo: Option<String>,
}

impl DecisionContext {
    fn decide(
        self,
        decision: Decision,
        reasons: Vec<&str>,
        replay: bool,
        status: Option<RequestStatus>,
    ) -> PaymentDecision {
        let reason_codes: Vec<String> = reasons.iter().map(|r| r.to_string()).collect();
        VaultEvent::PaymentDecision(vec![PaymentDecisionLog {
            key: self.key.clone(),
            request_id: self.request_id,
            recipient_id: self.recipient_id,
            amount: U128(self.amount),
            decision,
            reason_codes: reason_codes.clone(),
            replay,
            memo: self.memo,
        }])
        .emit();
        PaymentDecision {
            decision,
            reason_codes,
            replay,
            key: self.key,
            status,
        }
    }
}

impl Vault {
    fn assert_owner(&self) {
        near_sdk::assert_one_yocto();
        require!(
            env::predecessor_account_id() == self.owner_id,
            "NOT_OWNER: only the owner can call this method"
        );
    }

    /// Pause, zero amount, per-transaction limit, recipient and approval threshold.
    fn static_checks(&self, recipient: &AccountId, amount: u128) -> Checks {
        let p = &self.policy;
        let mut c = Checks {
            blocking: vec![],
            approval: vec![],
        };
        if self.paused {
            c.blocking.push(VAULT_PAUSED);
        }
        if amount == 0 && !p.allow_zero_amount {
            c.blocking.push(AMOUNT_ZERO);
        }
        if amount > p.max_transaction.0 {
            c.blocking.push(AMOUNT_EXCEEDS_TRANSACTION_LIMIT);
        }
        if !p.allowed_recipients.contains(recipient) {
            match p.recipient_mode {
                RecipientMode::Allowlist => c.blocking.push(RECIPIENT_NOT_ALLOWED),
                RecipientMode::AllowlistOrApproval => {
                    c.approval.push(APPROVAL_REQUIRED_UNKNOWN_RECIPIENT)
                }
            }
        }
        if p.approval_required_above.is_some_and(|t| amount > t.0) {
            c.approval.push(APPROVAL_REQUIRED_AMOUNT);
        }
        c
    }

    fn usage_in(&self, window: i64) -> Usage {
        if self.usage.window == window {
            self.usage
        } else {
            Usage {
                window,
                spent: 0,
                count: 0,
            }
        }
    }

    fn limit_checks(&self, window: i64, amount: u128, blocking: &mut Vec<&'static str>) {
        let usage = self.usage_in(window);
        if usage
            .spent
            .checked_add(amount)
            .is_none_or(|total| total > self.policy.max_daily_spend.0)
        {
            blocking.push(DAILY_SPEND_LIMIT_EXCEEDED);
        }
        if u64::from(usage.count) + 1 > u64::from(self.policy.max_daily_count) {
            blocking.push(DAILY_COUNT_LIMIT_EXCEEDED);
        }
    }

    fn count_spend(&mut self, window: i64, amount: u128) {
        let usage = self.usage_in(window);
        self.usage = Usage {
            window,
            spent: usage.spent + amount,
            count: usage.count + 1,
        };
    }

    fn available(&self) -> u128 {
        let locked = (u128::from(env::storage_usage()) + STORAGE_HEADROOM_BYTES)
            * env::storage_byte_cost().as_yoctonear();
        env::account_balance().as_yoctonear().saturating_sub(locked)
    }

    #[allow(clippy::too_many_arguments)]
    fn store(
        &mut self,
        key: &str,
        request_id: String,
        recipient_id: AccountId,
        amount: u128,
        status: RequestStatus,
        now: u64,
        window: i64,
    ) {
        self.requests.insert(
            key.to_string(),
            Request {
                request_id,
                recipient_id,
                amount,
                status,
                created_at_ns: now,
                window,
            },
        );
    }

    fn pending_request(&self, key: &str) -> Option<Request> {
        self.requests
            .get(key)
            .filter(|r| r.status == RequestStatus::Pending)
            .cloned()
    }

    fn is_expired(&self, req: &Request, now: u64) -> bool {
        let ttl = u64::from(self.policy.approval_ttl_seconds) * NS_PER_SECOND;
        now >= req.created_at_ns.saturating_add(ttl)
    }

    fn view(&self, key: &str, r: &Request) -> RequestView {
        RequestView {
            key: key.to_string(),
            request_id: r.request_id.clone(),
            recipient_id: r.recipient_id.clone(),
            amount: U128(r.amount),
            status: r.status,
            created_at_ns: r.created_at_ns.into(),
            expired: r.status == RequestStatus::Pending
                && self.is_expired(r, env::block_timestamp()),
        }
    }

    fn approval_outcome(
        &self,
        key: String,
        outcome: &str,
        done: bool,
        reasons: Vec<&str>,
    ) -> ApprovalOutcome {
        let reason_codes: Vec<String> = reasons.iter().map(|r| r.to_string()).collect();
        VaultEvent::ApprovalDecision(vec![ApprovalLog {
            key: key.clone(),
            outcome: outcome.to_string(),
            reason_codes: reason_codes.clone(),
        }])
        .emit();
        let status = self.requests.get(&key).map(|r| r.status);
        ApprovalOutcome {
            key,
            done,
            reason_codes,
            status,
        }
    }

    fn schedule_transfer(key: String, recipient: AccountId, amount: u128) {
        Promise::new(recipient)
            .transfer(NearToken::from_yoctonear(amount))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_transfer_settled(key),
            )
            .detach();
    }
}

#[cfg(test)]
mod tests;
