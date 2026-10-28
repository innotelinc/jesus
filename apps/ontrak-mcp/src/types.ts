/**
 * The two shapes this package needs from a host agent.
 *
 * A host console has its own tool registry; these are the parts of it the bridge
 * touches, written here so the package depends on nothing but Node. A host with a
 * richer definition (approval previews, diffs, telemetry) can widen these types
 * structurally — TypeScript only requires the fields it reads.
 */

/** What a tool returns: whether it worked, and the text the model sees. */
export interface ToolOutcome {
  ok: boolean;
  content: string;
}

/** What a tool *would* do, computed without doing it, for an approval prompt. */
export interface ToolPreview {
  summary: string;
}

/** A tool as the host console sees it. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  /**
   * The approval hook. A tool with no `inspect` runs without asking, which is
   * why the bridge only omits it for tools the server declared read-only.
   */
  inspect?: (args: Record<string, unknown>) => Promise<ToolPreview | null>;
  run: (args: Record<string, unknown>) => Promise<ToolOutcome>;
}
