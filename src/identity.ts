/**
 * Identity management: Ed25519 keypair generation, CGA and Yggdrasil address derivation.
 * Ported from agents/identity.py in the agent-economy-ipv6-mvp project.
 */
import * as nacl from "tweetnacl";
import { sha256 } from "@noble/hashes/sha256";
import { sha512 } from "@noble/hashes/sha512";
import * as fs from "fs";
import * as path from "path";
import { Identity } from "./types";

const ULA_PREFIX = Buffer.from("fd00deadbeef0000", "hex");

/**
 * Derive a CGA-style ULA IPv6 address from Ed25519 public key bytes.
 * Format: fd00:dead:beef:0000:<last 64 bits of sha256(pubkey)>
 */
export function deriveCgaIpv6(publicKeyBytes: Uint8Array): string {
  const h = sha256(publicKeyBytes);
  const ipv6Bytes = Buffer.alloc(16);
  ULA_PREFIX.copy(ipv6Bytes, 0, 0, 8);
  Buffer.from(h).copy(ipv6Bytes, 8, 24, 32); // last 8 bytes of hash
  const parts: string[] = [];
  for (let i = 0; i < 16; i += 2) {
    parts.push(ipv6Bytes.readUInt16BE(i).toString(16).padStart(4, "0"));
  }
  return parts.join(":");
}

/**
 * Derive a Yggdrasil-compatible IPv6 address from Ed25519 public key bytes.
 * Uses SHA-512, 200::/8 prefix. Matches yggdrasil-go's key-to-address logic.
 * Note: actual routable address comes from the Yggdrasil daemon; this is the
 * derived/expected address used for identity display before the daemon starts.
 */
export function deriveYggIpv6(publicKeyBytes: Uint8Array): string {
  const h = sha512(publicKeyBytes);
  const addr = Buffer.alloc(16);
  addr[0] = 0x02;
  Buffer.from(h).copy(addr, 1, 0, 15);
  const parts: string[] = [];
  for (let i = 0; i < 16; i += 2) {
    parts.push(addr.readUInt16BE(i).toString(16).padStart(4, "0"));
  }
  return parts.join(":");
}

/** Generate a new Ed25519 keypair and derive all addresses. */
export function generateIdentity(): Identity {
  const keypair = nacl.sign.keyPair();
  const pubBytes = keypair.publicKey;
  const privBytes = keypair.secretKey.slice(0, 32); // nacl uses 64-byte secret (priv+pub)

  const pubB64 = Buffer.from(pubBytes).toString("base64");
  const privB64 = Buffer.from(privBytes).toString("base64");

  const hashHex = Buffer.from(sha256(pubBytes)).toString("hex");
  const agentId = hashHex.slice(0, 16);

  return {
    agentId,
    publicKey: pubB64,
    privateKey: privB64,
    cgaIpv6: deriveCgaIpv6(pubBytes),
    yggIpv6: deriveYggIpv6(pubBytes),
  };
}

/** Load identity from file or generate and save a new one. */
export function loadOrCreateIdentity(dataDir: string): Identity {
  const idFile = path.join(dataDir, "identity.json");
  if (fs.existsSync(idFile)) {
    return JSON.parse(fs.readFileSync(idFile, "utf-8")) as Identity;
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const id = generateIdentity();
  fs.writeFileSync(idFile, JSON.stringify(id, null, 2));
  return id;
}

/** Sign a canonical message dict with the private key. Returns base64 signature. */
export function signMessage(privateKeyB64: string, data: Record<string, unknown>): string {
  const privBytes = Buffer.from(privateKeyB64, "base64");
  const pubBytes = Buffer.from(
    Buffer.from(privBytes).toString("hex") // just to get length check
  );

  // nacl expects 64-byte secret key = priv(32) + pub(32)
  // We stored only priv(32), so we need to reconstruct
  const privFull = nacl.sign.keyPair.fromSeed(privBytes);
  const msg = Buffer.from(JSON.stringify(data, Object.keys(data).sort()));
  const sig = nacl.sign.detached(msg, privFull.secretKey);
  return Buffer.from(sig).toString("base64");
}

/** Verify an Ed25519 signature. Returns true if valid. */
export function verifySignature(
  publicKeyB64: string,
  data: Record<string, unknown>,
  signatureB64: string
): boolean {
  try {
    const pubBytes = Buffer.from(publicKeyB64, "base64");
    const sigBytes = Buffer.from(signatureB64, "base64");
    const msg = Buffer.from(JSON.stringify(data, Object.keys(data).sort()));
    return nacl.sign.detached.verify(msg, sigBytes, pubBytes);
  } catch {
    return false;
  }
}

/** Compute agentId from a public key (sha256[:16]). */
export function agentIdFromPublicKey(publicKeyB64: string): string {
  const pubBytes = Buffer.from(publicKeyB64, "base64");
  return Buffer.from(sha256(pubBytes)).toString("hex").slice(0, 16);
}
