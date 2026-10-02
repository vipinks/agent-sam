/**
 * A Word document, as HTML.
 *
 * The conversion itself is mammoth's — a `.docx` is a zip of xml parts, and reading it is a job for a
 * library that knows WordprocessingML. What this file owns is the two things around it: the moment the
 * library is loaded, and the answer when the bytes are not a document at all.
 *
 * Loaded on the first document rather than at import: mammoth is a parser plus a zip reader and an xml
 * implementation behind it, and none of that is worth paying for in a window that may never open a Word
 * file. The dynamic import is the whole of the deferral — the module is reached the first time a
 * document viewer asks it for html, and the bundler is free to put it in a chunk of its own.
 *
 * The refusals are this app's wording rather than mammoth's. That is deliberate and it is the reason
 * the zip signature is checked here: mammoth reports a buffer that is not a container by describing its
 * own failure to read a central directory, and a viewer that showed that sentence would be telling its
 * reader about a zip library. Branching on a message string to reword it is not possible either, so the
 * check happens before the parser is handed anything. A container that *is* a zip and still will not
 * read is the one case where only mammoth knows, and its rejection is turned into a sentence here.
 */

import { looksLikeZip } from '@/conveyor/protocol/preview-kind'

/** What a conversion answers: html, or a sentence saying why there is none. */
export type DocxConversion = { ok: true; html: string } | { ok: false; message: string }

/**
 * The part of mammoth this app uses, named rather than imported as a type.
 *
 * Written structurally because the library ships its own types for a *node* caller: its input union is
 * `{ path } | { buffer } | { arrayBuffer }`, and the shape below is the one this app actually calls —
 * with both byte keys on it, for the reason stated there.
 */
interface MammothModule {
  convertToHtml: (input: { arrayBuffer: ArrayBuffer; buffer: ArrayBuffer }) => Promise<{ value: string }>
}

/** Bytes that are not a container: the file's name promised a Word document and its bytes disagree. */
const NOT_A_CONTAINER =
  'This file is not a Word document. A .docx is a zip container, and this file does not begin like one.'

/** Bytes that are a container and still do not read — the one refusal only the parser can report. */
const UNREADABLE =
  'This Word document could not be read. It may be damaged, or contain a part this viewer cannot convert.'

/** The conversion could not be loaded at all, which is a fact about this installation rather than the file. */
const CONVERTER_UNAVAILABLE = 'The Word converter could not be loaded, so this document cannot be shown.'

/**
 * Convert a Word container to HTML.
 *
 * Takes bytes rather than the bridge's base64: decoding is `base64.ts`'s job and the viewer does it
 * once, so what arrives here is exactly what a parser wants. The result is a union rather than a throw
 * — there is no error *class* in the renderer to carry a code, and a caller that must render a sentence
 * either way is better served by an answer than by a `catch` around a call.
 */
export async function docxToHtml(bytes: Uint8Array): Promise<DocxConversion> {
  if (!looksLikeZip(bytes)) return { ok: false, message: NOT_A_CONTAINER }

  let loaded: MammothModule & { default?: MammothModule }
  try {
    loaded = (await import('mammoth')) as unknown as MammothModule & { default?: MammothModule }
  } catch {
    return { ok: false, message: CONVERTER_UNAVAILABLE }
  }

  // mammoth is CommonJS, so a bundler hands it back either as the module itself or under `default`
  // depending on the interop shim in front of it. Reading both costs one line and removes the need to
  // know which build this is running under.
  const mammoth = loaded.default ?? loaded

  // `buffer` short of its byte offset, and a copy rather than a view: the caller's typed array may be a
  // window onto a larger buffer, and both parsers take the whole thing.
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer

  try {
    /*
      The same bytes under both of mammoth's input keys.

      Its two builds read the container from different names: the browser build, which the renderer
      bundles, takes `arrayBuffer`, and the node build, which the suites load, takes `buffer`. Offering
      both is what lets one call site serve both without testing which build is in front of it — and
      each build stops at the key it knows, so neither reads the bytes twice.
    */
    const result = await mammoth.convertToHtml({ arrayBuffer, buffer: arrayBuffer })

    return { ok: true, html: result.value }
  } catch {
    return { ok: false, message: UNREADABLE }
  }
}
