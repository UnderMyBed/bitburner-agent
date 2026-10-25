// Locale-sensitive built-ins called without a locale use the machine's default, which differs between machines
// (e.g. a Windows dev box and a Linux CI runner). Some game text that ends up in saves uses them (Dark Net logs call
// toLocaleTimeString()), so the host pins the default. Environment variables can't do this portably (ICU ignores
// LANG on Windows), hence wrappers. Calls that pass a locale explicitly are unchanged.

type LocaleArgs = [locales?: unknown, options?: unknown];

/** Methods whose first argument is the locale. */
const PROTOTYPE_METHODS: [object, string[]][] = [
  [Date.prototype, ["toLocaleString", "toLocaleDateString", "toLocaleTimeString"]],
  [Number.prototype, ["toLocaleString"]],
  [BigInt.prototype, ["toLocaleString"]],
  [String.prototype, ["toLocaleUpperCase", "toLocaleLowerCase"]],
];
const INTL_CONSTRUCTORS = [
  "DateTimeFormat",
  "NumberFormat",
  "Collator",
  "PluralRules",
  "RelativeTimeFormat",
  "ListFormat",
  "Segmenter",
  "DisplayNames",
];
// Stored on Intl (a realm-wide object) rather than in this module, so the pin is visible however this module is
// loaded; pinnedLocale() lets the host prove the pin is in place even on a machine whose default already matches.
const PINNED = Symbol.for("bitburner-agent.pinnedLocale");

/** The locale pinDefaultLocale installed, if any. */
export function pinnedLocale(): string | undefined {
  return (Intl as unknown as Record<symbol, string | undefined>)[PINNED];
}

/** Makes `locale` the default for every locale-sensitive built-in. Call before the engine loads. */
export function pinDefaultLocale(locale: string): void {
  (Intl as unknown as Record<symbol, string>)[PINNED] = locale;
  // `undefined` and `[]` both mean "the default locale" to these APIs.
  const withDefault = (locales: unknown) =>
    locales === undefined || (Array.isArray(locales) && locales.length === 0) ? locale : locales;

  for (const [prototype, names] of PROTOTYPE_METHODS) {
    const methods = prototype as Record<string, (...args: LocaleArgs) => string>;
    for (const name of names) {
      const original = methods[name];
      if (!original) continue;
      Object.defineProperty(prototype, name, {
        configurable: true,
        writable: true,
        value: function (this: unknown, locales?: unknown, options?: unknown) {
          return original.call(this, withDefault(locales), options);
        },
      });
    }
  }

  // localeCompare takes the locale as its *second* argument, so it gets its own wrapper.
  const localeCompare = String.prototype.localeCompare;
  Object.defineProperty(String.prototype, "localeCompare", {
    configurable: true,
    writable: true,
    value: function (this: string, that: string, locales?: string | string[], options?: Intl.CollatorOptions) {
      return localeCompare.call(this, that, withDefault(locales) as string | string[], options);
    },
  });

  const intl = Intl as unknown as Record<string, new (...args: LocaleArgs) => object>;
  for (const name of INTL_CONSTRUCTORS) {
    const Original = intl[name];
    if (!Original) continue;
    // Callable with or without `new`, like the originals. Constructing through Reflect with `new.target` keeps
    // subclasses working; sharing the prototype keeps instanceof and `constructor` working.
    // A function expression, not an arrow: it must be constructible (`new Intl.NumberFormat()`).
    const Pinned = function (this: unknown, locales?: unknown, options?: unknown) {
      return Reflect.construct(Original, [withDefault(locales), options], new.target ?? Original);
    } as unknown as new (
      ...args: LocaleArgs
    ) => object;
    Object.setPrototypeOf(Pinned, Original);
    Object.defineProperty(Pinned, "name", { value: name });
    Pinned.prototype = Original.prototype;
    Object.defineProperty(Original.prototype, "constructor", { configurable: true, writable: true, value: Pinned });
    intl[name] = Pinned;
  }
}
