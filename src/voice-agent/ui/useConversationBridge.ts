import { useEffect, useState } from "react";

export interface ConversationResult<T = unknown> {
  success?: boolean;
  data?: T;
  displayText?: string;
  errors?: string[];
  warnings?: string[];
}

export async function invokeConversation<T = unknown>(
  op: string,
  payload?: Record<string, unknown>
): Promise<ConversationResult<T>> {
  const api = window.conversationAPI;
  if (!api) return { success: false, displayText: "Conversation bridge unavailable." };
  return (await api.invoke(op, payload)) as ConversationResult<T>;
}

/** Current session state as broadcast by the main process. */
export function useConversationState(): string {
  const [state, setState] = useState("idle");

  useEffect(() => {
    const api = window.conversationAPI;
    if (!api) return;
    let cancelled = false;
    invokeConversation<{ state: string }>("session.getState").then((result) => {
      if (!cancelled && result?.success && result.data?.state) setState(result.data.state);
    });
    const off = api.on("state", (message) => {
      if (typeof message.state === "string") setState(message.state);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  return state;
}
