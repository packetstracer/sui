// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import {
  getObjectFields,
  SuiObjectResponse,
  SuiMoveObject,
  SuiObjectInfo,
  SuiObjectData,
  getObjectId,
  getObjectType,
} from '../types/objects';
import { normalizeSuiObjectId, ObjectId, SuiAddress } from '../types/common';

import { getOption, Option } from '../types/option';
import { CoinStruct } from '../types/coin';
import { StructTag } from '../types/sui-bcs';
import { Infer, literal, number, object, string, union } from 'superstruct';

export const SUI_FRAMEWORK_ADDRESS = '0x2';
export const MOVE_STDLIB_ADDRESS = '0x1';
export const OBJECT_MODULE_NAME = 'object';
export const UID_STRUCT_NAME = 'UID';
export const ID_STRUCT_NAME = 'ID';
export const SUI_TYPE_ARG = `${SUI_FRAMEWORK_ADDRESS}::sui::SUI`;

// `sui::pay` module is used for Coin management (split, join, join_and_transfer etc);
export const PAY_MODULE_NAME = 'pay';
export const PAY_SPLIT_COIN_VEC_FUNC_NAME = 'split_vec';
export const PAY_JOIN_COIN_FUNC_NAME = 'join';
export const COIN_TYPE_ARG_REGEX = /^0x2::coin::Coin<(.+)>$/;

type ObjectData = ObjectDataFull | SuiObjectInfo;
type ObjectDataFull = SuiObjectResponse | SuiMoveObject;

export const CoinMetadataStruct = object({
  decimals: number(),
  name: string(),
  symbol: string(),
  description: string(),
  iconUrl: union([string(), literal(null)]),
  id: union([ObjectId, literal(null)]),
});

export type CoinMetadata = Infer<typeof CoinMetadataStruct>;

/**
 * Utility class for 0x2::coin
 * as defined in https://github.com/MystenLabs/sui/blob/ca9046fd8b1a9e8634a4b74b0e7dabdc7ea54475/sui_programmability/framework/sources/Coin.move#L4
 */
export class Coin {
  static isCoin(data: ObjectData): boolean {
    return Coin.getType(data)?.match(COIN_TYPE_ARG_REGEX) != null;
  }

  static getCoinType(type: string) {
    const [, res] = type.match(COIN_TYPE_ARG_REGEX) ?? [];
    return res || null;
  }

  static getCoinTypeArg(obj: ObjectData) {
    const type = Coin.getType(obj);
    return type ? Coin.getCoinType(type) : null;
  }

  static isSUI(obj: ObjectData) {
    const arg = Coin.getCoinTypeArg(obj);
    return arg ? Coin.getCoinSymbol(arg) === 'SUI' : false;
  }

  static getCoinSymbol(coinTypeArg: string) {
    return coinTypeArg.substring(coinTypeArg.lastIndexOf(':') + 1);
  }

  static getCoinStructTag(coinTypeArg: string): StructTag {
    return {
      address: normalizeSuiObjectId(coinTypeArg.split('::')[0]),
      module: coinTypeArg.split('::')[1],
      name: coinTypeArg.split('::')[2],
      typeParams: [],
    };
  }

  public static getID(obj: ObjectData): ObjectId {
    if ('fields' in obj) {
      return obj.fields.id.id;
    }
    return getObjectId(obj);
  }

  /**
   * Convenience method for select coin objects that has a balance greater than or equal to `amount`
   *
   * @param amount coin balance
   * @param exclude object ids of the coins to exclude
   * @return a list of coin objects that has balance greater than `amount` in an ascending order
   */
  static selectCoinsWithBalanceGreaterThanOrEqual(
    coins: CoinStruct[],
    amount: bigint,
    exclude: ObjectId[] = [],
  ): CoinStruct[] {
    return Coin.sortByBalance(
      coins.filter(
        ({ coinObjectId, balance }) =>
          !exclude.includes(coinObjectId) && BigInt(balance) >= amount,
      ),
    );
  }

  /**
   * Convenience method for select a minimal set of coin objects that has a balance greater than
   * or equal to `amount`. The output can be used for `PayTransaction`
   *
   * @param amount coin balance
   * @param exclude object ids of the coins to exclude
   * @return a minimal list of coin objects that has a combined balance greater than or equal
   * to`amount` in an ascending order. If no such set exists, an empty list is returned
   */
  static selectCoinSetWithCombinedBalanceGreaterThanOrEqual(
    coins: CoinStruct[],
    amount: bigint,
    exclude: ObjectId[] = [],
  ): CoinStruct[] {
    const sortedCoins = Coin.sortByBalance(
      coins.filter(({ coinObjectId }) => !exclude.includes(coinObjectId)),
    );

    const total = Coin.totalBalance(sortedCoins);
    // return empty set if the aggregate balance of all coins is smaller than amount
    if (total < amount) {
      return [];
    } else if (total === amount) {
      return sortedCoins;
    }

    let sum = BigInt(0);
    let ret: CoinStruct[] = [];
    while (sum < total) {
      // prefer to add a coin with smallest sufficient balance
      const target = amount - sum;
      const coinWithSmallestSufficientBalance = sortedCoins.find(
        (coin) => Coin.getBalanceFromCoinStruct(coin) >= target,
      );
      if (coinWithSmallestSufficientBalance) {
        ret.push(coinWithSmallestSufficientBalance);
        break;
      }

      const coinWithLargestBalance = sortedCoins.pop()!;
      ret.push(coinWithLargestBalance);
      sum += BigInt(coinWithLargestBalance.balance);
    }

    return Coin.sortByBalance(ret);
  }

  static totalBalance(coins: CoinStruct[]): bigint {
    return coins.reduce(
      (partialSum, c) => partialSum + Coin.getBalanceFromCoinStruct(c),
      BigInt(0),
    );
  }

  /**
   * Sort coin by balance in an ascending order
   */
  static sortByBalance(coins: CoinStruct[]): CoinStruct[] {
    return [...coins].sort((a, b) =>
      Coin.getBalanceFromCoinStruct(a) < Coin.getBalanceFromCoinStruct(b)
        ? -1
        : Coin.getBalanceFromCoinStruct(a) > Coin.getBalanceFromCoinStruct(b)
        ? 1
        : 0,
    );
  }

  static getBalanceFromCoinStruct(coin: CoinStruct): bigint {
    return BigInt(coin.balance);
  }

  static getBalance(data: ObjectDataFull): bigint | undefined {
    if (!Coin.isCoin(data)) {
      return undefined;
    }
    const balance = getObjectFields(data)?.balance;
    return BigInt(balance);
  }

  private static getType(data: ObjectData): string | undefined {
    if ('status' in data) {
      return getObjectType(data);
    }
    return data.type;
  }
}

export type DelegationData = SuiMoveObject & {
  dataType: 'moveObject';
  type: '0x2::delegation::Delegation';
  fields: {
    active_delegation: Option<number>;
    delegate_amount: number;
    next_reward_unclaimed_epoch: number;
    validator_address: SuiAddress;
    info: {
      id: string;
      version: number;
    };
    coin_locked_until_epoch: Option<SuiMoveObject>;
    ending_epoch: Option<number>;
  };
};

export type DelegationSuiObject = Omit<SuiObjectData, 'data'> & {
  data: DelegationData;
};

// Class for delegation.move
// see https://github.com/MystenLabs/fastnft/blob/161aa27fe7eb8ecf2866ec9eb192e768f25da768/crates/sui-framework/sources/governance/delegation.move
export class Delegation {
  public static readonly SUI_OBJECT_TYPE = '0x2::delegation::Delegation';
  private suiObject: DelegationSuiObject;

  public static isDelegationSuiObject(
    obj: SuiObjectData,
  ): obj is DelegationSuiObject {
    return 'type' in obj && obj.type === Delegation.SUI_OBJECT_TYPE;
  }

  constructor(obj: DelegationSuiObject) {
    this.suiObject = obj;
  }

  public nextRewardUnclaimedEpoch() {
    return this.suiObject.data.fields.next_reward_unclaimed_epoch;
  }

  public activeDelegation() {
    return BigInt(getOption(this.suiObject.data.fields.active_delegation) || 0);
  }

  public delegateAmount() {
    return this.suiObject.data.fields.delegate_amount;
  }

  public endingEpoch() {
    return getOption(this.suiObject.data.fields.ending_epoch);
  }

  public validatorAddress() {
    return this.suiObject.data.fields.validator_address;
  }

  public isActive() {
    return this.activeDelegation() > 0 && !this.endingEpoch();
  }

  public hasUnclaimedRewards(epoch: number) {
    return (
      this.nextRewardUnclaimedEpoch() <= epoch &&
      (this.isActive() || (this.endingEpoch() || 0) > epoch)
    );
  }
}
