// ── Transport types ──────────────────────────────────────────────────────────

export type TransportType = "yggdrasil" | "quic" | "tailscale" | "tcp"

/** Transport-aware endpoint for multi-transport peer discovery (v2). */
export interface Endpoint {
  transport: TransportType
  address: string       // transport-specific: "1.2.3.4" or "200:xxxx::xxxx"
  port: number
  priority: number      // lower = preferred (0 = best)
  ttl: number           // seconds until this endpoint should be re-resolved
}

/** @deprecated Use Endpoint instead. Kept for backward compat with v1 code paths. */
export interface PeerEndpoint {
  transport: TransportType
  address: string
  priority: number
}

// ── Identity types ──────────────────────────────────────────────────────────

export interface Identity {
  agentId: string       // hex(sha256(publicKey))[:16] — permanent anchor
  publicKey: string     // base64 Ed25519 public key
  privateKey: string    // base64 Ed25519 private key (never leaves local storage)
  /** @deprecated Yggdrasil-specific, kept for v1 backward compat. */
  cgaIpv6?: string
  /** @deprecated Yggdrasil-specific, kept for v1 backward compat. Mutated at runtime by transport. */
  yggIpv6?: string
}

export interface YggdrasilInfo {
  address: string       // Real Yggdrasil address from daemon (200::/8)
  subnet: string        // e.g. 300::/64
  pid: number
}

// ── Wire protocol types ─────────────────────────────────────────────────────

/** P2P message v2 — transport-independent, agentId-based. */
export interface P2PMessage {
  from: string          // sender's agentId
  publicKey: string     // sender's Ed25519 public key base64 (for TOFU)
  event: "chat" | "ping" | "pong" | "leave" | string
  content: string
  timestamp: number     // unix ms
  signature: string     // Ed25519 sig over canonical JSON (all fields except signature)
  /** @deprecated v1 compat — present in v1 messages, absent in v2. */
  fromYgg?: string
}

/** Detect v1 vs v2 message format. */
export function isV1Message(msg: any): boolean {
  return typeof msg.fromYgg === "string" && typeof msg.from !== "string"
}

/** Signed peer-exchange announcement v2. */
export interface PeerAnnouncement {
  from: string              // announcer's agentId
  publicKey: string
  alias?: string
  version?: string
  endpoints: Endpoint[]     // announcer's own endpoints (signed)
  capabilities?: string[]
  timestamp: number
  signature: string
  /** @deprecated v1 compat field. */
  fromYgg?: string
  /** peers the sender knows about (shared for gossip) */
  peers: Array<{
    agentId: string
    publicKey: string
    alias?: string
    endpoints: Endpoint[]
    lastSeen: number
  }>
}

/** Detect v1 vs v2 announcement format. */
export function isV1Announcement(ann: any): boolean {
  return typeof ann.fromYgg === "string" && typeof ann.from !== "string"
}

// ── Peer record types ───────────────────────────────────────────────────────

/** Peer record v2 — keyed by agentId. */
export interface PeerRecord {
  agentId: string       // primary key
  publicKey: string     // verified Ed25519 public key
  alias: string
  endpoints: Endpoint[]
  capabilities: string[]
  firstSeen: number
  lastSeen: number
  /** @deprecated v1 compat — Yggdrasil address if known. */
  yggAddr?: string
}

/** Peer record with discovery metadata. */
export interface DiscoveredPeerRecord extends PeerRecord {
  discoveredVia?: string  // agentId of the node that told us about this peer
  source: "manual" | "bootstrap" | "gossip"
  version?: string
}

// ── Plugin config ───────────────────────────────────────────────────────────

export interface PluginConfig {
  agent_name?: string
  peer_port?: number
  quic_port?: number
  data_dir?: string
  yggdrasil_peers?: string[]
  test_mode?: boolean | "auto"
  bootstrap_peers?: string[]
  discovery_interval_ms?: number
  startup_delay_ms?: number
}

// ── Key rotation (future) ───────────────────────────────────────────────────

export interface KeyRotation {
  agentId: string
  oldPublicKey: string
  newPublicKey: string
  timestamp: number
  signatureByOldKey: string
  signatureByNewKey: string
}
