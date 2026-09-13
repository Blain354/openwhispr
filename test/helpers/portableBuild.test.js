const test = require("node:test");
const assert = require("node:assert/strict");

const {
  PORTABLE_BUILD_HEADER,
  isPortableBuild,
  withPortableBuildHeader,
} = require("../../src/helpers/portableBuild");

const PORTABLE_ENV = { PORTABLE_EXECUTABLE_DIR: "C:\\Users\\thibault\\Downloads" };

test("the header name matches the x-openwhispr-* family", () => {
  assert.equal(PORTABLE_BUILD_HEADER, "x-openwhispr-portable");
});

test("only a non-empty PORTABLE_EXECUTABLE_DIR means the portable build", () => {
  assert.equal(isPortableBuild(PORTABLE_ENV), true);
  assert.equal(isPortableBuild({}), false);
  assert.equal(isPortableBuild({ PORTABLE_EXECUTABLE_DIR: "" }), false);
  assert.equal(isPortableBuild({ PORTABLE_EXECUTABLE_DIR: undefined }), false);
});

test("the header is always sent, as 1 or 0, so absent can mean an older client", () => {
  assert.deepEqual(withPortableBuildHeader({ a: "b" }, PORTABLE_ENV), {
    a: "b",
    "x-openwhispr-portable": "1",
  });
  assert.deepEqual(withPortableBuildHeader({ a: "b" }, {}), {
    a: "b",
    "x-openwhispr-portable": "0",
  });
});

// The portable directory is under the user's profile, so it carries the
// Windows account name. A boolean is the entire question being asked.
test("the directory path never reaches a header value", () => {
  const headers = withPortableBuildHeader({}, PORTABLE_ENV);
  for (const value of Object.values(headers)) {
    assert.doesNotMatch(String(value), /thibault|Downloads|C:\\/i);
  }
});

test("a caller cannot pre-set the header to something untrue", () => {
  assert.deepEqual(withPortableBuildHeader({ "x-openwhispr-portable": "1" }, {}), {
    "x-openwhispr-portable": "0",
  });
});

test("the default env is process.env and does not throw", () => {
  assert.equal(typeof isPortableBuild(), "boolean");
});
