/**
 * Base mainnet (chain id 8453) contract addresses.
 *
 * Every address here was verified against a live Base node, not recalled.
 * Sources:
 *  - Uniswap official Base deployment table
 *    https://developers.uniswap.org/docs/protocols/v3/deployments/v3-base-deployments
 *  - Circle (native USDC on Base)
 *  - on-chain checks in `npm run verify` (eth_getCode + symbol()/decimals() + pool lookups)
 *
 * DO NOT add an address here that has not been confirmed by `npm run verify`.
 * A wrong address in a trading bot means irreversible fund loss.
 */

import { getAddress, type Address } from "viem";

function addr(value: string): Address {
  return getAddress(value);
}

export const CHAIN_ID = 8453;

/** WETH9 — wrapped native ETH on Base. */
export const WETH = addr("0x4200000000000000000000000000000000000006");

/** Native (Circle-issued) USDC on Base. Confirmed symbol="USDC", decimals=6. */
export const USDC = addr("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");

export const UNISWAP = {
  /** UniswapV3Factory — confirmed via official table; getPool() returns live pools. */
  v3Factory: addr("0x33128a8fC17869897dcE68Ed026d694621f6FDfD"),
  /** SwapRouter02 — current recommended V3 swap entrypoint. */
  swapRouter02: addr("0x2626664c2603336E57B271c5C0b26F421741e481"),
  /** QuoterV2 — on-chain quote simulation. */
  quoterV2: addr("0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a"),
  /** UniswapInterfaceMulticall — batched reads. */
  multicall: addr("0x091e99cb1C49331a94dD62755D168E941AbD0693"),
  /** Permit2 — canonical, same address on every chain. */
  permit2: addr("0x000000000022D473030F116dDEE9F6B43aC78BA3"),
  /** UniversalRouter — composes v2/v3 swaps; optional upgrade path. */
  universalRouter: addr("0x6fF5693b99212Da76ad316178A184AB56D299b43"),
} as const;

/*
 * UniswapV2 on Base is intentionally NOT wired up yet. Secondary sources disagree
 * on its addresses (one widely-copied "V2Router02" value for Base is in fact the
 * Base **Sepolia** v3 factory), so it is excluded rather than guessed at.
 * Add it only after `npm run verify` confirms a real contract + a live pool.
 */

export const MULTICALL3 = addr("0xcA11bde05977b3631167028862bE2a173976CA11");

/**
 * Tokens the agent is permitted to hold/trade by default.
 * Kept deliberately small. Owner can widen this at runtime.
 */
export const KNOWN_TOKENS: Record<Address, { symbol: string; decimals: number }> = {
  [WETH]: { symbol: "WETH", decimals: 18 },
  [USDC]: { symbol: "USDC", decimals: 6 },
};

/** Public Base RPCs, fastest-first. Rate limits are aggressive on the public ones. */
export const DEFAULT_RPCS = [
  "https://base.gateway.tenderly.co",
  "https://base-mainnet.public.blastapi.io",
  "https://mainnet.base.org",
] as const;
