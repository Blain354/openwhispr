import type { ToolDefinition, ToolResult } from "../../services/tools/ToolRegistry";
import { toToolResult } from "./os";

export interface McpToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  access: "read" | "write";
}

/**
 * Proxies for the MCP tools the main process declared. Nothing is called from here: the name goes
 * back to the main process, which checks it against the configuration again and confirms writes.
 */
export function createMcpTools(
  definitions: McpToolDefinition[],
  isAllowed: () => boolean
): ToolDefinition[] {
  return (Array.isArray(definitions) ? definitions : [])
    .filter(
      (definition) => typeof definition?.name === "string" && definition.name.startsWith("mcp_")
    )
    .map((definition) => ({
      name: definition.name,
      description: definition.description || definition.name,
      parameters:
        definition.parameters && typeof definition.parameters === "object"
          ? definition.parameters
          : { type: "object", properties: {} },
      readOnly: definition.access === "read",
      execute: async (args): Promise<ToolResult> => {
        const api = window.conversationAPI;
        if (!api || !isAllowed()) {
          return toToolResult({
            success: false,
            displayText: "MCP tools are only available in a voice session.",
          });
        }
        try {
          const result = await api.invoke("mcp.call", { name: definition.name, arguments: args });
          return toToolResult(result as Parameters<typeof toToolResult>[0]);
        } catch (error) {
          return toToolResult({
            success: false,
            displayText: (error as Error).message || "Failed.",
          });
        }
      },
    }));
}
