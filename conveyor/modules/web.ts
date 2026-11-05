import { Menu, shell } from 'electron'
import { z } from 'zod'
import { defineModule, command } from '../init'
import { ContextMenuInput, contextMenuTemplate } from '../protocol/context-menu'

/**
 * Web-content operations for the titlebar menu. Each acts on the *calling* frame (`ctx.sender`),
 * so it targets whichever window invoked it. Core chrome (not part of the strippable demo).
 */
export const webModule = defineModule({
  undo: command(({ ctx }) => ctx.sender.undo()),
  redo: command(({ ctx }) => ctx.sender.redo()),
  cut: command(({ ctx }) => ctx.sender.cut()),
  copy: command(({ ctx }) => ctx.sender.copy()),
  paste: command(({ ctx }) => ctx.sender.paste()),
  selectAll: command(({ ctx }) => ctx.sender.selectAll()),

  /**
   * The native menu a right-click raises, at the pointer.
   *
   * The region decides the items — `protocol/context-menu.ts` owns that table, and it is pure so the
   * items are testable without a window — and the caller decides the position. This handler is only
   * the translation into electron's own menu, which is the one part that cannot be stated without it.
   * `popup` is handed both coordinates, so the menu opens where the click happened rather than at a
   * platform-chosen default; a `context-menu` event's `clientX`/`clientY` are already in the window's
   * client area, which is the space `popup` takes.
   *
   * A call from a window that has gone is answered by doing nothing: the frame that made it went with
   * the window, and there is no surface to place a menu on. Nothing here reaches into the page — a
   * role item acts on whichever element has focus, the composer for its own menu and the selection for
   * the chat's — so the command cannot copy, paste or select on the caller's behalf by accident.
   *
   * There is no blanket `webContents.on('context-menu')` beside this, and that is the point: only the
   * two regions whose own handler asks for a menu get one, so an explorer row keeps the DOM menu it
   * draws and the guarded editor keeps no menu at all.
   */
  contextMenu: command(ContextMenuInput, ({ input, ctx }) => {
    const win = ctx.window
    if (!win) return
    Menu.buildFromTemplate(contextMenuTemplate(input.region)).popup({ window: win, x: input.x, y: input.y })
  }),

  reload: command(({ ctx }) => ctx.sender.reload()),
  forceReload: command(({ ctx }) => ctx.sender.reloadIgnoringCache()),
  toggleDevtools: command(({ ctx }) => ctx.sender.toggleDevTools()),
  actualSize: command(({ ctx }) => ctx.sender.setZoomLevel(0)),
  zoomIn: command(({ ctx }) => ctx.sender.setZoomLevel(ctx.sender.zoomLevel + 0.5)),
  zoomOut: command(({ ctx }) => ctx.sender.setZoomLevel(ctx.sender.zoomLevel - 0.5)),
  toggleFullscreen: command(({ ctx }) => {
    const win = ctx.window
    if (win) win.setFullScreen(!win.isFullScreen())
  }),
  openUrl: command(
    z.string().refine((s) => {
      try {
        const { protocol } = new URL(s)
        return protocol === 'https:' || protocol === 'http:'
      } catch {
        return false
      }
    }, 'Only http(s) URLs may be opened externally'),
    ({ input }) => shell.openExternal(input)
  ),
})
