import { encodeFunctionData, type Address, type PublicClient, type WalletClient } from "viem";
import { base } from "viem/chains";
import { UNISWAP, USDC, WETH } from "./addresses.js";
import { erc20Abi } from "./abi.js";
import { buildSwap, bestQuote, submitSwap, type Quote, type SwapPlan } from "./dex.js";
import { checkOrder, recordTrade, type Balances, type OrderIntent } from "./policy.js";
import { parseUnits, usdc } from "./money.js";
import { audit } from "./audit.js";
import { estimateGasPrice, nextNonce, tokenDecimals } from "./wallet.js";
import type { AgentState, Principal } from "./types.js";

/**
 * Trade execution, shared by the agent and the owner.
 *
 * The single difference between the two callers is the `principal` passed down,
 * which is what `checkOrder` uses to decide whether policy gates apply. Owner
 * trades bypass limits but not solvency, and still go through the same quoting
 * and slippage protection.
 */

export interface TradeRequest {
  side: "buy" | "sell";
  /** "buy" spends USDC for WETH. "sell" spends WETH for USDC. */
  usdcAmount?: string;
  /** For sells: exact WETH amount to liquidate. Mutually exclusive with usdcAmount. */
  wethAmount?: string;
  fee?: number;
}

export type TradeOutcome =
  | { status: "rejected"; reasons: string[]; intent: OrderIntent }
  | { status: "no-quote"; note: string }
  | { status: "planned"; intent: OrderIntent; quote: Quote; amountOutMinimum: bigint; approvalNeeded: bigint }
  | { status: "sent"; intent: OrderIntent; quote: Quote; txHash: string; approvalTxHash: string | null };

function intentFrom(
  request: TradeRequest,
  tokenIn: Address,
  tokenOut: Address,
  notionalUsdc: string,
  strategy: string,
): OrderIntent {
  return {
    side: request.side,
    tokenIn,
    tokenOut,
    notionalUsdc,
    increasesExposure: request.side === "buy",
    strategy,
  };
}

async function ensureAllowance(
  client: PublicClient,
  wallet: WalletClient,
  account: Address,
  token: Address,
  amount: bigint,
  nonce: number,
  gasPrice: bigint,
): Promise<{ hash: string | null }> {
  const current = await client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [account, UNISWAP.swapRouter02],
  });
  if (current >= amount) return { hash: null };

  // Exact-amount approval, not an infinite one. An unlimited standing allowance
  // to a router is a standing loss if that router is ever compromised; the
  // extra gas is cheap insurance on a wallet that holds real funds.
  const hash = await wallet.sendTransaction({
    account,
    chain: base,
    to: token,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [UNISWAP.swapRouter02, amount],
    }),
    value: 0n,
    gas: 60_000n,
    nonce,
    maxFeePerGas: gasPrice,
    maxPriorityFeePerGas: gasPrice / 10n,
  });
  return { hash: hash as string };
}

export interface ExecuteOptions {
  client: PublicClient;
  wallet: WalletClient | null;
  account: Address;
  state: AgentState;
  balances: Balances;
  principal: Principal;
  request: TradeRequest;
  strategy?: string;
  /** When false, the trade is priced and validated but never broadcast. */
  live: boolean;
}

export async function executeTrade(opts: ExecuteOptions): Promise<TradeOutcome> {
  const { client, state, balances, principal, request } = opts;
  const strategy = opts.strategy ?? "spot-swap";
  const slippageBps = state.policy.slippageToleranceBps;

  const tokenIn = request.side === "buy" ? USDC : WETH;
  const tokenOut = request.side === "buy" ? WETH : USDC;

  // --- determine size, quoting first for sells so the notional is real ------
  let amountIn: bigint;
  let notionalUsdc: string;

  if (request.side === "buy") {
    const usdcAmount = request.usdcAmount;
    if (!usdcAmount) return { status: "no-quote", note: "buy requires usdcAmount" };
    amountIn = usdc.parse(usdcAmount);
    notionalUsdc = usdcAmount;
  } else {
    const decimals = await tokenDecimals(client, WETH);
    if (request.wethAmount) {
      amountIn = parseUnits(request.wethAmount, decimals);
      const quote = await bestQuote(client, WETH, USDC, amountIn);
      if (!quote) return { status: "no-quote", note: "no WETH/USDC pool to quote" };
      notionalUsdc = usdc.format(quote.amountOut);
    } else {
      // "sell everything" — size from the live WETH balance.
      const held = balances.byToken[WETH.toLowerCase() as Address] ?? 0n;
      if (held === 0n) return { status: "no-quote", note: "no WETH to sell" };
      amountIn = held;
      const quote = await bestQuote(client, WETH, USDC, amountIn);
      if (!quote) return { status: "no-quote", note: "no WETH/USDC pool to quote" };
      notionalUsdc = usdc.format(quote.amountOut);
    }
  }

  const intent = intentFrom(request, tokenIn, tokenOut, notionalUsdc, strategy);

  // --- policy / authority gate ---------------------------------------------
  const verdict = checkOrder(state, intent, balances, principal);
  if (!verdict.ok) {
    audit({ kind: "order.rejected", intent: intent as unknown as Record<string, unknown>, reasons: verdict.reasons, by: principal, at: new Date().toISOString() });
    return { status: "rejected", reasons: verdict.reasons, intent };
  }

  const plan: SwapPlan | null = await buildSwap(client, {
    tokenIn,
    tokenOut,
    amountIn,
    recipient: opts.account,
    slippageBps,
    ...(request.fee !== undefined ? { fee: request.fee } : {}),
  });
  if (!plan) return { status: "no-quote", note: `no route for ${tokenIn} -> ${tokenOut} at size ${amountIn}` };

  const approvalNeeded = request.side === "buy" ? amountIn : 0n;

  if (!opts.live) {
    audit({
      kind: "decision",
      decision: `dry-run ${intent.side}`,
      inputs: { tokenIn, tokenOut, amountIn: amountIn.toString(), amountOut: plan.quote.amountOut.toString(), fee: plan.quote.fee },
      by: principal,
      at: new Date().toISOString(),
    });
    return { status: "planned", intent, quote: plan.quote, amountOutMinimum: plan.amountOutMinimum, approvalNeeded };
  }

  if (!opts.wallet) throw new Error("live trade requested without a wallet client");

  const gas = await estimateGasPrice(client);
  const nonce = await nextNonce(client, opts.account);
  const { hash: approvalTxHash } = await ensureAllowance(
    client,
    opts.wallet,
    opts.account,
    tokenIn,
    amountIn,
    nonce,
    gas.maxFeePerGasWei,
  );
  if (approvalTxHash) {
    const receipt = await client.waitForTransactionReceipt({ hash: approvalTxHash as `0x${string}` });
    if (receipt.status !== "success") {
      audit({ kind: "order.failed", txHash: approvalTxHash, error: "allowance approval reverted", intent: intent as unknown as Record<string, unknown> });
      return { status: "rejected", reasons: ["allowance approval reverted"], intent };
    }
  }

  const { hash } = await (await import("./dex.js")).submitSwap(
    opts.wallet,
    opts.account,
    plan,
    approvalTxHash ? nonce + 1 : nonce,
    { maxFeePerGasWei: gas.maxFeePerGasWei, gasLimit: 300_000n },
  );

  audit({ kind: "order.submitted", intent: intent as unknown as Record<string, unknown>, txHash: hash, by: principal, at: new Date().toISOString() });
  state.lastSentNonce = approvalTxHash ? nonce + 1 : nonce;

  return { status: "sent", intent, quote: plan.quote, txHash: hash, approvalTxHash };
}
