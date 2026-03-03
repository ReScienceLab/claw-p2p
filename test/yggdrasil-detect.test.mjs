import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "fs"

const source = fs.readFileSync(
  new URL("../dist/yggdrasil.js", import.meta.url),
  "utf8"
)

describe("yggdrasil daemon detection", () => {
  it("defines WELL_KNOWN_TCP_ENDPOINTS with 127.0.0.1:9001", () => {
    assert.ok(
      source.includes("tcp://127.0.0.1:9001"),
      "should have TCP admin endpoint as first detection candidate"
    )
  })

  it("exports detectExternalYggdrasil", () => {
    assert.ok(
      source.includes("exports.detectExternalYggdrasil"),
      "detectExternalYggdrasil should be exported"
    )
  })

  it("tries TCP endpoints before UNIX sockets", () => {
    const tcpIdx = source.indexOf("WELL_KNOWN_TCP_ENDPOINTS")
    const sockIdx = source.indexOf("WELL_KNOWN_SOCKETS")
    // In the detect function, TCP should be tried first
    const fnBody = source.slice(source.indexOf("function detectExternalYggdrasil"))
    const tcpUse = fnBody.indexOf("WELL_KNOWN_TCP_ENDPOINTS")
    const sockUse = fnBody.indexOf("WELL_KNOWN_SOCKETS")
    assert.ok(tcpUse < sockUse, "TCP endpoints should be checked before UNIX sockets")
  })

  it("generateConfig uses TCP admin endpoint", () => {
    const genFn = source.slice(source.indexOf("function generateConfig"))
    assert.ok(
      genFn.includes("WELL_KNOWN_TCP_ENDPOINTS"),
      "generateConfig should use TCP admin endpoint by default"
    )
  })

  it("logs actionable message on socket permission denied", () => {
    assert.ok(
      source.includes("setup-yggdrasil.sh"),
      "should suggest setup script when socket access fails"
    )
  })
})
