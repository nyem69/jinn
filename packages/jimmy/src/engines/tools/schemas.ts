/**
 * JSON-schema tool definitions presented to the model via the
 * provider tools[] array. Kept in OpenAI function-calling format
 * (which Ollama also accepts).
 *
 * Keep descriptions terse — every token here is in every prompt.
 */

import type { ProviderToolDef } from "../providers/types.js";

export const READ_TOOL_SCHEMA: ProviderToolDef = {
  name: "read",
  description:
    "Read a text file under the working directory. Returns the file contents as a string. " +
    "Use offset/limit for large files. Path may be relative or absolute; must resolve under the working directory.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path." },
      offset: { type: "integer", minimum: 1, description: "1-indexed line number to start at." },
      limit: { type: "integer", minimum: 1, description: "Max lines to return (default 2000)." },
    },
    required: ["path"],
  },
};

export const WRITE_TOOL_SCHEMA: ProviderToolDef = {
  name: "write",
  description:
    "Write text content to a file under the working directory. Overwrites existing files. " +
    "Creates parent directories as needed. Refuses symbolic links and paths outside the working directory.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path." },
      content: { type: "string", description: "File contents (UTF-8)." },
    },
    required: ["path", "content"],
  },
};

export const EDIT_TOOL_SCHEMA: ProviderToolDef = {
  name: "edit",
  description:
    "Replace an exact substring in a file with another string. " +
    "Fails if old_string is not found, or matches multiple times unless replace_all is true. " +
    "Refuses symbolic links and paths outside the working directory.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path." },
      old_string: { type: "string", description: "Exact substring to find. Must be non-empty." },
      new_string: { type: "string", description: "Replacement text. Pass empty string to delete." },
      replace_all: {
        type: "boolean",
        description: "Replace every occurrence. Default false (requires unique match).",
      },
    },
    required: ["path", "old_string", "new_string"],
  },
};

export const BASH_TOOL_SCHEMA: ProviderToolDef = {
  name: "bash",
  description:
    "Execute a command in argv form (no shell). " +
    "Shell metacharacters in arguments are rejected. " +
    "Available executables are limited to a per-engine allowlist; shell binaries (sh, bash, etc.) are never permitted. " +
    "python3 must be invoked with a script path argument (no -c, -m, or stdin).",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Executable basename or path." },
      args: {
        type: "array",
        items: { type: "string" },
        description: "Argument vector; each element passed as a separate argv slot.",
      },
    },
    required: ["command"],
  },
};

export const WEBFETCH_TOOL_SCHEMA: ProviderToolDef = {
  name: "webfetch",
  description:
    "GET an http or https URL. Returns the response body decoded as text. " +
    "Private-network targets, redirects to other schemes, and non-text content types are refused. " +
    "Follows up to 5 same-scheme redirects.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "Absolute http:// or https:// URL." },
    },
    required: ["url"],
  },
};

export const ALL_SCHEMAS = {
  read: READ_TOOL_SCHEMA,
  write: WRITE_TOOL_SCHEMA,
  edit: EDIT_TOOL_SCHEMA,
  bash: BASH_TOOL_SCHEMA,
  webfetch: WEBFETCH_TOOL_SCHEMA,
} as const;
