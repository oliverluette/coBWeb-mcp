/**
 * Internal keys of the standard time characteristics.
 *
 * The component value validator only takes the display form (01.2026 for a month). The time
 * characteristics have fixed internal formats, so a value may be given in the internal form
 * (202601) as well; the key and the display form are computed here. Anything else is left to
 * the validator.
 */
interface TimeFormat {
  /** Internal form, e.g. YYYYMM. */
  internal: RegExp;
  /** Display form → internal. */
  fromDisplay?: (v: string) => string | undefined;
  /** Internal → display, written as the value's text. */
  display: (v: string) => string;
}

const pad = (s: string, n: number) => s.padStart(n, '0');

const FORMATS: Record<string, TimeFormat> = {
  '0CALDAY': {
    internal: /^\d{8}$/,
    fromDisplay: (v) => (/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(v) ? v.replace(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/, (_, d, m, y) => `${y}${pad(m, 2)}${pad(d, 2)}`) : undefined),
    display: (v) => `${v.slice(6, 8)}.${v.slice(4, 6)}.${v.slice(0, 4)}`,
  },
  '0CALMONTH': {
    internal: /^\d{6}$/,
    fromDisplay: (v) => (/^(\d{1,2})\.(\d{4})$/.exec(v) ? v.replace(/^(\d{1,2})\.(\d{4})$/, (_, m, y) => `${y}${pad(m, 2)}`) : undefined),
    display: (v) => `${v.slice(4, 6)}.${v.slice(0, 4)}`,
  },
  '0CALWEEK': {
    internal: /^\d{6}$/,
    fromDisplay: (v) => (/^(\d{1,2})\.(\d{4})$/.exec(v) ? v.replace(/^(\d{1,2})\.(\d{4})$/, (_, w, y) => `${y}${pad(w, 2)}`) : undefined),
    display: (v) => `${v.slice(4, 6)}.${v.slice(0, 4)}`,
  },
  '0CALQUARTER': {
    internal: /^\d{4}[1-4]$/,
    fromDisplay: (v) => (/^([1-4])\.(\d{4})$/.exec(v) ? v.replace(/^([1-4])\.(\d{4})$/, (_, q, y) => `${y}${q}`) : undefined),
    display: (v) => `${v.slice(4)}.${v.slice(0, 4)}`,
  },
  '0FISCPER': {
    internal: /^\d{7}$/,
    fromDisplay: (v) => (/^(\d{1,3})\.(\d{4})$/.exec(v) ? v.replace(/^(\d{1,3})\.(\d{4})$/, (_, p, y) => `${y}${pad(p, 3)}`) : undefined),
    display: (v) => `${v.slice(4, 7)}.${v.slice(0, 4)}`,
  },
  '0CALYEAR': { internal: /^\d{4}$/, display: (v) => v },
  '0FISCYEAR': { internal: /^\d{4}$/, display: (v) => v },
};

/** Internal key and text of a value of a standard time characteristic, or undefined. */
export function timeValue(characteristic: string, value: string): { intKey: string; desc: string } | undefined {
  const f = FORMATS[characteristic.toUpperCase()];
  if (!f) return undefined;
  const v = value.trim();
  const intKey = f.internal.test(v) ? v : f.fromDisplay?.(v);
  return intKey && f.internal.test(intKey) ? { intKey, desc: f.display(intKey) } : undefined;
}
