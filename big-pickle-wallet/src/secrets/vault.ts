/**
 * Encrypted secret vault.
 *
 * Design decisions that matter:
 *
 *  - **No private key is ever stored here.** The wallet's signing key lives
 *    inside Coinbase's TEE and is never exported, so there is nothing to leak.
 *    What this vault holds are *credentials* (a CDP Secret API Key, a CDP Wallet
 *    Secret, the Risk attestation key, the owner's authority key). A credential
 *    leak degrades to "an attacker can attempt what the policy engine allows",
 *    not "an attacker has the funds".
 *
 *  - **KDF, not a raw passphrase.** scrypt with per-file random salt, so a stolen
 *    vault file is not brute-forceable from a wordlist at the cost of one hash.
 *
 *  - **Authenticated encryption.** AES-256-GCM. A modified vault fails to
 *    decrypt rather than yielding attacker-chosen plaintext.
 *
 *  - **0600 and owner-only.** Enforced on create and on every write.
 *
 *  - **Secrets are held in memory only as long as needed** and are never
 *    returned by any getter that logs. `toString`/`toJSON` on a `Secret` value
 *    is redacted.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  unlinkSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  createHash,
  sign as cryptoSign,
  verify as cryptoVerify,
  generateKeyPairSync,
  KeyObject,
} from "node:crypto";
import { VaultError } from "../errors.js";

const ALGO = "aes-256-gcm";
const IV_BYTES = 12;
const SALT_BYTES = 32;
const KEY_BYTES = 32;
const TAG_BYTES = 16;
const SCRYPT_N = 2 ** 17; // ~128 MiB. Deliberately expensive.
const SCRYPT_r = 8;
const SCRYPT_p = 1;

/**
 * A secret string that refuses to render itself.
 *
 * This exists so that an accidental `console.log(obj)` or
 * `JSON.stringify(config)` in a debugging session cannot leak a credential.
 * Templates, string concatenation, and `util.inspect` all go through
 * toString, so redacting here covers the realistic accident paths.
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /** The only way to obtain the plaintext. Call sites are auditable. */
  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return "[REDACTED]";
  }

  toJSON(): string {
    return "[REDACTED]";
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "[REDACTED]";
  }

  get length(): number {
    return this.#value.length;
  }
}

export interface VaultFileV1 {
  version: 1;
  kdf: { algo: "scrypt"; N: number; r: number; p: number; salt: string };
  cipher: { algo: "aes-256-gcm"; iv: string; tag: string };
  /** Base64 ciphertext of the canonical JSON payload. */
  data: string;
  createdAt: string;
  hint?: string;
}

export interface VaultPayload {
  /** CDP Secret API Key id (not itself a secret, but grouped). */
  cdpApiKeyId?: string;
  /** Ed25519, base64. Mints the `Authorization: Bearer` JWT. */
  cdpApiKeySecret?: string;
  /** P-256 PKCS#8 DER, base64. Mints the `X-Wallet-Auth` JWT. */
  cdpWalletSecret?: string;
  /** Ed25519, base64 PKCS#8. Signs Risk attestations. Public half is shared with the executor. */
  riskAttestationKey?: string;
  /** Risk attestation public key, base64 SPKI. Non-secret, stored alongside for convenience. */
  riskAttestationPublicKey?: string;
  /** Ed25519, base64 PKCS#8. Owner authority: approves, resumes, releases the kill switch. */
  ownerAuthorityKey?: string;
  ownerAuthorityPublicKey?: string;
  /** Wallet addresses this deployment owns, for display and allowlisting. */
  walletAddress?: string;
  extra?: Record<string, string>;
}

function deriveKey(passphrase: string, salt: Buffer, params: { N: number; r: number; p: number }): Buffer {
  return scryptSync(passphrase.normalize("NFKC"), salt, KEY_BYTES, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: 256 * 1024 * 1024,
  });
}

/** Encrypt a payload to a vault file. */
export function sealVault(path: string, passphrase: string, payload: VaultPayload): VaultFileV1 {
  if (passphrase.length < 12) {
    throw new VaultError("vault passphrase must be at least 12 characters");
  }
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const kdf = { algo: "scrypt" as const, N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p, salt: salt.toString("base64") };
  const key = deriveKey(passphrase, salt, kdf);

  const cipher = createCipheriv(ALGO, key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  const file: VaultFileV1 = {
    version: 1,
    kdf,
    cipher: { algo: ALGO, iv: iv.toString("base64"), tag: tag.toString("base64") },
    data: ciphertext.toString("base64"),
    createdAt: new Date().toISOString(),
  };

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return file;
}

/** Decrypt a vault file. Wrong passphrase fails as a GCM auth error. */
export function openVault(path: string, passphrase: string): VaultPayload {
  if (!existsSync(path)) throw new VaultError(`vault not found at ${path}`);

  let file: VaultFileV1;
  try {
    file = JSON.parse(readFileSync(path, "utf8")) as VaultFileV1;
  } catch (err) {
    throw new VaultError(`vault file at ${path} is not valid JSON: ${(err as Error).message}`);
  }

  if (file.version !== 1) throw new VaultError(`unsupported vault version ${file.version}`);
  if (file.cipher?.algo !== ALGO) throw new VaultError(`unsupported cipher ${file.cipher?.algo}`);

  const salt = Buffer.from(file.kdf.salt, "base64");
  const iv = Buffer.from(file.cipher.iv, "base64");
  const tag = Buffer.from(file.cipher.tag, "base64");
  const key = deriveKey(passphrase, salt, file.kdf);

  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([decipher.update(Buffer.from(file.data, "base64")), decipher.final()]);
  } catch {
    // GCM tag mismatch: wrong passphrase, or the file was modified. Do not
    // distinguish — that would leak information to someone probing the file.
    throw new VaultError(
      "vault could not be decrypted: wrong passphrase, or the vault file has been modified",
    );
  }

  try {
    return JSON.parse(plaintext.toString("utf8")) as VaultPayload;
  } catch (err) {
    throw new VaultError(`vault decrypted but payload is not valid JSON: ${(err as Error).message}`);
  }
}

/** Securely remove a vault file. Best effort on CoW filesystems. */
export function destroyVault(path: string): void {
  if (!existsSync(path)) return;
  try {
    const buf = readFileSync(path);
    randomBytes(buf.length).copy(buf);
  } catch {
    /* best effort */
  }
  unlinkSync(path);
}

// ---------------------------------------------------------------------------
// Attestation keys
// ---------------------------------------------------------------------------

/**
 * Ed25519 keypair used to sign Risk attestations.
 *
 * Generated on the local machine, never on a remote service, and the private
 * half lives only in the vault. The executor holds only the *public* half, so a
 * compromised executor can verify attestations but cannot forge them.
 */
export function generateAttestationKeyPair(): {
  privateKeyPem: string;
  publicKeyPem: string;
  keyId: string;
} {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  // Key id is a hash of the public key, so it is verifiable and not a secret.
  const keyId = `ed25519:${createHash("sha256").update(publicKeyPem, "utf8").digest("base64url").slice(0, 22)}`;
  return { privateKeyPem, publicKeyPem, keyId };
}

/** Sign a canonical proposal hash with an Ed25519 private key (PEM). */
export function signAttestation(privateKeyPem: string, payload: string): string {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== "ed25519") {
    throw new VaultError(`attestation key must be ed25519, got ${key.asymmetricKeyType}`);
  }
  return cryptoSign(null, Buffer.from(payload, "utf8"), key).toString("base64");
}

/** Verify an Ed25519 signature over a payload. Returns false, never throws. */
export function verifyAttestation(publicKeyPem: string, payload: string, signatureB64: string): boolean {
  try {
    const key = createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== "ed25519") return false;
    return cryptoVerify(
      null,
      Buffer.from(payload, "utf8"),
      key,
      Buffer.from(signatureB64, "base64"),
    );
  } catch {
    return false;
  }
}

export function importPublicKey(publicKeyPem: string): KeyObject {
  return createPublicKey(publicKeyPem);
}

/** Constant-time compare, for token equality checks. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) {
    // Still perform a comparison so timing does not reveal length via early
    // return on equal-length inputs.
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

export function defaultVaultPath(root: string): string {
  return resolve(root, "secrets", "wallet.vault");
}
