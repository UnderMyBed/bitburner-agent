// Stand-ins for the `WeakRef` and `FinalizationRegistry` of the game's script module cache (NetscriptJSEvaluator.ts:41-47,
// :223-224), imported into that file alone by build.ts (`holdModules`). The cache then holds every compiled module, as
// upstream dev does (8e385f31, "Removed weakRef from moduleCache"), so garbage collection can't change what scripts do
// (#73).

/** A `WeakRef` that holds its target: `deref()` always returns it. */
export class StrongRef<T extends object> {
  readonly #target: T;
  constructor(target: T) {
    this.#target = target;
  }
  deref(): T {
    return this.#target;
  }
}

/** A `FinalizationRegistry` whose callback never runs: nothing it watches is ever collected. */
export class InertFinalizationRegistry<T> {
  // biome-ignore lint/complexity/noUselessConstructor: it takes the cleanup callback, as the real one does, and drops it
  constructor(_cleanup: (heldValue: T) => void) {}
  register(_target: object, _heldValue: T, _unregisterToken?: object): void {}
  unregister(_unregisterToken: object): boolean {
    return false;
  }
}

export { InertFinalizationRegistry as FinalizationRegistry, StrongRef as WeakRef };
