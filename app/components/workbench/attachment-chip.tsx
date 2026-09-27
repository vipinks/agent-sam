import { useEffect, useState } from 'react'
import { ConveyorError } from 'electron-conveyor/react'
import { FileText, ImageOff, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { conveyor } from '@/conveyor/client'
import { attachmentReadNotice, type ImageAttachmentRef } from '@/conveyor/protocol/image-attachments'
import { attachmentSizeLabel, type DraftAttachment } from './attachments'

/**
 * One image the composer is about to send, and one image a sent message carried.
 *
 * Two components in one file because they are two readings of the same thing, and the difference between
 * them is exactly what each may do. A draft chip is a control: it has a thumbnail, because the bytes are
 * in memory and the user is choosing, and it has a remove affordance, because nothing has been sent yet.
 * A reference chip is a record: the byte are in the attachment store rather than in this process, so it
 * draws what it is given and asks the store for the rest, and the message has been sent, so there is
 * nothing to take off.
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
 * What one reference chip knows about the bytes behind it.
 *
 * Three states rather than two, because "no picture yet" and "no picture ever" are different answers: a
 * chip that could not say which one it is in would either draw a permanent hole or claim a read it has
 * not completed. `record` is the fourth reading — a chip that was given no conversation to ask — and it
 * is what a component rendered outside the pane shows.
 */
type RefThumbnail =
  { status: 'record' | 'loading' } | { status: 'ready'; url: string } | { status: 'unavailable'; notice: string }

/**
 * The bytes behind one reference, read once per chip and only when the chip is drawn.
 *
 * Lazy by construction rather than by a scroll listener: the read is an effect on this component, so it
 * happens when a chip is mounted and not when a conversation is opened — a reopened conversation draws
 * its images because their turns are drawn, and a turn the virtualized list has not reached asks for
 * nothing. Nothing is preloaded, and no read survives the chip: the `live` flag drops an answer that
 * arrives after unmount rather than setting state on a chip that is gone.
 *
 * The failure is read off the code and never the sentence, and what it becomes is a worded placeholder
 * rather than an empty box: a reference whose file was swept, and one larger than the cap the app sends
 * under, are different facts with a sentence each, and a read that failed for neither of those reasons
 * says only that it could not be shown. A chip that drew nothing would be indistinguishable from a chip
 * still waiting.
 */
function useRefThumbnail(sessionId: string | undefined, id: string): RefThumbnail {
  const [thumbnail, setThumbnail] = useState<RefThumbnail>(() =>
    sessionId ? { status: 'loading' } : { status: 'record' }
  )

  useEffect(() => {
    if (!sessionId) {
      setThumbnail({ status: 'record' })
      return
    }

    let live = true
    setThumbnail({ status: 'loading' })
    void conveyor.attachments.readDataUrl({ sessionId, id }).then(
      (url) => {
        // The read is capped in main and returns a data URL, so what arrives is what the chip draws.
        if (live) setThumbnail({ status: 'ready', url })
      },
      (err: unknown) => {
        if (!live) return
        const code = err instanceof ConveyorError ? err.code : undefined
        setThumbnail({ status: 'unavailable', notice: attachmentReadNotice(code) })
      }
    )

    return () => {
      live = false
    }
  }, [sessionId, id])

  return thumbnail
}

/**
 * One image a sent message carried, as the transcript shows it.
 *
 * A thumbnail when the store still has the bytes, and a named chip that says what happened when it does
 * not: the name and size come from the reference, which is the record the transcript actually holds, and
 * the picture is asked for from the conversation the message belongs to. Without that conversation
 * there is nothing to ask, so the chip shows the record alone — which is also what it shows while the
 * read is in flight, so a chip never changes width when its picture arrives.
 */
function AttachmentRefChip({ image, sessionId }: { image: ImageAttachmentRef; sessionId?: string }) {
  const thumbnail = useRefThumbnail(sessionId, image.id)
  const notice = thumbnail.status === 'unavailable' ? thumbnail.notice : null

  return (
    <span
      data-slot="attachment-ref-chip"
      title={notice ?? image.name}
      className={cn(
        'inline-flex max-w-56 min-w-0 items-center gap-1.5 rounded-md border border-border bg-background py-0.5 pr-1.5 pl-1.5 text-[11px] text-foreground',
        notice && 'border-dashed'
      )}
    >
      {thumbnail.status === 'ready' ? (
        <img src={thumbnail.url} alt="" className="size-4 shrink-0 rounded-sm object-cover" />
      ) : notice ? (
        <ImageOff className="size-3 shrink-0 text-muted-foreground" />
      ) : (
        <FileText className="size-3 shrink-0 text-muted-foreground" />
      )}
      <span className="truncate">{image.name}</span>
      <span className="shrink-0 text-muted-foreground">{notice ?? attachmentSizeLabel(image.size)}</span>
    </span>
  )
}

/** The images a sent message carried. Not removable: the message has been sent, so these are a record. */
export function AttachmentRefChipRow({
  images,
  sessionId,
  className,
}: {
  images: readonly ImageAttachmentRef[]
  /** The conversation the message belongs to, which is where its images are stored. */
  sessionId?: string
  className?: string
}) {
  return (
    <div data-slot="attachment-ref-chip-row" className={cn('flex flex-wrap gap-1', className)}>
      {images.map((image) => (
        <AttachmentRefChip key={image.id} image={image} sessionId={sessionId} />
      ))}
    </div>
  )
}
