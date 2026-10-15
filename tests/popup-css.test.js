// Static checks on popup.css for what jsdom cannot show (it neither lays out nor
// paints). An SVG data URI with only a viewBox has no intrinsic size, so with
// background-size left at auto every browser scales it to the whole control
// ("contain"): the Settings select chevron was drawn at full height and ran
// over the end of the selected value in Chrome, Edge, Opera and Firefox alike.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CSS = readFileSync(join(ROOT, 'popup.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
// Innermost `selector { declarations }` blocks (rules nested in @media included).
const RULES = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, sel, body]) => ({
  sel: sel.trim(),
  decls: Object.fromEntries([...body.matchAll(/([\w-]+)\s*:\s*((?:"[^"]*"|'[^']*'|[^;"'])+)/g)].map(([, p, v]) => [p, v.trim()])),
}));
const rule = (sel) => RULES.find((r) => r.sel === sel);

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
