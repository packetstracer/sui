// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

module sui::staking_pool {
    use sui::balance::{Self, Balance};
    use sui::sui::SUI;
    use std::option::{Self, Option};
    use sui::tx_context::{Self, TxContext};
    use sui::transfer;
    use sui::epoch_time_lock::{Self, EpochTimeLock};
    use sui::object::{Self, ID, UID};
    use sui::locked_coin;
    use sui::coin;
    use sui::math;
    use sui::table::{Self, Table};

    friend sui::validator;
    friend sui::validator_set;

    const EInsufficientPoolTokenBalance: u64 = 0;
    const EWrongPool: u64 = 1;
    const EWithdrawAmountCannotBeZero: u64 = 2;
    const EInsufficientSuiTokenBalance: u64 = 3;
    const EInsufficientRewardsPoolBalance: u64 = 4;
    const EDestroyNonzeroBalance: u64 = 5;
    const ETokenTimeLockIsSome: u64 = 6;
    const EWrongDelegation: u64 = 7;
    const EPendingDelegationDoesNotExist: u64 = 8;
    const ETokenBalancesDoNotMatchExchangeRate: u64 = 9;
    const EDelegationToInactivePool: u64 = 10;
    const EDeactivationOfInactivePool: u64 = 11;
    const EIncompatibleStakedSui: u64 = 12;
    const EWithdrawalInSameEpoch: u64 = 13;
    const EPoolAlreadyActive: u64 = 14;
    const EPoolNotPreactive: u64 = 15;
    const EActivationOfInactivePool: u64 = 16;
    const EDelegationOfZeroSui: u64 = 17;

    /// A staking pool embedded in each validator struct in the system state object.
    struct StakingPool has key, store {
        id: UID,
        /// The epoch at which this pool became active.
        /// The value is `None` if the pool is pre-active and `Some(<epoch_number>)` if active or inactive.
        activation_epoch: Option<u64>,
        /// The epoch at which this staking pool ceased to be active. `None` = {pre-active, active},
        /// `Some(<epoch_number>)` if in-active, and it was de-activated at epoch `<epoch_number>`.
        deactivation_epoch: Option<u64>,
        /// The total number of SUI tokens in this pool, including the SUI in the rewards_pool, as well as in all the principal
        /// in the `StakedSui` object, updated at epoch boundaries.
        sui_balance: u64,
        /// The epoch delegation rewards will be added here at the end of each epoch.
        rewards_pool: Balance<SUI>,
        /// Total number of pool tokens issued by the pool.
        pool_token_balance: u64,
        /// Exchange rate history of previous epochs. Key is the epoch number.
        /// The entries start from the `starting_epoch` of this pool and contain exchange rates at the beginning of each epoch,
        /// i.e., right after the rewards for the previous epoch have been deposited into the pool.
        exchange_rates: Table<u64, PoolTokenExchangeRate>,
        /// Pending delegation amount for this epoch.
        pending_delegation: u64,
        /// Pending delegation withdrawn during the current epoch, emptied at epoch boundaries.
        /// This includes both the principal and rewards SUI withdrawn.
        pending_total_sui_withdraw: u64,
        /// Pending pool token withdrawn during the current epoch, emptied at epoch boundaries.
        pending_pool_token_withdraw: u64,
    }

    /// Struct representing the exchange rate of the delegation pool token to SUI.
    struct PoolTokenExchangeRate has store, copy, drop {
        sui_amount: u64,
        pool_token_amount: u64,
    }

    /// A self-custodial object holding the staked SUI tokens.
    struct StakedSui has key {
        id: UID,
        /// ID of the staking pool we are staking with.
        pool_id: ID,
        // TODO: keeping this field here because the apps depend on it. consider removing it.
        validator_address: address,
        /// The epoch at which the delegation becomes active.
        delegation_activation_epoch: u64,
        /// The staked SUI tokens.
        principal: Balance<SUI>,
        /// If the stake comes from a Coin<SUI>, this field is None. If it comes from a LockedCoin<SUI>, this
        /// field will record the original lock expiration epoch, to be used when unstaking.
        sui_token_lock: Option<EpochTimeLock>,
    }

    // ==== initializer ====

    /// Create a new, empty staking pool.
    public(friend) fun new(ctx: &mut TxContext) : StakingPool {
        let exchange_rates = table::new(ctx);
        StakingPool {
            id: object::new(ctx),
            activation_epoch: option::none(),
            deactivation_epoch: option::none(),
            sui_balance: 0,
            rewards_pool: balance::zero(),
            pool_token_balance: 0,
            exchange_rates,
            pending_delegation: 0,
            pending_total_sui_withdraw: 0,
            pending_pool_token_withdraw: 0,
        }
    }

    // ==== delegation requests ====

    /// Request to delegate to a staking pool. The delegation starts counting at the beginning of the next epoch,
    public(friend) fun request_add_delegation(
        pool: &mut StakingPool,
        stake: Balance<SUI>,
        sui_token_lock: Option<EpochTimeLock>,
        validator_address: address,
        delegator: address,
        delegation_activation_epoch: u64,
        ctx: &mut TxContext
    ) {
        let sui_amount = balance::value(&stake);
        assert!(!is_inactive(pool), EDelegationToInactivePool);
        assert!(sui_amount > 0, EDelegationOfZeroSui);
        let staked_sui = StakedSui {
            id: object::new(ctx),
            pool_id: object::id(pool),
            validator_address,
            delegation_activation_epoch,
            principal: stake,
            sui_token_lock,
        };
        pool.pending_delegation = pool.pending_delegation + sui_amount;
        transfer::transfer(staked_sui, delegator);
    }

    /// Request to withdraw `principal_withdraw_amount` of stake plus rewards from a staking pool.
    /// This amount of principal and corresponding rewards in SUI are withdrawn and transferred to the delegator.
    /// A proportional amount of pool tokens is burnt.
    public(friend) fun request_withdraw_delegation(
        pool: &mut StakingPool,
        staked_sui: StakedSui,
        ctx: &mut TxContext
    ) : u64 {
        let (pool_token_withdraw_amount, principal_withdraw, time_lock) =
            withdraw_from_principal(pool, staked_sui);
        let delegator = tx_context::sender(ctx);
        let principal_withdraw_amount = balance::value(&principal_withdraw);

        let rewards_withdraw = withdraw_rewards_and_burn_pool_tokens(
            pool, principal_withdraw_amount, pool_token_withdraw_amount, tx_context::epoch(ctx)
        );
        let total_sui_withdraw_amount = principal_withdraw_amount + balance::value(&rewards_withdraw);

        pool.pending_total_sui_withdraw = pool.pending_total_sui_withdraw + total_sui_withdraw_amount;
        pool.pending_pool_token_withdraw = pool.pending_pool_token_withdraw + pool_token_withdraw_amount;

        // If the pool is inactive, we immediately process the withdrawal.
        if (is_inactive(pool)) process_pending_delegation_withdraw(pool);

        // TODO: implement withdraw bonding period here.
        if (option::is_some(&time_lock)) {
            locked_coin::new_from_balance(principal_withdraw, option::destroy_some(time_lock), delegator, ctx);
            if (balance::value(&rewards_withdraw) > 0) {
                transfer::transfer(coin::from_balance(rewards_withdraw, ctx), delegator);
            } else {
                balance::destroy_zero(rewards_withdraw);
            }
        } else {
            balance::join(&mut principal_withdraw, rewards_withdraw);
            transfer::transfer(coin::from_balance(principal_withdraw, ctx), delegator);
            option::destroy_none(time_lock);
        };
        total_sui_withdraw_amount

        // payment_amount
    }

    /// Withdraw the principal SUI stored in the StakedSui object, and calculate the corresponding amount of pool
    /// tokens using exchange rate at delegation epoch.
    /// Returns values are amount of pool tokens withdrawn, withdrawn principal portion of SUI, and its
    /// time lock if applicable.
    public(friend) fun withdraw_from_principal(
        pool: &mut StakingPool,
        staked_sui: StakedSui,
    ) : (u64, Balance<SUI>, Option<EpochTimeLock>) {

        // Check that the delegation information matches the pool.
        assert!(staked_sui.pool_id == object::id(pool), EWrongPool);

        let exchange_rate_at_staking_epoch = pool_token_exchange_rate_at_epoch(pool, staked_sui.delegation_activation_epoch);
        let (principal_withdraw, time_lock) = unwrap_staked_sui(staked_sui);
        let pool_token_withdraw_amount = get_token_amount(&exchange_rate_at_staking_epoch, balance::value(&principal_withdraw));

        (
            pool_token_withdraw_amount,
            principal_withdraw,
            time_lock
        )
    }

    fun unwrap_staked_sui(staked_sui: StakedSui): (Balance<SUI>, Option<EpochTimeLock>) {
        let StakedSui {
            id,
            pool_id: _,
            validator_address: _,
            delegation_activation_epoch: _,
            principal,
            sui_token_lock
        } = staked_sui;
        object::delete(id);
        (principal, sui_token_lock)
    }

    // ==== functions called at epoch boundaries ===

    /// Called at epoch advancement times to add rewards (in SUI) to the staking pool.
    public(friend) fun deposit_rewards(pool: &mut StakingPool, rewards: Balance<SUI>) {
        pool.sui_balance = pool.sui_balance + balance::value(&rewards);
        balance::join(&mut pool.rewards_pool, rewards);
    }

    public(friend) fun process_pending_delegations_and_withdraws(pool: &mut StakingPool, ctx: &mut TxContext) {
        let new_epoch = tx_context::epoch(ctx) + 1;
        process_pending_delegation_withdraw(pool);
        process_pending_delegation(pool);
        table::add(
            &mut pool.exchange_rates,
            new_epoch,
            PoolTokenExchangeRate { sui_amount: pool.sui_balance, pool_token_amount: pool.pool_token_balance },
        );
        check_balance_invariants(pool, new_epoch);
    }

    /// Called at epoch boundaries to process pending delegation withdraws requested during the epoch.
    /// Also called immediately upon withdrawal if the pool is inactive.
    fun process_pending_delegation_withdraw(pool: &mut StakingPool) {
        pool.sui_balance = pool.sui_balance - pool.pending_total_sui_withdraw;
        pool.pool_token_balance = pool.pool_token_balance - pool.pending_pool_token_withdraw;
        pool.pending_total_sui_withdraw = 0;
        pool.pending_pool_token_withdraw = 0;
    }

    /// Called at epoch boundaries to process the pending delegation.
    public(friend) fun process_pending_delegation(pool: &mut StakingPool) {
        // Use the most up to date exchange rate with the rewards deposited and withdraws effectuated.
        let latest_exchange_rate =
            PoolTokenExchangeRate { sui_amount: pool.sui_balance, pool_token_amount: pool.pool_token_balance };
        pool.sui_balance = pool.sui_balance + pool.pending_delegation;
        pool.pool_token_balance = get_token_amount(&latest_exchange_rate, pool.sui_balance);
        pool.pending_delegation = 0;
    }

    /// This function does the following:
    ///     1. Calculates the total amount of SUI (including principal and rewards) that the provided pool tokens represent
    ///        at the current exchange rate.
    ///     2. Using the above number and the given `principal_withdraw_amount`, calculates the rewards portion of the
    ///        delegation we should withdraw.
    ///     3. Withdraws the rewards portion from the rewards pool at the current exchange rate. We only withdraw the rewards
    ///        portion because the principal portion was already taken out of the delegator's self custodied StakedSui.
    ///     4. Since SUI tokens are withdrawn, we need to burn the corresponding pool tokens to keep the exchange rate the same.
    fun withdraw_rewards_and_burn_pool_tokens(
        pool: &mut StakingPool,
        principal_withdraw_amount: u64,
        pool_token_withdraw_amount: u64,
        epoch: u64,
    ) : Balance<SUI> {
        let exchange_rate = pool_token_exchange_rate_at_epoch(pool, epoch);
        let total_sui_withdraw_amount = get_sui_amount(&exchange_rate, pool_token_withdraw_amount);
        let reward_withdraw_amount =
            if (total_sui_withdraw_amount >= principal_withdraw_amount)
                total_sui_withdraw_amount - principal_withdraw_amount
            else 0;
        // This may happen when we are withdrawing everything from the pool and
        // the rewards pool balance may be less than reward_withdraw_amount.
        // TODO: FIGURE OUT EXACTLY WHY THIS CAN HAPPEN.
        reward_withdraw_amount = math::min(reward_withdraw_amount, balance::value(&pool.rewards_pool));
        balance::split(&mut pool.rewards_pool, reward_withdraw_amount)
    }

    // ==== preactive pool related ====

    // Called by `validator` module to activate a staking pool.
    public(friend) fun activate_staking_pool(pool: &mut StakingPool, activation_epoch: u64) {
        // Add the initial exchange rate to the table.
        table::add(
            &mut pool.exchange_rates,
            activation_epoch,
            initial_exchange_rate()
        );
        // Check that the pool is preactive and not inactive.
        assert!(is_preactive(pool), EPoolAlreadyActive);
        assert!(!is_inactive(pool), EActivationOfInactivePool);
        // Fill in the active epoch.
        option::fill(&mut pool.activation_epoch, activation_epoch);
    }

    public(friend) fun request_withdraw_delegation_preactive(
        pool: &mut StakingPool,
        staked_sui: StakedSui,
        ctx: &mut TxContext
    ) : u64 {
        // Check that the delegation information matches the pool.
        assert!(staked_sui.pool_id == object::id(pool), EWrongPool);

        assert!(is_preactive(pool), EPoolNotPreactive);

        let delegator = tx_context::sender(ctx);

        let (principal, time_lock) = unwrap_staked_sui(staked_sui);
        let withdraw_amount = balance::value(&principal);
        pool.sui_balance = pool.sui_balance - withdraw_amount;
        pool.pool_token_balance = pool.pool_token_balance - withdraw_amount;

        // TODO: consider sharing code with `request_withdraw_delegation`
        if (option::is_some(&time_lock)) {
            locked_coin::new_from_balance(principal, option::destroy_some(time_lock), delegator, ctx);
        } else {
            transfer::transfer(coin::from_balance(principal, ctx), delegator);
            option::destroy_none(time_lock);
        };
        withdraw_amount
    }

    // ==== inactive pool related ====

    /// Deactivate a staking pool by setting the `deactivation_epoch`. After
    /// this pool deactivation, the pool stops earning rewards. Only delegation
    /// withdraws can be made to the pool.
    public(friend) fun deactivate_staking_pool(pool: &mut StakingPool, deactivation_epoch: u64) {
        // We can't deactivate an already deactivated pool.
        assert!(!is_inactive(pool), EDeactivationOfInactivePool);
        pool.deactivation_epoch = option::some(deactivation_epoch);
    }

    // ==== getters and misc utility functions ====

    public fun sui_balance(pool: &StakingPool): u64 { pool.sui_balance }

    public fun pool_id(staked_sui: &StakedSui): ID { staked_sui.pool_id }

    public fun staked_sui_amount(staked_sui: &StakedSui): u64 { balance::value(&staked_sui.principal) }

    public fun delegation_activation_epoch(staked_sui: &StakedSui): u64 {
        staked_sui.delegation_activation_epoch
    }

    /// Returns true if the input staking pool is preactive.
    public fun is_preactive(pool: &StakingPool): bool{
        option::is_none(&pool.activation_epoch)
    }

    /// Returns true if the input staking pool is inactive.
    public fun is_inactive(pool: &StakingPool): bool {
        option::is_some(&pool.deactivation_epoch)
    }

    /// Split StakedSui `self` to two parts, one with principal `split_amount`,
    /// and the remaining principal is left in `self`.
    /// All the other parameters of the StakedSui like `delegation_activation_epoch` or `pool_id` remain the same.
    public fun split(self: &mut StakedSui, split_amount: u64, ctx: &mut TxContext): StakedSui {
        StakedSui {
            id: object::new(ctx),
            pool_id: self.pool_id,
            validator_address: self.validator_address,
            delegation_activation_epoch: self.delegation_activation_epoch,
            principal: balance::split(&mut self.principal, split_amount),
            sui_token_lock: self.sui_token_lock,
        }
    }

    /// Split the given StakedSui to the two parts, one with principal `split_amount`,
    /// transfer the newly split part to the sender address.
    public entry fun split_staked_sui(c: &mut StakedSui, split_amount: u64, ctx: &mut TxContext) {
        transfer::transfer(split(c, split_amount, ctx), tx_context::sender(ctx));
    }

    /// Consume the staked sui `other` and add its value to `self`.
    /// Aborts if some of the staking parameters are incompatible (pool id, delegation activation epoch, etc.)
    public entry fun join_staked_sui(self: &mut StakedSui, other: StakedSui) {
        assert!(is_equal_staking_metadata(self, &other), EIncompatibleStakedSui);
        let StakedSui {
            id,
            pool_id: _,
            validator_address: _,
            delegation_activation_epoch: _,
            principal,
            sui_token_lock
        } = other;

        object::delete(id);
        if (option::is_some(&sui_token_lock)) {
            epoch_time_lock::destroy_unchecked(option::destroy_some(sui_token_lock));
        } else {
            option::destroy_none(sui_token_lock);
        };
        balance::join(&mut self.principal, principal);
    }

    /// Returns true if all the staking parameters of the staked sui except the principal are identical
    public fun is_equal_staking_metadata(self: &StakedSui, other: &StakedSui): bool {
        if ((self.pool_id != other.pool_id) ||
            (self.validator_address != other.validator_address) ||
            (self.delegation_activation_epoch != other.delegation_activation_epoch)) {
            return false
        };
        if (option::is_none(&self.sui_token_lock) && option::is_none(&other.sui_token_lock)) {
            return true
        };
        if (option::is_some(&self.sui_token_lock) && option::is_some(&other.sui_token_lock)) {
            epoch_time_lock::epoch(option::borrow(&self.sui_token_lock)) ==
                epoch_time_lock::epoch(option::borrow(&other.sui_token_lock))
        } else
            false // locked coin in one and unlocked in another
    }


    public fun pool_token_exchange_rate_at_epoch(pool: &StakingPool, epoch: u64): PoolTokenExchangeRate {
        // If the pool is preactive then the exchange rate is always 1:1.
        if (is_preactive_at_epoch(pool, epoch)) {
            return initial_exchange_rate()
        };
        let clamped_epoch = option::get_with_default(&pool.deactivation_epoch, epoch);
        let epoch = math::min(clamped_epoch, epoch);
        let activation_epoch = *option::borrow(&pool.activation_epoch);

        // Find the latest epoch that's earlier than the given epoch with an entry in the table
        while (epoch >= activation_epoch) {
            if (table::contains(&pool.exchange_rates, epoch)) {
                return *table::borrow(&pool.exchange_rates, epoch)
            };
            epoch = epoch - 1;
        };
        // This line really should be unreachable. Do we want an assert false here?
        initial_exchange_rate()
    }

    /// Calculate the total value of the pending staking requests for this staking pool.
    public fun pending_stake_amount(staking_pool: &StakingPool): u64 {
        staking_pool.pending_delegation
    }

    /// Calculate the current the total withdrawal from the staking pool this epoch.
    public fun pending_stake_withdraw_amount(staking_pool: &StakingPool): u64 {
        staking_pool.pending_total_sui_withdraw
    }

    /// Returns true if the provided staking pool is preactive at the provided epoch.
    fun is_preactive_at_epoch(pool: &StakingPool, epoch: u64): bool{
        // Either the pool is currently preactive or the pool's starting epoch is later than the provided epoch.
        is_preactive(pool) || (*option::borrow(&pool.activation_epoch) > epoch)
    }

    fun get_sui_amount(exchange_rate: &PoolTokenExchangeRate, token_amount: u64): u64 {
        // When either amount is 0, that means we have no delegations with this pool.
        // The other amount might be non-zero when there's dust left in the pool.
        if (exchange_rate.sui_amount == 0 || exchange_rate.pool_token_amount == 0) {
            return token_amount
        };
        let res = (exchange_rate.sui_amount as u128)
                * (token_amount as u128)
                / (exchange_rate.pool_token_amount as u128);
        (res as u64)
    }

    fun get_token_amount(exchange_rate: &PoolTokenExchangeRate, sui_amount: u64): u64 {
        // When either amount is 0, that means we have no delegations with this pool.
        // The other amount might be non-zero when there's dust left in the pool.
        if (exchange_rate.sui_amount == 0 || exchange_rate.pool_token_amount == 0) {
            return sui_amount
        };
        let res = (exchange_rate.pool_token_amount as u128)
                * (sui_amount as u128)
                / (exchange_rate.sui_amount as u128);
        (res as u64)
    }

    fun initial_exchange_rate(): PoolTokenExchangeRate {
        PoolTokenExchangeRate { sui_amount: 0, pool_token_amount: 0 }
    }

    fun check_balance_invariants(pool: &StakingPool, epoch: u64) {
        let exchange_rate = pool_token_exchange_rate_at_epoch(pool, epoch);
        // check that the pool token balance and sui balance ratio matches the exchange rate stored.
        let expected = get_token_amount(&exchange_rate, pool.sui_balance);
        let actual = pool.pool_token_balance;
        assert!(expected == actual, ETokenBalancesDoNotMatchExchangeRate)
    }

    // ==== test-related functions ====

    // Given the `staked_sui` receipt calculate the current rewards (in terms of SUI) for it.
    #[test_only]
    public fun calculate_rewards(
        pool: &StakingPool,
        staked_sui: &StakedSui,
        current_epoch: u64,
    ): u64 {
        let staked_amount = staked_sui_amount(staked_sui);
        let pool_token_withdraw_amount = {
            let exchange_rate_at_staking_epoch = pool_token_exchange_rate_at_epoch(pool, staked_sui.delegation_activation_epoch);
            get_token_amount(&exchange_rate_at_staking_epoch, staked_amount)
        };

        let new_epoch_exchange_rate = pool_token_exchange_rate_at_epoch(pool, current_epoch);
        let total_sui_withdraw_amount = get_sui_amount(&new_epoch_exchange_rate, pool_token_withdraw_amount);

        let reward_withdraw_amount =
            if (total_sui_withdraw_amount >= staked_amount)
                total_sui_withdraw_amount - staked_amount
            else 0;
        reward_withdraw_amount = math::min(reward_withdraw_amount, balance::value(&pool.rewards_pool));

        staked_amount + reward_withdraw_amount
    }
}
