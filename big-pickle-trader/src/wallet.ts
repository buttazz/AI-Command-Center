import { createPublicClient, createWalletClient, fallback, http, formatEther, type Address, type PublicClient, type WalletClient, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { CHAIN_ID, DEFAULT_RPCS, KNOWN_TOKENS, WETH } from "./addresses.js";
import { erc20Abi } from "./abi.js";
import type { Balances } from "./policy.js";

const transport = fallback(DEFAULT_RPCS.map((url) => http(url, { timeout: 15_000, retryCount: 2 })), { rank: false });

export function publicClient(): PublicClient {
  return createPublicClient({ chain: { ...base, id: CHAIN_ID }, transport }) as PublicClient;
}

/**
 * The agent's hot key.
 *
 * This is a single EOA and therefore a single point of failure — see the
 * custody note in README. It is deliberately loaded only in the agent process
 * and only when signing is actually needed.
 */
export function agentWalletClient(): WalletClient {
  const key = process.env.AGENT_PRIVATE_KEY;
  if (!key) throw new Error("AGENT_PRIVATE_KEY is not set");
  const normalized = (key.startsWith("0x") ? key : `0x${key}`) as Hex;
  return createWalletClient({
    account: privateKeyToAccount(normalized),
    chain: { ...base, id: CHAIN_ID },
    transport,
  });
}

export function agentAddress(): Address {
  return agentWalletClient().account!.address;
}

export function ownerAddress(): Address | null {
  const v = process.env.OWNER_ADDRESS;
  return v ? (v as Address) : null;
}

export async function readBalances(
  client: PublicClient,
  holder: Address,
  tokens: Address[] = [WETH],
): Promise<Balances> {
  const eth = await client.getBalance({ address: holder });
  const byToken: Record<Address, bigint> = {};
  for (const token of tokens) {
    byToken[token.toLowerCase() as Address] = await client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [holder],
    });
  }
  return { usdc: byToken["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"] ?? 0n, eth, byToken };
}

export async function tokenDecimals(client: PublicClient, token: Address): Promise<number> {
  const known = KNOWN_TOKENS[token];
  if (known) return known.decimals;
  return Number(await client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }));
}

/**
 * Nonce for the agent key.
 *
 * Uses "pending" so we never hand out a nonce that is already consumed by an
 * in-flight transaction — reusing one silently replaces a pending tx, which is
 * exactly the kind of thing that looks like a successful trade and is not.
 */
export async function nextNonce(client: PublicClient, address: Address): Promise<number> {
  return await client.getTransactionCount({ address, blockTag: "pending" });
}

export interface GasEstimate {
  gasPriceWei: bigint;
  maxFeePerGasWei: bigint;
  baseFeePerGasWei: bigint;
  costWei: bigint;
}

export async function estimateGasPrice(client: PublicClient, gasUnits = 300_000n): Promise<GasEstimate> {
  const block = await client.getBlock({ blockTag: "pending" });
  const baseFee = block.baseFeePerGas ?? 0n;
  // Base blocks are ~2s; a small bump over base fee is usually enough.
  const maxFee = baseFee + baseFee / 5n + 1_000_000n;
  return {
    baseFeePerGasWei: baseFee,
    maxFeePerGasWei: maxFee,
    gasPriceWei: maxFee,
    costWei: maxFee * gasUnits,
  };
}

export function describeBalances(balances: Balances): Record<string, string> {
  const out: Record<string, string> = {
    ETH: formatEther(balances.eth),
    USDC: (balances.usdc / 1_000_000n).toString(),
  };
  for (const [token, amount] of Object.entries(balances.byToken)) {
    const meta = KNOWN_TOKENS[token as Address];
    if (meta) out[meta.symbol] = (amount / 10n ** BigInt(meta.decimals)).toString();
  }
  return out;
}
