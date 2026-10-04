import type { ToolSpec } from "../llm/types.js";

export interface ToolContext {
  /** Stable id of the customer (WhatsApp number, web session id, ...). */
  customerId: string;
  channel: "whatsapp" | "web" | "cli";
}

type JsonType = "string" | "number" | "integer" | "boolean";

export interface ParamSchema {
  type: JsonType;
  description: string;
  enum?: string[];
}

export interface Tool<A = Record<string, unknown>> {
  name: string;
  description: string;
  parameters: Record<string, ParamSchema>;
  required?: string[];
  handler: (args: A, ctx: ToolContext) => unknown | Promise<unknown>;
}

export function toSpec(tool: Tool<any>): ToolSpec {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: "object",
        properties: tool.parameters,
        required: tool.required ?? [],
        additionalProperties: false,
      },
    },
  };
}

/** Lightweight runtime validation of model-produced arguments (models do make mistakes). */
export function validateArgs(tool: Tool<any>, args: unknown): string[] {
  const errors: string[] = [];
  if (typeof args !== "object" || args === null || Array.isArray(args)) return ["arguments must be a JSON object"];
  const obj = args as Record<string, unknown>;
  for (const key of tool.required ?? []) {
    if (obj[key] === undefined || obj[key] === null || obj[key] === "") errors.push(`missing required argument "${key}"`);
  }
  for (const [key, value] of Object.entries(obj)) {
    const schema = tool.parameters[key];
    if (!schema) {
      errors.push(`unknown argument "${key}"`);
      continue;
    }
    if (value === undefined || value === null) continue;
    const ok =
      schema.type === "integer" ? Number.isInteger(value) : schema.type === "number" ? typeof value === "number" && Number.isFinite(value) : typeof value === schema.type;
    if (!ok) errors.push(`argument "${key}" must be of type ${schema.type}`);
    else if (schema.enum && !schema.enum.includes(value as string)) errors.push(`argument "${key}" must be one of: ${schema.enum.join(", ")}`);
  }
  return errors;
}
