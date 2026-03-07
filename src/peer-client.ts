/**
 * P2P client — sends signed messages to other OpenClaw nodes.
 *
 * v2: Messages use `from` (agentId) as the sender identifier.
 * Delivery strategy:
 *   1. QUIC/UDP transport (if peer has QUIC endpoints and we have the transport)
 *   2. HTTP over Yggdrasil IPv6 (if peer has yggdrasil endpoint or legacy yggAddr)
 *   3. HTTP over any reachable IPv4/IPv6
 */
import { P2PMessage, Identity, Endpoint } from "./types"
import { signMessage } from "./identity"
import { Transport } from "./transport"

/**
 * Build a signed P2PMessage payload (v2 format).
 * Uses `from` (agentId) as sender. Includes `fromYgg` for backward compat with v1 peers.
 */
function buildSignedMessage(
  identity: Identity,
  event: string,
  content: string,
): P2PMessage {
  const timestamp = Date.now()
  const payload: Omit<P2PMessage, "signature"> = {
    from: identity.agentId,
    publicKey: identity.publicKey,
    event,
    content,
    timestamp,
    // Include fromYgg for v1 backward compat (v1 servers verify fromYgg === TCP source)
    fromYgg: identity.yggIpv6,
  }
  // Sign over the canonical v2 fields (from, publicKey, event, content, timestamp)
  // plus fromYgg for backward compat with v1 verifiers
  const signature = signMessage(identity.privateKey, payload as Record<string, unknown>)
  return { ...payload, signature }
}

async function sendViaHttp(
  msg: P2PMessage,
  targetAddr: string,
  port: number,
  timeoutMs: number,
): Promise<{ ok: boolean; error?: string }> {
  const isIpv6 = targetAddr.includes(":")
  const url = isIpv6
    ? `http://[${targetAddr}]:${port}/peer/message`
    : `http://${targetAddr}:${port}/peer/message`

  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msg),
      signal: ctrl.signal,
    })
    clearTimeout(timer)
    if (!resp.ok) {
      const body = await resp.text().catch(() => "")
      return { ok: false, error: `HTTP ${resp.status}: ${body}` }
    }
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err.message ?? String(err) }
  }
}

async function sendViaTransport(
  msg: P2PMessage,
  target: string,
  transport: Transport,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const data = Buffer.from(JSON.stringify(msg))
    await transport.send(target, data)
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err.message ?? String(err) }
  }
}

export interface SendOptions {
  /** Peer's known transport endpoints (v2 Endpoint[]). */
  endpoints?: Endpoint[]
  /** Available QUIC transport for UDP delivery. */
  quicTransport?: Transport
}

/**
 * Build a signed P2PMessage and deliver it to the target peer.
 *
 * @param targetAddr — peer's agentId, yggAddr, or IP address (for HTTP fallback)
 *
 * Delivery strategy:
 *   1. QUIC endpoints (sorted by priority)
 *   2. Yggdrasil endpoints
 *   3. Direct HTTP to targetAddr (legacy fallback)
 */
export async function sendP2PMessage(
  identity: Identity,
  targetAddr: string,
  event: string,
  content: string,
  port: number = 8099,
  timeoutMs: number = 10_000,
  opts?: SendOptions,
): Promise<{ ok: boolean; error?: string }> {
  const msg = buildSignedMessage(identity, event, content)

  // Try QUIC transport first
  if (opts?.quicTransport?.isActive() && opts?.endpoints?.length) {
    const quicEndpoint = opts.endpoints
      .filter((e) => e.transport === "quic")
      .sort((a, b) => a.priority - b.priority)[0]
    if (quicEndpoint) {
      const target = quicEndpoint.port
        ? `${quicEndpoint.address}:${quicEndpoint.port}`
        : quicEndpoint.address
      const result = await sendViaTransport(msg, target, opts.quicTransport)
      if (result.ok) return result
      console.warn(`[p2p:client] QUIC send to ${quicEndpoint.address} failed, falling back to HTTP`)
    }
  }

  // Try Yggdrasil endpoint from peer record
  if (opts?.endpoints?.length) {
    const yggEndpoint = opts.endpoints
      .filter((e) => e.transport === "yggdrasil")
      .sort((a, b) => a.priority - b.priority)[0]
    if (yggEndpoint) {
      return sendViaHttp(msg, yggEndpoint.address, yggEndpoint.port || port, timeoutMs)
    }
  }

  // Legacy fallback: direct HTTP to the provided address
  return sendViaHttp(msg, targetAddr, port, timeoutMs)
}

/**
 * Broadcast a signed "leave" tombstone to all known peers on graceful shutdown.
 */
export async function broadcastLeave(
  identity: Identity,
  peers: Array<{ agentId: string; yggAddr?: string; endpoints?: Endpoint[] }>,
  port: number = 8099,
  opts?: SendOptions,
): Promise<void> {
  if (peers.length === 0) return
  await Promise.allSettled(
    peers.map((p) => {
      const addr = p.yggAddr ?? p.agentId
      return sendP2PMessage(identity, addr, "leave", "", port, 3_000, {
        ...opts,
        endpoints: p.endpoints ?? opts?.endpoints,
      })
    })
  )
  console.log(`[p2p] Leave broadcast sent to ${peers.length} peer(s)`)
}

/**
 * Ping a peer — returns true if reachable within timeout.
 * Accepts agentId or yggAddr; prefers endpoint-based routing.
 */
export async function pingPeer(
  targetAddr: string,
  port: number = 8099,
  timeoutMs: number = 5_000,
  endpoints?: Endpoint[],
): Promise<boolean> {
  // Try Yggdrasil endpoint first
  if (endpoints?.length) {
    const yggEp = endpoints.find((e) => e.transport === "yggdrasil")
    if (yggEp) {
      targetAddr = yggEp.address
      port = yggEp.port || port
    }
  }
  const isIpv6 = targetAddr.includes(":")
  const url = isIpv6
    ? `http://[${targetAddr}]:${port}/peer/ping`
    : `http://${targetAddr}:${port}/peer/ping`
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    const resp = await fetch(url, { signal: ctrl.signal })
    clearTimeout(timer)
    return resp.ok
  } catch {
    return false
  }
}
