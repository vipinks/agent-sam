import { z } from 'zod'
import { ConveyorError } from 'electron-conveyor/main'
import { defineModule, stream } from '../init'
import { readApiKey } from './settings'
import { streamChat, type ChatMessage } from './llm-engine'

/**
 * The chat engine. One stream, because a chat reply is a sequence of tokens and that is exactly
 * what `stream()` models: main holds the API key and the socket, the renderer receives text.
 */

/** A single turn. `system` is allowed so a future system prompt needs no schema change. */
const messageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string(),
})

export const llmModule = defineModule({
  /**
   * Stream a completion. The key is read here rather than passed in, so the renderer never holds
   * one; a provider without a key fails with a code the UI can turn into "add your key".
   */
  chat: stream(
    z.object({
      providerId: z.string().min(1),
      model: z.string().min(1),
      messages: z.array(messageSchema).min(1, 'A conversation needs at least one message'),
    }),
    async function* ({ input, signal }) {
      const apiKey = await readApiKey(input.providerId)
      if (!apiKey) {
        throw new ConveyorError(
          'NO_API_KEY',
          `No API key is saved for ${input.providerId}. Add one in Settings to start chatting.`
        )
      }

      // The signal is conveyor's own: aborting the call on the renderer side aborts this generator,
      // which in turn aborts the HTTP request inside `streamChat`.
      yield* streamChat({
        providerId: input.providerId,
        apiKey,
        model: input.model,
        messages: input.messages as ChatMessage[],
        signal,
      })
    }
  ),
})
