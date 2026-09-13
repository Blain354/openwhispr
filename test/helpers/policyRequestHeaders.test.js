const test = require("node:test");
const assert = require("node:assert/strict");

const {
  POLICY_CAPABILITY_VERSION,
  withPolicyRequestHeaders,
} = require("../../src/helpers/policyRequestHeaders");

// The builder reads process.env for the build flavour. Pin it so these
// assertions do not depend on where the suite happens to run.
const savedPortableDir = process.env.PORTABLE_EXECUTABLE_DIR;
test.beforeEach(() => {
  delete process.env.PORTABLE_EXECUTABLE_DIR;
});
test.after(() => {
  if (savedPortableDir === undefined) delete process.env.PORTABLE_EXECUTABLE_DIR;
  else process.env.PORTABLE_EXECUTABLE_DIR = savedPortableDir;
});

test("adds the exact policy capability and canonical app version headers", () => {
  assert.equal(POLICY_CAPABILITY_VERSION, "1");
  assert.deepEqual(withPolicyRequestHeaders({ Authorization: "Bearer token" }, "1.8.1"), {
    Authorization: "Bearer token",
    "x-openwhispr-policy-version": "1",
    "x-openwhispr-version": "1.8.1",
    "x-openwhispr-portable": "0",
  });
});

test("does not allow callers to override desktop policy capability headers", () => {
  assert.deepEqual(
    withPolicyRequestHeaders(
      {
        "x-openwhispr-policy-version": "2",
        "x-openwhispr-version": "0.0.1",
        "x-openwhispr-portable": "1",
      },
      "1.8.1"
    ),
    {
      "x-openwhispr-policy-version": "1",
      "x-openwhispr-version": "1.8.1",
      "x-openwhispr-portable": "0",
    }
  );
});

test("rejects a non-canonical app version instead of advertising a malformed client", () => {
  assert.throws(() => withPolicyRequestHeaders({}, "1.8"), /canonical app version/i);
  assert.throws(() => withPolicyRequestHeaders({}, "1.8.1-beta.1"), /canonical app version/i);
});

// The build flavour rides with the version header so the server never has to
// guess which artifact a recorded client_version came from.
test("reports the portable build when the launcher variable is set", () => {
  process.env.PORTABLE_EXECUTABLE_DIR = "C:\\Users\\someone\\Downloads";
  assert.deepEqual(withPolicyRequestHeaders({}, "1.9.1"), {
    "x-openwhispr-policy-version": "1",
    "x-openwhispr-version": "1.9.1",
    "x-openwhispr-portable": "1",
  });
});
