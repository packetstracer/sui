// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { SerializedSignature } from '../../cryptography/signature';
import {
  ObjectId,
  PureArg,
  SuiAddress,
  SuiJsonValue,
  TypeTag,
} from '../../types';

///////////////////////////////
// Exported Types
export interface TransactionCommon {
  /* This field is required for regular transaction but can be omitted for devinspect transaction */
  gasBudget?: number;
  /* If omitted, reference gas price fetched from the connected fullnode will be used */
  gasPrice?: number;
}

export interface TransferObjectTransaction extends TransactionCommon {
  objectId: ObjectId;
  recipient: SuiAddress;
  gasPayment?: ObjectId;
  gasOwner?: SuiAddress;
}

export interface TransferSuiTransaction extends TransactionCommon {
  suiObjectId: ObjectId;
  recipient: SuiAddress;
  amount: number | null;
}

/// Send Coin<T> to a list of addresses, where `T` can be any coin type, following a list of amounts,
/// The object specified in the `gas` field will be used to pay the gas fee for the transaction.
/// The gas object can not appear in `input_coins`. If the gas object is not specified, the RPC server
/// will auto-select one.
export interface PayTransaction extends TransactionCommon {
  /**
   * use `provider.selectCoinSetWithCombinedBalanceGreaterThanOrEqual` to
   * derive a minimal set of coins with combined balance greater than or
   * equal to sent amounts
   */
  inputCoins: ObjectId[];
  recipients: SuiAddress[];
  amounts: string[];
  gasPayment?: ObjectId;
  gasOwner?: SuiAddress;
}

/// Send SUI coins to a list of addresses, following a list of amounts.
/// This is for SUI coin only and does not require a separate gas coin object.
/// Specifically, what pay_sui does are:
/// 1. debit each input_coin to create new coin following the order of
/// amounts and assign it to the corresponding recipient.
/// 2. accumulate all residual SUI from input coins left and deposit all SUI to the first
/// input coin, then use the first input coin as the gas coin object.
/// 3. the balance of the first input coin after tx is sum(input_coins) - sum(amounts) - actual_gas_cost
/// 4. all other input coins other than the first one are deleted.
export interface PaySuiTransaction extends TransactionCommon {
  /**
   * use `provider.selectCoinSetWithCombinedBalanceGreaterThanOrEqual` to
   * derive a minimal set of coins with combined balance greater than or
   * equal to (sent amounts + gas budget).
   */
  inputCoins: ObjectId[];
  recipients: SuiAddress[];
  amounts: string[];
}

/// Send all SUI coins to one recipient.
/// This is for SUI coin only and does not require a separate gas coin object.
/// Specifically, what pay_all_sui does are:
/// 1. accumulate all SUI from input coins and deposit all SUI to the first input coin
/// 2. transfer the updated first coin to the recipient and also use this first coin as gas coin object.
/// 3. the balance of the first input coin after tx is sum(input_coins) - actual_gas_cost.
/// 4. all other input coins other than the first are deleted.
export interface PayAllSuiTransaction extends TransactionCommon {
  inputCoins: ObjectId[];
  recipient: SuiAddress;
}

export interface MergeCoinTransaction extends TransactionCommon {
  primaryCoin: ObjectId;
  coinToMerge: ObjectId;
  gasPayment?: ObjectId;
  gasOwner?: SuiAddress;
}

export interface SplitCoinTransaction extends TransactionCommon {
  coinObjectId: ObjectId;
  splitAmounts: number[];
  gasPayment?: ObjectId;
  gasOwner?: SuiAddress;
}

export interface MoveCallTransaction extends TransactionCommon {
  packageObjectId: ObjectId;
  module: string;
  function: string;
  typeArguments: string[] | TypeTag[];
  arguments: (SuiJsonValue | PureArg)[];
  gasPayment?: ObjectId;
  gasOwner?: SuiAddress;
}

export interface RawMoveCall {
  packageObjectId: ObjectId;
  module: string;
  function: string;
  typeArguments: string[];
  arguments: SuiJsonValue[];
}

/** @deprecated Use `Transaction` class. */
export type UnserializedSignableTransaction =
  | {
      kind: 'moveCall';
      data: MoveCallTransaction;
    }
  | {
      kind: 'transferSui';
      data: TransferSuiTransaction;
    }
  | {
      kind: 'transferObject';
      data: TransferObjectTransaction;
    }
  | {
      kind: 'mergeCoin';
      data: MergeCoinTransaction;
    }
  | {
      kind: 'splitCoin';
      data: SplitCoinTransaction;
    }
  | {
      kind: 'pay';
      data: PayTransaction;
    }
  | {
      kind: 'paySui';
      data: PaySuiTransaction;
    }
  | {
      kind: 'payAllSui';
      data: PayAllSuiTransaction;
    }
  | {
      kind: 'publish';
      data: PublishTransaction;
    };

export type SignedTransaction = {
  transactionBytes: string;
  signature: SerializedSignature;
};

export type SignedMessage = {
  messageBytes: string;
  signature: SerializedSignature;
};

/**
 * A type that represents the possible transactions that can be signed:
 * @deprecated Use `Transaction` instead.
 */
export type SignableTransaction =
  | UnserializedSignableTransaction
  | {
      kind: 'bytes';
      data: Uint8Array;
    };

export type SignableTransactionKind = SignableTransaction['kind'];
export type SignableTransactionData = SignableTransaction['data'];

/**
 * Transaction type used for publishing Move modules to the Sui.
 *
 * Use the util methods defined in [utils/publish.ts](../../utils/publish.ts)
 * to get `compiledModules` bytes by leveraging the sui
 * command line tool.
 *
 * ```
 * const { execSync } = require('child_process');
 * const modulesInBase64 = JSON.parse(execSync(
 *   `${cliPath} move build --dump-bytecode-as-base64 --path ${packagePath}`,
 *   { encoding: 'utf-8' }
 * ));
 *
 * // const modulesInBytes = modules.map((m) => Array.from(fromB64(m)));
 * // ... publish logic ...
 * ```
 *
 */
export interface PublishTransaction extends TransactionCommon {
  compiledModules: ArrayLike<string> | ArrayLike<ArrayLike<number>>;
  gasPayment?: ObjectId;
  gasOwner?: SuiAddress;
}

export type TransactionBuilderMode = 'Commit' | 'DevInspect';

///////////////////////////////
// Exported Abstracts
/**
 * Serializes a transaction to a string that can be signed by a `Signer`.
 */
export interface TxnDataSerializer {
  serializeToBytes(
    signerAddress: SuiAddress,
    txn: UnserializedSignableTransaction,
    mode: TransactionBuilderMode,
  ): Promise<Uint8Array>;
}
