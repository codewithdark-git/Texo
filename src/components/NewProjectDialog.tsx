// The template gallery behind "New project…" (Ctrl+N on the dashboard).
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Template } from "../lib/api";
import { uniqueName } from "../lib/projects";
import { useApp } from "../store";
import { Button, Modal } from "./Dialog";

interface TemplateInfo {
  id: Template;
  title: string;
  description: string;
  /** Suggested project name. */
  name: string;
  thumb: ReactNode;
}

/** A sheet of paper for the thumbnails, 48 × 62 units. */
function Page({ children, x = 6, y = 3 }: { children?: ReactNode; x?: number; y?: number }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect width="48" height="62" rx="2" className="fill-white stroke-black/15" />
      {children}
    </g>
  );
}

/** Grey text lines: `[x, y, width]`. */
function Lines({ rows }: { rows: [number, number, number][] }) {
  return (
    <>
      {rows.map(([x, y, w]) => (
        <rect key={`${x}-${y}`} x={x} y={y} width={w} height="2" rx="1" className="fill-black/20" />
      ))}
    </>
  );
}

const body = (top: number, count: number): [number, number, number][] =>
  Array.from({ length: count }, (_, i) => [6, top + i * 5, i % 3 === 2 ? 26 : 36]);

export const TEMPLATES: TemplateInfo[] = [
  {
    id: "blank",
    title: "Blank",
    description: "An empty article with a title.",
    name: "Untitled",
    thumb: (
      <Page>
        <rect x="12" y="8" width="24" height="3" rx="1.5" className="fill-black/35" />
        <Lines rows={[[6, 18, 30]]} />
      </Page>
    ),
  },
  {
    id: "example",
    title: "Example paper",
    description: "Sections, maths, a table and citations.",
    name: "Example paper",
    thumb: (
      <Page>
        <rect x="10" y="6" width="28" height="3" rx="1.5" className="fill-black/35" />
        <Lines rows={body(14, 3)} />
        <text x="24" y="36" textAnchor="middle" className="fill-black/45 text-[7px] italic">
          E = mc²
        </text>
        <Lines rows={body(42, 3)} />
      </Page>
    ),
  },
  {
    id: "report",
    title: "Report",
    description: "Title page, contents, chapters, a figure and a table.",
    name: "Report",
    thumb: (
      <>
        <Page x={12} y={0} />
        <Page x={6} y={4}>
          <rect x="10" y="20" width="28" height="4" rx="2" className="fill-black/40" />
          <Lines rows={[[14, 30, 20], [17, 36, 14]]} />
        </Page>
      </>
    ),
  },
  {
    id: "presentation",
    title: "Presentation",
    description: "Slides with columns, steps and blocks.",
    name: "Presentation",
    thumb: (
      <g transform="translate(2 16)">
        <rect width="56" height="36" rx="2" className="fill-white stroke-black/15" />
        <rect x="0" y="0" width="56" height="9" rx="2" className="fill-accent/70" />
        <Lines rows={[[6, 15, 20], [6, 21, 18], [6, 27, 16]]} />
        <rect x="32" y="14" width="18" height="16" rx="1.5" className="fill-black/10" />
      </g>
    ),
  },
  {
    id: "thesis",
    title: "Thesis",
    description: "Front matter, chapters in separate files and an appendix.",
    name: "Thesis",
    thumb: (
      <>
        <Page x={14} y={0} />
        <Page x={10} y={2} />
        <Page x={6} y={4}>
          <rect x="6" y="8" width="20" height="3" rx="1.5" className="fill-black/35" />
          <Lines rows={[[6, 17, 30], [10, 23, 26], [10, 29, 24], [6, 35, 30], [10, 41, 22]]} />
        </Page>
      </>
    ),
  },
];

export function NewProjectDialog({
  initial = "example",
  onClose,
}: {
  initial?: Template;
  onClose: () => void;
}) {
  const app = useApp();
  const taken = app.projects.map((p) => p.name);
  const suggest = (t: Template) => uniqueName(TEMPLATES.find((x) => x.id === t)!.name, taken);
  const [template, setTemplate] = useState<Template>(initial);
  const [name, setName] = useState(() => suggest(initial));
  // Picking another template updates the name until the user types their own.
  const [edited, setEdited] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.select(), []);

  const pick = (t: Template) => {
    setTemplate(t);
    if (!edited) setName(suggest(t));
  };

  return (
    <Modal title="New project" onClose={onClose} wide>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          onClose();
          void app.createProject(name.trim(), template);
        }}
      >
        <div role="radiogroup" aria-label="Template" className="grid grid-cols-3 gap-3 sm:grid-cols-5">
          {TEMPLATES.map((t) => {
            const selected = t.id === template;
            return (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => pick(t.id)}
                onDoubleClick={() => input.current?.form?.requestSubmit()}
                className={`flex flex-col items-center gap-2 rounded-lg border p-2 text-center transition-colors ${
                  selected ? "border-accent bg-accent/10" : "border-border hover:border-accent/60"
                }`}
              >
                <span className="flex h-20 w-full items-center justify-center rounded-md bg-surface-2">
                  <svg viewBox="0 0 60 68" className="h-16 w-14" aria-hidden="true">
                    {t.thumb}
                  </svg>
                </span>
                <span className="text-sm font-medium">{t.title}</span>
                <span className="text-[11px] leading-snug text-muted">{t.description}</span>
              </button>
            );
          })}
        </div>

        <label htmlFor="new-project-name" className="mt-5 mb-1.5 block text-xs text-muted">
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
        <p className="mt-2 text-xs text-muted">Saved in {app.settings?.projectsRoot}</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!name.trim()}>
            Create
          </Button>
        </div>
      </form>
    </Modal>
  );
}
