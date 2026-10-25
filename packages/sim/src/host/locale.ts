// Locale-sensitive built-ins called without a locale use the machine's default, which differs between machines
// (e.g. a Windows dev box and a Linux CI runner). Some game text that ends up in saves uses them (Dark Net logs call
// toLocaleTimeString()), so the host pins the default. Environment variables can't do this portably (ICU ignores
// LANG on Windows), hence wrappers.

type LocaleArgs = [locales?: unknown, options?: unknown];

const PROTOTYPE_METHODS: [object, string[]][] = [
  [Date.prototype, ["toLocaleString", "toLocaleDateString", "toLocaleTimeString"]],
  [Number.prototype, ["toLocaleString"]],
  [BigInt.prototype, ["toLocaleString"]],
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

const PINNED = Symbol.for("bitburner-agent.pinnedLocale");

/** The locale pinDefaultLocale installed, if any (lets the host prove the pin is in place on any machine). */
export function pinnedLocale(): string | undefined {
  return (Intl as unknown as Record<symbol, string | undefined>)[PINNED];
}

export function pinDefaultLocale(locale: string): void {
  (Intl as unknown as Record<symbol, string>)[PINNED] = locale;
  const withDefault = (locales: unknown) => (locales === undefined ? locale : locales);

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
    // Callable with or without `new`, like the originals; same prototype, so instanceof still works.
    // biome-ignore lint/complexity/useArrowFunction: must be a constructor (`new Intl.NumberFormat()`); arrows aren't.
    const Pinned = function (locales?: unknown, options?: unknown) {
      return new Original(withDefault(locales), options);
    } as unknown as new (
      ...args: LocaleArgs
    ) => object;
    Object.setPrototypeOf(Pinned, Original);
    Pinned.prototype = Original.prototype;
    intl[name] = Pinned;
  }
}
