/** Raised in a microtask, as an uncaught exception, so the brain fails fast and is restarted. */
export const raiseAsUncaught = (error: unknown): void =>
  queueMicrotask(() => {
    throw error;
  });

/**
 * A component's subscribers. A listener that throws can't stop the others or the component that emits: its error goes
 * to `onListenerError`, by default raised afterwards as an uncaught exception (the brain fails fast).
 */
export class EventListeners<Event> {
  readonly #listeners = new Set<(event: Event) => void>();
  readonly #onListenerError: (error: unknown) => void;

  constructor(onListenerError: (error: unknown) => void = raiseAsUncaught) {
    this.#onListenerError = onListenerError;
  }

  /** Calls `listener` with every event from now on; returns a function that stops it. */
  subscribe(listener: (event: Event) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(event: Event): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        this.#onListenerError(error);
      }
    }
  }
}
