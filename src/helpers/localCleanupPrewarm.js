// Loading a local cleanup model into llama-server takes seconds. Started when
// the recording begins, the load overlaps the user speaking instead of being
// paid after the mic closes, when the transcript is waiting for cleanup.

/**
 * The local model id the dictation cleanup step will ask for, or null when
 * cleanup is off, runs in the cloud, or uses a non-local provider.
 *
 * @param {object} settings
 * @param {{
 *   resolveConfig: (settings: object) => { mode?: string, provider?: string, model?: string },
 *   resolveProvider: (provider: string | undefined, model: string) => string,
 *   isCloudCleanup: () => boolean,
 * }} deps
 */
export function resolveLocalCleanupPrewarmModel(settings, deps) {
  if (!settings?.useCleanupModel) return null;
  if (deps.isCloudCleanup()) return null;
  const cleanup = deps.resolveConfig(settings);
  const model = cleanup?.model?.trim?.() || "";
  if (!model || cleanup.mode !== "local") return null;
  return deps.resolveProvider(cleanup.provider, model) === "local" ? model : null;
}
