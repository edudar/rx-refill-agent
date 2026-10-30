import { z } from "zod";

export const reasoningEffortSchema = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;

export const modelConfigSchema = z.object({
  apiKey: z.string().min(1),
  model: z.string().min(1),
  reasoning: z.object({ effort: reasoningEffortSchema }).optional(),
});
export const ehrConfigSchema = z.object({
  baseUrl: z
    .url()
    .refine((url) => ["http:", "https:"].includes(new URL(url).protocol), {
      message: "EHR_BASE_URL must be an HTTP(S) URL",
    }),
  apiKey: z.string(),
});
export const agentConfigSchema = z.object({
  openai: modelConfigSchema,
  ehr: ehrConfigSchema,
  port: z.number().int().min(1).max(65_535),
  conversationLogging: z.boolean(),
});

export type ModelConfig = z.infer<typeof modelConfigSchema>;
export type EhrConfig = z.infer<typeof ehrConfigSchema>;
export type AgentConfig = z.infer<typeof agentConfigSchema>;

// Importing configuration does not read the environment or validate credentials.
export function loadConfig(
  env: Record<string, string | undefined>,
): AgentConfig {
  const effort = reasoningEffortSchema
    .optional()
    .parse(env.OPENAI_REASONING_EFFORT);
  if (!env.OPENAI_API_KEY || !env.OPENAI_MODEL) {
    throw new Error(
      "Set OPENAI_API_KEY and OPENAI_MODEL before starting the agent",
    );
  }
  const port = Number(env.AGENT_PORT ?? 5050);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("AGENT_PORT must be an integer between 1 and 65535");
  }
  return agentConfigSchema.parse({
    conversationLogging: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true")
      .parse(env.CONVERSATION_LOGGING),
    openai: {
      apiKey: env.OPENAI_API_KEY,
      model: env.OPENAI_MODEL,
      reasoning: effort ? { effort } : undefined,
    },
    ehr: {
      baseUrl: env.EHR_BASE_URL ?? "http://localhost:4010",
      apiKey: env.EHR_API_KEY ?? "dev-ehr-key",
    },
    port,
  });
}
