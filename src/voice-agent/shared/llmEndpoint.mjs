/**
 * The language model a voice session talks to, from OpenWhispr's Voice Assistant settings.
 *
 * The session reads the same scope as the Voice Assistant (Settings → AI Models → Voice
 * Assistant, scope `dictationAgent`) and turns it into a request the main process checks: the
 * local model server, or an OpenAI-compatible Chat Completions endpoint with a model and a key.
 *
 * The app stores a cloud model as mode `providers` with a provider id (`custom` being one of the
 * providers, with its own URL and key), or as mode `self-hosted` with a URL. OpenWhispr Cloud and
 * enterprise providers have no Chat Completions endpoint a session can reach: they are refused
 * with a reason, never rerouted somewhere the user did not choose.
 */

/** Chat Completions endpoints of the reasoning providers the app offers, and where their key is. */
export const PROVIDER_ENDPOINTS = Object.freeze({
  openai: { label: "OpenAI", baseURL: "https://api.openai.com/v1", keyField: "openaiApiKey" },
  groq: { label: "Groq", baseURL: "https://api.groq.com/openai/v1", keyField: "groqApiKey" },
  openrouter: {
    label: "OpenRouter",
    baseURL: "https://openrouter.ai/api/v1",
    keyField: "openrouterApiKey",
  },
  // The app reaches Anthropic and Google through their own SDKs; both also publish an
  // OpenAI-compatible endpoint, which is what the session's Chat Completions client speaks.
  anthropic: {
    label: "Anthropic",
    baseURL: "https://api.anthropic.com/v1",
    keyField: "anthropicApiKey",
  },
  gemini: {
    label: "Google",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyField: "geminiApiKey",
  },
});

/** A base URL with a version segment, as OpenAI-compatible clients expect: `…/v1` appended if absent. */
export function withV1Suffix(base) {
  const trimmed = String(base ?? "")
    .trim()
    .replace(/\/+$/, "");
  if (!trimmed) return "";
  return /\/v\d+[a-z]*(\/[a-z]+)?$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

const invalid = (error) => ({ mode: "invalid", error });

// Prefixes that name a key's provider beyond doubt. An OpenRouter key saved as the OpenAI key was
// sent to api.openai.com and shown back, masked, in OpenAI's refusal: a key saved under the wrong
// provider is now refused before it leaves the machine.
const KEY_OWNERS = Object.freeze([
  ["sk-or-", "openrouter"],
  ["sk-ant-", "anthropic"],
  ["gsk_", "groq"],
  ["AIza", "gemini"],
]);

/** The provider a key unmistakably belongs to, or null (`sk-…` alone names no one). */
export function keyOwner(apiKey) {
  const key = String(apiKey ?? "").trim();
  const owner = KEY_OWNERS.find(([prefix]) => key.startsWith(prefix));
  return owner ? owner[1] : null;
}

/** What the settings panel shows as the model in use: the model and where it runs, or why none. */
export function describeSessionModel(request, conversationModel) {
  if (request?.mode === "local") return { model: String(conversationModel ?? ""), where: "local" };
  if (request?.mode === "remote") {
    return { model: String(request.model ?? ""), where: request.label || request.baseURL || "" };
  }
  return { model: "", where: "", error: request?.error || "unsupported-provider" };
}

/**
 * @param {{ mode?: string, provider?: string, model?: string, cloudBaseUrl?: string,
 *           remoteUrl?: string, customApiKey?: string }} config
 *   what `selectResolvedLLMConfig(settings, "dictationAgent")` returns
 * @param {Record<string, unknown>} settings the settings store, with the provider keys loaded
 */
export function sessionLlmRequest(config = {}, settings = {}) {
  const mode = config?.mode;
  if (mode === "local") return { mode: "local" };

  const model = String(config?.model ?? "").trim();

  if (mode === "self-hosted") {
    const baseURL = withV1Suffix(config.remoteUrl);
    if (!baseURL) return invalid("missing-base-url");
    if (!model) return invalid("missing-model");
    return {
      mode: "remote",
      provider: "self-hosted",
      label: hostOf(baseURL),
      baseURL,
      model,
      apiKey: String(config.customApiKey ?? ""),
    };
  }

  if (mode === "providers") {
    const provider = String(config.provider ?? "");
    if (provider === "custom") {
      const baseURL = withV1Suffix(config.cloudBaseUrl);
      if (!baseURL) return invalid("missing-base-url");
      if (!model) return invalid("missing-model");
      // A custom server may need no key (Ollama, llama-server): an empty one is sent as is.
      return {
        mode: "remote",
        provider,
        label: hostOf(baseURL),
        baseURL,
        model,
        apiKey: String(config.customApiKey ?? ""),
      };
    }
    if (!Object.prototype.hasOwnProperty.call(PROVIDER_ENDPOINTS, provider)) {
      return invalid("unsupported-provider");
    }
    const endpoint = PROVIDER_ENDPOINTS[provider];
    if (!model) return invalid("missing-model");
    const apiKey = String(settings?.[endpoint.keyField] ?? "").trim();
    if (!apiKey) return invalid("missing-api-key");
    const owner = keyOwner(apiKey);
    if (owner && owner !== provider) return invalid("key-mismatch");
    return {
      mode: "remote",
      provider,
      label: endpoint.label,
      baseURL: endpoint.baseURL,
      model,
      apiKey,
    };
  }

  return invalid("unsupported-provider");
}
