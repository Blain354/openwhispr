// Validation of the Conversation mode hotkey against Windows reserved shortcuts and the other
// OpenWhispr slots. Pure logic, shared by the main process and the session settings panel.
//
// Upstream only rejects exact duplicates. That misses the case that bit this feature: with
// dictation on the modifier-only chord Control+Super, any Control+Super+X press also starts a
// dictation, because the low-level hook fires as soon as both modifiers are down.

const MODIFIER_ALIASES = Object.freeze({
  control: "control",
  ctrl: "control",
  commandorcontrol: "control",
  cmdorctrl: "control",
  alt: "alt",
  option: "alt",
  altgr: "alt",
  shift: "shift",
  super: "super",
  meta: "super",
  win: "super",
  windows: "super",
  command: "super",
  cmd: "super",
});

const RIGHT_SIDE = /^right(control|ctrl|alt|option|shift|command|cmd|super|meta|win)$/;
const FUNCTION_KEY = /^f([1-9]|1[0-9]|2[0-4])$/;

// Windows 11 shortcuts that switch input methods or belong to the shell.
const WINDOWS_RESERVED = [
  { modifiers: ["super"], key: "space" },
  { modifiers: ["control", "super"], key: "space" },
  { modifiers: ["shift", "super"], key: "space" },
  { modifiers: ["super"], key: "l" },
  { modifiers: ["super"], key: "d" },
  { modifiers: ["super"], key: "e" },
  { modifiers: ["super"], key: "r" },
  { modifiers: ["super"], key: "tab" },
];

// Common third-party bindings: allowed, but worth a warning.
const KNOWN_CONFLICTS = [
  { modifiers: ["alt"], key: "space", warning: "powertoys-run" },
  { modifiers: ["alt", "super"], key: "space", warning: "command-palette" },
];

export function parseHotkey(hotkey) {
  const raw = String(hotkey ?? "");
  const modifiers = new Set();
  const keys = [];
  let rightSide = false;
  for (const part of raw.split("+")) {
    const lower = part.trim().toLowerCase();
    if (!lower) continue;
    const right = lower.match(RIGHT_SIDE);
    if (right) {
      rightSide = true;
      modifiers.add(MODIFIER_ALIASES[right[1]]);
      continue;
    }
    if (MODIFIER_ALIASES[lower]) {
      modifiers.add(MODIFIER_ALIASES[lower]);
      continue;
    }
    keys.push(lower === "spacebar" ? "space" : lower);
  }
  return { raw, modifiers, keys, rightSide };
}

function signature(parsed) {
  return `${[...parsed.modifiers].sort().join("+")}|${[...parsed.keys].sort().join("+")}`;
}

function matchesShortcut(parsed, shortcut) {
  return (
    parsed.keys.length === 1 &&
    parsed.keys[0] === shortcut.key &&
    parsed.modifiers.size === shortcut.modifiers.length &&
    shortcut.modifiers.every((m) => parsed.modifiers.has(m))
  );
}

/**
 * @param {string} hotkey
 * @param {Record<string, string | string[] | undefined>} otherSlots hotkeys of the other slots
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 *   errors: "empty" | "modifier-only" | "right-side-modifier" | "multiple-keys" |
 *           "needs-modifier" | "windows-reserved" | "duplicate:<slot>" | "starts-with:<slot>"
 */
export function validateConversationHotkey(hotkey, otherSlots = {}) {
  const parsed = parseHotkey(hotkey);
  const errors = [];
  const warnings = [];

  if (!parsed.raw.trim()) return { ok: false, errors: ["empty"], warnings };
  if (parsed.keys.length === 0) errors.push("modifier-only");
  if (parsed.rightSide) errors.push("right-side-modifier");
  if (parsed.keys.length > 1) errors.push("multiple-keys");
  if (
    parsed.keys.length === 1 &&
    parsed.modifiers.size === 0 &&
    !FUNCTION_KEY.test(parsed.keys[0])
  ) {
    errors.push("needs-modifier");
  }
  if (WINDOWS_RESERVED.some((shortcut) => matchesShortcut(parsed, shortcut))) {
    errors.push("windows-reserved");
  }

  const ownSignature = signature(parsed);
  for (const [slot, value] of Object.entries(otherSlots || {})) {
    for (const other of [].concat(value || [])) {
      const otherParsed = parseHotkey(other);
      if (!otherParsed.raw.trim()) continue;
      if (signature(otherParsed) === ownSignature) {
        errors.push(`duplicate:${slot}`);
      } else if (
        otherParsed.keys.length === 0 &&
        otherParsed.modifiers.size > 0 &&
        [...otherParsed.modifiers].every((m) => parsed.modifiers.has(m))
      ) {
        errors.push(`starts-with:${slot}`);
      }
    }
  }

  for (const conflict of KNOWN_CONFLICTS) {
    if (matchesShortcut(parsed, conflict)) warnings.push(conflict.warning);
  }

  return { ok: errors.length === 0, errors: [...new Set(errors)], warnings };
}
