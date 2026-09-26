import { useEffect, useState } from 'react'
import { FileText, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { attachmentSizeLabel, type DraftAttachment } from './attachments'
import type { ImageAttachmentRef } from '@/conveyor/protocol/image-attachments'

/**
 * One image the composer is about to send, and one image a sent message carried.
 *
 * Two components in one file because they are two readings of the same thing, and the difference between
 * them is exactly what each may do. A draft chip is a control: it has a thumbnail, because the bytes are
 * in memory and the user is choosing, and it has a remove affordance, because nothing has been sent yet.
 * A reference chip is a record: the bytes are in the attachment store rather than in this process, so
 * there is nothing here to draw, and the message has been sent, so there is nothing to take off.
 *
 * They are separate rather than one component with a mode, because a mode is how a record would quietly
 * acquire a remove control it cannot honour.
 */

/**
 * The thumbnail's own object URL, created and revoked by the chip that shows it.
 *
 * Owned here rather than by the row so that revocation cannot be forgotten: the URL's lifetime is the
 * chip's lifetime, and every way a chip goes away — the user removing it, the send clearing the array,
 * the pane unmounting — is an unmount, which is the one case an effect can guarantee to see. A row
 * holding a map of URLs would need a revoke in three places and would leak the bytes whenever one of
 * them was missed.
 */
function useThumbnailUrl(image: DraftAttachment): string | null {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    // Guarded rather than assumed: an environment may not implement the object-URL API at all, and a
    // missing thumbnail is a chip without a picture rather than a composer that fails to render.
    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return

    // And guarded around the call as well as before it, which is not belt-and-braces: jsdom defines
    // `createObjectURL` and throws when it is used, so the existence check alone let a test environment
    // reach this line and take the render down with it. A picture is a nicety, and it may never be the
    // reason the composer cannot be typed into.
    let next: string
    try {
      next = URL.createObjectURL(new Blob([image.bytes], { type: image.mimeType }))
    } catch {
      // No URL was handed out, so there is nothing to show and nothing to release.
      return
    }

    setUrl(next)
    return () => {
      setUrl(null)
      try {
        URL.revokeObjectURL(next)
      } catch {
        // An environment that cannot release the URL it handed out is one whose URLs hold nothing once
        // the chip is gone, and a throw here would take the unmount down instead.
      }
    }
  }, [image])

  return url
}

/** One image in the composer's draft: its picture, its name, its size, and the way to take it off. */
function AttachmentChip({ image, onRemove }: { image: DraftAttachment; onRemove?: (id: string) => void }) {
  const thumbnail = useThumbnailUrl(image)

  return (
    <span
      data-slot="attachment-chip"
      title={image.name}
      className="inline-flex max-w-56 min-w-0 items-center gap-1.5 rounded-md border border-border bg-background py-0.5 pr-0.5 pl-1 text-[11px] text-foreground"
    >
      {thumbnail ? (
        // Decorative: the file's name is the text beside it, so a screen reader has nothing to gain from
        // the picture and something to lose from announcing it twice.
        <img src={thumbnail} alt="" className="size-5 shrink-0 rounded-sm object-cover" />
      ) : (
        <span className="flex size-5 shrink-0 items-center justify-center rounded-sm bg-muted">
          <FileText className="size-3 text-muted-foreground" />
        </span>
      )}
      <span className="truncate">{image.name}</span>
      <span className="shrink-0 text-muted-foreground">{attachmentSizeLabel(image.size)}</span>
      {onRemove && (
        <button
          type="button"
          // The name, not the size: two screenshots can arrive under the same name, and only the id
          // distinguishes them — so the label carries the name and the click carries the id.
          aria-label={`Remove ${image.name}`}
          onClick={() => onRemove(image.id)}
          className="flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <X className="size-3" />
        </button>
      )}
    </span>
  )
}

/** The composer's images, in the order they were attached. */
export function AttachmentChipRow({
  images,
  onRemove,
  className,
}: {
  images: readonly DraftAttachment[]
  onRemove?: (id: string) => void
  className?: string
}) {
  return (
    <div data-slot="attachment-chip-row" className={cn('flex flex-wrap gap-1', className)}>
      {images.map((image) => (
        <AttachmentChip key={image.id} image={image} onRemove={onRemove} />
      ))}
    </div>
  )
}

/**
 * One image a sent message carried, as the transcript shows it.
 *
 * A reference and not a thumbnail, this turn: the bytes are main's, behind a read this app has not been
 * given a command for yet, and a chip that drew an empty frame would be claiming to show something it
 * does not have. The name and the size are what the record actually holds, so they are what it shows —
 * and this is the shape the thumbnail upgrade will replace, not a placeholder for it.
 */
function AttachmentRefChip({ image }: { image: ImageAttachmentRef }) {
  return (
    <span
      data-slot="attachment-ref-chip"
      title={image.name}
      className="inline-flex max-w-56 min-w-0 items-center gap-1.5 rounded-md border border-border bg-background py-0.5 pr-1.5 pl-1.5 text-[11px] text-foreground"
    >
      <FileText className="size-3 shrink-0 text-muted-foreground" />
      <span className="truncate">{image.name}</span>
      <span className="shrink-0 text-muted-foreground">{attachmentSizeLabel(image.size)}</span>
    </span>
  )
}

/** The images a sent message carried. Not removable: the message has been sent, so these are a record. */
export function AttachmentRefChipRow({
  images,
  className,
}: {
  images: readonly ImageAttachmentRef[]
  className?: string
}) {
  return (
    <div data-slot="attachment-ref-chip-row" className={cn('flex flex-wrap gap-1', className)}>
      {images.map((image) => (
        <AttachmentRefChip key={image.id} image={image} />
      ))}
    </div>
  )
}
