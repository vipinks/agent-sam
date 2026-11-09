/**
 * The providers this build ships, and the model each one preselects.
 *
 * Plain data, on the protocol side of the module boundary, because two processes need the same list for
 * different reasons: main answers Settings with it and derives the seeded catalogues from it, and
 * `newProviderId` avoids every id in it — a rule the renderer runs too, when the add form computes the
 * id it is about to create. It cannot live in `conveyor/modules/settings.ts`, which is where it used to
 * be: that module imports electron, `fs` and `path`, and the renderer imports the protocol's rules.
 *
 * `defaultModel` is a starting point, not a constraint: `fetchModels` replaces it with the provider's
 * real catalogue, and the chat dropdown only ever shows models the user has switched on.
 */
export const PROVIDERS = [
  { id: 'deepseek', name: 'DeepSeek', defaultModel: 'deepseek-chat' },
  { id: 'openrouter', name: 'OpenRouter', defaultModel: 'openai/gpt-4o-mini' },
  { id: 'opencode', name: 'OpenCode', defaultModel: 'opencode-model' },
  { id: 'openai', name: 'OpenAI', defaultModel: 'gpt-4o-mini' },
  { id: 'anthropic', name: 'Anthropic', defaultModel: 'claude-3-5-sonnet-latest' },
] as const
