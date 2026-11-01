/**
 * Shared error type for the patch engine. Lives in its own module so that `asar.mjs`, `bundle.mjs`
 * and `patch.mjs` can throw it without importing each other in a cycle.
 */

/** Thrown when the target is missing, unsupported, or the patch cannot be applied. */
export class PatchError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PatchError'
  }
}
