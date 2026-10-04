/**
 * Minimal, provider-agnostic chat types modelled on the OpenAI
 * Chat Completions format (the de-facto standard most providers speak).
 */

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type AssistantMessage = Extract<ChatMessage, { role: "assistant" }>;

/** JSON-schema description of a tool, as sent to the model. */
export interface ToolSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface CompletionRequest {
  messages: ChatMessage[];
  tools?: ToolSpec[];
}

export interface CompletionResult {
  message: AssistantMessage;
  usage?: { promptTokens: number; completionTokens: number };
}

/** Anything that can turn a conversation into the next assistant message. */
export interface LLMProvider {
  readonly name: string;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}
