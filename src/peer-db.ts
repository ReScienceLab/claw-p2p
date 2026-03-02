/**
 * Local peer store with TOFU (Trust On First Use) logic.
 * Persisted as a simple JSON file — no native dependencies required.
 */
import * as fs from "fs";
import * as path from "path";
import { PeerRecord } from "./types";

interface PeerStore {
  peers: Record<string, PeerRecord>;
}

let dbPath: string;
let store: PeerStore = { peers: {} };

function load(): void {
  if (fs.existsSync(dbPath)) {
    try {
      store = JSON.parse(fs.readFileSync(dbPath, "utf-8"));
    } catch {
      store = { peers: {} };
    }
  }
}

function save(): void {
  fs.writeFileSync(dbPath, JSON.stringify(store, null, 2));
}

export function initDb(dataDir: string): void {
  dbPath = path.join(dataDir, "peers.json");
  load();
}

export function listPeers(): PeerRecord[] {
  return Object.values(store.peers).sort((a, b) => b.lastSeen - a.lastSeen);
}

export function upsertPeer(yggAddr: string, alias: string = ""): void {
  const now = Date.now();
  const existing = store.peers[yggAddr];
  if (existing) {
    existing.alias = alias || existing.alias;
    existing.lastSeen = now;
  } else {
    store.peers[yggAddr] = { yggAddr, publicKey: "", alias, firstSeen: now, lastSeen: now };
  }
  save();
}

export function removePeer(yggAddr: string): void {
  delete store.peers[yggAddr];
  save();
}

export function getPeer(yggAddr: string): PeerRecord | null {
  return store.peers[yggAddr] ?? null;
}

export function getPeerAddresses(): string[] {
  return Object.keys(store.peers);
}

/**
 * TOFU: on first message from a peer, cache their public key.
 * On subsequent messages the key must match. Returns false if mismatched.
 */
export function toufuVerifyAndCache(yggAddr: string, publicKey: string): boolean {
  const now = Date.now();
  const existing = store.peers[yggAddr];

  if (!existing) {
    // Unknown peer — TOFU: accept and cache
    store.peers[yggAddr] = { yggAddr, publicKey, alias: "", firstSeen: now, lastSeen: now };
    save();
    return true;
  }

  if (!existing.publicKey) {
    // Known address (manually added) but no key yet — cache now
    existing.publicKey = publicKey;
    existing.lastSeen = now;
    save();
    return true;
  }

  if (existing.publicKey !== publicKey) {
    return false; // Key mismatch — reject
  }

  existing.lastSeen = now;
  save();
  return true;
}
