// The template gallery behind "New project…" (the New button, Ctrl+N on the
// dashboard, the empty dashboard's cards, and the app menu).
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Check } from "lucide-react";
import type { Template } from "../lib/api";
import { uniqueName } from "../lib/projects";
import {
  CATEGORIES,
  TEMPLATES,
  TemplateThumb,
  lastTemplate,
  rememberTemplate,
  templateInfo,
  type TemplateCategory,
} from "../lib/templates";
import { useApp } from "../store";
import { Button, Modal } from "./Dialog";

type Filter = TemplateCategory | "All";
const FILTERS: Filter[] = ["All", ...CATEGORIES];
const GRID = "grid grid-cols-[repeat(auto-fill,minmax(128px,1fr))] gap-2.5";

export function NewProjectDialog({ initial, onClose }: { initial?: Template; onClose: () => void }) {
  const app = useApp();
  const taken = app.projects.map((p) => p.name);
  const suggest = (t: Template) => uniqueName(templateInfo(t).name, taken);
  const [template, setTemplate] = useState<Template>(() => initial ?? lastTemplate());
  const [name, setName] = useState(() => suggest(template));
  // Picking another template updates the name until the user types their own.
  const [edited, setEdited] = useState(false);
  const [filter, setFilter] = useState<Filter>("All");
  const input = useRef<HTMLInputElement>(null);
  const grid = useRef<HTMLDivElement>(null);

  useEffect(() => {
    input.current?.select();
    grid.current?.querySelector('[aria-checked="true"]')?.scrollIntoView({ block: "nearest" });
  }, []);

  const pick = (t: Template) => {
    setTemplate(t);
    if (!edited) setName(suggest(t));
  };

  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const create = async (t: Template = template) => {
    // A double-clicked card wins over a name suggested for another template.
    const finalName = (edited ? name : suggest(t)).trim();
    if (!finalName || busy) return;
    setBusy(true);
    setFailure(null);
    const ok = await app.createProject(finalName, t);
    setBusy(false);
    if (ok) {
      rememberTemplate(t);
      onClose();
    } else {
      // Stay open with the name kept, so the user can fix it and try again.
      setFailure(useApp.getState().error ?? "The project could not be created.");
      useApp.getState().dismissError();
    }
  };

  const shown = TEMPLATES.filter((t) => filter === "All" || t.category === filter);
  const changeFilter = (f: Filter) => {
    setFilter(f);
    const visible = TEMPLATES.filter((t) => f === "All" || t.category === f);
    if (!visible.some((t) => t.id === template)) pick(visible[0].id);
  };

  // Arrow keys move between cards (and select, like a radio group); Enter creates.
  const onCardKey = (e: KeyboardEvent<HTMLButtonElement>, t: Template) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void create(t);
      return;
    }
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    const home = e.key === "Home" ? 0 : e.key === "End" ? shown.length - 1 : null;
    if (step === undefined && home === null) return;
    e.preventDefault();
    const index = shown.findIndex((x) => x.id === t);
    const next = shown[home ?? (index + step! + shown.length) % shown.length];
    pick(next.id);
    grid.current?.querySelector<HTMLButtonElement>(`[data-template="${next.id}"]`)?.focus();
  };

  const info = templateInfo(template);
  const card = (t: (typeof TEMPLATES)[number]) => {
    const selected = t.id === template;
    return (
      <button
        key={t.id}
        type="button"
        role="radio"
        aria-checked={selected}
        aria-label={`${t.title}: ${t.description}`}
        data-template={t.id}
        tabIndex={selected || (!shown.some((x) => x.id === template) && t === shown[0]) ? 0 : -1}
        onClick={() => pick(t.id)}
        onDoubleClick={() => void create(t.id)}
        onKeyDown={(e) => onCardKey(e, t.id)}
        className={`relative flex flex-col gap-1.5 rounded-lg border p-2 text-left transition-colors ${
          selected ? "border-accent bg-accent/10" : "border-border hover:border-accent/60 hover:bg-surface-2/50"
        }`}
      >
        {selected && (
          <span className="absolute top-1.5 right-1.5 flex size-4 items-center justify-center rounded-full bg-accent text-accent-ink">
            <Check size={11} strokeWidth={3} />
          </span>
        )}
        <span className="flex h-24 w-full items-center justify-center rounded-md bg-surface-2">
          <TemplateThumb template={t.id} className="h-20 w-18" />
        </span>
        <span className="px-0.5 text-sm font-medium">{t.title}</span>
        <span className="line-clamp-2 px-0.5 text-[11px] leading-snug text-muted">{t.description}</span>
      </button>
    );
  };

  return (
    <Modal title="New project" onClose={onClose} extraWide>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <div role="group" aria-label="Show templates" className="mb-3 flex flex-wrap gap-1">
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => changeFilter(f)}
              className={`rounded-full px-3 py-1 text-xs transition-colors ${
                filter === f ? "bg-accent text-accent-ink" : "bg-surface-2 text-muted hover:text-text"
              }`}
            >
              {f}
            </button>
          ))}
        </div>

        <div className="flex flex-col gap-5 md:flex-row">
          <div ref={grid} className="max-h-[40vh] min-w-0 flex-1 space-y-3 overflow-auto p-1 md:max-h-[min(58vh,540px)]">
            {filter === "All" ? (
              CATEGORIES.map((c) => (
                <section key={c}>
                  <h3
                    id={`template-group-${c}`}
                    className="mb-1.5 text-[11px] font-medium tracking-wide text-muted uppercase"
                  >
                    {c}
                  </h3>
                  <div role="radiogroup" aria-labelledby={`template-group-${c}`} className={GRID}>
                    {TEMPLATES.filter((t) => t.category === c).map(card)}
                  </div>
                </section>
              ))
            ) : (
              <div role="radiogroup" aria-label={`${filter} templates`} className={GRID}>
                {shown.map(card)}
              </div>
            )}
          </div>

          <aside className="flex shrink-0 flex-col md:w-64" aria-live="polite">
            <div className="hidden h-44 items-center justify-center rounded-lg border border-border bg-surface-2 md:flex">
              <TemplateThumb template={template} className="h-40 w-36" />
            </div>
            <div className="text-[11px] font-medium tracking-wide text-muted uppercase md:mt-3">{info.category}</div>
            <div className="text-base font-semibold">{info.title}</div>
            <p className="mt-1 text-xs leading-relaxed text-muted">{info.description}</p>
            <div className="mt-3 text-xs font-medium">What you get</div>
            <ul className="mt-1.5 space-y-1 text-xs text-muted">
              {info.features.map((f) => (
                <li key={f} className="flex items-start gap-1.5">
                  <Check size={12} className="mt-0.5 shrink-0 text-accent" />
                  <span>{f}</span>
                </li>
              ))}
            </ul>

            <label htmlFor="new-project-name" className="mt-4 mb-1.5 block text-xs text-muted">
              Project name
            </label>
            <input
              id="new-project-name"
              ref={input}
              autoFocus
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setEdited(true);
              }}
              className="h-9 w-full rounded-lg border border-border bg-bg px-3 outline-none focus:border-accent"
            />
            <p className="mt-1.5 truncate text-[11px] text-muted" title={app.settings?.projectsRoot}>
              Saved in {app.settings?.projectsRoot}
            </p>
            {failure && (
              <p role="alert" className="mt-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-text">
                {failure}
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2 md:mt-auto md:pt-4">
              <Button onClick={onClose}>Cancel</Button>
              <Button type="submit" variant="primary" disabled={!name.trim() || busy}>
                {busy ? "Creating…" : "Create"}
              </Button>
            </div>
          </aside>
        </div>
      </form>
    </Modal>
  );
}
