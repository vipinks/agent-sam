import appIcon from '@/resources/build/icon.png'
import { useThemeApplication } from '../components/workbench/theme-apply'

/**
 * The startup splash, drawn from the same renderer bundle as the workbench.
 *
 * The vertical rhythm is the ruled 480 px stack: 36 top, 360 logo, 12 gap, 64 caption band, 8 bottom.
 * The surface is the opaque `#0e1011` the BrowserWindow is born with; the band and its caption are
 * theme tokens, applied by the workbench's existing theme seam rather than by a second palette here.
 *
 * Both arrivals stop under `prefers-reduced-motion`, and both use the utilities already present in
 * `tw-animate-css` and Tailwind — no new dependency and no stylesheet.
 */
export function SplashScreen() {
  useThemeApplication()

  return (
    <div
      data-slot="splash"
      className="flex h-screen w-screen flex-col items-center overflow-hidden bg-[#0e1011] pt-9 pb-2"
    >
      <img
        data-slot="splash-logo"
        src={appIcon}
        alt="Agent Sam"
        width={360}
        height={360}
        draggable={false}
        className="size-[360px] shrink-0 animate-in fade-in zoom-in-95 duration-200 ease-out motion-reduce:animate-none"
      />

      <div
        data-slot="splash-caption-band"
        className="mt-3 flex h-16 w-full shrink-0 items-center justify-center bg-secondary"
      >
        <p data-slot="splash-caption" className="animate-pulse text-[14px] text-foreground motion-reduce:animate-none">
          Waking Sam...
        </p>
      </div>
    </div>
  )
}
