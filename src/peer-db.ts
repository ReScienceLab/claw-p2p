/**
 * Local peer store with TOFU (Trust On First Use) logic.
 * v2: keyed by agentId (was yggAddr in v1).
 */
import * as fs from "fs"
import * as path from "path"
import { DiscoveredPeerRecord, Endpoint } from "./types"
import { agentIdFromPublicKey } from "./identity"

interface PeerStore {
  version: number
  peers: Record<string, DiscoveredPeerRecord>
}

let dbPath: string
let store: PeerStore = { version: 2, peers: {} }
let _saveTimer: ReturnType<typeof setTimeout> | null = null
const SAVE_DEBOUNCE_MS = 1000

/** Migrate v1 store (keyed by yggAddr) to v2 (keyed by agentId). */
function migrateV1(raw: any): PeerStore {
  if (raw.version === 2) return raw as PeerStore
  const migrated: PeerStore = { version: 2, peers: {} }
  const oldPeers: Record<string, any> = raw.peers ?? {}
  for (const [key, p] of Object.entries(oldPeers)) {
    let agentId = p.agentId
    if (!agentId && p.publicKey) {
      agentId = agentIdFromPublicKey(p.publicKey)
    }
    if (!agentId) {
      agentId = key // use old key as fallback placeholder
    }
    migrated.peers[agentId] = {
      agentId,
      publicKey: p.publicKey ?? "",
      alias: p.alias ?? "",
      endpoints: p.endpoints ?? [],
      capabilities: p.capabilities ?? [],
      firstSeen: p.firstSeen ?? Date.now(),
      lastSeen: p.lastSeen ?? Date.now(),
      yggAddr: p.yggAddr ?? key,
      source: p.source ?? "gossip",
      discoveredVia: p.discoveredVia,
      version: p.version,
    }
  }
  return migrated
}

function load(): void {
  if (fs.existsSync(dbPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(dbPath, "utf-8"))
      store = migrateV1(raw)
    } catch {
      store = { version: 2, peers: {} }
    }
  } else {
    store = { version: 2, peers: {} }
  }
}

function saveImmediate(): void {
  if (_saveTimer) {
    clearTimeout(_saveTimer)
    _saveTimer = null
  }
  fs.writeFileSync(dbPath, JSON.stringify(store, null, 2))
}

function save(): void {
  if (_saveTimer) return
  _saveTimer = setTimeout(() => {
    _saveTimer = null
    fs.writeFileSync(dbPath, JSON.stringify(store, null, 2))
  }, SAVE_DEBOUNCE_MS)
}

export function flushDb(): void {
  if (_saveTimer) saveImmediate()
}

export function initDb(dataDir: string): void {
  dbPath = path.join(dataDir, "peers.json")
  load()
}

export function listPeers(): DiscoveredPeerRecord[] {
  return Object.values(store.peers).sort((a, b) => b.lastSeen - a.lastSeen)
}

/** Add a peer manually by agentId or legacy yggAddr. */
export function upsertPeer(idOrAddr: string, alias: string = ""): void {
  const now = Date.now()
  const existing = store.peers[idOrAddr] ?? findByYggAddr(idOrAddr)
  if (existing) {
    existing.alias = alias || existing.alias
    existing.lastSeen = now
  } else {
    store.peers[idOrAddr] = {
      agentId: idOrAddr,
      publicKey: "",
      alias,
      endpoints: [],
      capabilities: [],
      firstSeen: now,
      lastSeen: now,
      source: "manual",
      yggAddr: isYggAddress(idOrAddr) ? idOrAddr : undefined,
    }
  }
  saveImmediate()
}

/** Find a peer by legacy yggAddr. */
function findByYggAddr(yggAddr: string): DiscoveredPeerRecord | undefined {
  return Object.values(store.peers).find((p) => p.yggAddr === yggAddr)
}

function isYggAddress(addr: string): boolean {
  return /^2[0-9a-f]{2}:/i.test(addr)
}

/**
 * Upsert a peer discovered via bootstrap or gossip.
 * v2: keyed by agentId. Derives agentId from publicKey if not provided.
 */
export function upsertDiscoveredPeer(
  agentId: string,
  publicKey: string,
  opts: {
    alias?: string
    version?: string
    discoveredVia?: string
    source?: "bootstrap" | "gossip"
    lastSeen?: number
    endpoints?: Endpoint[]
    capabilities?: string[]
    yggAddr?: string
  } = {}
): void {
  const now = Date.now()
  // Derive agentId from publicKey if the provided ID looks like a ygg address (v1 compat)
  let resolvedId = agentId
  if (isYggAddress(agentId) && publicKey) {
    resolvedId = agentIdFromPublicKey(publicKey)
  }

  const existing = store.peers[resolvedId] ?? (opts.yggAddr ? findByYggAddr(opts.yggAddr) : undefined)
  if (existing) {
    // Re-key if we resolved a better agentId
    if (existing.agentId !== resolvedId) {
      delete store.peers[existing.agentId]
      existing.agentId = resolvedId
      store.peers[resolvedId] = existing
    }
    if (!existing.publicKey) existing.publicKey = publicKey
    if (opts.lastSeen !== undefined) {
      existing.lastSeen = Math.max(existing.lastSeen, opts.lastSeen)
    } else {
      existing.lastSeen = now
    }
    if (!existing.discoveredVia) existing.discoveredVia = opts.discoveredVia
    if (opts.version) existing.version = opts.version
    if (opts.endpoints?.length) existing.endpoints = opts.endpoints
    if (opts.capabilities?.length) existing.capabilities = opts.capabilities
    if (opts.yggAddr && !existing.yggAddr) existing.yggAddr = opts.yggAddr
    if (opts.alias && existing.source !== "manual") existing.alias = opts.alias
  } else {
    store.peers[resolvedId] = {
      agentId: resolvedId,
      publicKey,
      alias: opts.alias ?? "",
      version: opts.version,
      endpoints: opts.endpoints ?? [],
      capabilities: opts.capabilities ?? [],
      firstSeen: now,
      lastSeen: opts.lastSeen ?? now,
      source: opts.source ?? "gossip",
      discoveredVia: opts.discoveredVia,
      yggAddr: opts.yggAddr ?? (isYggAddress(agentId) ? agentId : undefined),
    }
  }
  save()
}

/** Return peers suitable for sharing during peer exchange. */
export function getPeersForExchange(max: number = 20): DiscoveredPeerRecord[] {
  return Object.values(store.peers)
    .filter((p) => p.publicKey)
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .slice(0, max)
}

export function removePeer(idOrAddr: string): void {
  if (store.peers[idOrAddr]) {
    delete store.peers[idOrAddr]
  } else {
    // Try legacy yggAddr lookup
    const peer = findByYggAddr(idOrAddr)
    if (peer) delete store.peers[peer.agentId]
  }
  saveImmediate()
}

export function getPeer(idOrAddr: string): DiscoveredPeerRecord | null {
  return store.peers[idOrAddr] ?? findByYggAddr(idOrAddr) ?? null
}

export function getPeerIds(): string[] {
  return Object.keys(store.peers)
}

/** @deprecated Use getPeerIds(). Kept for v1 channel compat. */
export function getPeerAddresses(): string[] {
  return Object.values(store.peers).map((p) => p.yggAddr ?? p.agentId)
}

/**
 * Remove peers whose lastSeen is older than maxAgeMs.
 * Skips manually-added peers and any ID in protectedIds.
 */
export function pruneStale(maxAgeMs: number, protectedIds: string[] = []): number {
  const cutoff = Date.now() - maxAgeMs
  let pruned = 0
  for (const [id, record] of Object.entries(store.peers)) {
    if (record.source === "manual") continue
    if (protectedIds.includes(id)) continue
    // Also protect by yggAddr for bootstrap nodes
    if (record.yggAddr && protectedIds.includes(record.yggAddr)) continue
    if (record.lastSeen < cutoff) {
      delete store.peers[id]
      pruned++
    }
  }
  if (pruned > 0) {
    console.log(`[p2p:db] Pruned ${pruned} stale peer(s)`)
    saveImmediate()
  }
  return pruned
}

/**
 * TOFU: on first message from a peer, cache their public key.
 * v2: keyed by agentId (derived from publicKey).
 */
export function tofuVerifyAndCache(agentId: string, publicKey: string): boolean {
  const now = Date.now()
  const existing = store.peers[agentId]

  if (!existing) {
    store.peers[agentId] = {
      agentId,
      publicKey,
      alias: "",
      endpoints: [],
      capabilities: [],
      firstSeen: now,
      lastSeen: now,
      source: "gossip",
    }
    saveImmediate()
    return true
  }

  if (!existing.publicKey) {
    existing.publicKey = publicKey
    existing.lastSeen = now
    saveImmediate()
    return true
  }

  if (existing.publicKey !== publicKey) {
    return false
  }

  existing.lastSeen = now
  save()
  return true
}

/** @deprecated v1 compat wrapper. Use tofuVerifyAndCache with agentId. */
export function toufuVerifyAndCache(yggAddr: string, publicKey: string): boolean {
  const agentId = publicKey ? agentIdFromPublicKey(publicKey) : yggAddr
  return tofuVerifyAndCache(agentId, publicKey)
}
