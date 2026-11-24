import { describe, expect, it } from "vitest";
import {
  ensurePackage,
  formatCm,
  lengthCm,
  marginPreset,
  MARGIN_PRESETS,
  pageGeometry,
  pageStyle,
  parseMarginCm,
  readPageSetup,
  removePackage,
  writePageSetup,
  type PageSetup,
} from "./pageSetup";

const doc = (head: string) => `${head}\n\\begin{document}`;
const read = (src: string) => readPageSetup(src).settings;
const write = (src: string, patch: Partial<PageSetup>) => writePageSetup(src, { ...read(src), ...patch });

const SAMPLES = [
  doc("\\documentclass{article}"),
  doc("\\documentclass[11pt,a4paper]{article}\n\\usepackage{amsmath}"),
  doc("\\documentclass[12pt, twocolumn]{report}\n\\usepackage[margin=1in]{geometry}\n\\usepackage{parskip}"),
  doc("\\documentclass{article}\n\\usepackage{amsmath,geometry}\n\\geometry{left=2cm,right=3cm}\n% \\usepackage{lmodern}\n\\usepackage{setspace}\n\\onehalfspacing"),
  doc("\\documentclass{article}\r\n\\usepackage[a4paper,top=2cm,bottom=2cm,left=1.5cm,right=1.5cm,headheight=14pt]{geometry}\r\n\\usepackage{mathpazo}"),
  doc("\\documentclass[conference]{IEEEtran}\n\\usepackage{cite}"),
];

describe("readPageSetup", () => {
  it("reads defaults from a bare article", () => {
    expect(read(SAMPLES[0])).toEqual({
      paper: "letter",
      orientation: "portrait",
      margins: null,
      fontSize: 10,
      font: "cm",
      lineSpacing: "single",
      columns: 1,
      parStyle: "indent",
    });
  });

  it("reads class options, geometry, fonts and spacing", () => {
    expect(read(SAMPLES[1])).toMatchObject({ paper: "a4", fontSize: 11 });
    const s = read(SAMPLES[2]);
    expect(s).toMatchObject({ fontSize: 12, columns: 2, parStyle: "space" });
    expect(s.margins).toEqual({ top: 2.54, bottom: 2.54, left: 2.54, right: 2.54 });
    const t = read(SAMPLES[3]);
    expect(t.margins?.left).toBeCloseTo(2);
    expect(t.margins?.right).toBeCloseTo(3);
    expect(t.font).toBe("cm"); // commented out
    expect(t.lineSpacing).toBe("1.5");
    const u = read(SAMPLES[4]);
    expect(u).toMatchObject({ paper: "a4", font: "palatino", margins: { top: 2, bottom: 2, left: 1.5, right: 1.5 } });
  });

  it("reads hmargin/vmargin pairs, paper= and landscape", () => {
    const s = read(doc("\\documentclass{article}\n\\usepackage[paper=a5paper,landscape,hmargin={1cm,2cm},vmargin=15mm]{geometry}"));
    expect(s).toMatchObject({ paper: "a5", orientation: "landscape" });
    expect(s.margins!.left).toBeCloseTo(1);
    expect(s.margins!.right).toBeCloseTo(2);
    expect(s.margins!.top).toBeCloseTo(1.5);
  });

  it("reads sans default and setstretch", () => {
    const s = read(doc("\\documentclass{article}\n\\usepackage{setspace}\n\\setstretch{1.15}\n\\renewcommand{\\familydefault}{\\sfdefault}"));
    expect(s).toMatchObject({ font: "helvetica", lineSpacing: "1.15" });
    expect(read(doc("\\documentclass{article}\n\\usepackage[doublespacing]{setspace}")).lineSpacing).toBe("double");
  });

  it("limits fixed-layout classes and fontspec documents", () => {
    expect(readPageSetup(SAMPLES[5]).limits.layout).toMatch(/IEEEtran/);
    expect(readPageSetup(doc("\\documentclass{beamer}")).limits.layout).toMatch(/beamer/);
    expect(readPageSetup(doc("\\documentclass{acmart}")).limits.font).toBeTruthy();
    expect(readPageSetup(doc("\\documentclass{article}\n\\usepackage{fontspec}")).limits.font).toMatch(/fontspec/);
    expect(readPageSetup(SAMPLES[0]).limits).toEqual({ layout: null, font: null });
  });
});

describe("writePageSetup", () => {
  it("is a no-op for the current settings", () => {
    for (const s of SAMPLES) expect(writePageSetup(s, read(s))).toBe(s);
  });

  it("is idempotent", () => {
    const patches: Partial<PageSetup>[] = [
      { paper: "a4" },
      { margins: MARGIN_PRESETS.narrow.margins },
      { font: "times", lineSpacing: "double" },
      { columns: 2, parStyle: "space", fontSize: 12 },
      { orientation: "landscape", margins: { top: 1, bottom: 2, left: 3, right: 4 } },
    ];
    for (const s of SAMPLES.slice(0, 5)) {
      for (const p of patches) {
        const once = write(s, p);
        expect(write(once, p)).toBe(once);
        expect(read(once)).toMatchObject(p);
      }
    }
  });

  it("changes only the paper option in place", () => {
    expect(write(SAMPLES[1], { paper: "letter" })).toBe(doc("\\documentclass[11pt,letterpaper]{article}\n\\usepackage{amsmath}"));
    expect(write(SAMPLES[0], { paper: "a4" })).toBe(doc("\\documentclass[a4paper]{article}"));
    // In geometry when geometry names it.
    expect(write(SAMPLES[4], { paper: "letter" })).toContain("\\usepackage[letterpaper,top=2cm");
  });

  it("keeps other geometry options when margins change", () => {
    const out = write(SAMPLES[4], { margins: MARGIN_PRESETS.normal.margins });
    expect(out).toBe(doc("\\documentclass{article}\r\n\\usepackage[a4paper,margin=2.5cm,headheight=14pt]{geometry}\r\n\\usepackage{mathpazo}"));
    const custom = write(SAMPLES[2], { margins: { top: 2, bottom: 2, left: 3, right: 1.5 } });
    expect(custom).toContain("\\usepackage[top=2cm,bottom=2cm,left=3cm,right=1.5cm]{geometry}");
  });

  it("updates \\geometry{} commands instead of adding a second geometry", () => {
    const out = write(SAMPLES[3], { margins: MARGIN_PRESETS.narrow.margins });
    expect(out).toContain("\\geometry{margin=1.27cm}");
    expect(out.match(/geometry/g)).toHaveLength(2);
  });

  it("adds geometry once when there is none, and removes an idle one", () => {
    const out = write(SAMPLES[1], { margins: MARGIN_PRESETS.wide.margins });
    expect(out).toBe(doc("\\documentclass[11pt,a4paper]{article}\n\\usepackage{amsmath}\n\\usepackage[top=2.5cm,bottom=2.5cm,left=5cm,right=5cm]{geometry}"));
    expect(write(out, { margins: null })).toBe(SAMPLES[1]);
  });

  it("writes landscape through geometry and removes it again", () => {
    const out = write(SAMPLES[1], { orientation: "landscape" });
    expect(out).toContain("\\usepackage[landscape]{geometry}");
    expect(write(out, { orientation: "portrait" })).toBe(SAMPLES[1]);
    const cls = doc("\\documentclass[landscape]{article}");
    expect(read(write(cls, { orientation: "portrait" })).orientation).toBe("portrait");
  });

  it("sets font size and columns as class options", () => {
    expect(write(SAMPLES[0], { fontSize: 12 })).toBe(doc("\\documentclass[12pt]{article}"));
    expect(write(SAMPLES[1], { fontSize: 10 })).toBe(doc("\\documentclass[10pt,a4paper]{article}\n\\usepackage{amsmath}"));
    expect(write(SAMPLES[0], { fontSize: 10 })).toBe(SAMPLES[0]);
    expect(write(SAMPLES[2], { columns: 1 })).toContain("\\documentclass[12pt]{report}");
    expect(write(SAMPLES[1], { columns: 2 })).toContain("\\documentclass[11pt,a4paper,twocolumn]{article}");
  });

  it("replaces conflicting font packages", () => {
    const out = write(SAMPLES[4], { font: "times" });
    expect(out).not.toContain("mathpazo");
    expect(out.match(/mathptmx/g)).toHaveLength(1);
    const sans = write(SAMPLES[0], { font: "helvetica" });
    expect(sans).toBe(doc("\\documentclass{article}\n\\usepackage[scaled]{helvet}\n\\renewcommand{\\familydefault}{\\sfdefault}"));
    expect(write(sans, { font: "cm" })).toBe(SAMPLES[0]);
    const shared = doc("\\documentclass{article}\n\\usepackage{amsmath,lmodern}");
    expect(write(shared, { font: "cm" })).toBe(doc("\\documentclass{article}\n\\usepackage{amsmath}"));
  });

  it("writes line spacing through setspace without duplicates", () => {
    const out = write(SAMPLES[3], { lineSpacing: "double" });
    expect(out).toContain("\\usepackage{setspace}\n\\doublespacing");
    expect(out).not.toContain("onehalfspacing");
    expect(out.match(/setspace/g)).toHaveLength(1);
    const single = write(SAMPLES[3], { lineSpacing: "single" });
    expect(single).not.toMatch(/spacing/);
    const fresh = write(SAMPLES[0], { lineSpacing: "1.15" });
    expect(fresh).toBe(doc("\\documentclass{article}\n\\usepackage{setspace}\n\\setstretch{1.15}"));
    const opt = doc("\\documentclass{article}\n\\usepackage[onehalfspacing]{setspace}");
    expect(write(opt, { lineSpacing: "double" })).toBe(doc("\\documentclass{article}\n\\usepackage{setspace}\n\\doublespacing"));
  });

  it("toggles parskip", () => {
    const out = write(SAMPLES[0], { parStyle: "space" });
    expect(out).toBe(doc("\\documentclass{article}\n\\usepackage{parskip}"));
    expect(write(out, { parStyle: "indent" })).toBe(SAMPLES[0]);
  });

  it("leaves fixed-layout classes' layout alone", () => {
    expect(write(SAMPLES[5], { paper: "a4", margins: MARGIN_PRESETS.narrow.margins, columns: 2 })).toBe(SAMPLES[5]);
    expect(write(SAMPLES[5], { lineSpacing: "1.5" })).toContain("\\onehalfspacing");
  });

  it("leaves comments alone", () => {
    const src = doc("\\documentclass{article} % [a4paper]\n% \\usepackage[margin=1cm]{geometry}");
    const out = write(src, { margins: MARGIN_PRESETS.normal.margins });
    expect(out).toContain("% \\usepackage[margin=1cm]{geometry}");
    expect(out).toContain("% [a4paper]");
    expect(read(out).margins).toEqual(MARGIN_PRESETS.normal.margins);
  });
});

describe("packages", () => {
  it("ensurePackage adds once and merges options", () => {
    const base = SAMPLES[1];
    const once = ensurePackage(base, "xcolor");
    expect(once).toBe(doc("\\documentclass[11pt,a4paper]{article}\n\\usepackage{amsmath}\n\\usepackage{xcolor}"));
    expect(ensurePackage(once, "xcolor")).toBe(once);
    expect(ensurePackage(once, "xcolor", ["dvipsnames"])).toContain("\\usepackage[dvipsnames]{xcolor}");
    expect(ensurePackage(ensurePackage(once, "xcolor", ["table"]), "xcolor", ["table"]).match(/xcolor/g)).toHaveLength(1);
    // From a shared line: its own line, so the options don't spread to the others.
    const shared = ensurePackage(doc("\\documentclass{article}\n\\usepackage{amsmath,xcolor}"), "xcolor", ["table"]);
    expect(shared).toBe(doc("\\documentclass{article}\n\\usepackage{amsmath}\n\\usepackage[table]{xcolor}"));
  });

  it("ensurePackage works without any packages yet, keeping CRLF", () => {
    expect(ensurePackage("\\documentclass{article}\r\n\\begin{document}", "xcolor")).toBe("\\documentclass{article}\r\n\\usepackage{xcolor}\r\n\\begin{document}");
  });

  it("removePackage removes the whole line or one name", () => {
    expect(removePackage(SAMPLES[1], "amsmath")).toBe(doc("\\documentclass[11pt,a4paper]{article}"));
    expect(removePackage(doc("\\documentclass{article}\n\\usepackage{a, b ,c}"), "b")).toBe(doc("\\documentclass{article}\n\\usepackage{a ,c}"));
  });
});

describe("units and presets", () => {
  it("converts lengths", () => {
    expect(lengthCm("1in")).toBeCloseTo(2.54);
    expect(lengthCm("25mm")).toBeCloseTo(2.5);
    expect(lengthCm("72.27pt")).toBeCloseTo(2.54);
    expect(lengthCm("\\dimexpr 1cm")).toBeNull();
    expect(formatCm(1.2700001)).toBe("1.27cm");
  });

  it("names presets", () => {
    expect(marginPreset(null)).toBe("default");
    expect(marginPreset({ top: 2.5, bottom: 2.5, left: 2.5, right: 2.5 })).toBe("normal");
    expect(marginPreset({ top: 1, bottom: 2.5, left: 2.5, right: 2.5 })).toBe("custom");
  });

  it("gives page geometry for the canvas", () => {
    const g = pageGeometry({ ...read(SAMPLES[1]), orientation: "landscape" });
    expect(g.width).toBeCloseTo(29.7);
    expect(g.margins.left).toBeGreaterThan(2);
  });
});

describe("pageStyle", () => {
  const a4 = { ...read(SAMPLES[1]), margins: MARGIN_PRESETS.normal.margins };

  it("draws the paper at real size when it fits", () => {
    const st = pageStyle(a4, 2000, 1);
    expect(parseFloat(st["--v-page-width"])).toBeCloseTo((21 / 2.54) * 96, 0);
    expect(parseFloat(st["--v-pad-left"])).toBeCloseTo((2.5 / 2.54) * 96, 0);
    expect(parseFloat(st["--v-doc-font-size"])).toBeCloseTo(11 * (96 / 72.27), 0);
    expect(st["--v-pt"]).toBe("1.3px");
  });

  it("scales the page down to fit a narrow pane, keeping type readable", () => {
    const st = pageStyle(a4, 448, 1);
    expect(parseFloat(st["--v-page-width"])).toBeCloseTo(400, 0);
    expect(parseFloat(st["--v-doc-font-size"])).toBeGreaterThanOrEqual(11 * (96 / 72.27) * 0.8 - 0.1);
  });

  it("follows the editor zoom and line spacing", () => {
    expect(parseFloat(pageStyle(a4, 4000, 2)["--v-page-width"])).toBeCloseTo((21 / 2.54) * 96 * 2, 0);
    expect(pageStyle({ ...a4, lineSpacing: "double" }, 2000, 1)["--v-line-height"]).toBe("2.5");
  });
});

describe("page setup with comments, KOMA, other fonts and macros", () => {
  it("reads class options around % comments in a multi-line list", () => {
    const src = doc("\\documentclass[%\n  11pt, % body size\n  twocolumn % layout\n]{article}");
    expect(read(src)).toMatchObject({ fontSize: 11, columns: 2 });
    // Writing the other way really changes the options, and keeps the comments.
    const out = write(src, { fontSize: 10, columns: 1 });
    expect(read(out)).toMatchObject({ fontSize: 10, columns: 1 });
    expect(out).toContain("% body size");
    expect(out).toContain("% layout");
  });

  it("reads geometry options around % comments", () => {
    const src = doc("\\documentclass{article}\n\\usepackage[\n  margin=2cm, % all sides\n  top=3cm\n]{geometry}");
    expect(read(src).margins).toMatchObject({ top: 3, bottom: 2, left: 2, right: 2 });
    const out = write(src, { margins: MARGIN_PRESETS.normal.margins });
    expect(read(out).margins).toEqual(MARGIN_PRESETS.normal.margins);
    expect(out).not.toContain("top=3cm");
    expect(out).toContain("% all sides");
  });

  it("adds an option after a commented list without copying the comment", () => {
    const src = doc("\\documentclass[\n  a4paper, % paper\n  11pt\n]{article}");
    const out = write(src, { columns: 2 });
    expect(out.match(/% paper/g)).toHaveLength(1);
    expect(read(out)).toMatchObject({ columns: 2, fontSize: 11, paper: "a4" });
  });

  it("reads and rewrites KOMA's fontsize= in place", () => {
    const src = doc("\\documentclass[fontsize=11pt,paper=a4]{scrartcl}");
    expect(read(src).fontSize).toBe(11);
    expect(write(src, { fontSize: 12 })).toContain("\\documentclass[fontsize=12pt,paper=a4]{scrartcl}");
    expect(write(src, { fontSize: 10 })).toContain("\\documentclass[fontsize=10pt,paper=a4]{scrartcl}");
    // KOMA's default is 11pt, written as fontsize= when changed.
    const bare = doc("\\documentclass{scrreprt}");
    expect(read(bare).fontSize).toBe(11);
    expect(write(bare, { fontSize: 11 })).toBe(bare);
    expect(write(bare, { fontSize: 12 })).toContain("\\documentclass[fontsize=12pt]{scrreprt}");
  });

  it("leaves fonts alone when the document uses a font package the dialog doesn't offer", () => {
    const src = doc("\\documentclass{article}\n\\usepackage{libertine}\n\\usepackage{fourier}");
    const info = readPageSetup(src);
    expect(info.limits.font).toMatch(/libertine|fourier/);
    expect(write(src, { font: "times" })).toBe(src);
  });

  it("replaces geometry's text size when margins are set", () => {
    const src = doc("\\documentclass{article}\n\\usepackage[a4paper,textwidth=15cm,top=2cm]{geometry}");
    const out = write(src, { margins: MARGIN_PRESETS.normal.margins });
    expect(out).toContain("\\usepackage[a4paper,margin=2.5cm]{geometry}");
  });

  it("ignores spacing commands inside macro definitions", () => {
    const src = doc("\\documentclass{article}\n\\usepackage{setspace}\n\\newcommand{\\draftmode}{\\doublespacing}");
    expect(read(src).lineSpacing).toBe("single");
    const out = write(src, { lineSpacing: "1.5" });
    expect(out).toContain("\\newcommand{\\draftmode}{\\doublespacing}");
    expect(out).toContain("\\onehalfspacing");
    expect(write(out, { lineSpacing: "single" })).toContain("\\newcommand{\\draftmode}{\\doublespacing}");
  });

  it("parses typed margins without snapping partial input to 0", () => {
    expect(parseMarginCm("")).toBeNull();
    expect(parseMarginCm("  ")).toBeNull();
    expect(parseMarginCm("abc")).toBeNull();
    expect(parseMarginCm("1.")).toBe(1);
    expect(parseMarginCm("1.5")).toBe(1.5);
    expect(parseMarginCm(".5")).toBe(0.5);
    expect(parseMarginCm("2,5")).toBe(2.5);
    expect(parseMarginCm("0")).toBe(0);
    expect(parseMarginCm("16")).toBeNull();
    expect(parseMarginCm("-1")).toBeNull();
  });
});
