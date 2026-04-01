export interface PreSessionContext {
  sessionId: string;
  engine: string;
  model: string | null;
  employee: string | undefined;
  prompt: string;
  systemPrompt: string;
  source: string;
  channel: string;
  user: string;
  timestamp: string;
}

export interface PreSessionResult {
  action: "continue" | "abort";
  prompt?: string;
  systemPrompt?: string;
  reason?: string;
}

export interface PostSessionContext {
  sessionId: string;
  engine: string;
  model: string | null;
  employee: string | undefined;
  result: string;
  error: string | undefined;
  cost: number | undefined;
  durationMs: number | undefined;
  numTurns: number | undefined;
  timestamp: string;
}

export interface ToolUseContext {
  sessionId: string;
  engine: string;
  employee: string | undefined;
  toolName: string;
  toolId: string | undefined;
  timestamp: string;
}

export interface ToolResultContext {
  sessionId: string;
  engine: string;
  employee: string | undefined;
  toolName: string | undefined;
  toolId: string | undefined;
  timestamp: string;
}
