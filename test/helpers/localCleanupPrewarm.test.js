import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveLocalCleanupPrewarmModel } from "../../src/helpers/localCleanupPrewarm.js";

const deps = (cleanup, { cloud = false, provider = "local" } = {}) => ({
  resolveConfig: () => cleanup,
  resolveProvider: () => provider,
  isCloudCleanup: () => cloud,
});

const local = { mode: "local", provider: "qwen", model: "qwen3-4b-q4_k_m" };

test("returns the local cleanup model when cleanup is on", () => {
  assert.equal(
    resolveLocalCleanupPrewarmModel({ useCleanupModel: true }, deps(local)),
    "qwen3-4b-q4_k_m"
  );
});

test("nothing to warm when cleanup is off", () => {
  assert.equal(resolveLocalCleanupPrewarmModel({ useCleanupModel: false }, deps(local)), null);
});

test("nothing to warm for cloud cleanup", () => {
  assert.equal(
    resolveLocalCleanupPrewarmModel({ useCleanupModel: true }, deps(local, { cloud: true })),
    null
  );
});

test("nothing to warm for a provider or self-hosted cleanup", () => {
  const s = { useCleanupModel: true };
  assert.equal(
    resolveLocalCleanupPrewarmModel(
      s,
      deps({ ...local, mode: "providers" }, { provider: "openai" })
    ),
    null
  );
  assert.equal(resolveLocalCleanupPrewarmModel(s, deps({ ...local, mode: "self-hosted" })), null);
  assert.equal(resolveLocalCleanupPrewarmModel(s, deps(local, { provider: "openai" })), null);
});

test("nothing to warm without a model", () => {
  assert.equal(
    resolveLocalCleanupPrewarmModel({ useCleanupModel: true }, deps({ ...local, model: "  " })),
    null
  );
});
