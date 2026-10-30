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

// Default model and reasoning effort; both are overridable from the environment.
export const DEFAULT_OPENAI_MODEL = "gpt-6-luna";
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "none";

export const modelConfigSchema = z.object({
  apiKey: z.string().min(1),
  model: z.string().min(1),
  reasoning: z.object({ effort: reasoningEffortSchema }),
});
const serviceConfigSchema = z.object({
  baseUrl: z
    .url()
    .refine((url) => ["http:", "https:"].includes(new URL(url).protocol), {
      message: "Service base URLs must be HTTP(S)",
    }),
  apiKey: z.string(),
});
export const ehrConfigSchema = serviceConfigSchema;
export const pharmacyConfigSchema = serviceConfigSchema;
export const agentConfigSchema = z.object({
  openai: modelConfigSchema,
  ehr: ehrConfigSchema,
  pharmacy: pharmacyConfigSchema,
  port: z.number().int().min(1).max(65_535),
  conversationLogging: z.boolean(),
});

export type ModelConfig = z.infer<typeof modelConfigSchema>;
export type EhrConfig = z.infer<typeof ehrConfigSchema>;
export type PharmacyConfig = z.infer<typeof pharmacyConfigSchema>;
export type AgentConfig = z.infer<typeof agentConfigSchema>;

// Importing configuration does not read the environment or validate credentials.
export function loadConfig(
  env: Record<string, string | undefined>,
): AgentConfig {
  const effort = reasoningEffortSchema
    .default(DEFAULT_REASONING_EFFORT)
    .parse(env.OPENAI_REASONING_EFFORT || undefined);
  if (!env.OPENAI_API_KEY) {
    throw new Error("Set OPENAI_API_KEY before starting the agent");
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
      model: env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL,
      reasoning: { effort },
    },
    ehr: {
      baseUrl: env.EHR_BASE_URL ?? "http://localhost:4010",
      apiKey: env.EHR_API_KEY ?? "dev-ehr-key",
    },
    pharmacy: {
      baseUrl: env.PHARMACY_BASE_URL ?? "http://localhost:4010",
      apiKey: env.PHARMACY_API_KEY ?? "dev-pharmacy-key",
    },
    port,
  });
}
