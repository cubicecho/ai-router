import { z } from 'zod';

/**
 * What the layers above an agent may change, as the `override_policies` table keeps it. Phase 6's
 * run applies it; anything it does not allow refuses the request, and nothing is quietly trimmed.
 * The model and the endpoint are never in it: no request changes them.
 */
export const overridePolicyRulesSchema = z.object({
  /** The app's leading system or developer messages become the agent's `host` prompt part. */
  hostPrompt: z.boolean(),
  /** `ai_router.task` becomes the agent's `task` prompt part. */
  taskPrompt: z.boolean(),
  /** A request may narrow the agent's servers. It never widens them, whatever this says. */
  narrowServers: z.boolean(),
  /** The OpenAI request fields an app may set, by their wire names. */
  sampling: z.array(z.string()),
  /** A request may send `response_format`. */
  responseFormat: z.boolean(),
});
export type OverridePolicyRules = z.infer<typeof overridePolicyRulesSchema>;

/** The seeded policy's rules: add instructions, narrow servers, set sampling; never change the model. */
export const DEFAULT_POLICY_RULES: OverridePolicyRules = Object.freeze({
  hostPrompt: true,
  taskPrompt: true,
  narrowServers: true,
  sampling: [
    'temperature',
    'max_tokens',
    'max_completion_tokens',
    'top_p',
    'top_k',
    'min_p',
    'presence_penalty',
    'frequency_penalty',
    'repetition_penalty',
    'seed',
    'stop',
  ],
  responseFormat: true,
});
