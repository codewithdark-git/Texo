// A Visual session: one file's text, its ProseMirror doc, and the block map
// tying them together. The text is the source of truth. syncFromText turns
// new text into doc changes, reusing unchanged nodes by identity; plan turns a
// changed doc into minimal text edits and refuses any change whose new text
// would not parse back to the same doc (I3).

import { Fragment, type Node as PMNode, type Slice } from "prosemirror-model";
import { codecFor, type BlockSpan, type DialectCodec } from "./dialects";
import { readContext } from "./context";
import { detectMdStyle, setMdStyle } from "./markdown/helpers";
import { SRC, register } from "./registry";
import { schema } from "./schema";
import { semEq } from "./semEq";
import { mapPmToSrc, mapSrcToPm, type SourceMap } from "./serialize";
import type { Dialect, DocContext, PlanResult, SyncResult, TextEdit, VisualSession } from "./types";

/** Test-only hooks; production code never sets these. */
export const testHooks: { corruptRegion: ((s: string) => string) | null } = { corruptRegion: null };

interface Block {
  start: number;
  end: number;
}

interface Layout {
  doc: PMNode;
  blocks: Block[];
}

/** A small LRU map: insertion order is recency order. */
class Lru<V> {
  map = new Map<string, V>();
  constructor(public capacity: number) {}
  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  set(key: string, v: V) {
    this.map.delete(key);
    this.map.set(key, v);
    while (this.map.size > this.capacity) this.map.delete(this.map.keys().next().value!);
  }
  clear() {
    this.map.clear();
  }
}

function isVirtual(node: PMNode): boolean {
  return node.type === schema.nodes.paragraph && node.content.size === 0;
}

const isWs = (s: string) => /^\s*$/.test(s);

/** Has a blank line (two line breaks with only spaces between). */
const hasBlankLine = (s: string) => /\n[ \t]*\r?\n/.test(s);

function trimEdit(text: string, offset: number, del: number, ins: string): TextEdit | null {
  const old = text.slice(offset, offset + del);
  const max = Math.min(old.length, ins.length);
  let p = 0;
  while (p < max && old.charCodeAt(p) === ins.charCodeAt(p)) p++;
  let q = 0;
  while (q < max - p && old.charCodeAt(old.length - 1 - q) === ins.charCodeAt(ins.length - 1 - q)) q++;
  if (old.length - p - q === 0 && ins.length - p - q === 0) return null;
  return { offset: offset + p, deleteLength: old.length - p - q, insert: ins.slice(p, ins.length - q) };
}

interface Run {
  i0: number;
  i1: number;
  j0: number;
  j1: number;
}

interface RawEdit {
  offset: number;
  deleteLength: number;
  insert: string;
  /** New-text-relative positions of run children, filled in later: [newIndex, relStart, relEnd]. */
  kids: [number, number, number][];
  run: Run;
}

class Session implements VisualSession {
  readonly dialect: Dialect;
  doc!: PMNode;
  text!: string;
  context!: DocContext;
  private codec: DialectCodec;
  private blocks: Block[] = [];
  private cache = new Lru<PMNode>(2000);
  private env: Record<string, unknown> = {};
  private overrides: Partial<DocContext>;
  private cacheTag = "";
  private ctxChanged = false;
  private maps = new WeakMap<PMNode, SourceMap>();
  private starts: number[] | null = null;
  private pending: { doc: PMNode; text: string; blocks: Block[] } | null = null;
  private prevText = "";

  constructor(dialect: Dialect, text: string, overrides: Partial<DocContext>) {
    this.dialect = dialect;
    this.codec = codecFor(dialect);
    this.overrides = overrides;
    this.load(text);
  }

  get rawRatio(): number {
    let body = 0;
    let raw = 0;
    this.doc.forEach((n) => {
      if (n.type === schema.nodes.preamble || n.type === schema.nodes.postamble || isVirtual(n)) return;
      body++;
      if (n.type === schema.nodes.raw_block) raw++;
    });
    return body === 0 ? 0 : raw / body;
  }

  /** Reads the context; clears the node cache (and returns true) when parsing would differ. */
  private readCtx(text: string): DocContext {
    const ctx = { ...readContext(this.dialect, text), ...this.overrides };
    if (this.dialect === "markdown") setMdStyle(ctx, detectMdStyle(text));
    const tag = ctx.macrosHash + "\0" + JSON.stringify(ctx.theorems) + "\0" + ctx.hasChapters;
    this.ctxChanged = tag !== this.cacheTag;
    if (this.ctxChanged) {
      this.cache.clear();
      this.cacheTag = tag;
    }
    return ctx;
  }

  private key(src: string): string {
    return this.dialect + "\0" + this.context.macrosHash + "\0" + src;
  }

  private node(src: string, kind: string): PMNode {
    const key = this.key(src);
    let n = this.cache.get(key);
    if (!n) {
      n = this.codec.build(src, kind, this.context, this.env);
      this.cache.set(key, n);
    }
    return n;
  }

  private atomNode(type: "preamble" | "postamble", src: string): PMNode {
    const key = this.key(src) + "\0" + type;
    let n = this.cache.get(key);
    if (!n) {
      n = register(schema.nodes[type].create({ src }), src);
      this.cache.set(key, n);
    }
    return n;
  }

  /** Splits and parses the whole text, reusing cached nodes. */
  private build(text: string): Layout {
    this.env = {};
    const layout = this.codec.splitFile(text, this.env);
    const kids: PMNode[] = [];
    const blocks: Block[] = [];
    if (layout.pre) {
      kids.push(this.atomNode("preamble", text.slice(layout.pre[0], layout.pre[1])));
      blocks.push({ start: layout.pre[0], end: layout.pre[1] });
    }
    for (const sp of layout.body) {
      kids.push(this.node(text.slice(sp.start, sp.end), sp.kind));
      blocks.push({ start: sp.start, end: sp.end });
    }
    if (layout.body.length === 0) {
      // Give an empty body one virtual paragraph to type into.
      const at = layout.pre ? layout.pre[1] : layout.post ? layout.post[0] : 0;
      kids.push(schema.nodes.paragraph.create());
      blocks.push({ start: at, end: at });
    }
    if (layout.post) {
      kids.push(this.atomNode("postamble", text.slice(layout.post[0], layout.post[1])));
      blocks.push({ start: layout.post[0], end: layout.post[1] });
    }
    this.cache.capacity = Math.max(2000, 4 * blocks.length);
    return { doc: schema.nodes.doc.create(null, kids), blocks };
  }

  /** Text that may change the file-level split or far-away blocks: rebuild fully. */
  private risky(s: string): boolean {
    return this.dialect === "latex" ? /\\(begin|end)|document|verbatim/.test(s) : /\]:|```|~~~|\$\$|^(---|\.\.\.)/m.test(s);
  }

  /**
   * Re-splits only a window around the changed text, reusing the old nodes
   * outside it. Returns null when a full rebuild is needed.
   */
  private incremental(oldText: string, text: string): Layout | null {
    const kids: PMNode[] = [];
    this.doc.forEach((n) => kids.push(n));
    const ob = this.blocks;
    const n = kids.length;
    if (n !== ob.length) return null;
    const hasPre = n > 0 && kids[0].type === schema.nodes.preamble;
    const hasPost = n > 0 && kids[n - 1].type === schema.nodes.postamble;
    const lo = hasPre ? 1 : 0;
    const hi = hasPost ? n - 1 : n;
    if (hi - lo < 2) return null;
    const max = Math.min(oldText.length, text.length);
    let p = 0;
    while (p < max && oldText.charCodeAt(p) === text.charCodeAt(p)) p++;
    let q = 0;
    while (q < max - p && oldText.charCodeAt(oldText.length - 1 - q) === text.charCodeAt(text.length - 1 - q)) q++;
    const delta = text.length - oldText.length;
    const oldEnd = oldText.length - q;
    if (p < 8) return null;
    if (hasPre && p <= ob[0].end + 1) return null;
    if (hasPost && oldEnd >= ob[n - 1].start - 1) return null;
    if (this.risky(oldText.slice(Math.max(0, p - 12), oldEnd + 12)) || this.risky(text.slice(Math.max(0, p - 12), text.length - q + 12))) return null;

    // Window start: the block before the first one the change touches, at a line start.
    let a = lo;
    while (a < hi && ob[a].end < p) a++;
    let ws = Math.max(lo, a - 1);
    const lineStartOf = (x: number) => {
      let i = x;
      while (i > 0 && (oldText.charCodeAt(i - 1) === 32 || oldText.charCodeAt(i - 1) === 9)) i--;
      return i === 0 || oldText.charCodeAt(i - 1) === 10 ? i : -1;
    };
    while (ws > lo && lineStartOf(ob[ws].start) === -1) ws--;
    const bodyStart = hasPre ? ob[0].end : 0;
    const wStart = ws === lo ? bodyStart : lineStartOf(ob[ws].start);
    if (wStart > p) return null;

    // Window end: a block wholly after the change, preceded by a blank line, whose split must line up.
    const bodyEndNew = hasPost ? ob[n - 1].start + delta : text.length;
    const blank = (i: number) => /\n[ \t]*\r?\n/.test(oldText.slice(ob[i - 1].end, ob[i].start));
    let c = a;
    while (c < hi && (ob[c].start <= oldEnd + 1 || !blank(c))) c++;
    for (let attempt = 0; attempt < 4; attempt++) {
      const wEnd = c < hi ? ob[c].end + delta : bodyEndNew;
      const spans = this.codec.splitRange(text, wStart, wEnd, this.env);
      if (c < hi) {
        const last = spans[spans.length - 1];
        if (!last || last.start !== ob[c].start + delta || last.end !== ob[c].end + delta) {
          c = Math.min(hi, c + (2 << attempt));
          while (c < hi && !blank(c)) c++;
          continue;
        }
      }
      const outKids = kids.slice(0, ws);
      const outBlocks = ob.slice(0, ws);
      for (const sp of spans) {
        outKids.push(this.node(text.slice(sp.start, sp.end), sp.kind));
        outBlocks.push({ start: sp.start, end: sp.end });
      }
      for (let k = c < hi ? c + 1 : hi; k < n; k++) {
        outKids.push(kids[k]);
        outBlocks.push({ start: ob[k].start + delta, end: ob[k].end + delta });
      }
      if (outKids.length === (hasPre ? 1 : 0) + (hasPost ? 1 : 0)) return null;
      return { doc: schema.nodes.doc.create(null, outKids), blocks: outBlocks };
    }
    return null;
  }

  private load(text: string) {
    this.text = text;
    this.context = this.readCtx(text);
    const l = this.build(text);
    this.doc = l.doc;
    this.blocks = l.blocks;
    this.starts = null;
  }

  syncFromText(text: string): SyncResult {
    if (text === this.text) return { changed: false, doc: this.doc, from: 0, toOld: 0, toNew: 0 };
    const old = this.doc;
    this.prevText = this.text;
    this.text = text;
    this.context = this.readCtx(text);
    const l = (!this.ctxChanged && this.incremental(this.prevText, text)) || this.build(text);
    this.prevText = text;
    this.doc = l.doc;
    this.blocks = l.blocks;
    this.starts = null;
    this.pending = null;
    const from = l.doc.content.findDiffStart(old.content);
    if (from === null) {
      // Same content; keep the old doc object so the view need not change.
      this.doc = old;
      return { changed: false, doc: old, from: 0, toOld: 0, toNew: 0 };
    }
    const end = old.content.findDiffEnd(l.doc.content)!;
    let toOld = end.a;
    let toNew = end.b;
    const overlap = from - Math.min(toOld, toNew);
    if (overlap > 0) {
      toOld += overlap;
      toNew += overlap;
    }
    return { changed: true, doc: l.doc, from, toOld, toNew };
  }

  // -------------------------------------------------------------------------
  // Outbound: doc → text edits

  private ser(node: PMNode): string | null {
    if (isVirtual(node)) return null;
    const s = this.codec.serialize(node, { eol: this.context.eol });
    return testHooks.corruptRegion ? testHooks.corruptRegion(s) : s;
  }

  /** Splits the changed window into runs of children that are not reused by identity. */
  private runs(oldKids: PMNode[], newKids: PMNode[]): Run[] {
    const n = oldKids.length;
    const m = newKids.length;
    let a = 0;
    while (a < n && a < m && oldKids[a] === newKids[a]) a++;
    let b = 0;
    while (b < n - a && b < m - a && oldKids[n - 1 - b] === newKids[m - 1 - b]) b++;
    const oEnd = n - b;
    const nEnd = m - b;
    const where = new Map<PMNode, number[]>();
    for (let i = a; i < oEnd; i++) {
      const list = where.get(oldKids[i]);
      if (list) list.push(i);
      else where.set(oldKids[i], [i]);
    }
    const runs: Run[] = [];
    let i = a;
    let j = a;
    while (i < oEnd || j < nEnd) {
      if (i < oEnd && j < nEnd && oldKids[i] === newKids[j]) {
        i++;
        j++;
        continue;
      }
      // Find the next new child that matches an old child at or after i.
      let jn = j;
      let im = -1;
      for (; jn < nEnd; jn++) {
        const list = where.get(newKids[jn]);
        const hit = list?.find((x) => x >= i);
        if (hit !== undefined) {
          im = hit;
          break;
        }
      }
      if (im === -1) im = oEnd;
      if (im - i === jn - j && im - i > 1) {
        // Same count on both sides: one run per child, so edits stay small.
        for (let k = 0; k < im - i; k++) runs.push({ i0: i + k, i1: i + k + 1, j0: j + k, j1: j + k + 1 });
      } else runs.push({ i0: i, i1: im, j0: j, j1: jn });
      i = im;
      j = jn;
    }
    return runs;
  }

  private realBefore(kids: PMNode[], blocks: Block[], i: number): number {
    for (let k = i - 1; k >= 0; k--) if (blocks[k].end > blocks[k].start || !isVirtual(kids[k])) return k;
    return -1;
  }

  private realAfter(kids: PMNode[], blocks: Block[], i: number): number {
    for (let k = i; k < kids.length; k++) if (blocks[k].end > blocks[k].start || !isVirtual(kids[k])) return k;
    return -1;
  }

  /** One raw (untrimmed) edit for a run; `pad` adds blank lines around the region. */
  private editFor(run: Run, oldKids: PMNode[], newKids: PMNode[], pad: boolean): RawEdit | null {
    const text = this.text;
    const eol = this.context.eol;
    const sep = eol + eol;
    const real: { j: number; s: string }[] = [];
    for (let j = run.j0; j < run.j1; j++) {
      const s = this.ser(newKids[j]);
      if (s !== null) real.push({ j, s });
    }
    const oldReal: number[] = [];
    for (let i = run.i0; i < run.i1; i++) if (!isVirtual(oldKids[i])) oldReal.push(i);
    const kids: [number, number, number][] = [];
    const join = (gaps: string[]) => {
      let out = "";
      real.forEach((r, k) => {
        if (k > 0) out += k - 1 < gaps.length ? gaps[k - 1] : sep;
        kids.push([r.j, out.length, out.length + r.s.length]);
        out += r.s;
      });
      return out;
    };
    const prev = this.realBefore(oldKids, this.blocks, run.i0);
    const next = this.realAfter(oldKids, this.blocks, run.i1);
    if (oldReal.length > 0) {
      const first = this.blocks[oldReal[0]];
      const last = this.blocks[oldReal[oldReal.length - 1]];
      if (real.length === 0) {
        if (next !== -1) return { offset: first.start, deleteLength: this.blocks[next].start - first.start, insert: "", kids, run };
        if (prev !== -1) {
          const s = this.blocks[prev].end;
          return { offset: s, deleteLength: last.end - s, insert: "", kids, run };
        }
        return { offset: first.start, deleteLength: last.end - first.start, insert: "", kids, run };
      }
      const gaps: string[] = [];
      for (let k = 1; k < oldReal.length; k++) gaps.push(text.slice(this.blocks[oldReal[k - 1]].end, this.blocks[oldReal[k]].start));
      let body = join(gaps);
      let lead = "";
      if (pad) {
        if (prev !== -1 && !hasBlankLine(text.slice(this.blocks[prev].end, first.start))) lead = eol;
        if (next !== -1 && !hasBlankLine(text.slice(last.end, this.blocks[next].start))) body += eol;
        for (const k of kids) {
          k[1] += lead.length;
          k[2] += lead.length;
        }
      }
      return { offset: first.start, deleteLength: last.end - first.start, insert: lead + body, kids, run };
    }
    if (real.length === 0) return null;
    const body = join([]);
    if (prev !== -1) {
      const at = this.blocks[prev].end;
      const gapAfter = next !== -1 ? text.slice(at, this.blocks[next].start) : "";
      const tail = next !== -1 && (pad || !hasBlankLine(gapAfter)) ? eol : "";
      for (const k of kids) {
        k[1] += sep.length;
        k[2] += sep.length;
      }
      return { offset: at, deleteLength: 0, insert: sep + body + tail, kids, run };
    }
    if (next !== -1) return { offset: this.blocks[next].start, deleteLength: 0, insert: body + sep, kids, run };
    return { offset: 0, deleteLength: 0, insert: body, kids, run };
  }

  /** Applies raw edits; returns the new text and new block positions for every new child. */
  private layout(edits: RawEdit[], oldKids: PMNode[], newKids: PMNode[], runs: Run[]): { text: string; blocks: Block[] } {
    let out = "";
    let pos = 0;
    const deltas: { at: number; d: number }[] = [];
    let d = 0;
    const kidPos = new Map<number, Block>();
    for (const e of edits) {
      out += this.text.slice(pos, e.offset);
      const base = out.length;
      out += e.insert;
      for (const [j, s, t] of e.kids) kidPos.set(j, { start: base + s, end: base + t });
      pos = e.offset + e.deleteLength;
      d += e.insert.length - e.deleteLength;
      deltas.push({ at: pos, d });
    }
    out += this.text.slice(pos);
    // A block start at an insertion point moves with it; a block end there does not.
    const shift = (x: number, isEnd: boolean) => {
      let r = 0;
      for (const dl of deltas) if (isEnd ? dl.at < x : dl.at <= x) r = dl.d;
      return x + r;
    };
    // Aligned (reused) children: new index → old index.
    const aligned = new Map<number, number>();
    let i = 0;
    let j = 0;
    for (const run of [...runs, { i0: oldKids.length, i1: oldKids.length, j0: newKids.length, j1: newKids.length }]) {
      while (i < run.i0 && j < run.j0) aligned.set(j++, i++);
      i = run.i1;
      j = run.j1;
    }
    const blocks: Block[] = [];
    for (let k = 0; k < newKids.length; k++) {
      const kp = kidPos.get(k);
      if (kp) blocks.push(kp);
      else if (aligned.has(k) && !isVirtual(newKids[k])) {
        const ob = this.blocks[aligned.get(k)!];
        const start = shift(ob.start, false);
        blocks.push({ start, end: Math.max(start, shift(ob.end, ob.end > ob.start)) });
      } else {
        const at = k > 0 ? blocks[k - 1].end : 0;
        blocks.push({ start: at, end: at });
      }
    }
    // Virtual children that sit before real ones: keep positions monotonic.
    for (let k = blocks.length - 2; k >= 0; k--) {
      if (blocks[k].start === blocks[k].end && blocks[k].start > blocks[k + 1].start) blocks[k] = { start: blocks[k + 1].start, end: blocks[k + 1].start };
    }
    return { text: out, blocks };
  }

  /** I3: re-split the new text around each run and compare with the new doc. */
  private check(newText: string, newKids: PMNode[], blocks: Block[], runs: Run[]): string | null {
    let full: BlockSpan[] | null = null;
    const fileSpans = () => {
      if (full) return full;
      const l = this.codec.splitFile(newText, {});
      full = [];
      if (l.pre) full.push({ start: l.pre[0], end: l.pre[1], kind: "preamble" });
      full.push(...l.body);
      if (l.post) full.push({ start: l.post[0], end: l.post[1], kind: "postamble" });
      return full;
    };
    const real = (k: number) => blocks[k].end > blocks[k].start || !isVirtual(newKids[k]);
    for (let k = 0; k < newKids.length; k++) {
      if (!real(k)) continue;
      const lo = k > 0 ? blocks[k - 1].end : 0;
      if (!isWs(newText.slice(lo, blocks[k].start))) return "non-whitespace gap";
    }
    for (const run of runs) {
      let a = run.j0 - 1;
      while (a >= 0 && !real(a)) a--;
      let b = run.j1;
      while (b < newKids.length && !real(b)) b++;
      const expected: number[] = [];
      for (let k = Math.max(a, 0); k <= Math.min(b, newKids.length - 1); k++) if (real(k)) expected.push(k);
      if (expected.length === 0) continue;
      const winStart = blocks[expected[0]].start;
      const winEnd = blocks[expected[expected.length - 1]].end;
      const touchesFile = expected.some((k) => newKids[k].type === schema.nodes.preamble || newKids[k].type === schema.nodes.postamble);
      const suspicious = /\\(begin|end)\s*\{document\}|^---/m.test(newText.slice(winStart, winEnd));
      let spans: BlockSpan[];
      if (touchesFile || suspicious) spans = fileSpans().filter((s) => s.end > winStart && s.start < winEnd);
      else spans = this.codec.splitRange(newText, winStart, winEnd, this.env);
      if (spans.length !== expected.length) return `run splits into ${spans.length} blocks, expected ${expected.length}`;
      for (let x = 0; x < spans.length; x++) {
        const k = expected[x];
        const sp = spans[x];
        // A block's own trailing spaces (a space just typed at the end of a
        // paragraph) fall outside its re-split span; they mean nothing to TeX
        // or Markdown, so the block still counts as in place.
        const trailingSpaces = sp.end < blocks[k].end && /^[ \t]+$/.test(newText.slice(sp.end, blocks[k].end));
        if (sp.start !== blocks[k].start || (sp.end !== blocks[k].end && !trailingSpaces)) return `block ${k} moved`;
        if (k < run.j0 || k >= run.j1) continue;
        const node = newKids[k];
        const src = newText.slice(sp.start, sp.end);
        let parsed: PMNode;
        if (sp.kind === "preamble" || sp.kind === "postamble") parsed = schema.nodes[sp.kind].create({ src });
        else parsed = this.codec.build(src, sp.kind, this.context, this.env);
        if (!semEq(parsed, node)) return `block ${k} would parse differently`;
      }
    }
    return null;
  }

  plan(newDoc: PMNode): PlanResult {
    const oldKids: PMNode[] = [];
    this.doc.forEach((n) => oldKids.push(n));
    const newKids: PMNode[] = [];
    newDoc.forEach((n) => newKids.push(n));
    const runs = this.runs(oldKids, newKids);
    if (runs.length === 0) {
      this.pending = { doc: newDoc, text: this.text, blocks: this.blocks };
      return { ok: true, edits: [], newText: this.text };
    }
    let reason = "";
    for (const pad of [false, true]) {
      const raw: RawEdit[] = [];
      for (const run of runs) {
        const e = this.editFor(run, oldKids, newKids, pad);
        if (e) raw.push(e);
      }
      raw.sort((x, y) => x.offset - y.offset);
      for (let k = 1; k < raw.length; k++) {
        if (raw[k].offset < raw[k - 1].offset + raw[k - 1].deleteLength) return { ok: false, reason: "overlapping edits" };
      }
      const { text: newText, blocks } = this.layout(raw, oldKids, newKids, runs);
      const fail = this.check(newText, newKids, blocks, runs);
      if (fail === null) {
        const edits: TextEdit[] = [];
        for (const e of raw) {
          const t = trimEdit(this.text, e.offset, e.deleteLength, e.insert);
          if (t) edits.push(t);
        }
        this.pending = { doc: newDoc, text: newText, blocks };
        return { ok: true, edits, newText };
      }
      reason = fail;
    }
    return { ok: false, reason };
  }

  commit(newDoc: PMNode, newText: string): void {
    let blocks: Block[] | null = null;
    if (this.pending && this.pending.doc === newDoc && this.pending.text === newText) blocks = this.pending.blocks;
    else blocks = this.tile(newDoc, newText);
    this.pending = null;
    if (!blocks) {
      console.warn("Visual: commit could not tile the new text; reloading");
      this.load(newText);
      return;
    }
    this.doc = newDoc;
    this.text = newText;
    this.blocks = blocks;
    this.starts = null;
    const ctx = this.readCtx(newText);
    this.context = ctx;
    newDoc.forEach((child, _o, i) => {
      if (isVirtual(child)) return;
      const src = newText.slice(blocks![i].start, blocks![i].end);
      if (!SRC.has(child)) {
        SRC.set(child, src);
        this.registerDescendants(child);
      }
      if (child.type !== schema.nodes.preamble && child.type !== schema.nodes.postamble) this.cache.set(this.key(src), child);
    });
    if (import.meta.env?.DEV) {
      const v = this.verify();
      if (!v.ok) console.error("Visual: tiling broken after commit at", v.offset);
    }
  }

  private registerDescendants(node: PMNode) {
    node.descendants((n) => {
      if (n.isText) return false;
      if (!SRC.has(n) && !isVirtual(n)) SRC.set(n, this.codec.serialize(n, { eol: this.context.eol }));
      return !n.isInline;
    });
  }

  /** Lays children over text greedily; null if they do not tile it. */
  private tile(doc: PMNode, text: string): Block[] | null {
    const blocks: Block[] = [];
    let pos = 0;
    let ok = true;
    doc.forEach((child) => {
      if (!ok) return;
      if (isVirtual(child)) {
        blocks.push({ start: pos, end: pos });
        return;
      }
      const src = this.codec.serialize(child, { eol: this.context.eol });
      let s = pos;
      while (s < text.length && /\s/.test(text[s]) && !text.startsWith(src, s)) s++;
      if (!text.startsWith(src, s)) ok = false;
      else {
        blocks.push({ start: s, end: s + src.length });
        pos = s + src.length;
      }
    });
    if (!ok || !isWs(text.slice(pos))) return null;
    return blocks;
  }

  // -------------------------------------------------------------------------
  // Positions

  private childStarts(): number[] {
    if (this.starts) return this.starts;
    const s: number[] = [];
    this.doc.forEach((_c, offset) => s.push(offset));
    this.starts = s;
    return s;
  }

  private mapOf(node: PMNode): SourceMap {
    let m = this.maps.get(node);
    if (!m) {
      m = this.codec.serializeWithMap(node, this.context.eol);
      this.maps.set(node, m);
    }
    return m;
  }

  private childAt(pos: number): number {
    const s = this.childStarts();
    let lo = 0;
    let hi = s.length - 1;
    let best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (s[mid] <= pos) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return best;
  }

  pmToSrc(pos: number): number {
    if (this.doc.childCount === 0) return 0;
    const p = Math.max(0, Math.min(pos, this.doc.content.size));
    const i = this.childAt(p);
    const child = this.doc.child(i);
    const local = p - this.childStarts()[i];
    const b = this.blocks[i];
    if (local >= child.nodeSize) return b.end;
    if (child.isAtom) return local === 0 ? b.start : b.end;
    return b.start + Math.min(mapPmToSrc(this.mapOf(child), local), b.end - b.start);
  }

  srcToPm(offset: number): number {
    const n = this.blocks.length;
    if (n === 0) return 0;
    let lo = 0;
    let hi = n - 1;
    let i = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.blocks[mid].start <= offset) {
        i = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    let off = offset;
    const b = this.blocks[i];
    if (off > b.end && i + 1 < n) {
      // In a gap: go to whichever block edge is nearer.
      const nb = this.blocks[i + 1];
      if (nb.start - off < off - b.end) {
        i++;
        off = nb.start;
      } else off = b.end;
    }
    const blk = this.blocks[i];
    off = Math.max(blk.start, Math.min(off, blk.end));
    const child = this.doc.child(i);
    const start = this.childStarts()[i];
    if (child.isAtom) return start;
    const local = mapSrcToPm(this.mapOf(child), off - blk.start);
    return this.enterText(start + Math.min(local, child.nodeSize - 1));
  }

  /** Moves a position into the nearest text position at or after it, stopping before atoms. */
  private enterText(pos: number): number {
    let p = pos;
    for (let guard = 0; guard < 64; guard++) {
      const $p = this.doc.resolve(p);
      if ($p.parent.inlineContent) return p;
      const after = $p.nodeAfter;
      if (!after || after.isAtom || after.isLeaf) return p;
      p += 1;
    }
    return p;
  }

  topBlockAt(pos: number): { index: number; start: number; end: number } {
    if (this.doc.childCount === 0) return { index: 0, start: 0, end: 0 };
    const p = Math.max(0, Math.min(pos, this.doc.content.size - 1));
    const i = this.childAt(p);
    const start = this.childStarts()[i];
    return { index: i, start, end: start + this.doc.child(i).nodeSize };
  }

  // -------------------------------------------------------------------------
  // Snippets

  serializeSlice(slice: Slice): string {
    const nodes: PMNode[] = [];
    slice.content.forEach((n) => nodes.push(n));
    if (nodes.length === 0) return "";
    if (nodes.every((n) => n.isInline)) {
      return this.codec.serialize(schema.nodes.paragraph.create(null, nodes), { eol: this.context.eol });
    }
    const eol = this.context.eol;
    return nodes
      .map((n) => (n.isInline ? this.codec.serialize(n) : this.codec.serialize(n, { eol })))
      .filter((s) => s !== "")
      .join(eol + eol);
  }

  parseSnippet(src: string): Fragment {
    try {
      return Fragment.from(this.codec.parseBlocks(src, this.context, this.env).nodes);
    } catch {
      return Fragment.from(register(schema.nodes.raw_block.create({ src, label: "Source" }), src));
    }
  }

  parseInlineSnippet(src: string): Fragment {
    try {
      const nodes = this.codec.parseInline(src, this.env);
      if (nodes) return Fragment.from(nodes);
    } catch {
      // fall through to a raw chip
    }
    return src === "" ? Fragment.empty : Fragment.from(register(schema.nodes.raw_inline.create({ src, label: "Source" }), src));
  }

  verify(): { ok: true } | { ok: false; offset: number; expected: string; actual: string } {
    let out = "";
    let pos = 0;
    let bad = false;
    this.doc.forEach((child, _o, i) => {
      const b = this.blocks[i];
      const gap = this.text.slice(pos, b.start);
      if (!isWs(gap)) bad = true;
      out += gap;
      out += isVirtual(child) ? "" : this.codec.serialize(child, { useSrc: false, eol: this.context.eol });
      pos = b.end;
    });
    out += this.text.slice(pos);
    if (!bad && out === this.text) return { ok: true };
    let k = 0;
    while (k < out.length && k < this.text.length && out[k] === this.text[k]) k++;
    return { ok: false, offset: k, expected: this.text.slice(k, k + 40), actual: out.slice(k, k + 40) };
  }
}

export function createSession(dialect: Dialect, text: string, opts?: { context?: Partial<DocContext> }): VisualSession {
  return new Session(dialect, text, opts?.context ?? {});
}
