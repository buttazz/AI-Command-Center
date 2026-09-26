import { createPublicClient, createWalletClient, fallback, http, parseEther, formatUnits, encodeFunctionData, type PublicClient, type Address } from "viem";
import { base } from "viem/chains";
import { CHAIN_ID, DEFAULT_RPCS, MULTICALL3, UNISWAP, USDC, WETH } from "./addresses.js";
import { erc20Abi, quoterV2Abi, swapRouter02Abi, uniV3FactoryAbi } from "./abi.js";

const transport = fallback(
  DEFAULT_RPCS.map((url) => http(url, { timeout: 15_000, retryCount: 2 })),
  { rank: false },
);

export function publicClient(): PublicClient {
  return createPublicClient({ chain: { ...base, id: CHAIN_ID }, transport }) as PublicClient;
}

const FEE_TIERS = [100, 500, 3000, 10_000];
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

async function isContract(client: PublicClient, address: Address): Promise<boolean> {
  const code = await client.getCode({ address });
  return Boolean(code && code !== "0x");
}

async function main() {
  const client = publicClient();

  const chainId = await client.getChainId();
  if (chainId !== CHAIN_ID) throw new Error(`wrong chain: ${chainId}, expected ${CHAIN_ID}`);
  const block = await client.getBlockNumber();
  console.log(`chain ${chainId} ok, block ${block}\n`);

  console.log("--- contracts exist ---");
  const targets: [string, Address][] = [
    ["WETH", WETH],
    ["USDC", USDC],
    ["Multicall3", MULTICALL3],
    ["v3Factory", UNISWAP.v3Factory],
    ["swapRouter02", UNISWAP.swapRouter02],
    ["quoterV2", UNISWAP.quoterV2],
    ["universalRouter", UNISWAP.universalRouter],
    ["permit2", UNISWAP.permit2],
  ];
  for (const [name, address] of targets) {
    console.log(`  ${(await isContract(client, address)) ? "OK     " : "MISSING"} ${name.padEnd(16)} ${address}`);
  }

  console.log("\n--- token identity ---");
  for (const token of [USDC, WETH]) {
    const [symbol, decimals] = await Promise.all([
      client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }),
      client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
    ]);
    console.log(`  ${token} symbol=${symbol} decimals=${decimals}`);
  }

  console.log("\n--- UniswapV3Factory.tickSpacing sanity (proves it is really a V3 factory) ---");
  for (const fee of FEE_TIERS) {
    const spacing = await client.readContract({
      address: UNISWAP.v3Factory,
      abi: uniV3FactoryAbi,
      functionName: "feeAmountTickSpacing",
      args: [fee],
    });
    console.log(`  fee ${String(fee).padEnd(6)} tickSpacing=${spacing}`);
  }

  console.log("\n--- USDC/WETH V3 pools ---");
  const live: { fee: number; pool: Address }[] = [];
  for (const fee of FEE_TIERS) {
    const pool = await client.readContract({
      address: UNISWAP.v3Factory,
      abi: uniV3FactoryAbi,
      functionName: "getPool",
      args: [USDC, WETH, fee],
    });
    if (pool === ZERO) {
      console.log(`  fee ${String(fee).padEnd(6)} -> none`);
      continue;
    }
    live.push({ fee, pool });
    console.log(`  fee ${String(fee).padEnd(6)} -> ${pool}  (contract=${await isContract(client, pool)})`);
  }

  if (live.length === 0) {
    console.log("\nNO USDC/WETH V3 POOL FOUND — stop and investigate before trading.");
    process.exitCode = 1;
    return;
  }

  console.log("\n--- QuoterV2 live quotes: 0.01 ETH -> USDC ---");
  for (const { fee, pool } of live) {
    try {
      const amountIn = parseEther("0.01");
      const { result } = await client.simulateContract({
        address: UNISWAP.quoterV2,
        abi: quoterV2Abi,
        functionName: "quoteExactInputSingle",
        args: [{ tokenIn: WETH, tokenOut: USDC, amountIn, fee, sqrtPriceLimitX96: 0n }],
        account: ZERO,
      });
      const out = result as bigint;
      const implied = Number(out) / 1e6 / (Number(amountIn) / 1e18);
      console.log(
        `  fee ${String(fee).padEnd(6)} out=${formatUnits(out, 6)} USDC  (~${implied.toFixed(2)} USDC/ETH)  pool=${pool}`,
      );
    } catch (err) {
      console.log(`  fee ${String(fee).padEnd(6)} quote failed: ${(err as Error).message.slice(0, 120)}`);
    }
  }

  console.log("\n--- swap calldata encodes cleanly (no send) ---");
  const target = live[0]!;
  const data = encodeFunctionData({
    abi: swapRouter02Abi,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: WETH,
        tokenOut: USDC,
        fee: target.fee,
        recipient: ZERO,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 1200),
        amountIn: parseEther("0.001"),
        amountOutMinimum: 0n,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
  console.log(`  selector ${data.slice(0, 10)} length ${data.length} chars, fee tier ${target.fee}`);
  if (data.slice(0, 10) !== "0x414bf389") {
    throw new Error(`unexpected selector ${data.slice(0, 10)}, expected exactInputSingle 0x414bf389`);
  }

  console.log("\nverify: PASS");
}

main().catch((err) => {
  console.error("verify: FAIL", err);
  process.exitCode = 1;
});
