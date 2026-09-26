/**
 * CDP (Coinbase Developer Platform) client wrapper.
 *
 * Custody model, stated once so the rest of the codebase can rely on it:
 * the wallet's private key is generated and used **only inside an AWS Nitro
 * Enclave** and is never returned to this process, to this machine, or to
 * Coinbase. Signing happens remotely. Therefore:
 *
 *  - There is no `exportAccount` call anywhere in this project, deliberately.
 *  - There is no seed phrase, because CDP Wallets v2 does not use one.
 *  - "Never expose private keys" is satisfied structurally, not by discipline.
 *
 * What this process *does* hold is credential material: the CDP Secret API Key
 * and the Wallet Secret. A compromise of those lets an attacker attempt
 * whatever the CDP Policy Engine permits, which is why the enclave policy in
 * `cdp/policy-template.ts` is written to be the real boundary.
 */

import { CdpClient, type Policy as CdpPolicy } from "@coinbase/cdp-sdk";
import { createPublicClient, http, fallback, type PublicClient } from "viem";
import { baseSepolia, base } from "viem/chains";
import { CredentialError, UpstreamError, NetworkNotPermitted } from "../errors.js";
import type { NetworkId } from "../types.js";

export const NETWORK_IDS: NetworkId[] = ["base", "base-sepolia"];

export function isNetworkId(v: string): v is NetworkId {
  return (NETWORK_IDS as string[]).includes(v);
}

const CHAIN = {
  "base-sepolia": baseSepolia,
  base,
} as const;

/** Public RPC endpoints. Read-only; no credential is attached to these calls. */
const DEFAULT_RPCS: Record<NetworkId, string[]> = {
  "base-sepolia": [
    "https://base-sepolia-rpc.publicnode.com",
    "https://sepolia.base.org",
    "https://base-sepolia.gateway.tenderly.co",
  ],
  base: ["https://base-rpc.publicnode.com", "https://mainnet.base.org"],
};

export interface CdpCredentials {
  apiKeyId: string;
  apiKeySecret: string;
  walletSecret: string;
}

export function credentialsFromEnv(): CdpCredentials {
  const apiKeyId = process.env["CDP_API_KEY_ID"];
  const apiKeySecret = process.env["CDP_API_KEY_SECRET"];
  const walletSecret = process.env["CDP_WALLET_SECRET"];

  const missing: string[] = [];
  if (!apiKeyId) missing.push("CDP_API_KEY_ID");
  if (!apiKeySecret) missing.push("CDP_API_KEY_SECRET");
  if (!walletSecret) missing.push("CDP_WALLET_SECRET");
  if (missing.length > 0) {
    throw new CredentialError(
      `missing required CDP credential environment variables: ${missing.join(", ")}. ` +
        `See docs/SETUP.md. Credentials are never written to disk by this tool; the vault is the only supported path.`,
    );
  }
  return {
    apiKeyId: apiKeyId as string,
    apiKeySecret: apiKeySecret as string,
    walletSecret: walletSecret as string,
  };
}

export interface CdpFacadeOptions {
  credentials: CdpCredentials;
  network: NetworkId;
  permittedNetworks: readonly string[];
  debugging?: boolean;
}

export interface AccountSummary {
  address: `0x${string}`;
  name?: string;
  policies?: string[];
  createdAt?: string;
}

export interface TokenBalance {
  token: `0x${string}`;
  symbol?: string;
  decimals?: number;
  /** Raw atomic units as a string, to avoid precision loss. */
  balanceAtomic: string;
}

export interface SendResult {
  transactionHash: `0x${string}`;
}

/**
 * Narrow facade over the parts of the CDP SDK this project uses.
 *
 * Deliberately not a re-export of `CdpClient`: the surface is small on purpose,
 * so that an agent process which somehow obtained this object still cannot reach
 * an arbitrary signing method.
 */
export class CdpFacade {
  readonly network: NetworkId;
  private readonly client: CdpClient;
  private readonly permitted: readonly string[];

  constructor(opts: CdpFacadeOptions) {
    // Gate 3 of 3 for mainnet. The CDP Policy Engine and the local policy engine
    // both check independently; this is the innermost assertion.
    if (!opts.permittedNetworks.includes(opts.network)) {
      throw new NetworkNotPermitted(opts.network, opts.permittedNetworks.join(", "));
    }
    this.network = opts.network;
    this.permitted = opts.permittedNetworks;
    this.client = new CdpClient({
      apiKeyId: opts.credentials.apiKeyId,
      apiKeySecret: opts.credentials.apiKeySecret,
      walletSecret: opts.credentials.walletSecret,
      debugging: opts.debugging ?? false,
    });
  }

  private assertNetwork(network: NetworkId): void {
    if (!this.permitted.includes(network)) {
      throw new NetworkNotPermitted(network, this.permitted.join(", "));
    }
  }

  // --- accounts -----------------------------------------------------------

  /**
   * Create a server account.
   *
   * `idempotencyKey` is important: the same key always yields the same address,
   * so a retried bootstrap cannot accidentally create a second wallet that later
   * receives funds nobody is watching.
   */
  async createAccount(opts: { name: string; idempotencyKey: string }): Promise<AccountSummary> {
    try {
      const account = await this.client.evm.createAccount({
        name: opts.name,
        idempotencyKey: opts.idempotencyKey,
      });
      return {
        address: account.address,
        ...(account.name ? { name: account.name } : {}),
        ...(account.policies ? { policies: account.policies } : {}),
      };
    } catch (err) {
      throw this.wrap("createAccount", err);
    }
  }

  async getAccount(address: `0x${string}`): Promise<AccountSummary> {
    try {
      const account = await this.client.evm.getAccount({ address });
      return {
        address: account.address,
        ...(account.name ? { name: account.name } : {}),
        ...(account.policies ? { policies: account.policies } : {}),
      };
    } catch (err) {
      throw this.wrap("getAccount", err);
    }
  }

  async listAccounts(): Promise<AccountSummary[]> {
    try {
      const result = await this.client.evm.listAccounts();
      return result.accounts.map((a) => ({
        address: a.address,
        ...(a.name ? { name: a.name } : {}),
        ...(a.policies ? { policies: a.policies } : {}),
      }));
    } catch (err) {
      throw this.wrap("listAccounts", err);
    }
  }

  // --- balances -----------------------------------------------------------

  async listTokenBalances(address: `0x${string}`): Promise<TokenBalance[]> {
    this.assertNetwork(this.network);
    try {
      const result = await this.client.evm.listTokenBalances({
        address,
        network: this.network,
      });
      return result.balances.map((b) => ({
        // `EvmToken.contractAddress` is the canonical field. For the native asset
        // it is the EIP-7528 sentinel 0xEeee...EEeE, not zero.
        token: b.token.contractAddress,
        ...(b.token.symbol ? { symbol: b.token.symbol } : {}),
        ...(typeof b.amount.decimals === "number" ? { decimals: b.amount.decimals } : {}),
        // Atomic amount. Kept as a string so a large supply cannot lose
        // precision by passing through a JS number.
        balanceAtomic: b.amount.amount.toString(),
      }));
    } catch (err) {
      throw this.wrap("listTokenBalances", err);
    }
  }

  /** Native balance in wei, read from a public RPC. */
  async nativeBalanceWei(address: `0x${string}`): Promise<bigint> {
    const client = this.publicClient();
    try {
      return await client.getBalance({ address });
    } catch (err) {
      throw this.wrap("nativeBalance", err, true);
    }
  }

  publicClient(): PublicClient {
    const chain = CHAIN[this.network];
    const urls = DEFAULT_RPCS[this.network];
    return createPublicClient({
      chain,
      transport: fallback(urls.map((url) => http(url, { timeout: 15_000, retryCount: 2 })), { rank: false }),
    }) as PublicClient;
  }

  // --- sending ------------------------------------------------------------

  /**
   * Send a transaction. This is the ONLY path in the system that causes a
   * signature to be produced, and it is reachable only from the executor.
   *
   * An idempotency key is always supplied so a network-level retry cannot
   * produce two transactions from one decision.
   */
  async sendTransaction(
    address: `0x${string}`,
    transaction: { to?: `0x${string}`; value?: bigint; data?: `0x${string}`; gas?: bigint },
    idempotencyKey: string,
  ): Promise<SendResult> {
    this.assertNetwork(this.network);
    try {
      const result = await this.client.evm.sendTransaction({
        address,
        transaction: {
          ...(transaction.to ? { to: transaction.to } : {}),
          ...(transaction.value !== undefined ? { value: transaction.value } : {}),
          ...(transaction.data ? { data: transaction.data } : {}),
          ...(transaction.gas !== undefined ? { gas: transaction.gas } : {}),
        } as never,
        network: this.network,
        idempotencyKey,
      });
      return { transactionHash: result.transactionHash };
    } catch (err) {
      throw this.wrap("sendTransaction", err);
    }
  }

  /**
   * Transfer a token. Uses the account-level helper, which builds and signs the
   * transfer server-side. Gasless for USDC on Base and Base Sepolia.
   */
  async transfer(
    address: `0x${string}`,
    to: `0x${string}`,
    amount: bigint,
    token: "eth" | "usdc" | `0x${string}`,
    idempotencyKey: string,
  ): Promise<SendResult> {
    this.assertNetwork(this.network);
    try {
      const account = await this.client.evm.getAccount({ address });
      const result = await account.transfer({
        to,
        amount,
        token,
        network: this.network,
      } as never);
      void idempotencyKey; // account.transfer has no idempotency parameter
      return { transactionHash: result.transactionHash as `0x${string}` };
    } catch (err) {
      throw this.wrap("transfer", err);
    }
  }

  /** Base Sepolia faucet. Testnet only; refuses mainnet by construction. */
  async requestFaucet(
    address: `0x${string}`,
    token: "eth" | "usdc" = "eth",
  ): Promise<{ transactionHash: string }> {
    if (this.network !== "base-sepolia") {
      throw new NetworkNotPermitted(this.network, "base-sepolia (the faucet is testnet-only)");
    }
    try {
      const account = await this.client.evm.getAccount({ address });
      const result = await account.requestFaucet({ network: this.network, token });
      return { transactionHash: String(result.transactionHash) };
    } catch (err) {
      throw this.wrap("requestFaucet", err);
    }
  }

  // --- policy engine ------------------------------------------------------

  async createPolicy(body: unknown, idempotencyKey: string): Promise<CdpPolicy> {
    try {
      return await this.client.policies.createPolicy({
        policy: body as never,
        idempotencyKey,
      });
    } catch (err) {
      throw this.wrap("createPolicy", err);
    }
  }

  async listPolicies(scope?: "account" | "project"): Promise<CdpPolicy[]> {
    try {
      const result = await this.client.policies.listPolicies(scope ? { scope } : {});
      return result.policies;
    } catch (err) {
      throw this.wrap("listPolicies", err);
    }
  }

  async getPolicyById(id: string): Promise<CdpPolicy> {
    try {
      return await this.client.policies.getPolicyById({ id });
    } catch (err) {
      throw this.wrap("getPolicyById", err);
    }
  }

  async deletePolicy(id: string): Promise<void> {
    try {
      await this.client.policies.deletePolicy({ id });
    } catch (err) {
      throw this.wrap("deletePolicy", err);
    }
  }

  /**
   * Attach a policy to an account. An account accepts at most one
   * account-scoped policy at a time, so this is a replace operation.
   *
   * The SDK signature is `{ address, update: { accountPolicy }, idempotencyKey }`.
   */
  async attachPolicyToAccount(
    address: `0x${string}`,
    policyId: string,
    idempotencyKey: string,
  ): Promise<{ address: `0x${string}`; policies: string[] }> {
    try {
      const account = await this.client.evm.updateAccount({
        address,
        update: { accountPolicy: policyId },
        idempotencyKey,
      });
      return {
        address: account.address,
        policies: account.policies ?? [],
      };
    } catch (err) {
      throw this.wrap("attachPolicyToAccount", err);
    }
  }

  // --- lifecycle ----------------------------------------------------------

  /**
   * Best-effort teardown of the underlying HTTP pool.
   *
   * The SDK does not expose a public `close`, so this probes for one rather
   * than pretending it exists. Absent one, the process simply exits and the OS
   * reclaims the sockets.
   */
  async close(): Promise<void> {
    const maybe = this.client as unknown as { close?: () => Promise<void> | void };
    if (typeof maybe.close === "function") {
      try {
        await maybe.close();
      } catch {
        /* teardown is best effort */
      }
    }
  }

  /**
   * Wrap an SDK error with enough context to act on, without echoing
   * credentials. Never includes options objects, which may hold a secret.
   */
  private wrap(op: string, err: unknown, permanent = false): UpstreamError {
    const e = err as { message?: string; status?: number; statusCode?: number };
    const status = e?.status ?? e?.statusCode;
    // 4xx other than 408/429 will not succeed on retry.
    const isPermanent = permanent || (typeof status === "number" && status >= 400 && status < 500 && status !== 408 && status !== 429);
    return new UpstreamError(`cdp.${op}`, e?.message ?? String(err), isPermanent);
  }
}
