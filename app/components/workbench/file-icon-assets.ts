import type { IconKey } from '@/conveyor/protocol/file-icons'

/**
 * Every file-type icon's url, keyed by the contract's key.
 *
 * One glob, once, at module load: Vite emits each svg as its own asset and the record below is the
 * only place a url is looked up. `no-inline` keeps the icons as files rather than data urls, so a
 * row's image is fetched and cached by the renderer like any other asset — and the glob's key is the
 * file name, which is why the key is recovered from the path rather than written out again here.
 */
const modules = import.meta.glob('../../assets/file-icons/*.svg', {
  eager: true,
  query: '?url&no-inline',
  import: 'default',
})

export const fileIconUrls = Object.fromEntries(
  Object.entries(modules).map(([path, url]) => [path.slice(path.lastIndexOf('/') + 1, -'.svg'.length), url as string])
) as Record<IconKey, string>
