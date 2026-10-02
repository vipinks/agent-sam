/**
 * The bridge's base64, undone.
 *
 * A document read crosses IPC as a string — base64 is the one encoding that does — and both document
 * viewers then want the bytes back: pdf.js loads an ArrayBuffer and mammoth reads a container. Kept out
 * of both components for the reason `preview.ts` and `image.ts` are kept out of theirs: it is a
 * conversion a test should be able to make by calling a function rather than by opening a file.
 *
 * `atob` rather than a decode written here. It is the platform's own decoder, it is present in the
 * renderer, in jsdom and in node, and a hand-rolled base64 loop is a place for an off-by-one that would
 * corrupt a document in a way only its reader would notice.
 *
 * The result is a `Uint8Array` over exactly the decoded bytes: pdf.js accepts one directly, and mammoth
 * reads the container through jszip, which takes a typed array as readily as a Buffer.
 */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }

  return bytes
}
