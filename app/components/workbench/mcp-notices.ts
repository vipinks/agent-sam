/**
 * What an MCP surface says when a call failed.
 *
 * Two surfaces say it. The settings screen's MCP Servers section is where a server is added, started,
 * trusted, given a secret and deleted; the tools panel's MCP servers tab is where one is found and switched
 * on or off. A failure is a fact about the call rather than about the surface that made it, so the sentences
 * live here and both import them — a second wording map would be a second chance for the two to explain one
 * code differently, which is exactly what the Skills surfaces stopped doing when theirs moved out.
 *
 * Every sentence is chosen by `error.code` and never by its message text: the code is the contract, and the
 * message is written for a log rather than for a person looking at a row. Every code here is one main
 * already raises — none was added for either screen — and each map's fallback exists because a surface must
 * say something even about a failure it did not anticipate.
 *
 * The two are apart because the two kinds of call are. A read that failed leaves the lists as they were, so
 * its sentence can say the last answer is still shown; an action that failed leaves the row that started it
 * exactly as it was, and says what the code means for the thing the user just tried to do.
 */
import { ConveyorError } from 'electron-conveyor/react'

/**
 * The same judgment for a failed read: a code means something, and it is said here rather than shown.
 *
 * The last sentence is the one for anything else, including a rejection that carries no code at all, and it
 * is honest about the state of the screen rather than about the cause: the mirror keeps the previous answer,
 * so the lists below are the previous answer.
 */
export function readErrorMessage(error: unknown): string {
  if (error instanceof ConveyorError && error.code === 'MCP_CONFIG_INVALID') {
    return 'This configuration could not be read, so the server lists may be incomplete.'
  }
  return 'The server lists could not be read. The last answer is still shown.'
}

/**
 * What a failed action says, in the surface's own words.
 *
 * Branched on the code and never on main's message: the code is the contract, and a message is written for
 * a log rather than for a person looking at a row.
 */
export function actionErrorMessage(error: unknown): string {
  if (error instanceof ConveyorError) {
    switch (error.code) {
      case 'MCP_SPAWN_FAILED':
        return 'The command could not be started on this machine.'
      case 'MCP_START_TIMEOUT':
        return 'The server did not answer in time.'
      case 'MCP_TRUST_MISMATCH':
        return 'This server is not trusted as it stands, so it was not started.'
      case 'MCP_CONFIG_INVALID':
        return 'This configuration is not one this app can run.'
      case 'MCP_SERVER_NOT_FOUND':
        return 'This server is no longer in its config file.'
      case 'MCP_SERVER_NOT_RUNNING':
        return 'That server is not running.'
      case 'MCP_PROTOCOL_ERROR':
        return 'The server started, but did not speak the protocol back.'
      case 'MCP_TOOL_ERROR':
        return 'The server refused a tool call.'
      case 'MCP_SERVER_DUPLICATE':
        return 'A server with this id already exists in this scope.'
      case 'MCP_SECRET_CRYPTO_FAILED':
        return 'The secret could not be encrypted on this machine.'
      default:
        return 'The action did not complete.'
    }
  }
  return 'The action did not complete.'
}
