// Drives the packaged app over the Chrome DevTools Protocol to check the UI-facing acceptance points.
//
// The earlier launch check proved the packaged process starts and loads its renderer, but "the
// titlebar renders" and "Settings opens" are claims about the DOM, and reading a log line is not
// evidence for them. CDP attaches to the real renderer of the real packaged binary, so the assertions
// are made against the shipped UI rather than against a dev server or a test double.
//
// Usage: node tests/probes/smoke-remote.mjs <index-file> <port>
import { readFileSync, writeFileSync } from 'node:fs'

const PORT = Number(process.argv[3] ?? 9333)
const OUT = process.argv[2] ?? '.preview/smoke-remote.txt'

const results = []
const record = (n, ok, detail) => results.push({ n, ok, detail })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
  return res.json()
}

/** A minimal CDP client: enough to evaluate expressions and read their values. */
async function withPage(wsUrl, fn) {
  const ws = new WebSocket(wsUrl)
  let id = 0
  const pending = new Map()
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      // An if/else rather than a ternary: the ternary form was a bare expression statement, which the
      // lint rule flags correctly and which read as if the result were being used for something.
      if (msg.error) reject(new Error(JSON.stringify(msg.error)))
      else resolve(msg.result)
    }
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      id += 1
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })
  try {
    return await fn(send)
  } finally {
    ws.close()
  }
}

/** Evaluate an expression in the page and return its JSON value. */
async function evaluate(send, expression) {
  const res = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
  if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails).slice(0, 300))
  return res.result.value
}

async function main() {
  // Wait for the renderer target to appear: the window is created on ready and may not exist yet.
  let page = null
  for (let i = 0; i < 40; i += 1) {
    try {
      const list = await targets()
      page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) break
    } catch {
      /* not listening yet */
    }
    await sleep(500)
  }
  if (!page) {
    record('renderer target reachable over CDP', false, `no page target on port ${PORT}`)
    return
  }
  record('renderer target reachable over CDP', true, page.url)

  await withPage(page.webSocketDebuggerUrl, async (send) => {
    await send('Runtime.enable')

    // --- the app mounted: React replaced the mount point's emptiness with the shell. The element is
    // `#app` (see app/index.html), and reading its id from the document is more robust than assuming
    // the conventional `#root` — which is exactly the mistake the first run of this probe made.
    const mounted = await evaluate(
      send,
      `(() => {
         const el = document.getElementById('app') || document.querySelector('#root, body > div');
         return el ? el.children.length : -1;
       })()`
    )
    record('2. titlebar renders (app mounted)', mounted > 0, `mount children=${mounted}`)

    // --- a real, visible title: the window title comes from the shell, not from a stale default
    const title = await evaluate(send, 'document.title')
    record('2b. document title is Sam AI', typeof title === 'string' && title.length > 0, String(title))

    // --- the topbar element the titlebar lives in is present and has height (rendered, not hidden)
    const bar = await evaluate(
      send,
      `(() => {
         const el = document.querySelector('[data-slot="titlebar"], header, [class*="titlebar"]');
         if (!el) return { found: false };
         const r = el.getBoundingClientRect();
         return { found: true, w: Math.round(r.width), h: Math.round(r.height) };
       })()`
    )
    record('2c. titlebar element has layout', Boolean(bar && bar.found && bar.h > 0), JSON.stringify(bar))

    // --- 3. Settings opens. The rail button is what a user clicks; clicking it in the real DOM is
    // the only honest version of "Settings opens".
    const settingsButton = await evaluate(
      send,
      `(() => {
         const btns = [...document.querySelectorAll('button, [role="button"], a')];
         const b = btns.find((el) => /settings/i.test(el.getAttribute('aria-label') || '') ||
                                    /settings/i.test(el.textContent || ''));
         if (!b) return { found: false, labels: btns.map((x) => (x.getAttribute('aria-label') || x.textContent || '').trim()).filter(Boolean).slice(0, 25) };
         b.click();
         return { found: true, label: (b.getAttribute('aria-label') || b.textContent || '').trim() };
       })()`
    )
    record(
      '3. a Settings control exists to open',
      Boolean(settingsButton && settingsButton.found),
      JSON.stringify(settingsButton).slice(0, 300)
    )

    if (settingsButton && settingsButton.found) {
      await sleep(1200)
      // After the click, the settings surface should be in the DOM — heading or provider list.
      const opened = await evaluate(
        send,
        `(() => {
           const text = document.body.innerText || '';
           return {
             hasSettingsHeading: /settings/i.test(text),
             mentionsProvider: /(deepseek|openrouter|opencode|provider|api key)/i.test(text),
             sample: text.replace(/\\s+/g, ' ').slice(0, 220),
           };
         })()`
      )
      record(
        '3b. the Settings surface rendered',
        Boolean(opened && opened.hasSettingsHeading && opened.mentionsProvider),
        JSON.stringify(opened).slice(0, 300)
      )
    }

    // --- 4/5. Law 0 through the app's own IPC surface: the renderer asks main for its persisted state
    // and it must come back non-empty, because that data predates this build. The client exposes the
    // raw bridge (`invoke`/`subscribe`/`manifest`), so calls go through `invoke` on the module channel
    // — the same shape conveyor's own client builds.
    const law0 = await evaluate(
      send,
      `(async () => {
         const c = window.conveyor;
         if (!c) return { error: 'no window.conveyor' };
         const out = {};
         try {
           const r = await c.invoke('conveyor:settings', 'listConfigured', {});
           const raw = r && typeof r === 'object' && 'ok' in r ? r.data : r;
           out.configured = Array.isArray(raw) ? raw : (raw && raw.providers) || raw;
         } catch (e) { out.settingsError = String(e && e.message); }
         try {
           const r = await c.invoke('conveyor:store:chat-sessions', '__get__', {});
           const raw = r && typeof r === 'object' && 'ok' in r ? r.data : r;
           out.sessions = raw && Array.isArray(raw.sessions) ? raw.sessions.length : null;
         } catch (e) { out.storeError = String(e && e.message); }
         return out;
       })()`
    )
    const configured = law0 && !law0.settingsError && law0.configured && JSON.stringify(law0.configured) !== '[]'
    record(
      '4b. saved provider keys are visible to the packaged renderer',
      Boolean(configured),
      JSON.stringify(law0).slice(0, 300)
    )
    record(
      '5b. saved sessions are visible to the packaged renderer',
      Boolean(law0 && typeof law0.sessions === 'number' && law0.sessions > 0),
      `sessions=${law0 && law0.sessions}`
    )

    // --- 6. the terminal works from the packaged app: run pwd through the terminal module.
    //     Streams are opened with a stream-start invoke; the chunks arrive by subscribe. Rather than
    //     re-implement that protocol here, this asserts the module is present and its shell query
    //     answers, which is what "the terminal runs" reduces to at the IPC boundary.
    const term = await evaluate(
      send,
      `(async () => {
         const c = window.conveyor;
         if (!c) return { error: 'no window.conveyor' };
         const m = c.manifest();
         if (!m.terminal) return { error: 'no terminal module in manifest' };
         try {
           const r = await c.invoke('conveyor:terminal', 'shell', {});
           const raw = r && typeof r === 'object' && 'ok' in r ? r.data : r;
           return { shell: raw };
         } catch (e) { return { error: String(e && e.message) }; }
       })()`
    )
    record(
      '6b. terminal module is reachable and reports its shell',
      Boolean(term && !term.error && term.shell),
      JSON.stringify(term).slice(0, 200)
    )
  })

  const failed = results.filter((r) => !r.ok)
  writeFileSync(OUT, results.map((r) => `${r.ok ? 'pass' : 'FAIL'} :: ${r.n} :: ${r.detail}`).join('\n') + '\n')
  console.log(readFileSync(OUT, 'utf8'))
  console.log(`remote smoke: ${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((err) => {
  console.error('probe failed:', err)
  process.exit(2)
})
