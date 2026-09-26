import { z } from 'zod'

/**
 * Composer image attachments: what may be attached, how large, how many, and how the model is told.
 *
 * Pure and shared rather than main-only, for the same reason `image.ts` and `mentions.ts` are: main
 * does the byte write and the byte read, but the *rules* — four media types, one size cap, one count
 * cap, and the wire content a message goes out with — are decisions a test should be able to make
 * without a filesystem. Nothing here touches the disk, and nothing here is main-only: the renderer
 * reads these constants to word its own refusals, exactly as it reads `MAX_MENTION_PATHS`.
 *
 * Why these four types and not the viewer's eight. The viewer renders a file that is already in the
 * workspace, so its list includes `svg`, `bmp`, and `ico` — those are things a repository holds. An
 * attachment is a thing the *provider* has to accept, and the OpenAI dialect's image part takes png,
 * jpeg, webp, and gif. A type that cannot be sent is therefore refused at the composer rather than
 * accepted and then dropped while a request is being built, which is the failure that would leave a
 * user believing an image had been sent.
 */

/**
 * The code an attachment is refused under: a media type nothing may send, an image over the cap, one
 * image too many, or a name that could not be a path segment.
 *
 * One code for all four, exported and named rather than written out at each throw site, because the
 * renderer branches on it while the sentence is the only thing that differs between them: what the
 * user does next — attach something else — is the same in every case.
 */
export const IMAGE_ATTACH_REFUSED = 'IMAGE_ATTACH_REFUSED'

/**
 * The code a read or a delete of an attachment that is not there is reported under.
 *
 * Its own code rather than the refusal above, because the two are different facts about different
 * things: a refusal means the user chose something this app will not store, while this means something
 * the app stored is gone — a transcript naming an image whose folder was swept, or a delete of a
 * conversation whose attachments were never written. The renderer words them differently, and only one
 * of them is worth showing at all.
 */
export const IMAGE_ATTACH_NOT_FOUND = 'IMAGE_ATTACH_NOT_FOUND'

/** The media types the OpenAI dialect's image part accepts. */
export const IMAGE_ATTACHMENT_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const

export type ImageAttachmentMime = (typeof IMAGE_ATTACHMENT_MIME_TYPES)[number]

/**
 * How large one image may be, in bytes.
 *
 * Eight times the viewer's 2 MB, and the number is not arbitrary: the viewer's cap bounds what is worth
 * shipping over IPC to *draw*, while this one bounds what is worth sending to a provider, where the
 * bytes are billed as tokens and a screenshot from a 4K display lands around 3 MB. Base64 adds a third
 * again to what goes on the wire, so 8 MB of file is about 10.7 MB of request body per image — which is
 * why four of them per message is the other half of this rule.
 */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024

/**
 * How many images one message may carry.
 *
 * Kept whole and small rather than derived from the byte cap, because the two limits fail differently:
 * over the count is a message nobody can read, while over the size is one request nobody can send. Four
 * is what a person attaches when they are pointing at something — the bug, the design, the diff, the
 * error — and past that the useful move is a second message whose text says what links them.
 */
export const MAX_ATTACHMENTS_PER_MESSAGE = 4

/**
 * The extension a stored attachment carries.
 *
 * Derived from the media type and never from the name the file arrived under: the name is the user's,
 * and a `.png` that is really a JPEG would be stored under an extension the reader would then trust.
 * `jpeg` stores as `jpg` because that is the extension a browser and a provider both recognise.
 */
const EXTENSION_BY_MIME: Record<ImageAttachmentMime, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

/**
 * The canonical media type for an incoming one, or `null` when this app will not attach it.
 *
 * Case-folded before the lookup, and that is the one piece of slack here: a clipboard or a camera may
 * hand over `image/JPEG`, media types are case-insensitive by definition, and a case-sensitive table
 * would refuse a JPEG on the strength of its spelling. What comes back is the canonical lower-case
 * form, so a stored reference never carries two spellings of one type.
 */
export function acceptedAttachmentMime(mimeType: string): ImageAttachmentMime | null {
  const canonical = mimeType.trim().toLowerCase()
  return (IMAGE_ATTACHMENT_MIME_TYPES as readonly string[]).includes(canonical)
    ? (canonical as ImageAttachmentMime)
    : null
}

/**
 * The extension an accepted media type is stored under.
 *
 * Takes the narrowed type rather than a string, so the caller has already answered the whitelist and
 * this cannot be reached with a type that has no extension.
 */
export function attachmentExtensionFor(mimeType: ImageAttachmentMime): string {
  return EXTENSION_BY_MIME[mimeType]
}

/** A refusal, as the module that throws it needs it: the code to branch on, and the sentence to show. */
export interface AttachmentRefusal {
  code: typeof IMAGE_ATTACH_REFUSED
  message: string
}

/**
 * Whether one image may be stored, and what to say when it may not. `null` means it may.
 *
 * One decision covering both the media type and the size, because a caller that checked one and forgot
 * the other would store something it could never send — and the two checks have no callers apart from
 * each other. `null` means yes, the shape `mcpTrustRefusal` uses, so a caller reads as a guard clause
 * rather than as a boolean it has to remember to negate.
 *
 * The cap is inclusive at the boundary: exactly `MAX_ATTACHMENT_BYTES` is accepted and only a byte more
 * is refused. The comparison lives here rather than at the throw site so the off-by-one has somewhere
 * to be tested, because getting it wrong in either direction is invisible — a file that fits is
 * refused, or one that does not is shipped.
 */
export function attachmentRefusal(input: { mimeType: string; bytes: number }): AttachmentRefusal | null {
  if (!acceptedAttachmentMime(input.mimeType)) {
    const shown = input.mimeType.trim() === '' ? 'unrecognised' : input.mimeType
    return {
      code: IMAGE_ATTACH_REFUSED,
      message: `Only PNG, JPEG, WebP, and GIF images can be attached; this file is ${shown}.`,
    }
  }

  if (input.bytes > MAX_ATTACHMENT_BYTES) {
    return {
      code: IMAGE_ATTACH_REFUSED,
      message: `An image can be at most ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB. This one is larger.`,
    }
  }

  return null
}

/**
 * Whether one message may carry this many images, and what to say when it may not. `null` means it may.
 *
 * The count is the message's, not the session's: a conversation may hold as many images as its turns
 * were attached, and this bounds what one request is asked to carry.
 */
export function attachmentCountRefusal(count: number): AttachmentRefusal | null {
  if (count <= MAX_ATTACHMENTS_PER_MESSAGE) return null
  return {
    code: IMAGE_ATTACH_REFUSED,
    message: `One message can attach at most ${MAX_ATTACHMENTS_PER_MESSAGE} images.`,
  }
}

/**
 * Whether a provider may take images, as its stored preference says.
 *
 * `true` only when the record says so, which makes absence and `false` the same answer. That is the
 * whole of the default: a provider record written before this key existed carries no opinion, and a
 * gate that read silence as permission would send an image to a model that cannot see it — a failure
 * the user learns about from a provider error that names nothing about images.
 *
 * A boolean rather than a refusal, and pointedly *not* a `ConveyorError` code. Nothing was rejected
 * here: the bytes are the user's, the draft stays exactly where it is, and what the composer shows is
 * its own sentence about where to switch the capability on. The provider record is a preference, and
 * this file owns the rules a *store* enforces; where a preference is read, the wording belongs to the
 * surface that displays it.
 *
 * The parameter is `unknown` rather than a shape with an optional flag on it, and that is deliberate. A
 * record that predates this key does not *declare* it, and a parameter listing it as optional rejects
 * exactly those records — an object literal for the excess-property rule, a structural type for the
 * weak-type rule, and a store's own type for neither only because it happens to declare the key. The one
 * thing this rule reads is a flag, so the honest parameter is anything, and the honest answer is that only
 * a literal `true` opens the gate.
 */
export function providerAcceptsImages(provider: unknown): boolean {
  if (typeof provider !== 'object' || provider === null) return false
  return (provider as { supportsImages?: unknown }).supportsImages === true
}

/**
 * Whether one image may be taken into the composer at all, and what to say when it may not. `null`
 * means it may.
 *
 * The composer's question rather than the store's, and the count is what makes it a different one:
 * `saveAttachment` bounds a single image, while a draft is a growing list and the cap is a property of
 * the message it will become. Both of the rules above are *asked* rather than restated — the media type
 * and the size through `attachmentRefusal`, the count through `attachmentCountRefusal` — so the
 * sentence the composer shows while the user is still choosing is the same sentence a write would be
 * refused with, and the two cannot drift into promising different numbers.
 *
 * The file's own rules come first and the count second, and that order is a decision. An image that is
 * the wrong type or too large is unusable wherever it would sit, so the sentence worth reading is
 * about the file; a message past its cap is one the user can act on only after picking something
 * else. Reporting the count first would tell a user to attach fewer images when the image in hand
 * could not be attached in any number.
 */
export function attachmentCaptureRefusal(input: {
  mimeType: string
  bytes: number
  /** How many images the draft is already holding, every one of them already past these rules. */
  attached: number
}): AttachmentRefusal | null {
  return attachmentRefusal(input) ?? attachmentCountRefusal(input.attached + 1)
}

/**
 * One attachment as a transcript records it: where the bytes are and what they are, never the bytes.
 *
 * A reference rather than the image, for the same reason `mentionPaths` is paths and not contents: a
 * transcript records the conversation, not a copy of the user's files, and a base64 image inline in
 * every turn would multiply the size of the one file the app rewrites on every turn boundary. The
 * bytes live in the attachment folder, and this is what points at them.
 *
 * The media type is a plain string and *not* the whitelist above, deliberately. A reference is a record
 * of what was stored, while the whitelist binds what may be stored — so a build that reads a transcript
 * naming a type it no longer sends loses nothing, where an enum here would turn one unrecognised media
 * type into an unreadable conversation. That is the same rule the rest of the transcript shape follows:
 * a reader that does not know a value must not be the reason a file fails to open.
 */
export const imageAttachmentRefSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  mimeType: z.string().min(1),
  size: z.number().int().nonnegative(),
})

export type ImageAttachmentRef = z.infer<typeof imageAttachmentRefSchema>

/**
 * An attachment resolved for sending: its reference, and the data URL the bytes became.
 *
 * The two travel together because only the send path needs both, and keeping them apart there would
 * mean a second array whose order had to be kept in step with the first.
 */
export interface ResolvedAttachment {
  ref: ImageAttachmentRef
  dataUrl: string
}

/** The OpenAI dialect's text part. */
export interface MessageTextPart {
  type: 'text'
  text: string
}

/**
 * The OpenAI dialect's image part.
 *
 * A data URL, which is the only form a local image can be sent in: the dialect fetches an http URL, and
 * these bytes exist nowhere a provider could reach. That is also why the caps above are byte caps — the
 * whole image rides inside the request body.
 */
export interface MessageImagePart {
  type: 'image_url'
  image_url: { url: string }
}

export type MessageContentPart = MessageTextPart | MessageImagePart

/**
 * The content a message is sent with: a plain string when it carries no images, and the dialect's part
 * array when it does.
 *
 * The string case is a *regression* rule rather than a convenience. Every message this app has ever
 * sent was a string, and the dialect accepts a string or an array — so a builder that always returned
 * an array would still be valid and would still change the request for every existing conversation at
 * once, including the ones with no image in sight. Emitting the string untouched is what keeps this
 * feature additive on the wire as well as in the transcript, and it is asserted as equality against the
 * text itself in the suite that covers this file.
 *
 * With images, the text part comes first and the images follow in attach order. The order is the user's,
 * not a convenience: the model reads the parts in sequence, and a sentence that says "the second one is
 * the bug" means what the user meant only if the second image is where they put it.
 *
 * The count is not checked here — `attachmentCountRefusal` is the rule and the caller with a refusal to
 * report is the one that asks it. A builder that also threw would make the cap unreachable for a caller
 * that wanted to show the sentence rather than fail, which is what the composer does.
 */
export function buildMessageContent(
  text: string,
  images: readonly ResolvedAttachment[] = []
): string | MessageContentPart[] {
  if (images.length === 0) return text

  return [
    { type: 'text', text },
    ...images.map((image): MessageImagePart => ({ type: 'image_url', image_url: { url: image.dataUrl } })),
  ]
}
