import { encodeFunctionData, type Address, type PublicClient, type WalletClient } from "viem";
import { base } from "viem/chains";
import { UNISWAP, WETH, CHAIN_ID } from "./addresses.js";
import { quoterV2Abi, swapRouter02Abi, uniV3FactoryAbi } from "./abi.js";
import { applySlippage } from "./money.js";

/**
 * Uniswap V3 swap path on Base.
 *
 * Venue is intentionally narrow: one protocol, verified pools, on-chain quoting.
 * Adding a second venue is easy later; adding a wrong address now is expensive.
 */

export const FEE_TIERS = [100, 500, 3000, 10_000] as const;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

export interface PoolInfo {
  fee: number;
  address: Address;
  exists: boolean;
}

export async function listPools(client: PublicClient, tokenA: Address, tokenB: Address): Promise<PoolInfo[]> {
  const out: PoolInfo[] = [];
  for (const fee of FEE_TIERS) {
    try {
      const address = await client.readContract({
        address: UNISWAP.v3Factory,
        abi: uniV3FactoryAbi,
        functionName: "getPool",
        args: [tokenA, tokenB, fee],
      });
      out.push({ fee, address, exists: address !== ZERO_ADDRESS });
    } catch {
      out.push({ fee, address: ZERO_ADDRESS, exists: false });
    }
  }
  return out;
}

export interface Quote {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  amountOut: bigint;
  fee: number;
  pool: Address;
}

/** QuoterV2 is a state-mutating simulation, so this is an eth_call, not a read. */
export async function quoteExactInputSingle(
  client: PublicClient,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  fee: number,
): Promise<bigint | null> {
  try {
    const { result } = await client.simulateContract({
      address: UNISWAP.quoterV2,
      abi: quoterV2Abi,
      functionName: "quoteExactInputSingle",
      args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }],
      account: ZERO_ADDRESS,
    });
    return result as bigint;
  } catch {
    return null;
  }
}

/** Quote across every live pool and take the best output. */
export async function bestQuote(
  client: PublicClient,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
): Promise<Quote | null> {
  const pools = (await listPools(client, tokenIn, tokenOut)).filter((p) => p.exists);
  const quotes: Quote[] = [];
  for (const pool of pools) {
    const amountOut = await quoteExactInputSingle(client, tokenIn, tokenOut, amountIn, pool.fee);
    if (amountOut !== null && amountOut > 0n) {
      quotes.push({ tokenIn, tokenOut, amountIn, amountOut, fee: pool.fee, pool: pool.address });
    }
  }
  if (quotes.length === 0) return null;
  return quotes.reduce((best, q) => (q.amountOut > best.amountOut ? q : best));
}

export interface SwapPlan {
  quote: Quote;
  /** Absolute minimum acceptable output after slippage tolerance. */
  amountOutMinimum: bigint;
  /** Human-readable slippage applied, bps. */
  slippageBps: number;
  deadline: number;
  to: Address;
  data: Hex;
  /** Always 0: the tradeable pair is USDC<->WETH, so no native ETH is sent with the swap. */
  value: bigint;
}

export type Hex = `0x${string}`;

/**
 * Build (but do not send) a swap. The caller decides whether to broadcast.
 * Splitting plan from execute is what makes dry-run the default rather than a
 * flag someone has to remember.
 *
 * Native ETH is deliberately not accepted as an input. SwapRouter02's
 * exactInputSingle does not wrap, so a native-ETH trade would need an extra wrap
 * transaction (more gas, more failure modes, and a window where the wrap is
 * unsold). ETH is reserved for gas; USDC is the base currency.
 */
export async function buildSwap(
  client: PublicClient,
  params: {
    tokenIn: Address;
    tokenOut: Address;
    amountIn: bigint;
    recipient: Address;
    slippageBps: number;
    /** Overrides the auto-picked pool; used to force a specific fee tier. */
    fee?: number;
  },
): Promise<SwapPlan | null> {
  if (params.tokenIn === ZERO_ADDRESS || params.tokenOut === ZERO_ADDRESS) {
    throw new Error("native ETH is not a supported swap input/output; trade USDC<->WETH and keep ETH for gas");
  }

  const requestedFee = params.fee;
  const quote: Quote | null = requestedFee !== undefined
    ? await (async () => {
        const out = await quoteExactInputSingle(client, params.tokenIn, params.tokenOut, params.amountIn, requestedFee);
        if (out === null || out === 0n) return null;
        const pools = await listPools(client, params.tokenIn, params.tokenOut);
        const pool = pools.find((p) => p.fee === requestedFee)?.address ?? ZERO_ADDRESS;
        return { tokenIn: params.tokenIn, tokenOut: params.tokenOut, amountIn: params.amountIn, amountOut: out, fee: requestedFee, pool };
      })()
    : await bestQuote(client, params.tokenIn, params.tokenOut, params.amountIn);

  if (!quote) return null;

  const amountOutMinimum = applySlippage(quote.amountOut, params.slippageBps);
  const deadline = Math.floor(Date.now() / 1000) + 60 * 20;
  const usesNativeInput = params.tokenIn === ZERO_ADDRESS;

  const data = encodeFunctionData({
    abi: swapRouter02Abi,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: params.tokenIn,
        tokenOut: params.tokenOut,
        fee: quote.fee,
        recipient: params.recipient,
        deadline: BigInt(deadline),
        amountIn: params.amountIn,
        amountOutMinimum,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });

  return {
    quote,
    amountOutMinimum,
    slippageBps: params.slippageBps,
    deadline,
    to: UNISWAP.swapRouter02,
    data,
    value: 0n,
  };
}

export interface SendResult {
  hash: `0x${string}`;
}

/** Broadcast a prepared plan. The only place in the codebase that sends a trade. */
export async function submitSwap(
  wallet: WalletClient,
  account: Address,
  plan: SwapPlan,
  nonce: number,
  gas: { maxFeePerGasWei: bigint; gasLimit: bigint },
): Promise<SendResult> {
  const hash = await wallet.sendTransaction({
    account,
    chain: base,
    to: plan.to,
    data: plan.data,
    value: plan.value,
    nonce,
    gas: gas.gasLimit,
    maxFeePerGas: gas.maxFeePerGasWei,
    maxPriorityFeePerGas: gas.maxFeePerGasWei / 10n,
  });
  return { hash: hash as `0x${string}` };
}
