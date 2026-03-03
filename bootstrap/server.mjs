/**
 * DeClaw Bootstrap Node — standalone peer exchange server.
 * No OpenClaw dependency. Runs alongside a Yggdrasil daemon.
 *
 * Endpoints:
 *   GET  /peer/ping     — health check
 *   GET  /peer/peers    — return known peer list
 *   POST /peer/announce — accept signed peer announcement, return our peer list
 */
import Fastify from "fastify";
import nacl from "tweetnacl";
import fs from "fs";
import path from "path";

const PORT = parseInt(process.env.PEER_PORT ?? "8099");
const DATA_DIR = process.env.DATA_DIR ?? "/data";
const TEST_MODE = process.env.TEST_MODE === "true";
const MAX_PEERS = 500;
const PERSIST_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// Peer DB (in-memory + JSON persistence)
// ---------------------------------------------------------------------------
const peers = new Map(); // yggAddr -> PeerRecord

function loadPeers() {
  const file = path.join(DATA_DIR, "peers.json");
  if (!fs.existsSync(file)) return;
  try {
    const records = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const r of records) peers.set(r.yggAddr, r);
    console.log(`[bootstrap] Loaded ${peers.size} peers from disk`);
  } catch (e) {
    console.warn("[bootstrap] Could not load peers.json:", e.message);
  }
}

function savePeers() {
  const file = path.join(DATA_DIR, "peers.json");
  try {
    fs.writeFileSync(file, JSON.stringify([...peers.values()], null, 2));
  } catch (e) {
    console.warn("[bootstrap] Could not save peers.json:", e.message);
  }
}

function upsertPeer(yggAddr, publicKey, opts = {}) {
  const now = Date.now();
  const existing = peers.get(yggAddr);
  peers.set(yggAddr, {
    yggAddr,
    publicKey,
    alias: opts.alias ?? existing?.alias ?? "",
    firstSeen: existing?.firstSeen ?? now,
    lastSeen: now,
    source: opts.source ?? "gossip",
    discoveredVia: opts.discoveredVia ?? existing?.discoveredVia,
  });
  // Evict oldest peers if we exceed MAX_PEERS
  if (peers.size > MAX_PEERS) {
    const sorted = [...peers.values()].sort((a, b) => a.lastSeen - b.lastSeen);
    peers.delete(sorted[0].yggAddr);
  }
}

function getPeersForExchange(limit = 50) {
  return [...peers.values()]
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .slice(0, limit)
    .map(({ yggAddr, publicKey, alias, lastSeen }) => ({
      yggAddr,
      publicKey,
      alias,
      lastSeen,
    }));
}

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------
function verifySignature(publicKeyB64, obj, signatureB64) {
  try {
    const pubKey = Buffer.from(publicKeyB64, "base64");
    const sig = Buffer.from(signatureB64, "base64");
    const msg = Buffer.from(JSON.stringify(obj));
    return nacl.sign.detached.verify(msg, sig, pubKey);
  } catch {
    return false;
  }
}

function isYggdrasilAddr(addr) {
  // Yggdrasil 200::/8 — first byte 0x02, compressed to "2XX:" in IPv6 text
  const clean = addr.replace(/^::ffff:/, "");
  return /^2[0-9a-f]{2}:/i.test(clean);
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
fs.mkdirSync(DATA_DIR, { recursive: true });
loadPeers();
setInterval(savePeers, PERSIST_INTERVAL_MS);

const server = Fastify({ logger: false });

server.get("/peer/ping", async () => ({
  ok: true,
  ts: Date.now(),
  bootstrap: true,
  peers: peers.size,
}));

server.get("/peer/peers", async () => ({
  peers: getPeersForExchange(50),
}));

server.post("/peer/announce", async (req, reply) => {
  const ann = req.body;
  if (!ann || typeof ann !== "object") {
    return reply.code(400).send({ error: "Invalid body" });
  }

  const srcIp = req.socket.remoteAddress ?? "";

  if (!TEST_MODE) {
    if (!isYggdrasilAddr(srcIp)) {
      return reply.code(403).send({ error: "Source must be a Yggdrasil address (200::/8)" });
    }
    const normalizedSrc = srcIp.replace(/^::ffff:/, "");
    if (ann.fromYgg !== normalizedSrc) {
      return reply.code(403).send({
        error: `fromYgg ${ann.fromYgg} does not match TCP source ${normalizedSrc}`,
      });
    }
  }

  const { signature, peers: sharedPeers, ...signable } = ann;
  if (!verifySignature(ann.publicKey, signable, signature)) {
    return reply.code(403).send({ error: "Invalid Ed25519 signature" });
  }

  upsertPeer(ann.fromYgg, ann.publicKey, {
    alias: ann.alias,
    source: "gossip",
    discoveredVia: ann.fromYgg,
  });

  for (const p of sharedPeers ?? []) {
    if (p.yggAddr === ann.fromYgg) continue;
    upsertPeer(p.yggAddr, p.publicKey, {
      alias: p.alias,
      source: "gossip",
      discoveredVia: ann.fromYgg,
    });
  }

  console.log(
    `[bootstrap] ↔ ${ann.fromYgg.slice(0, 22)}...  shared=${sharedPeers?.length ?? 0}  total=${peers.size}`
  );

  return { ok: true, peers: getPeersForExchange(50) };
});

await server.listen({ port: PORT, host: "::" });
console.log(`[bootstrap] Listening on [::]:${PORT}${TEST_MODE ? " (test mode)" : ""}`);
console.log(`[bootstrap] Data dir: ${DATA_DIR}`);
