// Generates the minimal `.docx` fixture the document suites carry as a base64 constant, and prints it.
//
// The fixture has to be a real Word container rather than a string that looks like one: the claim the
// suite makes is that mammoth's own reader returns the paragraph text, and a hand-made stand-in would
// make that claim about the stand-in. Four parts is the whole of a readable document — the content
// types, the package relationships, the document part's own (empty) relationship list, and the
// document itself — and building it here rather than checking in a binary keeps the bytes reviewable.
//
// Usage: node tests/probes/make-docx-fixture.mjs [out.docx]
import { writeFileSync } from 'node:fs'
import JSZip from 'jszip'

const PARAGRAPHS = ['Hello from the document.', 'Second paragraph.']

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`

const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`

const DOCUMENT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W_NS}"><w:body>${PARAGRAPHS.map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join(
  ''
)}</w:body></w:document>`

const zip = new JSZip()
zip.file('[Content_Types].xml', CONTENT_TYPES)
zip.file('_rels/.rels', RELS)
zip.file('word/_rels/document.xml.rels', DOC_RELS)
zip.file('word/document.xml', DOCUMENT)

// Stored rather than deflated: the fixture is small, and a stored container is one more thing a reader
// of the constant can see for itself.
const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' })

if (process.argv[2]) writeFileSync(process.argv[2], bytes)
console.log(`${bytes.length} bytes, ${bytes.toString('base64').length} base64 characters`)
console.log(bytes.toString('base64'))
