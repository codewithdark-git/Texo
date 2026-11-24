// A very small DOM for tests that draw Visual mode's node views without a
// browser: elements with attributes, classes, inline styles, children, text
// and events, and just enough of selectors (tags, .classes, [attr]) for the
// views' closest() and querySelector() calls. Nothing is laid out.

type Listener = (e: { type: string; target: FakeNode; preventDefault(): void; stopPropagation(): void }) => void;

export class FakeNode {
  parentNode: FakeElement | null = null;
  childNodes: FakeNode[] = [];
  constructor(
    readonly nodeType: number,
    readonly ownerDocument: FakeDocument,
  ) {}
  get parentElement() {
    return this.parentNode;
  }
  get firstChild() {
    return this.childNodes[0] ?? null;
  }
  get lastChild() {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }
  get nextSibling(): FakeNode | null {
    const sibs = this.parentNode?.childNodes ?? [];
    return sibs[sibs.indexOf(this) + 1] ?? null;
  }
  get isConnected(): boolean {
    let n: FakeNode | null = this;
    while (n.parentNode) n = n.parentNode;
    return n === this.ownerDocument.body;
  }
  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join("");
  }
  set textContent(text: string) {
    this.replaceChildren();
    if (text) this.appendChild(this.ownerDocument.createTextNode(text));
  }
  appendChild<T extends FakeNode>(child: T): T {
    if (child instanceof FakeFragment) {
      for (const c of [...child.childNodes]) this.appendChild(c);
      return child;
    }
    child.remove();
    child.parentNode = this as unknown as FakeElement;
    this.childNodes.push(child);
    return child;
  }
  insertBefore<T extends FakeNode>(child: T, ref: FakeNode | null): T {
    if (!ref) return this.appendChild(child);
    child.remove();
    child.parentNode = this as unknown as FakeElement;
    this.childNodes.splice(this.childNodes.indexOf(ref), 0, child);
    return child;
  }
  removeChild<T extends FakeNode>(child: T): T {
    const i = this.childNodes.indexOf(child);
    if (i >= 0) this.childNodes.splice(i, 1);
    child.parentNode = null;
    return child;
  }
  remove() {
    this.parentNode?.removeChild(this);
  }
  append(...items: (FakeNode | string)[]) {
    for (const it of items) this.appendChild(typeof it === "string" ? this.ownerDocument.createTextNode(it) : it);
  }
  prepend(...items: (FakeNode | string)[]) {
    const first = this.firstChild;
    for (const it of items) this.insertBefore(typeof it === "string" ? this.ownerDocument.createTextNode(it) : it, first);
  }
  replaceChildren(...items: (FakeNode | string)[]) {
    for (const c of [...this.childNodes]) this.removeChild(c);
    this.append(...items);
  }
  replaceWith(...items: (FakeNode | string)[]) {
    const parent = this.parentNode;
    if (!parent) return;
    const next = this.nextSibling;
    this.remove();
    for (const it of items) parent.insertBefore(typeof it === "string" ? this.ownerDocument.createTextNode(it) : it, next);
  }
  contains(other: FakeNode | null): boolean {
    for (let n = other; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
}

export class FakeText extends FakeNode {
  constructor(
    public data: string,
    doc: FakeDocument,
  ) {
    super(3, doc);
  }
  get textContent() {
    return this.data;
  }
  set textContent(t: string) {
    this.data = t;
  }
  get nodeValue() {
    return this.data;
  }
}

export class FakeFragment extends FakeNode {
  constructor(doc: FakeDocument) {
    super(11, doc);
  }
}

class FakeClassList {
  constructor(private el: FakeElement) {}
  private get list() {
    return this.el.className.split(/\s+/).filter(Boolean);
  }
  add(...names: string[]) {
    const l = this.list;
    for (const n of names) if (!l.includes(n)) l.push(n);
    this.el.className = l.join(" ");
  }
  remove(...names: string[]) {
    this.el.className = this.list.filter((n) => !names.includes(n)).join(" ");
  }
  toggle(name: string, force?: boolean) {
    const on = force ?? !this.contains(name);
    if (on) this.add(name);
    else this.remove(name);
    return on;
  }
  contains(name: string) {
    return this.list.includes(name);
  }
}

function makeStyle() {
  const props = new Map<string, string>();
  const style: Record<string, unknown> = {
    setProperty: (k: string, v: string) => void props.set(k, v),
    removeProperty: (k: string) => void props.delete(k),
    getPropertyValue: (k: string) => props.get(k) ?? "",
  };
  return style;
}

/** One simple selector: tag, .class, [attr] or [attr=value], combined (no spaces). */
function matchesOne(el: FakeElement, sel: string): boolean {
  const re = /([a-z0-9*-]+)|\.([\w-]+)|\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]/gi;
  let m: RegExpExecArray | null;
  let any = false;
  while ((m = re.exec(sel))) {
    any = true;
    if (m[1] && m[1] !== "*" && m[1].toUpperCase() !== el.tagName) return false;
    if (m[2] && !el.classList.contains(m[2])) return false;
    if (m[3] && (!el.hasAttribute(m[3]) || (m[4] !== undefined && el.getAttribute(m[3]) !== m[4]))) return false;
  }
  return any;
}

export class FakeElement extends FakeNode {
  readonly tagName: string;
  readonly attributes = new Map<string, string>();
  readonly style = makeStyle();
  readonly dataset: Record<string, string> = {};
  readonly classList = new FakeClassList(this);
  className = "";
  /** What innerHTML was set to (KaTeX, Monaco): kept as markup, never read as page text. */
  html: string | null = null;
  private listeners = new Map<string, Listener[]>();
  [prop: string]: unknown;

  constructor(tag: string, doc: FakeDocument) {
    super(1, doc);
    this.tagName = tag.toUpperCase();
  }
  get nodeName() {
    return this.tagName;
  }
  get children(): FakeElement[] {
    return this.childNodes.filter((c): c is FakeElement => c instanceof FakeElement);
  }
  get childElementCount() {
    return this.children.length;
  }
  set innerHTML(html: string) {
    this.replaceChildren();
    this.html = html;
  }
  get innerHTML() {
    return this.html ?? "";
  }
  setAttribute(k: string, v: string) {
    if (k === "class") this.className = String(v);
    else this.attributes.set(k, String(v));
  }
  getAttribute(k: string) {
    if (k === "class") return this.className;
    return this.attributes.get(k) ?? null;
  }
  hasAttribute(k: string) {
    return k === "class" ? !!this.className : this.attributes.has(k);
  }
  removeAttribute(k: string) {
    if (k === "class") this.className = "";
    else this.attributes.delete(k);
  }
  toggleAttribute(k: string, force?: boolean) {
    const on = force ?? !this.hasAttribute(k);
    if (on) this.setAttribute(k, "");
    else this.removeAttribute(k);
    return on;
  }
  addEventListener(type: string, fn: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(type: string, fn: Listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn));
  }
  dispatchEvent(e: { type: string }) {
    let prevented = false;
    for (const fn of this.listeners.get(e.type) ?? []) fn({ type: e.type, target: this, preventDefault: () => (prevented = true), stopPropagation() {} });
    return !prevented;
  }
  matches(selector: string) {
    return selector.split(",").some((s) => matchesOne(this, s.trim()));
  }
  closest(selector: string): FakeElement | null {
    for (let n: FakeElement | null = this; n; n = n.parentNode) if (n.matches(selector)) return n;
    return null;
  }
  querySelectorAll(selector: string): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (n: FakeElement) => {
      for (const c of n.children) {
        if (c.matches(selector)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
  }
  focus() {
    this.ownerDocument.activeElement = this;
  }
  blur() {}
}

export class FakeDocument {
  body: FakeElement;
  activeElement: FakeElement | null = null;
  constructor() {
    this.body = new FakeElement("body", this);
  }
  createElement(tag: string) {
    return new FakeElement(tag, this);
  }
  createElementNS(_ns: string, tag: string) {
    return new FakeElement(tag, this);
  }
  createTextNode(text: string) {
    return new FakeText(text, this);
  }
  createDocumentFragment() {
    return new FakeFragment(this);
  }
  addEventListener() {}
  removeEventListener() {}
}

/** Puts a fresh fake document (and requestAnimationFrame) on globalThis; returns it. */
export function installFakeDom(): FakeDocument {
  const doc = new FakeDocument();
  const g = globalThis as Record<string, unknown>;
  g.document = doc;
  g.requestAnimationFrame ??= (fn: () => void) => setTimeout(fn, 0);
  g.cancelAnimationFrame ??= (id: number) => clearTimeout(id);
  return doc;
}

/**
 * The text a reader sees in `root`: text nodes, plus the values of inputs
 * and text areas. Elements for which `skip` is true are left out with
 * everything inside them, as is markup set through innerHTML.
 */
export function visibleText(root: FakeNode, skip: (el: FakeElement) => boolean = () => false): string {
  if (root instanceof FakeText) return root.data;
  if (root instanceof FakeElement) {
    if (skip(root) || root.hidden === true || root.hasAttribute("hidden") || root.getAttribute("aria-hidden") === "true") return "";
    if (root.html !== null) return "";
    const own = (root.tagName === "TEXTAREA" || root.tagName === "INPUT") && typeof root.value === "string" ? root.value : "";
    return own + root.childNodes.map((c) => visibleText(c, skip)).join("");
  }
  return root.childNodes.map((c) => visibleText(c, skip)).join("");
}
