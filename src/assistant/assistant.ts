import type { ChatMessage, LLMProvider, ToolCall } from "../llm/types.js";
import { toSpec, validateArgs, type Tool, type ToolContext } from "../tools/types.js";
import { SessionStore } from "./sessions.js";

export interface ToolTrace {
  name: string;
  args: unknown;
  result: unknown;
  ok: boolean;
}

export interface AssistantReply {
  reply: string;
  toolCalls: ToolTrace[];
}

export interface AssistantOptions {
  llm: LLMProvider;
  tools: Tool<any>[];
  systemPrompt: () => string;
  sessions?: SessionStore;
  /** Safety cap on LLM <-> tool round-trips per user message. */
  maxToolRounds?: number;
  logger?: Pick<Console, "info" | "warn" | "error">;
}

const FALLBACK = "Sorry, I'm having trouble right now. Please try again in a moment.";

/**
 * The agent loop:
 *   user msg -> LLM -> (tool calls -> execute -> results back to LLM)* -> final text
 */
export class Assistant {
  readonly sessions: SessionStore;
  private readonly toolMap: Map<string, Tool<any>>;

  constructor(private readonly opts: AssistantOptions) {
    this.sessions = opts.sessions ?? new SessionStore();
    this.toolMap = new Map(opts.tools.map((t) => [t.name, t]));
  }

  async handleMessage(text: string, ctx: ToolContext): Promise<AssistantReply> {
    const log = this.opts.logger;
    const history = this.sessions.get(ctx.customerId);
    const turn: ChatMessage[] = [{ role: "user", content: text }];
    const traces: ToolTrace[] = [];
    const specs = this.opts.tools.map(toSpec);
    const maxRounds = this.opts.maxToolRounds ?? 5;

    try {
      for (let round = 0; round <= maxRounds; round++) {
        const messages: ChatMessage[] = [{ role: "system", content: this.opts.systemPrompt() }, ...history, ...turn];
        // On the last allowed round, withhold tools to force a text answer.
        const { message } = await this.opts.llm.complete({ messages, tools: round < maxRounds ? specs : undefined });
        turn.push(message);

        if (!message.tool_calls || message.tool_calls.length === 0) {
          const reply = message.content?.trim() || FALLBACK;
          this.sessions.save(ctx.customerId, [...history, ...turn]);
          return { reply, toolCalls: traces };
        }

        for (const call of message.tool_calls) {
          const trace = await this.runTool(call, ctx);
          traces.push(trace);
          log?.info(`[tool] ${trace.name}(${JSON.stringify(trace.args)}) -> ${trace.ok ? "ok" : "error"}`);
          turn.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(trace.result) });
        }
      }
      throw new Error("tool round limit exceeded");
    } catch (err) {
      log?.error(`[assistant] ${err instanceof Error ? err.message : String(err)}`);
      // Don't persist a half-finished turn; keep the conversation consistent.
      return { reply: FALLBACK, toolCalls: traces };
    }
  }

  private async runTool(call: ToolCall, ctx: ToolContext): Promise<ToolTrace> {
    const name = call.function.name;
    const tool = this.toolMap.get(name);
    let args: unknown;
    try {
      args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
    } catch {
      return { name, args: call.function.arguments, ok: false, result: { error: "arguments were not valid JSON" } };
    }
    if (!tool) return { name, args, ok: false, result: { error: `unknown tool "${name}"` } };

    const errors = validateArgs(tool, args);
    if (errors.length > 0) return { name, args, ok: false, result: { error: errors.join("; ") } };

    try {
      const result = await tool.handler(args, ctx);
      return { name, args, ok: true, result };
    } catch (err) {
      // Errors are returned to the model so it can recover (e.g. pick another slot).
      return { name, args, ok: false, result: { error: err instanceof Error ? err.message : String(err) } };
    }
  }
}
