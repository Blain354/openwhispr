import i18n from "../../i18n";
import en from "../locales/en.json";
import fr from "../locales/fr.json";

let registered = false;

/**
 * Adds the "conversation" namespace to this window's i18next instance. Keys are always written
 * with the namespace prefix, e.g. t("conversation:session.title"). Call before the first render.
 */
export function ensureConversationBundles(): void {
  if (registered) return;
  i18n.addResourceBundle("en", "conversation", en, true, true);
  i18n.addResourceBundle("fr", "conversation", fr, true, true);
  registered = true;
}
