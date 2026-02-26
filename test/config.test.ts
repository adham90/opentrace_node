import { describe, expect, it } from "vitest";
import { clearLevelCache, isLevelEnabled, resolveConfig, validateConfig } from "../src/config.js";
import type { ResolvedConfig } from "../src/config.js";

describe("validateConfig", () => {
  it("returns null for valid config", () => {
    expect(validateConfig({ endpoint: "http://localhost", apiKey: "key", service: "svc" })).toBeNull();
  });

  it("requires endpoint", () => {
    expect(validateConfig({ endpoint: "", apiKey: "key", service: "svc" })).toBe("endpoint is required");
  });

  it("requires apiKey", () => {
    expect(validateConfig({ endpoint: "http://localhost", apiKey: "", service: "svc" })).toBe("apiKey is required");
  });

  it("requires service", () => {
    expect(validateConfig({ endpoint: "http://localhost", apiKey: "key", service: "" })).toBe("service is required");
  });
});

describe("resolveConfig", () => {
  const minimal = { endpoint: "http://localhost:8080/", apiKey: "test-key", service: "test-svc" };

  it("applies defaults", () => {
    const config = resolveConfig(minimal);
    expect(config.batchSize).toBe(50);
    expect(config.flushInterval).toBe(5000);
    expect(config.maxPayloadBytes).toBe(256 * 1024);
    expect(config.compression).toBe(true);
    expect(config.maxRetries).toBe(2);
    expect(config.minLevel).toBe("info");
    expect(config.sampleRate).toBe(1.0);
    expect(config.debug).toBe(false);
  });

  it("strips trailing slash from endpoint", () => {
    const config = resolveConfig(minimal);
    expect(config.endpoint).toBe("http://localhost:8080");
  });

  it("resolves hostname and pid", () => {
    const config = resolveConfig(minimal);
    expect(config.hostname).toBeTruthy();
    expect(config.pid).toBe(process.pid);
  });

  it("allows overriding defaults", () => {
    const config = resolveConfig({
      ...minimal,
      batchSize: 100,
      flushInterval: 10000,
      minLevel: "warn",
      debug: true,
    });
    expect(config.batchSize).toBe(100);
    expect(config.flushInterval).toBe(10000);
    expect(config.minLevel).toBe("warn");
    expect(config.debug).toBe(true);
  });

  it("resolves gitSha from env vars", () => {
    const original = process.env.REVISION;
    process.env.REVISION = "abc123";
    const config = resolveConfig(minimal);
    expect(config.gitSha).toBe("abc123");
    if (original === undefined) {
      process.env.REVISION = undefined;
    } else {
      process.env.REVISION = original;
    }
  });
});

describe("isLevelEnabled", () => {
  const makeConfig = (overrides: Partial<ResolvedConfig> = {}): ResolvedConfig =>
    resolveConfig({ endpoint: "http://x", apiKey: "k", service: "s", ...overrides });

  afterEach(() => clearLevelCache());

  it("filters by minLevel", () => {
    const config = makeConfig({ minLevel: "warn" });
    expect(isLevelEnabled("debug", config)).toBe(false);
    expect(isLevelEnabled("info", config)).toBe(false);
    expect(isLevelEnabled("warn", config)).toBe(true);
    expect(isLevelEnabled("error", config)).toBe(true);
  });

  it("defaults to info level", () => {
    const config = makeConfig();
    expect(isLevelEnabled("debug", config)).toBe(false);
    expect(isLevelEnabled("info", config)).toBe(true);
  });

  it("respects allowedLevels over minLevel", () => {
    const config = makeConfig({ allowedLevels: ["debug", "error"] });
    expect(isLevelEnabled("debug", config)).toBe(true);
    expect(isLevelEnabled("info", config)).toBe(false);
    expect(isLevelEnabled("warn", config)).toBe(false);
    expect(isLevelEnabled("error", config)).toBe(true);
  });

  it("handles unknown levels", () => {
    const config = makeConfig();
    expect(isLevelEnabled("trace", config)).toBe(false);
    expect(isLevelEnabled("CRITICAL", config)).toBe(false);
  });
});
