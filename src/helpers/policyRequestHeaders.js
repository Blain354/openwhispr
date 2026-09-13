const { isCanonicalAppVersion } = require("./appVersion");
const { withPortableBuildHeader } = require("./portableBuild");

const POLICY_CAPABILITY_VERSION = "1";

function withPolicyRequestHeaders(headers, appVersion) {
  if (!isCanonicalAppVersion(appVersion)) {
    throw new Error("Policy requests require a canonical app version");
  }
  // The build flavour is set last, like the other two, so a caller cannot
  // claim to be an artifact it is not.
  return withPortableBuildHeader({
    ...headers,
    "x-openwhispr-policy-version": POLICY_CAPABILITY_VERSION,
    "x-openwhispr-version": appVersion,
  });
}

module.exports = { POLICY_CAPABILITY_VERSION, withPolicyRequestHeaders };
