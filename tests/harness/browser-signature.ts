import { signTypedData, SignTypedDataVersion, type MessageTypes, type TypedMessage } from "@metamask/eth-sig-util";
import { mnemonicToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { TEST_ACCOUNTS, TEST_MNEMONIC } from "./local-chain";

/** Sign the exact JSON sent to eth_signTypedData_v4 with MetaMask's encoder.
 * Only the public Hardhat test mnemonic is used, never a user's wallet key.
 */
export function signBrowserPayload(data: unknown, accountIndex: number = TEST_ACCOUNTS.owner): Hex {
  const account = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: accountIndex });
  const key = account.getHdKey().privateKey;
  if (!key) throw new Error("test account has no signing key");
  return signTypedData({
    privateKey: Buffer.from(key),
    data: JSON.parse(JSON.stringify(data)) as TypedMessage<MessageTypes>,
    version: SignTypedDataVersion.V4,
  }) as Hex;
}
