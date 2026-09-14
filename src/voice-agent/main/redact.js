// Removes credentials from anything that is about to be logged or relayed to a renderer.

const SECRET_FIELD = /(api[_-]?key|apikey|token|authorization|secret|password|passwd|cookie)/i;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const OPENAI_STYLE_KEY = /\bsk-[A-Za-z0-9_-]{8,}/g;
const REDACTED = "[redacted]";

function redactString(value) {
  return value.replace(BEARER, `Bearer ${REDACTED}`).replace(OPENAI_STYLE_KEY, REDACTED);
}

function redact(value, depth = 0) {
  if (depth > 8) return REDACTED;
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SECRET_FIELD.test(key) ? REDACTED : redact(item, depth + 1);
    }
    return out;
  }
  return value;
}

module.exports = { redact, REDACTED };
