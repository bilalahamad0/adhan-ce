// Static checks on popup.css for what jsdom cannot show (it neither lays out nor
// paints). An SVG data URI with only a viewBox has no intrinsic size, so with
// background-size left at auto every browser scales it to the whole control
// ("contain"): the Settings select chevron was drawn at full height and ran
// over the end of the selected value in Chrome, Edge, Opera and Firefox alike.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Innermost `selector { declarations }` blocks (rules nested in @media included).
const rulesOf = (file) =>
  [...readFileSync(join(ROOT, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, sel, body]) => ({
    sel: sel.trim(),
    decls: Object.fromEntries([...body.matchAll(/([\w-]+)\s*:\s*((?:"[^"]*"|'[^']*'|[^;"'])+)/g)].map(([, p, v]) => [p, v.trim()])),
  }));
const RULES = rulesOf('popup.css');
const rule = (sel, rules = RULES) => rules.find((r) => r.sel === sel);

describe('popup.css SVG backgrounds', () => {
  it('gives every SVG data-URI background without its own width an explicit size', () => {
    const svgRules = RULES.filter((r) => /data:image\/svg\+xml/.test(r.decls['background-image'] || r.decls.background || ''));
    expect(svgRules.length).toBeGreaterThan(0);
    for (const r of svgRules) {
      const value = r.decls['background-image'] || r.decls.background;
      if (/%3Csvg(?:(?!%3E).)*\swidth=/.test(value)) continue; // intrinsic size: auto is fine
      const sized = r.decls['background-size'] || (r.decls.background && /\/\s*[\d.]+px/.test(r.decls.background));
      expect({ sel: r.sel, sized: Boolean(sized) }).toEqual({ sel: r.sel, sized: true });
    }
  });

  it('keeps the Settings select chevron inside the end padding, clear of the value', () => {
    const sel = rule('.set-row select').decls;
    const size = parseFloat(sel['background-size']);
    const pad = parseFloat(sel['padding-inline-end']);
    const ltr = parseFloat(sel['background-position'].match(/right\s+([\d.]+)px/)[1]);
    const rtl = parseFloat(rule('[dir="rtl"] .set-row select').decls['background-position'].match(/left\s+([\d.]+)px/)[1]);
    expect(size).toBeGreaterThan(0);
    expect(ltr + size).toBeLessThanOrEqual(pad);
    expect(rtl + size).toBeLessThanOrEqual(pad);
  });
});

// A Latin run in an Arabic or Urdu page is laid out right to left unless told
// otherwise: a long value was clipped at its start and a time read "AM 09:05".
describe('Latin text in right-to-left pages', () => {
  it('lets the method and Hijri selects read left to right while they keep the RTL chevron side', () => {
    expect(rule('#method, #hijriOffset').decls.direction).toBe('ltr'); // "+1", not "1+"
    const rtl = rule('[dir="rtl"] #method, [dir="rtl"] #hijriOffset').decls;
    expect(rtl['text-align']).toBe('right'); // a short name sits where the other values do
    // The chevron is drawn at "left 10px" in RTL: the padding there must clear it.
    const chevron = rule('.set-row select').decls;
    const at = parseFloat(rule('[dir="rtl"] .set-row select').decls['background-position'].match(/left\s+([\d.]+)px/)[1]);
    expect(at + parseFloat(chevron['background-size'])).toBeLessThanOrEqual(parseFloat(rtl['padding-left']));
    expect(parseFloat(rtl['padding-right'])).toBeLessThan(parseFloat(rtl['padding-left']));
  });

  it("keeps an empty city field's placeholder right to left in Arabic and Urdu", () => {
    expect(rule('[dir="rtl"] #city:placeholder-shown').decls.direction).toBe('rtl');
    expect(rule('[dir="rtl"] .loc-input:placeholder-shown', rulesOf('welcome.css')).decls.direction).toBe('rtl');
  });

  it("leaves the Tracker's Hijri date in the UI language's direction", () => {
    // Forced left to right, "4 جمادى الأولى 1448 هـ" put the day number at the wrong end.
    const hijri = rule('.dd-hijri').decls;
    expect(hijri.direction).toBeUndefined();
    expect(hijri['unicode-bidi']).toBe('isolate');
  });

  it('keeps the welcome preview times left to right', () => {
    const time = rule('.pp-time', rulesOf('welcome.css')).decls;
    expect(time.direction).toBe('ltr');
    expect(time['unicode-bidi']).toBe('isolate');
  });
});
