import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { initDb, upsertPeer, upsertDiscoveredPeer, listPeers, getPeer, removePeer, flushDb, tofuVerifyAndCache, toufuVerifyAndCache, getPeerIds, getPeerAddresses, pruneStale } from "../dist/peer-db.js"
import { generateIdentity, agentIdFromPublicKey } from "../dist/identity.js"

let tmpDir

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "declaw-peerdb-"))
  initDb(tmpDir)
})

afterEach(() => {
  flushDb()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe("peer-db v2 (agentId-keyed)", () => {
  it("upsertDiscoveredPeer stores by agentId", () => {
    const id = generateIdentity()
    upsertDiscoveredPeer(id.agentId, id.publicKey, { source: "bootstrap" })
    const peer = getPeer(id.agentId)
    assert.ok(peer)
    assert.equal(peer.agentId, id.agentId)
    assert.equal(peer.publicKey, id.publicKey)
  })

  it("getPeerIds returns agentIds", () => {
    const id1 = generateIdentity()
    const id2 = generateIdentity()
    upsertDiscoveredPeer(id1.agentId, id1.publicKey, { source: "bootstrap" })
    upsertDiscoveredPeer(id2.agentId, id2.publicKey, { source: "gossip" })
    const ids = getPeerIds()
    assert.ok(ids.includes(id1.agentId))
    assert.ok(ids.includes(id2.agentId))
  })

  it("upsertPeer works with agentId", () => {
    upsertPeer("abcdef1234567890", "Alice")
    const peer = getPeer("abcdef1234567890")
    assert.ok(peer)
    assert.equal(peer.alias, "Alice")
  })

  it("removePeer works with agentId", () => {
    const id = generateIdentity()
    upsertDiscoveredPeer(id.agentId, id.publicKey, {})
    assert.ok(getPeer(id.agentId))
    removePeer(id.agentId)
    assert.equal(getPeer(id.agentId), null)
  })

  it("derives agentId from publicKey when yggAddr passed as ID", () => {
    const id = generateIdentity()
    const yggAddr = "200:1234::5678"
    upsertDiscoveredPeer(yggAddr, id.publicKey, { source: "bootstrap", yggAddr })
    // Should be stored under derived agentId, not yggAddr
    const peer = getPeer(id.agentId)
    assert.ok(peer, "peer should be findable by derived agentId")
    assert.equal(peer.yggAddr, yggAddr)
  })

  it("TOFU: tofuVerifyAndCache accepts first key", () => {
    const id = generateIdentity()
    assert.equal(tofuVerifyAndCache(id.agentId, id.publicKey), true)
  })

  it("TOFU: rejects different key for same agentId", () => {
    const id1 = generateIdentity()
    const id2 = generateIdentity()
    tofuVerifyAndCache(id1.agentId, id1.publicKey)
    assert.equal(tofuVerifyAndCache(id1.agentId, id2.publicKey), false)
  })

  it("TOFU: v1 compat wrapper toufuVerifyAndCache works", () => {
    const id = generateIdentity()
    const yggAddr = "200::1"
    assert.equal(toufuVerifyAndCache(yggAddr, id.publicKey), true)
    // Second call with same key should pass
    assert.equal(toufuVerifyAndCache(yggAddr, id.publicKey), true)
  })

  it("v1 store migration adds agentId to old records", () => {
    // Write a v1 store file directly
    const v1Store = {
      peers: {
        "200::1": {
          yggAddr: "200::1",
          publicKey: "dGVzdHB1YmtleQ==",
          alias: "OldPeer",
          firstSeen: 1000,
          lastSeen: 2000,
          source: "bootstrap",
        },
      },
    }
    const dbPath = path.join(tmpDir, "peers.json")
    fs.writeFileSync(dbPath, JSON.stringify(v1Store))

    // Re-init triggers migration
    initDb(tmpDir)
    const peers = listPeers()
    assert.equal(peers.length, 1)
    assert.ok(peers[0].agentId, "migrated peer should have agentId")
    assert.equal(peers[0].alias, "OldPeer")
    assert.equal(peers[0].yggAddr, "200::1")
  })

  it("pruneStale removes old peers but protects manual", () => {
    const id1 = generateIdentity()
    const id2 = generateIdentity()
    // Create gossip peer with old lastSeen
    upsertDiscoveredPeer(id1.agentId, id1.publicKey, {
      source: "gossip",
      lastSeen: 1000, // very old timestamp
    })
    // Create manual peer (should be protected from pruning)
    upsertPeer(id2.agentId, "Manual")

    assert.equal(listPeers().length, 2, "should have 2 peers before prune")
    const pruned = pruneStale(1000) // maxAge 1 second
    assert.ok(pruned >= 1, "should have pruned at least the gossip peer")
    assert.equal(getPeer(id1.agentId), null, "gossip peer should be pruned")
    assert.ok(getPeer(id2.agentId), "manual peer should be protected")
  })
})
