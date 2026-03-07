/**
 * P2P peer HTTP server listening on [::]:8099.
 *
 * v2 trust model (transport-agnostic):
 *   Layer 1 — Transport security (TLS/Yggdrasil/WireGuard — handled by transport)
 *   Layer 2 — Source verification (transport-specific, relaxed in multi-transport mode)
 *   Layer 3 — Ed25519 signature (universal trust anchor)
 *   Layer 4 — TOFU: agentId → publicKey binding
 */
import Fastify, { FastifyInstance } from "fastify"
import { P2PMessage, PeerAnnouncement, Endpoint, isV1Message, isV1Announcement } from "./types"
import { verifySignature, agentIdFromPublicKey } from "./identity"
import { tofuVerifyAndCache, getPeersForExchange, upsertDiscoveredPeer, removePeer } from "./peer-db"

export type MessageHandler = (msg: P2PMessage & { verified: boolean }) => void

let server: FastifyInstance | null = null
const _inbox: (P2PMessage & { verified: boolean; receivedAt: number })[] = []
const _handlers: MessageHandler[] = []

interface SelfMeta {
  agentId?: string
  publicKey?: string
  alias?: string
  version?: string
  endpoints?: Endpoint[]
  yggAddr?: string
}
let _selfMeta: SelfMeta = {}

export function setSelfMeta(meta: SelfMeta): void {
  _selfMeta = meta
}

export function onMessage(handler: MessageHandler): void {
  _handlers.push(handler)
}

/** Build the canonical object that the sender signed (all fields except signature). */
function canonical(msg: P2PMessage): Record<string, unknown> {
  const obj: Record<string, unknown> = {
    from: msg.from,
    publicKey: msg.publicKey,
    event: msg.event,
    content: msg.content,
    timestamp: msg.timestamp,
  }
  // v1 messages signed over fromYgg instead of from
  if (msg.fromYgg) {
    obj.fromYgg = msg.fromYgg
  }
  return obj
}

/** Canonical for v1 messages (signed with fromYgg, not from). */
function canonicalV1(msg: any): Record<string, unknown> {
  return {
    fromYgg: msg.fromYgg,
    publicKey: msg.publicKey,
    event: msg.event,
    content: msg.content,
    timestamp: msg.timestamp,
  }
}

/** Check whether an IPv6 address is in the Yggdrasil 200::/7 range. */
export function isYggdrasilAddr(addr: string): boolean {
  const clean = addr.replace(/^::ffff:/, "")
  return /^2[0-9a-f]{2}:/i.test(clean)
}

export async function startPeerServer(
  port: number = 8099,
  opts: { testMode?: boolean } = {}
): Promise<void> {
  const testMode = opts.testMode ?? false
  server = Fastify({ logger: false })

  server.get("/peer/ping", async () => ({ ok: true, ts: Date.now() }))
  server.get("/peer/inbox", async () => _inbox.slice(0, 100))
  server.get("/peer/peers", async () => ({ peers: getPeersForExchange(20) }))

  // ── Announce endpoint (v1 + v2 compatible) ──────────────────────────────
  server.post("/peer/announce", async (req, reply) => {
    const ann = req.body as any
    const srcIp = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "")
    const v1 = isV1Announcement(ann)

    // Transport-layer source verification (Yggdrasil only, skip for non-Ygg sources)
    if (!testMode && v1 && isYggdrasilAddr(srcIp)) {
      if (ann.fromYgg !== srcIp) {
        return reply.code(403).send({ error: `fromYgg ${ann.fromYgg} does not match TCP source ${srcIp}` })
      }
    }

    // Ed25519 signature verification
    const { signature, ...signable } = ann
    if (!verifySignature(ann.publicKey, signable as Record<string, unknown>, signature)) {
      return reply.code(403).send({ error: "Invalid announcement signature" })
    }

    // Derive agentId
    const agentId = v1 ? agentIdFromPublicKey(ann.publicKey) : ann.from
    const yggAddr = ann.fromYgg ?? undefined
    const endpoints: Endpoint[] = ann.endpoints ?? (yggAddr ? [{ transport: "yggdrasil" as const, address: yggAddr, port, priority: 1, ttl: 3600 }] : [])

    // TOFU: record the announcer
    upsertDiscoveredPeer(agentId, ann.publicKey, {
      alias: ann.alias,
      version: ann.version,
      discoveredVia: agentId,
      source: "gossip",
      endpoints,
      yggAddr,
    })

    // Absorb shared peers
    for (const p of ann.peers ?? []) {
      const peerId = p.agentId ?? (p.publicKey ? agentIdFromPublicKey(p.publicKey) : p.yggAddr)
      if (!peerId || peerId === agentId) continue
      const peerEndpoints = p.endpoints ?? (p.yggAddr ? [{ transport: "yggdrasil" as const, address: p.yggAddr, port, priority: 1, ttl: 3600 }] : [])
      upsertDiscoveredPeer(peerId, p.publicKey, {
        alias: p.alias,
        discoveredVia: agentId,
        source: "gossip",
        lastSeen: p.lastSeen,
        endpoints: peerEndpoints,
        yggAddr: p.yggAddr,
      })
    }

    console.log(`[p2p] ↔ peer-exchange  from=${agentId}  shared=${ann.peers?.length ?? 0} peers`)

    // Return self metadata
    const self = _selfMeta.agentId
      ? { agentId: _selfMeta.agentId, publicKey: _selfMeta.publicKey, alias: _selfMeta.alias, version: _selfMeta.version, endpoints: _selfMeta.endpoints, yggAddr: _selfMeta.yggAddr }
      : undefined
    return { ok: true, ...(self ? { self } : {}), peers: getPeersForExchange(20) }
  })

  // ── Message endpoint (v1 + v2 compatible) ───────────────────────────────
  server.post("/peer/message", async (req, reply) => {
    const raw = req.body as any
    const srcIp = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "")
    const v1 = isV1Message(raw)

    // Transport-layer source verification (Yggdrasil only)
    if (!testMode && v1 && isYggdrasilAddr(srcIp)) {
      if (raw.fromYgg !== srcIp) {
        return reply.code(403).send({
          error: `from_ygg ${raw.fromYgg} does not match TCP source ${srcIp}`,
        })
      }
    }

    // Ed25519 signature verification
    const sigData = v1 ? canonicalV1(raw) : canonical(raw)
    if (!verifySignature(raw.publicKey, sigData, raw.signature)) {
      return reply.code(403).send({ error: "Invalid Ed25519 signature" })
    }

    // Derive agentId for TOFU
    const agentId = v1 ? agentIdFromPublicKey(raw.publicKey) : raw.from
    if (!tofuVerifyAndCache(agentId, raw.publicKey)) {
      return reply.code(403).send({
        error: `Public key mismatch for ${agentId} — possible key rotation, re-add peer`,
      })
    }

    // Normalize to v2 message format
    const msg: P2PMessage = {
      from: agentId,
      publicKey: raw.publicKey,
      event: raw.event,
      content: raw.content,
      timestamp: raw.timestamp,
      signature: raw.signature,
      fromYgg: raw.fromYgg,
    }

    // Leave tombstone
    if (msg.event === "leave") {
      removePeer(agentId)
      console.log(`[p2p] ← leave  from=${agentId} — removed from peer table`)
      return { ok: true }
    }

    const entry = { ...msg, verified: true, receivedAt: Date.now() }
    _inbox.unshift(entry)
    if (_inbox.length > 500) _inbox.pop()

    console.log(`[p2p] ← verified  from=${agentId}  event=${msg.event}`)

    _handlers.forEach((h) => h(entry))
    return { ok: true }
  })

  await server.listen({ port, host: "::" })
  console.log(`[p2p] Peer server listening on [::]:${port}${testMode ? " (test mode)" : ""}`)
}

export async function stopPeerServer(): Promise<void> {
  if (server) {
    await server.close()
    server = null
  }
}

export function getInbox(): typeof _inbox {
  return _inbox
}
