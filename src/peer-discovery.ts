/**
 * DHT-style peer discovery via Bootstrap + Gossip exchange.
 *
 * v2: announcements use `from` (agentId) as the primary identifier.
 * Still includes `fromYgg` for backward compat with v1 bootstrap nodes.
 *
 * Flow:
 *   1. On startup, connect to bootstrap nodes (hardcoded + config)
 *   2. POST /peer/announce to each bootstrap → receive their peer list
 *   3. Add discovered peers to local store (keyed by agentId)
 *   4. Fanout: announce to a sample of newly-discovered peers (1 level deep)
 *   5. Periodic loop: re-announce to a random sample to keep the table fresh
 */

import { Identity, PeerAnnouncement, Endpoint } from "./types"
import { signMessage, agentIdFromPublicKey } from "./identity"
import { listPeers, upsertDiscoveredPeer, getPeersForExchange, pruneStale } from "./peer-db"

const BOOTSTRAP_JSON_URL =
  "https://resciencelab.github.io/DeClaw/bootstrap.json"

export async function fetchRemoteBootstrapPeers(): Promise<string[]> {
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 10_000)
    const resp = await fetch(BOOTSTRAP_JSON_URL, { signal: ctrl.signal })
    clearTimeout(timer)
    if (!resp.ok) return []
    const data = (await resp.json()) as {
      bootstrap_nodes?: { yggAddr: string; port?: number }[]
    }
    return (data.bootstrap_nodes ?? []).map((n) => n.yggAddr)
  } catch {
    console.warn("[p2p:discovery] Could not fetch remote bootstrap list — using hardcoded fallback")
    return []
  }
}

export const DEFAULT_BOOTSTRAP_PEERS: string[] = [
  "200:697f:bda:1e8e:706a:6c5e:630b:51d",
  "200:e1a5:b063:958:8f74:ec45:8eb0:e30e",
  "200:9cf6:eaf1:7d3e:14b0:5869:2140:b618",
  "202:adbc:dde1:e272:1cdb:97d0:8756:4f77",
  "200:5ec6:62dd:9e91:3752:820c:98f5:5863",
]

const EXCHANGE_TIMEOUT_MS = 30_000
const MAX_FANOUT_PEERS = 5
const MAX_SHARED_PEERS = 20

let _discoveryTimer: NodeJS.Timeout | null = null

// ── Signed announcement builder (v2) ─────────────────────────────────────────

function buildAnnouncement(
  identity: Identity,
  meta: { name?: string; version?: string; endpoints?: Endpoint[]; transport?: string } = {}
): Omit<PeerAnnouncement, "signature"> {
  const myPeers = getPeersForExchange(MAX_SHARED_PEERS).map((p) => {
    const entry: {
      agentId: string
      publicKey: string
      alias?: string
      lastSeen: number
      endpoints: Endpoint[]
      yggAddr?: string
    } = {
      agentId: p.agentId,
      publicKey: p.publicKey,
      lastSeen: p.lastSeen,
      endpoints: p.endpoints ?? [],
    }
    if (p.alias) entry.alias = p.alias
    if (p.yggAddr) entry.yggAddr = p.yggAddr
    return entry
  })

  const ann: Omit<PeerAnnouncement, "signature"> = {
    from: identity.agentId,
    publicKey: identity.publicKey,
    timestamp: Date.now(),
    peers: myPeers,
    endpoints: meta.endpoints ?? [],
    // v1 compat: include fromYgg so v1 bootstrap nodes can verify source
    fromYgg: identity.yggIpv6,
  }
  if (meta.name) ann.alias = meta.name
  if (meta.version) ann.version = meta.version
  return ann
}

// ── Core exchange ─────────────────────────────────────────────────────────────

/**
 * POST /peer/announce to a single target node.
 * Target is addressed by yggAddr (for v1 bootstrap) or IP.
 * Returns the list of peers they shared back, or null on failure.
 */
export async function announceToNode(
  identity: Identity,
  targetAddr: string,
  port: number = 8099,
  meta: { name?: string; version?: string; endpoints?: Endpoint[]; transport?: string } = {}
): Promise<Array<{
  agentId: string
  publicKey: string
  alias?: string
  lastSeen: number
  endpoints?: Endpoint[]
  yggAddr?: string
}> | null> {
  const payload = buildAnnouncement(identity, meta)
  const signature = signMessage(identity.privateKey, payload as Record<string, unknown>)
  const announcement: PeerAnnouncement = { ...payload, signature }

  // Target may be IPv6 (needs brackets) or IPv4/hostname
  const isIpv6 = targetAddr.includes(":")
  const url = isIpv6
    ? `http://[${targetAddr}]:${port}/peer/announce`
    : `http://${targetAddr}:${port}/peer/announce`

  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), EXCHANGE_TIMEOUT_MS)
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(announcement),
      signal: ctrl.signal,
    })
    clearTimeout(timer)

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "")
      console.warn(`[p2p:discovery] Announce to ${targetAddr.slice(0, 20)}... rejected ${resp.status}: ${errText}`)
      return null
    }

    const body = await resp.json() as {
      ok: boolean
      self?: {
        agentId?: string
        yggAddr?: string
        publicKey?: string
        alias?: string
        version?: string
        endpoints?: Endpoint[]
      }
      peers?: any[]
    }

    // Store the responder's self metadata
    if (body.self?.publicKey) {
      const selfId = body.self.agentId ?? (body.self.publicKey ? agentIdFromPublicKey(body.self.publicKey) : body.self.yggAddr)
      if (selfId) {
        upsertDiscoveredPeer(selfId, body.self.publicKey, {
          alias: body.self.alias,
          version: body.self.version,
          discoveredVia: selfId,
          source: "gossip",
          endpoints: body.self.endpoints,
          yggAddr: body.self.yggAddr,
        })
      }
    }

    // Normalize returned peers to v2 format
    return (body.peers ?? []).map((p: any) => ({
      agentId: p.agentId ?? (p.publicKey ? agentIdFromPublicKey(p.publicKey) : p.yggAddr),
      publicKey: p.publicKey,
      alias: p.alias,
      lastSeen: p.lastSeen,
      endpoints: p.endpoints ?? [],
      yggAddr: p.yggAddr,
    }))
  } catch (err: any) {
    console.warn(`[p2p:discovery] Announce to ${targetAddr.slice(0, 20)}... error: ${err?.message}`)
    return null
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

export async function bootstrapDiscovery(
  identity: Identity,
  port: number = 8099,
  extraBootstrap: string[] = [],
  meta: { name?: string; version?: string; endpoints?: Endpoint[]; transport?: string } = {}
): Promise<number> {
  const remotePeers = await fetchRemoteBootstrapPeers()
  const bootstrapAddrs = [
    ...new Set([...remotePeers, ...DEFAULT_BOOTSTRAP_PEERS, ...extraBootstrap]),
  ].filter((a) => a && a !== identity.yggIpv6)

  if (bootstrapAddrs.length === 0) {
    console.log("[p2p:discovery] No bootstrap nodes configured — skipping initial discovery.")
    return 0
  }

  console.log(`[p2p:discovery] Bootstrapping via ${bootstrapAddrs.length} node(s) (parallel)...`)

  let totalDiscovered = 0
  const fanoutCandidates: Array<{ addr: string; endpoints?: Endpoint[] }> = []

  const results = await Promise.allSettled(
    bootstrapAddrs.map(async (addr) => {
      const peers = await announceToNode(identity, addr, port, meta)
      return { addr, peers }
    })
  )

  for (const result of results) {
    if (result.status !== "fulfilled") continue
    const { addr, peers } = result.value
    if (!peers) {
      console.warn(`[p2p:discovery] Bootstrap ${addr.slice(0, 20)}... unreachable`)
      continue
    }

    for (const p of peers) {
      if (p.agentId === identity.agentId) continue
      // Also skip self by yggAddr
      if (p.yggAddr && p.yggAddr === identity.yggIpv6) continue
      upsertDiscoveredPeer(p.agentId, p.publicKey, {
        alias: p.alias,
        discoveredVia: addr,
        source: "bootstrap",
        lastSeen: p.lastSeen,
        endpoints: p.endpoints,
        yggAddr: p.yggAddr,
      })
      // Use yggAddr for fanout HTTP if available, otherwise skip
      if (p.yggAddr) {
        fanoutCandidates.push({ addr: p.yggAddr, endpoints: p.endpoints })
      }
      totalDiscovered++
    }

    console.log(`[p2p:discovery] Bootstrap ${addr.slice(0, 20)}... → +${peers.length} peers`)
  }

  // Fanout: announce to a sample of newly-learned peers
  const fanout = fanoutCandidates.slice(0, MAX_FANOUT_PEERS)
  await Promise.allSettled(
    fanout.map(({ addr }) =>
      announceToNode(identity, addr, port, meta).then((peers) => {
        if (!peers) return
        for (const p of peers) {
          if (p.agentId === identity.agentId) continue
          if (p.yggAddr && p.yggAddr === identity.yggIpv6) continue
          upsertDiscoveredPeer(p.agentId, p.publicKey, {
            alias: p.alias,
            discoveredVia: addr,
            source: "gossip",
            lastSeen: p.lastSeen,
            endpoints: p.endpoints,
            yggAddr: p.yggAddr,
          })
        }
      })
    )
  )

  console.log(`[p2p:discovery] Bootstrap complete — ${totalDiscovered} peers discovered`)
  return totalDiscovered
}

// ── Periodic gossip loop ──────────────────────────────────────────────────────

export function startDiscoveryLoop(
  identity: Identity,
  port: number = 8099,
  intervalMs: number = 10 * 60 * 1000,
  extraBootstrap: string[] = [],
  meta: { name?: string; version?: string; endpoints?: Endpoint[]; transport?: string } = {}
): void {
  if (_discoveryTimer) return

  const protectedAddrs = [...new Set([...DEFAULT_BOOTSTRAP_PEERS, ...extraBootstrap])]

  const runGossip = async () => {
    pruneStale(3 * intervalMs, protectedAddrs)

    const peers = listPeers()
    if (peers.length === 0) return

    const sample = peers.sort(() => Math.random() - 0.5).slice(0, MAX_FANOUT_PEERS)

    let updated = 0
    await Promise.allSettled(
      sample.map(async (peer) => {
        // Use yggAddr for HTTP if available, otherwise we can't reach them yet
        const addr = peer.yggAddr
        if (!addr) return
        const received = await announceToNode(identity, addr, port, meta)
        if (!received) return
        // Direct contact succeeded — update
        upsertDiscoveredPeer(peer.agentId, peer.publicKey, {
          alias: peer.alias,
          discoveredVia: peer.agentId,
          source: "gossip",
          endpoints: peer.endpoints,
          yggAddr: peer.yggAddr,
        })
        for (const p of received) {
          if (p.agentId === identity.agentId) continue
          if (p.yggAddr && p.yggAddr === identity.yggIpv6) continue
          upsertDiscoveredPeer(p.agentId, p.publicKey, {
            alias: p.alias,
            discoveredVia: peer.agentId,
            source: "gossip",
            lastSeen: p.lastSeen,
            endpoints: p.endpoints,
            yggAddr: p.yggAddr,
          })
          updated++
        }
      })
    )

    if (updated > 0) {
      console.log(`[p2p:discovery] Gossip round: +${updated} peer updates`)
    }
  }

  _discoveryTimer = setInterval(runGossip, intervalMs)
  console.log(`[p2p:discovery] Gossip loop started (interval: ${intervalMs / 1000}s)`)
}

export function stopDiscoveryLoop(): void {
  if (_discoveryTimer) {
    clearInterval(_discoveryTimer)
    _discoveryTimer = null
    console.log("[p2p:discovery] Gossip loop stopped")
  }
}
