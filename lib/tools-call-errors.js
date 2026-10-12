import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { redactSensitiveText } from "./redaction.js";
import { truncateText } from "./result-text.js";

// SDK input validation runs before bridge handlers, so annotate that refusal at the
// protocol boundary without changing tool registration or argument schemas.
export function installToolInputRefusals(server) {
  const protocol = server.server;
  const original = protocol._requestHandlers.get("tools/call");
  if (typeof original !== "function") throw new Error("MCP tools/call handler unavailable.");
  protocol.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const result = await original(request, extra);
    if (!result?.isError || !result.content?.some(item => item.type === "text" && /^MCP error -32602: Input validation error:/.test(item.text))) return result;
    return { ...result, content: [{ type: "text", text: [
      "Tool arguments rejected.", "errorType: invalid_tool_arguments",
      `reason: ${truncateText(redactSensitiveText(result.content.filter(item => item.type === "text").map(item => item.text).join("\n")), 2000)}`,
      `suggestedFix: Check tools/list for ${request.params.name}'s schema, correct the arguments, and retry.`,
    ].join("\n") }] };
  });
}
