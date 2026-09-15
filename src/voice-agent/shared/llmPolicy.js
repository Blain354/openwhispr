/**
 * Where a voice session may send its prompt and its key: HTTPS anywhere, plain HTTP only inside
 * the user's own network (loopback, private ranges, link-local, Tailscale, `.local`).
 *
 * The same rule as the app's `isSecureHttpEndpoint` (src/utils/urlUtils.ts), which guards these
 * endpoints everywhere else in OpenWhispr. Kept in step with it by hand: that module is renderer
 * TypeScript, this one runs in the main process.
 */

function parseIPv4(host) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every((part) => part <= 255) ? parts : null;
}

function isPrivateHost(hostname) {
  const host = String(hostname ?? "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "0.0.0.0" || host === "::1") return true;

  const ip = parseIPv4(host);
  if (ip) {
    const [a, b] = ip;
    return (
      a === 127 ||
      a === 10 ||
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31) ||
      // RFC 6598 shared address space, which Tailscale uses.
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254)
    );
  }

  if (
    host.includes(":") &&
    (/^fe[89ab]/.test(host) || host.startsWith("fc") || host.startsWith("fd"))
  ) {
    return true;
  }
  return host.endsWith(".local") || host.endsWith(".ts.net");
}

/** Why a base URL cannot be used, or null when it can. */
function remoteBaseProblem(baseURL) {
  let url;
  try {
    url = new URL(String(baseURL ?? ""));
  } catch {
    return "invalid-base-url";
  }
  if (url.protocol === "https:") return null;
  if (url.protocol !== "http:") return "invalid-base-url";
  return isPrivateHost(url.hostname) ? null : "insecure-base-url";
}

module.exports = { isPrivateHost, remoteBaseProblem };
