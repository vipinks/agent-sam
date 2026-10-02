/// <reference types="electron-vite/node" />

declare module '*.css' {
  const content: string
  export default content
}

declare module '*.png' {
  const content: string
  export default content
}

declare module '*.jpg' {
  const content: string
  export default content
}

declare module '*.jpeg' {
  const content: string
  export default content
}

declare module '*.svg' {
  const content: string
  export default content
}

declare module '*?raw' {
  const content: string
  export default content
}

// A file addressed as an asset rather than imported as code: vite emits it next to the bundle and
// answers with its url. Used for pdf.js's worker, which has to be a script of this app's own origin
// because the window's policy allows no other kind of worker.
declare module '*?url' {
  const url: string
  export default url
}

declare module '*.web' {
  const content: string
  export default content
}
