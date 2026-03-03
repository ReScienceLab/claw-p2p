import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { CHANNEL_CONFIG_SCHEMA } from "../dist/channel.js"

describe("CHANNEL_CONFIG_SCHEMA", () => {
  it("has schema and uiHints top-level keys", () => {
    assert.ok(CHANNEL_CONFIG_SCHEMA.schema, "missing schema")
    assert.ok(CHANNEL_CONFIG_SCHEMA.uiHints, "missing uiHints")
  })

  it("schema is an object type", () => {
    assert.equal(CHANNEL_CONFIG_SCHEMA.schema.type, "object")
  })

  it("schema has additionalProperties: false (required by OpenClaw UI)", () => {
    assert.equal(
      CHANNEL_CONFIG_SCHEMA.schema.additionalProperties,
      false,
      "additionalProperties must be false — true causes 'Unsupported schema node' in Control UI"
    )
  })

  it("schema defines enabled, dmPolicy, allowFrom properties", () => {
    const props = CHANNEL_CONFIG_SCHEMA.schema.properties
    assert.ok(props.enabled, "missing enabled property")
    assert.ok(props.dmPolicy, "missing dmPolicy property")
    assert.ok(props.allowFrom, "missing allowFrom property")
  })

  it("dmPolicy default is pairing", () => {
    assert.equal(
      CHANNEL_CONFIG_SCHEMA.schema.properties.dmPolicy.default,
      "pairing"
    )
  })

  it("dmPolicy enum includes open, pairing, allowlist", () => {
    const e = CHANNEL_CONFIG_SCHEMA.schema.properties.dmPolicy.enum
    assert.ok(e.includes("open"))
    assert.ok(e.includes("pairing"))
    assert.ok(e.includes("allowlist"))
  })

  it("allowFrom is array of strings", () => {
    const af = CHANNEL_CONFIG_SCHEMA.schema.properties.allowFrom
    assert.equal(af.type, "array")
    assert.equal(af.items.type, "string")
  })

  it("uiHints has entries for dmPolicy and allowFrom", () => {
    assert.ok(CHANNEL_CONFIG_SCHEMA.uiHints.dmPolicy, "missing dmPolicy hint")
    assert.ok(CHANNEL_CONFIG_SCHEMA.uiHints.allowFrom, "missing allowFrom hint")
  })
})
