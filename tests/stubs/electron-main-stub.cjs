/**
 * Test double for `electron-conveyor/main`, which imports electron and so cannot load in plain node.
 *
 * Only `ConveyorError` is needed by the modules the suites exercise — but it has to be a faithful
 * double, because the whole point of these tests is that callers branch on `code`. It therefore
 * mirrors the real class: the same constructor signature, the same `name`, a `code` that survives,
 * and `from` for rebuilding one from a wire payload.
 */
class ConveyorError extends Error {
  /** Mirrors the real class's shape: `new ConveyorError(code, message?, issues?)`. */
  constructor(code, message, issues) {
    super(message ?? code)
    this.name = 'ConveyorError'
    this.code = code
    this.issues = issues
  }

  /** Rebuild from a payload, as the real class does when a result crosses the boundary. */
  static from(payload) {
    return new ConveyorError(payload.code, payload.message, payload.issues)
  }
}

module.exports = { ConveyorError }
