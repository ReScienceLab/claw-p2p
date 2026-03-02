export interface Identity {
  agentId: string;       // sha256(publicKey)[:16] hex
  publicKey: string;     // base64 Ed25519 public key
  privateKey: string;    // base64 Ed25519 private key
  cgaIpv6: string;       // CGA ULA address (fd00::/8 style)
  yggIpv6: string;       // Derived Yggdrasil address (200::/8 style, before daemon starts)
}

export interface YggdrasilInfo {
  address: string;       // Real Yggdrasil address from daemon (200::/8)
  subnet: string;        // e.g. 300::/64
  pid: number;
}

export interface P2PMessage {
  fromYgg: string;       // sender's Yggdrasil address (must match TCP source IP)
  publicKey: string;     // sender's Ed25519 public key base64 (for TOFU)
  event: "chat" | "ping" | "pong" | string;
  content: string;
  timestamp: number;     // unix ms
  signature: string;     // Ed25519 sig over canonical JSON (all fields except signature)
}

export interface PeerRecord {
  yggAddr: string;       // primary key
  publicKey: string;     // verified Ed25519 public key
  alias: string;
  firstSeen: number;
  lastSeen: number;
}

export interface PluginConfig {
  peer_port?: number;
  data_dir?: string;
  yggdrasil_peers?: string[];
}
