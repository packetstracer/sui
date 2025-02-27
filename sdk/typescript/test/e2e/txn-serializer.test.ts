// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll } from 'vitest';
import {
  bcsForVersion,
  deserializeTransactionBytesToTransactionData,
  LocalTxnDataSerializer,
  MoveCallTransaction,
  PaySuiTx,
  PureArg,
  SUI_SYSTEM_STATE_OBJECT_ID,
  UnserializedSignableTransaction,
  TransactionData,
  TransactionKind,
  PaySuiTransaction,
  PayAllSuiTx,
  PayAllSuiTransaction,
} from '../../src';
import { CallArgSerializer } from '../../src/signers/txn-data-serializers/call-arg-serializer';
import {
  DEFAULT_GAS_BUDGET,
  DEFAULT_RECIPIENT,
  DEFAULT_RECIPIENT_2,
  publishPackage,
  setup,
  TestToolbox,
} from './utils/setup';

describe('Transaction Serialization and deserialization', () => {
  let toolbox: TestToolbox;
  let localSerializer: LocalTxnDataSerializer;
  let packageId: string;

  beforeAll(async () => {
    toolbox = await setup();
    localSerializer = new LocalTxnDataSerializer(toolbox.provider);
    const packagePath = __dirname + '/./data/serializer';
    packageId = await publishPackage(packagePath);
  });

  async function serializeAndDeserialize(
    moveCall: MoveCallTransaction,
  ): Promise<MoveCallTransaction> {
    const localTxnBytes = await localSerializer.serializeToBytes(
      toolbox.address(),
      { kind: 'moveCall', data: moveCall },
    );

    const deserialized =
      (await localSerializer.deserializeTransactionBytesToSignableTransaction(
        localTxnBytes,
      )) as UnserializedSignableTransaction;
    expect(deserialized.kind).toEqual('moveCall');

    const deserializedTxnData = deserializeTransactionBytesToTransactionData(
      bcsForVersion(await toolbox.provider.getRpcApiVersion()),
      localTxnBytes,
    );
    const reserialized = await localSerializer.serializeTransactionData(
      deserializedTxnData,
    );
    expect(reserialized).toEqual(localTxnBytes);
    if ('moveCall' === deserialized.kind) {
      const normalized = {
        ...deserialized.data,
        gasBudget: Number(deserialized.data.gasBudget!.toString(10)),
        gasPayment: '0x' + deserialized.data.gasPayment,
        gasPrice: Number(deserialized.data.gasPrice!.toString(10)),
      };
      return normalized;
    }

    throw new Error('unreachable');
  }

  it('Move Call', async () => {
    const coins = await toolbox.getGasObjectsOwnedByAddress();
    const moveCall = {
      packageObjectId:
        '0000000000000000000000000000000000000000000000000000000000000002',
      module: 'devnet_nft',
      function: 'mint',
      typeArguments: [],
      arguments: [
        'Example NFT',
        'An NFT created by the wallet Command Line Tool',
        'ipfs://bafkreibngqhl3gaa7daob4i2vccziay2jjlp435cf66vhono7nrvww53ty',
      ],
      gasOwner: toolbox.address(),
      gasBudget: DEFAULT_GAS_BUDGET,
      gasPayment: coins[0].objectId,
    };

    const deserialized = await serializeAndDeserialize(moveCall);
    expect(deserialized).toEqual(moveCall);
  });

  it('Move Call With Type Tags', async () => {
    const coins = await toolbox.getGasObjectsOwnedByAddress();
    const moveCall = {
      packageObjectId: packageId,
      module: 'serializer_tests',
      function: 'list',
      typeArguments: ['0x2::coin::Coin<0x2::sui::SUI>', '0x2::sui::SUI'],
      arguments: [coins[0].objectId],
      gasBudget: DEFAULT_GAS_BUDGET,
    };
    await serializeAndDeserialize(moveCall);
  });

  it('Move Shared Object Call', async () => {
    const coins = await toolbox.getGasObjectsOwnedByAddress();

    const [{ sui_address: validator_address }] =
      await toolbox.getActiveValidators();

    const moveCall = {
      packageObjectId:
        '0000000000000000000000000000000000000000000000000000000000000002',
      module: 'sui_system',
      function: 'request_add_delegation',
      typeArguments: [],
      arguments: [
        SUI_SYSTEM_STATE_OBJECT_ID,
        coins[2].objectId,
        validator_address,
      ],
      gasOwner: toolbox.address(),
      gasBudget: DEFAULT_GAS_BUDGET,
      gasPayment: coins[3].objectId,
    };

    const deserialized = await serializeAndDeserialize(moveCall);
    const normalized = {
      ...deserialized,
      arguments: deserialized.arguments.map((d) => '0x' + d),
    };
    expect(normalized).toEqual(moveCall);
  });

  it('Move Call with Pure Arg', async () => {
    const coins = await toolbox.getGasObjectsOwnedByAddress();
    const moveCallExpected = {
      packageObjectId: '0x2',
      module: 'devnet_nft',
      function: 'mint',
      typeArguments: [],
      arguments: [
        'Example NFT',
        'An NFT created by the wallet Command Line Tool',
        'ipfs://bafkreibngqhl3gaa7daob4i2vccziay2jjlp435cf66vhono7nrvww53ty',
      ],
      gasBudget: DEFAULT_GAS_BUDGET,
      gasPayment: coins[0].objectId,
    } as MoveCallTransaction;
    const setArgsExpected = await new CallArgSerializer(
      toolbox.provider,
    ).serializeMoveCallArguments(moveCallExpected);

    const version = await toolbox.provider.getRpcApiVersion();
    const pureArg: PureArg = {
      Pure: bcsForVersion(version).ser('string', 'Example NFT').toBytes(),
    };
    const moveCall = {
      packageObjectId: '0x2',
      module: 'devnet_nft',
      function: 'mint',
      typeArguments: [],
      arguments: [
        pureArg,
        'An NFT created by the wallet Command Line Tool',
        'ipfs://bafkreibngqhl3gaa7daob4i2vccziay2jjlp435cf66vhono7nrvww53ty',
      ],
      gasBudget: DEFAULT_GAS_BUDGET,
      gasPayment: coins[0].objectId,
    } as MoveCallTransaction;
    const setArgs = await new CallArgSerializer(
      toolbox.provider,
    ).serializeMoveCallArguments(moveCall);
    expect(setArgs).toEqual(setArgsExpected);
  });

  it('Serialize and deserialize paySui', async () => {
    const gasBudget = 1000;
    const coins =
      await toolbox.provider.selectCoinsWithBalanceGreaterThanOrEqual(
        toolbox.address(),
        BigInt(DEFAULT_GAS_BUDGET),
      );

    const paySuiTx = {
      PaySui: {
        coins: [
          {
            objectId: coins[0].coinObjectId,
            version: coins[0].version,
            digest: coins[0].digest,
          },
        ],
        recipients: [DEFAULT_RECIPIENT],
        amounts: ['100'],
      },
    } as PaySuiTx;

    const tx_data = {
      messageVersion: 1,
      sender: DEFAULT_RECIPIENT_2,
      kind: { Single: paySuiTx } as TransactionKind,
      gasData: {
        owner: DEFAULT_RECIPIENT_2,
        budget: gasBudget,
        price: 100,
        payment: [
          {
            objectId: coins[1].coinObjectId,
            version: coins[1].version,
            digest: coins[1].digest,
          },
        ],
      },
      expiration: { None: null },
    } as TransactionData;

    const serializedData = await localSerializer.serializeTransactionData(
      tx_data,
    );

    const deserialized =
      await localSerializer.deserializeTransactionBytesToSignableTransaction(
        serializedData,
      );

    const expectedTx = {
      kind: 'paySui',
      data: {
        inputCoins: [coins[0].coinObjectId.substring(2)],
        recipients: [DEFAULT_RECIPIENT.substring(2)],
        amounts: [BigInt(100)] as unknown as string[],
      } as PaySuiTransaction,
    } as UnserializedSignableTransaction;
    expect(expectedTx).toEqual(deserialized);
  });

  it('Serialize and deserialize payAllSui', async () => {
    const gasBudget = 1000;
    const coins =
      await toolbox.provider.selectCoinsWithBalanceGreaterThanOrEqual(
        toolbox.address(),
        BigInt(DEFAULT_GAS_BUDGET),
      );

    const payAllSui = {
      PayAllSui: {
        coins: [
          {
            objectId: coins[0].coinObjectId,
            version: coins[0].version,
            digest: coins[0].digest,
          },
        ],
        recipient: DEFAULT_RECIPIENT,
      },
    } as PayAllSuiTx;
    const tx_data = {
      messageVersion: 1,
      sender: DEFAULT_RECIPIENT_2,
      kind: { Single: payAllSui } as TransactionKind,
      gasData: {
        owner: DEFAULT_RECIPIENT_2,
        budget: gasBudget,
        price: 100,
        payment: [
          {
            objectId: coins[1].coinObjectId,
            version: coins[1].version,
            digest: coins[1].digest,
          },
        ],
      },
      expiration: { None: null },
    } as TransactionData;

    const serializedData = await localSerializer.serializeTransactionData(
      tx_data,
    );

    const deserialized =
      await localSerializer.deserializeTransactionBytesToSignableTransaction(
        serializedData,
      );

    const expectedTx = {
      kind: 'payAllSui',
      data: {
        inputCoins: [coins[0].coinObjectId.substring(2)],
        recipient: DEFAULT_RECIPIENT.substring(2),
      } as PayAllSuiTransaction,
    } as UnserializedSignableTransaction;
    expect(expectedTx).toEqual(deserialized);
  });
});
