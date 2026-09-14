// Native confirmation owned by the main process.
//
// Every mutating conversation op calls this before doing anything, in the same main-process
// handler that then executes it: a renderer can ask for an action but can never approve one.
// Dialogs are serialized, default to Cancel, and count as a refusal after the timeout.

const DEFAULT_TIMEOUT_MS = 60_000;

function createConfirm({ dialog, tr, debugLogger, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  let queue = Promise.resolve();

  async function show({ title, message, detail, risk, parent }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const options = {
        type: risk === "high" ? "warning" : "question",
        title,
        message,
        detail: [detail, tr("conversation:confirm.timeoutNote")].filter(Boolean).join("\n\n"),
        buttons: [tr("conversation:confirm.cancel"), tr("conversation:confirm.execute")],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        signal: controller.signal,
      };
      const usable = parent && !parent.isDestroyed() ? parent : null;
      const { response } = usable
        ? await dialog.showMessageBox(usable, options)
        : await dialog.showMessageBox(options);
      return response === 1 && !controller.signal.aborted;
    } catch (error) {
      debugLogger?.warn(
        "Conversation confirmation failed",
        { error: error?.message },
        "conversation"
      );
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  return function requestConfirmation(request) {
    const result = queue.then(
      () => show(request),
      () => show(request)
    );
    queue = result.catch(() => {});
    return result;
  };
}

module.exports = { createConfirm, DEFAULT_TIMEOUT_MS };
