// The Conversation mode global hotkey, registered as its own upstream hotkey slot.
//
// Registering through hotkeyManager.registerSlot (never a raw globalShortcut) lets upstream restore
// the slot after a hotkey capture in Settings. The anti-repeat gate lives in the callback so the
// restored registration keeps it.
const { createHotkeyRepeatGate } = require("../../helpers/hotkeyRepeatGate");

const SLOT = "conversation";
const OTHER_SLOTS = ["dictation", "voiceAgent", "translation", "meeting"];

function createConversationHotkey({ windowManager, onToggle, debugLogger }) {
  const isPress = createHotkeyRepeatGate();
  let validatorPromise = null;

  const loadValidator = () => {
    validatorPromise ||= import("../shared/hotkeyOverlap.mjs").then(
      (m) => m.validateConversationHotkey
    );
    return validatorPromise;
  };

  const hotkeyManager = () => windowManager?.hotkeyManager || null;

  function otherSlotHotkeys() {
    const manager = hotkeyManager();
    const slots = {};
    for (const slot of OTHER_SLOTS) {
      try {
        slots[slot] = manager?.getSlotHotkeys?.(slot) || [];
      } catch {
        slots[slot] = [];
      }
    }
    return slots;
  }

  const callback = () => {
    const manager = hotkeyManager();
    if (manager?.isInListeningMode?.()) return;
    // Same fail-closed gate upstream's meeting hotkey uses: nothing fires during onboarding.
    if (
      typeof windowManager?.isMeetingInputAllowed === "function" &&
      !windowManager.isMeetingInputAllowed()
    ) {
      return;
    }
    if (!isPress()) return;
    Promise.resolve(onToggle()).catch((error) => {
      debugLogger?.error("Conversation toggle failed", { error: error?.message }, "conversation");
    });
  };

  async function validate(hotkey) {
    const validateFn = await loadValidator();
    return validateFn(hotkey, otherSlotHotkeys());
  }

  async function register(hotkey) {
    const manager = hotkeyManager();
    if (!manager?.registerSlot) {
      return { success: false, errors: ["hotkey-manager-unavailable"], warnings: [] };
    }
    const verdict = await validate(hotkey);
    if (!verdict.ok) {
      debugLogger?.warn("Conversation hotkey rejected", { hotkey, ...verdict }, "conversation");
      return { success: false, errors: verdict.errors, warnings: verdict.warnings };
    }
    const result = await manager.registerSlot(SLOT, hotkey, callback);
    if (!result?.success) {
      debugLogger?.warn(
        "Conversation hotkey registration failed",
        { hotkey, error: result?.error },
        "conversation"
      );
      return {
        success: false,
        errors: ["registration-failed"],
        warnings: verdict.warnings,
        detail: result?.error,
      };
    }
    debugLogger?.info(
      "Conversation hotkey registered",
      { hotkey, warnings: verdict.warnings },
      "conversation"
    );
    return { success: true, errors: [], warnings: verdict.warnings };
  }

  function unregister() {
    try {
      hotkeyManager()?.unregisterSlot?.(SLOT);
    } catch {}
  }

  return { register, unregister, validate, SLOT };
}

module.exports = { createConversationHotkey, SLOT };
