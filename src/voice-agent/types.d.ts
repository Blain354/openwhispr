export {};

declare global {
  interface ConversationBootstrap {
    windowKind: "main" | "control-panel" | "session" | "companion";
    enabled: boolean;
    toolsInChat: boolean;
  }

  interface ConversationBridgeMessage {
    type: string;
    [key: string]: unknown;
  }

  interface Window {
    conversationAPI?: {
      bootstrap: Readonly<ConversationBootstrap>;
      invoke: (op: string, payload?: Record<string, unknown>) => Promise<unknown>;
      on: (type: string, callback: (message: ConversationBridgeMessage) => void) => () => void;
    };
  }
}
