import type { ExportFormat } from '@/conveyor/protocol/export'

/**
 * The request shape one export sends across the bridge.
 *
 * Pure and separate from the component because the interesting part is a rule, not a call: the stored
 * title is *omitted* when there is none, rather than sent as an empty or undefined field. Main's
 * schema declares `title` as an optional string, so `title: ''` would be accepted as a present-but-
 * empty title and win over the first-message fallback — which would name an export of an unnamed
 * session after nothing at all. Absent is what makes main derive a name.
 *
 * The title is the one the row is showing, which is the only place a renamed session's name exists:
 * a transcript records what was said, not what the conversation is called.
 */
export interface ExportRequest {
  id: string
  format: ExportFormat
  title?: string
}

export function exportRequest(id: string, format: ExportFormat, title: string): ExportRequest {
  const trimmed = title.trim()
  return trimmed ? { id, format, title } : { id, format }
}
