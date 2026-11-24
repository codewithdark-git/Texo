// Visual mode: the file as a document you edit in place. One ProseMirror view
// for the pane; switching files swaps its state. Every change is planned by
// the core and written into the file's Monaco model, which stays the only
// copy of the document (see view/binding.ts).

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { EditorState, TextSelection, type Plugin } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { gapCursor } from "prosemirror-gapcursor";
import "prosemirror-view/style/prosemirror.css";
import "prosemirror-gapcursor/style/gapcursor.css";
import { AlertTriangle, Code2, Loader2, X } from "lucide-react";
import { dialectFor, helpersFor, schema } from "./core";
import { Binding } from "./view/binding";
import { normalizeTransaction, type VisualEnv } from "./view/commands";
import { openSession, type SessionEntry } from "./view/sessions";
import { buildKeymap } from "./view/keymap";
import { inputRulesPlugin } from "./view/inputRules";
import { findKey, findPlugin } from "./view/find";
import { FindBar } from "./view/FindBar";
import { protectPlugin } from "./view/protect";
import { issuesPlugin, SET_ISSUES } from "./view/issues";
import { clipboardTextParser, handlePaste, transformPasted } from "./view/clipboard";
import { Toolbar } from "./view/Toolbar";
import { PopoverHost, closePopover } from "./view/Popovers";
import { GridDialog } from "./view/GridDialog";
import { openLink } from "./view/nodeviews/ChipViews";
import { buildMarkViews, buildNodeViews } from "./view/nodeviews";
import { expandPreamble } from "./view/nodeviews/PreambleView";
import { PageSetupDialog } from "./view/PageSetupDialog";
import { DEFAULT_SETUP, pageStyle, readPageSetup } from "./view/pageSetup";
import type { GetEnv } from "./view/commands";
import { getModel, useWorkspace } from "../workspace/store";
import { setActiveEditor, switchMode, takeVisualStart, type ActiveEditor } from "../workspace/editorBridge";
import { zoomBy } from "../workspace/EditorPane";
import { useCompile } from "../workspace/compileStore";
import { DEFAULT_EDITOR_PREFS, getEditorPrefs, onEditorPrefs } from "../lib/editorPrefs";
import { api } from "../lib/api";
import { toast } from "../ui";
import "./view/visual.css";

const TIP_KEY = "texo.visualTip";

/** The preamble a file's page follows: its own, else the main document's (for \input files). */
function usePagePreamble(path: string, doc: EditorState["doc"] | undefined): string | null {
  const first = doc?.firstChild;
  const own = first?.type === schema.nodes.preamble ? (first.attrs.src as string) : null;
  const [main, setMain] = useState<string | null>(null);
  useEffect(() => {
    setMain(null);
    if (!/\.(tex|ltx)$/i.test(path)) return;
    const ws = useWorkspace.getState();
    const mainDoc = ws.project?.mainDocument;
    if (!mainDoc || mainDoc === path || !ws.project) return;
    let cancelled = false;
    const text = getModel(mainDoc)?.getValue();
    const take = (t: string | undefined) => {
      if (cancelled || !t) return;
      const at = t.indexOf("\\begin{document}");
      setMain(at === -1 ? null : t.slice(0, at));
    };
    if (text !== undefined) take(text);
    else
      void api
        .readFile(ws.project.path, mainDoc)
        .then((c) => take(c.kind === "text" ? c.content : undefined))
        .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [path]);
  return own ?? main;
}

function readTipSeen(): boolean {
  try {
    return localStorage.getItem(TIP_KEY) === "1";
  } catch {
    return true;
  }
}

export default function VisualPane({ path }: { path: string }) {
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const mount = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const envRef = useRef<VisualEnv | null>(null);
  const entryRef = useRef<SessionEntry | null>(null);
  const [env, setEnv] = useState<VisualEnv | null>(null);
  const [pmState, setPmState] = useState<EditorState | null>(null);
  const [failed, setFailed] = useState(false);
  const [width, setWidth] = useState(1200);
  const [find, setFind] = useState<{ open: boolean; replace: boolean; key: number }>({ open: false, replace: false, key: 0 });
  const [showComments, setShowComments] = useState(() => getEditorPrefs().visualShowComments);
  const [tipSeen, setTipSeen] = useState(readTipSeen);
  const [rawRatio, setRawRatio] = useState(0);
  const [zoom, setZoom] = useState(() => getEditorPrefs().fontSize / DEFAULT_EDITOR_PREFS.fontSize);

  // The page follows the document's paper, margins, font and spacing.
  const preamble = usePagePreamble(path, pmState?.doc);
  const setup = useMemo(() => (preamble === null ? DEFAULT_SETUP : readPageSetup(preamble).settings), [preamble]);
  const page = useMemo(() => pageStyle(setup, width, zoom) as CSSProperties, [setup, width, zoom]);

  const getEnv: GetEnv = () => envRef.current;

  // One view for the pane's lifetime.
  useEffect(() => {
    const view = new EditorView(mount.current!, {
      state: EditorState.create({ schema }),
      editable: () => envRef.current !== null,
      dispatchTransaction: (tr) => {
        const e = envRef.current;
        if (e) e.binding.dispatch(normalizeTransaction(e, tr));
        else if (!tr.docChanged) view.updateState(view.state.apply(tr));
      },
      nodeViews: buildNodeViews(getEnv),
      markViews: buildMarkViews(),
      clipboardTextSerializer: (slice) => envRef.current?.session.serializeSlice(slice) ?? "",
      clipboardTextParser: clipboardTextParser(getEnv),
      transformPasted: transformPasted(getEnv),
      handlePaste: handlePaste(toast),
      handleDOMEvents: {
        click: (_v, event) => {
          const a = (event.target as HTMLElement | null)?.closest?.("a[data-href]");
          if (a && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            void openLink(a.getAttribute("data-href") ?? "", toast);
            return true;
          }
          return false;
        },
      },
      attributes: { spellcheck: "true", class: "visual-doc", "aria-label": "Document" },
    });
    viewRef.current = view;
    return () => {
      // A maths edit in progress is kept, as clicking away keeps it (and
      // while the view can still take it: this cleanup runs first on unmount).
      closePopover({ commit: true });
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // Show the file: attach its session to the view; detach when it goes away.
  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    const view = viewRef.current;
    if (!view) return;
    // The scroll position, kept as it changes: by the time this effect is
    // cleaned up on unmount the scroller is gone. Tracking starts once the
    // saved position is restored, so clamping while the new doc draws is ignored.
    const scrollEl = scroller.current;
    let tracking = false;
    const onScroll = () => {
      const entry = entryRef.current;
      if (tracking && entry && scrollEl) entry.scrollTop = scrollEl.scrollTop;
    };
    scrollEl?.addEventListener("scroll", onScroll, { passive: true });
    void openSession(path).then((entry) => {
      if (cancelled) return;
      const model = getModel(path);
      const dialect = dialectFor(path);
      if (!entry || !model || !dialect) {
        setFailed(true);
        return;
      }
      const plugins: Plugin[] = [
        inputRulesPlugin(getEnv),
        ...buildKeymap(getEnv, { openFind: (replace) => setFind((f) => ({ open: true, replace, key: f.key + 1 })) }),
        gapCursor(),
        findPlugin(),
        protectPlugin(),
        issuesPlugin(getEnv),
      ];
      const state = entry.state ? entry.state.reconfigure({ plugins }) : EditorState.create({ doc: entry.session.doc, plugins });
      // Node views read the env while the state is first drawn; the binding joins right after.
      const next: VisualEnv = {
        path,
        dialect,
        session: entry.session,
        binding: null as unknown as Binding,
        helpers: helpersFor(dialect),
        view,
        toast,
        openInCode: (offset) => switchMode(path, "code", offset),
      };
      envRef.current = next;
      view.updateState(state);
      const binding = new Binding({
        session: entry.session,
        model,
        view,
        selMap: entry.selMap,
        host: {
          toast: (t) => toast(t, "info"),
          setCursor: (c) => useWorkspace.getState().setCursor(c),
          schedule: (fn) => requestAnimationFrame(fn),
          dev: import.meta.env.DEV,
          onChange: setPmState,
        },
      });
      next.binding = binding;
      entry.attached = true;
      entry.stale = false;
      entryRef.current = entry;
      setEnv(next);
      setRawRatio(entry.session.rawRatio);
      setPmState(view.state);
      view.setProps({}); // re-check editable

      const issues = useCompile.getState().result?.issues ?? [];
      view.dispatch(view.state.tr.setMeta(SET_ISSUES, issues));

      // Where to put the cursor: where it was in Code mode, else where it was here.
      const start = takeVisualStart(path);
      requestAnimationFrame(() => {
        if (envRef.current !== next) return;
        if (start !== undefined) {
          binding.selectSource(start);
          view.dispatch(view.state.tr.scrollIntoView());
        } else if (scrollEl) scrollEl.scrollTop = entry.scrollTop;
        tracking = true;
        onScroll();
        view.focus();
      });

      const active: ActiveEditor = {
        path,
        revealLine: (line) => revealLine(next, line),
        getLine: () => model.getPositionAt(binding.sourceOffset()).lineNumber,
        focus: () => view.focus(),
        zoom: zoomBy,
        sourceOffset: () => binding.sourceOffset(),
      };
      setActiveEditor(active);
    });

    return () => {
      cancelled = true;
      closePopover({ commit: true });
      scrollEl?.removeEventListener("scroll", onScroll);
      const e = envRef.current;
      const entry = entryRef.current;
      if (e && entry && e.path === path) {
        entry.state = view.state;
        entry.attached = false;
        e.binding?.dispose();
      }
      envRef.current = null;
      entryRef.current = null;
      setEnv(null);
      setActiveEditor(null);
    };
  }, [path]);

  // Compile issues for this file, as marks in the margin.
  useEffect(
    () =>
      useCompile.subscribe((s, prev) => {
        if (s.result === prev.result) return;
        const view = viewRef.current;
        if (view && envRef.current) view.dispatch(view.state.tr.setMeta(SET_ISSUES, s.result?.issues ?? []));
      }),
    [],
  );

  useEffect(
    () =>
      onEditorPrefs((p) => {
        setShowComments(p.visualShowComments);
        setZoom(p.fontSize / DEFAULT_EDITOR_PREFS.fontSize);
      }),
    [],
  );

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const dismissTip = () => {
    setTipSeen(true);
    try {
      localStorage.setItem(TIP_KEY, "1");
    } catch {
      // Shown again next time; harmless.
    }
  };

  const findState = pmState ? findKey.getState(pmState) : undefined;

  return (
    <div ref={root} className={`visual-pane relative flex min-h-0 min-w-0 flex-1 flex-col ${showComments ? "" : "v-hide-comments"}`}>
      {env && pmState && <Toolbar env={env} state={pmState} width={width} />}
      {env && rawRatio > 0.4 && (
        <div className="flex items-center gap-2 border-b border-border bg-amber-500/10 px-4 py-1.5 text-xs">
          <AlertTriangle size={13} className="shrink-0 text-amber-500" />
          <span>Parts of this file use LaTeX that Visual mode can't edit directly. They are shown as in the PDF and kept exactly as written; double-click one to edit it.</span>
        </div>
      )}
      {env && !tipSeen && (
        <div className="flex items-center gap-2 border-b border-border bg-accent/10 px-4 py-1.5 text-xs">
          <span className="flex-1">
            Type on the page as in a word processor: what you change here is saved as ordinary {env.dialect === "latex" ? "LaTeX" : "Markdown"}.
            {env.dialect === "latex" ? " Page setup is at the page's top right." : ""} Type $ for maths, / for more; Ctrl+Shift+E switches to Code.
          </span>
          <button type="button" aria-label="Dismiss" onClick={dismissTip} className="rounded p-0.5 text-muted hover:text-text">
            <X size={13} />
          </button>
        </div>
      )}
      <div ref={scroller} className="visual-scroll v-canvas min-h-0 flex-1 overflow-auto">
        {failed ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center text-sm text-muted">
            <p>Visual mode couldn't open this file.</p>
            <button
              type="button"
              onClick={() => switchMode(path, "code")}
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-1.5 text-text"
            >
              <Code2 size={14} /> Open in Code
            </button>
          </div>
        ) : (
          <div
            className={`v-page ${setup.columns === 2 ? "v-cols-2" : ""} ${setup.parStyle === "space" ? "v-par-space" : "v-par-indent"} ${env?.dialect === "markdown" ? "v-markdown" : ""}`}
            style={page}
            role="document"
            aria-label="Page"
          >
            <div ref={mount} className={env ? "" : "hidden"} />
            {!env && (
              <div className="flex justify-center py-16 text-neutral-500">
                <Loader2 className="animate-spin" />
              </div>
            )}
          </div>
        )}
      </div>
      {env && find.open && (
        <FindBar
          view={env.view}
          state={findState}
          replace={find.replace}
          focusKey={find.key}
          onClose={() => setFind((f) => ({ ...f, open: false }))}
          toast={toast}
        />
      )}
      <PopoverHost />
      <GridDialog />
      <PageSetupDialog />
    </div>
  );
}

/** Moves to a source line, scrolls it into view and flashes its block. */
function revealLine(env: VisualEnv, line: number) {
  const { view, session, binding } = env;
  const model = binding.model;
  const offset = model.getOffsetAt({ lineNumber: Math.max(1, line), column: 1 });
  const pos = Math.max(0, Math.min(view.state.doc.content.size, session.srcToPm(offset)));
  const block = session.topBlockAt(pos);
  const first = view.state.doc.firstChild;
  if (block.index === 0 && first?.type === schema.nodes.preamble) expandPreamble(view.nodeDOM(0));
  try {
    const sel = TextSelection.near(view.state.doc.resolve(pos));
    view.dispatch(view.state.tr.setSelection(sel).scrollIntoView());
  } catch {
    // An odd position: the scroll below still helps.
  }
  const dom = view.nodeDOM(block.start);
  if (dom instanceof HTMLElement) {
    dom.scrollIntoView({ block: "center" });
    dom.classList.add("v-flash");
    setTimeout(() => dom.classList.remove("v-flash"), 600);
  }
  view.focus();
}
