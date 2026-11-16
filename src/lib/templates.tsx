// The templates a new project can start from: what the gallery shows for
// each one, and a small drawing of its first page. The files themselves are
// created by the Rust side (src-tauri/src/templates.rs).
import type { ReactNode } from "react";
import type { Template } from "./api";

export type TemplateCategory = "Start" | "Papers" | "Teaching" | "Slides" | "Personal";

export const CATEGORIES: TemplateCategory[] = ["Start", "Papers", "Teaching", "Slides", "Personal"];

export interface TemplateInfo {
  id: Template;
  title: string;
  /** One line for the gallery card. */
  description: string;
  category: TemplateCategory;
  /** Suggested project name (made unique against existing projects). */
  name: string;
  /** "What you get": a few short points for the preview. */
  features: string[];
  /** SVG content in a 60 × 68 viewBox; see {@link TemplateThumb}. */
  thumb: ReactNode;
}

// ---------------------------------------------------------------------------
// Drawing helpers. Pages are always white paper with dark ink, like the PDF
// they stand for, so they read the same on light and dark surfaces.

/** A sheet of paper, 48 × 62 units. */
function Page({ children, x = 6, y = 3 }: { children?: ReactNode; x?: number; y?: number }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect width="48" height="62" rx="2" className="fill-white stroke-black/15" strokeWidth="0.75" />
      {children}
    </g>
  );
}

/** Grey text lines: `[x, y, width]`. */
function Lines({ rows, className = "fill-black/20", h = 1.6 }: { rows: [number, number, number][]; className?: string; h?: number }) {
  return (
    <>
      {rows.map(([x, y, w]) => (
        <rect key={`${x}-${y}-${w}`} x={x} y={y} width={w} height={h} rx={h / 2} className={className} />
      ))}
    </>
  );
}

/** A darker bar: a title or heading. */
function Bar({ x, y, w, h = 2.6, accent }: { x: number; y: number; w: number; h?: number; accent?: boolean }) {
  return <rect x={x} y={y} width={w} height={h} rx={h / 2} className={accent ? "fill-accent" : "fill-black/45"} />;
}

/** `count` body lines starting at `top`, `gap` apart, ragged every third line. */
const para = (x: number, top: number, count: number, width = 36, gap = 3.6): [number, number, number][] =>
  Array.from({ length: count }, (_, i) => [x, top + i * gap, i % 3 === 2 || i === count - 1 ? width * 0.7 : width]);

// ---------------------------------------------------------------------------

export const TEMPLATES: TemplateInfo[] = [
  {
    id: "blank",
    title: "Blank",
    description: "An empty article with a title, ready for your words.",
    category: "Start",
    name: "Untitled",
    features: ["Title, author and date", "One empty section", "Compiles straight away"],
    thumb: (
      <Page>
        <Bar x={12} y={9} w={24} h={3} />
        <Lines rows={[[17, 15, 14]]} />
        <Bar x={6} y={24} w={14} h={2} />
        <rect x={6} y={30} width={0.9} height={4} className="fill-accent" />
      </Page>
    ),
  },
  {
    id: "example",
    title: "Paper",
    description: "A one-column article with maths, a figure, a table and citations.",
    category: "Papers",
    name: "Paper",
    features: ["Abstract and sections", "Equations with amsmath", "A figure and a table", "Citations from references.bib"],
    thumb: (
      <Page>
        <Bar x={10} y={6} w={28} h={3} />
        <Lines rows={[[16, 11.5, 16]]} />
        <Lines rows={para(10, 16, 3, 28, 3)} className="fill-black/15" />
        <Bar x={6} y={27} w={14} h={2} />
        <Lines rows={para(6, 31.5, 2)} />
        <text x="24" y="42.5" textAnchor="middle" className="fill-black/55 text-[6px] italic">
          f(x) = ∑ aₙxⁿ
        </text>
        <Lines rows={para(6, 47, 2)} />
        <rect x={6} y={53} width={36} height={5.5} rx={1} className="fill-accent/15 stroke-accent/50" strokeWidth="0.5" />
      </Page>
    ),
  },
  {
    id: "conference",
    title: "Two-column paper",
    description: "Conference style: authors and affiliations, keywords, two columns.",
    category: "Papers",
    name: "Conference paper",
    features: [
      "Title block with authors and affiliations",
      "Abstract and keywords",
      "Two-column body",
      "Full-width figure and a table",
      "References",
    ],
    thumb: (
      <Page>
        <Bar x={8} y={5} w={32} h={2.8} />
        <Lines rows={[[7, 10.5, 12], [29, 10.5, 12]]} className="fill-black/35" h={1.3} />
        <Lines rows={[[8, 13, 10], [30, 13, 10]]} className="fill-black/15" h={1.2} />
        {/* Left column */}
        <Bar x={4} y={18} w={8} h={1.6} />
        <Lines rows={para(4, 21.5, 4, 18, 2.8)} h={1.2} />
        {/* Right column */}
        <Lines rows={para(26, 18, 5, 18, 2.8)} h={1.2} />
        {/* figure* spanning both columns */}
        <rect x={4} y={33} width={40} height={11} rx={1} className="fill-accent/15 stroke-accent/50" strokeWidth="0.5" />
        <path d="M8 41 L15 36.5 L21 39.5 L28 35 L40 39" className="fill-none stroke-accent" strokeWidth="0.9" />
        <Lines rows={para(4, 47, 4, 18, 2.8)} h={1.2} />
        <Lines rows={para(26, 47, 4, 18, 2.8)} h={1.2} />
      </Page>
    ),
  },
  {
    id: "report",
    title: "Report",
    description: "Title page, contents, chapters, a figure and a table.",
    category: "Papers",
    name: "Report",
    features: ["Title page", "Table of contents", "Chapters", "A figure and a table", "Bibliography"],
    thumb: (
      <>
        <Page x={11} y={1} />
        <Page x={6} y={4}>
          <Bar x={10} y={20} w={28} h={3.5} />
          <Lines rows={[[14, 27, 20], [17, 31, 14]]} />
          <rect x={18} y={46} width={12} height={0.8} className="fill-accent" />
          <Lines rows={[[16, 50, 16]]} className="fill-black/15" />
        </Page>
      </>
    ),
  },
  {
    id: "thesis",
    title: "Thesis",
    description: "Front matter, chapters in separate files and an appendix.",
    category: "Papers",
    name: "Thesis",
    features: [
      "Title page, abstract and acknowledgements",
      "Chapters in separate files",
      "Appendix",
      "Bibliography",
    ],
    thumb: (
      <>
        <Page x={13} y={0} />
        <Page x={9.5} y={2} />
        <Page x={6} y={4}>
          <Bar x={6} y={7} w={18} h={3} />
          {[0, 1, 2, 3].map((i) => (
            <g key={i}>
              <Lines rows={[[6, 16 + i * 10, 4]]} className="fill-accent" />
              <Lines rows={[[12, 16 + i * 10, 22]]} className="fill-black/35" />
              <Lines rows={[[12, 20 + i * 10, 18]]} className="fill-black/15" />
              <Lines rows={[[38, 16 + i * 10, 4]]} className="fill-black/20" />
            </g>
          ))}
        </Page>
      </>
    ),
  },
  {
    id: "lecture",
    title: "Lecture notes",
    description: "Definitions, theorems and proofs, examples and boxed remarks.",
    category: "Teaching",
    name: "Lecture notes",
    features: [
      "Definition, theorem and proof environments",
      "Worked examples",
      "Boxed remarks",
      "Numbered equations",
    ],
    thumb: (
      <Page>
        <Bar x={6} y={6} w={22} h={2.8} />
        <Lines rows={para(6, 12, 2)} />
        {/* Boxed theorem */}
        <rect x={5} y={19} width={38} height={15} rx={1.2} className="fill-accent/10 stroke-accent" strokeWidth="0.7" />
        <Bar x={8} y={22} w={12} h={1.8} accent />
        <Lines rows={para(8, 26, 2, 32)} className="fill-black/30" />
        {/* Proof, ending in a square */}
        <Lines rows={para(6, 38, 2)} />
        <rect x={39.5} y={41} width={2.4} height={2.4} className="fill-none stroke-black/50" strokeWidth="0.6" />
        {/* Numbered equation */}
        <text x="22" y="51" textAnchor="middle" className="fill-black/55 text-[5.5px] italic">
          ∇·E = ρ/ε₀
        </text>
        <text x="42" y="51" textAnchor="end" className="fill-black/40 text-[4.5px]">
          (1)
        </text>
        <Lines rows={[[6, 55, 34]]} />
      </Page>
    ),
  },
  {
    id: "homework",
    title: "Assignment",
    description: "Numbered problems with parts and room for your solutions.",
    category: "Teaching",
    name: "Assignment",
    features: [
      "Header with name, course and due date",
      "Numbered problems with parts",
      "Solution environment",
      "Maths packages included",
    ],
    thumb: (
      <Page>
        <Lines rows={[[6, 6, 14]]} className="fill-black/45" />
        <Lines rows={[[6, 9.5, 10]]} />
        <Lines rows={[[30, 6, 12], [34, 9.5, 8]]} />
        <rect x={6} y={13.5} width={36} height={0.6} className="fill-black/40" />
        {[0, 1].map((i) => {
          const y = 18 + i * 21;
          return (
            <g key={i}>
              <text x="6" y={y + 2} className="fill-accent text-[4.5px] font-bold">
                {i + 1}.
              </text>
              <Lines rows={[[11, y, 30]]} className="fill-black/30" />
              <Lines rows={[[13, y + 4.5, 2], [17, y + 4.5, 22], [13, y + 8.5, 2], [17, y + 8.5, 18]]} />
              <rect
                x={11}
                y={y + 11.5}
                width={31}
                height={5.5}
                rx={1}
                className="fill-none stroke-black/30"
                strokeWidth="0.5"
                strokeDasharray="1.5 1"
              />
            </g>
          );
        })}
      </Page>
    ),
  },
  {
    id: "presentation",
    title: "Slides",
    description: "A beamer deck with an outline, columns, steps and blocks.",
    category: "Slides",
    name: "Presentation",
    features: ["Title slide and outline", "Two-column slides", "Step-by-step reveals", "Highlighted blocks"],
    thumb: (
      <>
        <g transform="translate(7 10)">
          <rect width="50" height="31" rx="2" className="fill-white stroke-black/15" strokeWidth="0.75" />
        </g>
        <g transform="translate(3 20)">
          <rect width="54" height="34" rx="2" className="fill-white stroke-black/15" strokeWidth="0.75" />
          <path d="M2 0 H52 A2 2 0 0 1 54 2 V8 H0 V2 A2 2 0 0 1 2 0 Z" className="fill-accent" />
          <rect x={4} y={3} width={18} height={2} rx={1} className="fill-white/90" />
          {[0, 1, 2].map((i) => (
            <g key={i}>
              <circle cx={6} cy={14 + i * 5} r={0.9} className="fill-accent" />
              <rect x={9} y={13.2 + i * 5} width={i === 2 ? 12 : 17} height={1.6} rx={0.8} className="fill-black/25" />
            </g>
          ))}
          <rect x={30} y={11} width={20} height={17} rx={1.2} className="fill-accent/10 stroke-accent/60" strokeWidth="0.5" />
          <rect x={30} y={11} width={20} height={4} rx={1.2} className="fill-accent/40" />
          <Lines rows={[[33, 18.5, 14], [33, 22, 10]]} h={1.4} />
        </g>
      </>
    ),
  },
  {
    id: "letter",
    title: "Letter",
    description: "A formal letter with addresses, date, subject and signature.",
    category: "Personal",
    name: "Letter",
    features: ["Sender and recipient addresses", "Date and subject line", "Opening, body and closing", "Space for a signature"],
    thumb: (
      <Page>
        {/* Letterhead */}
        <rect x={0} y={0} width={48} height={1.6} className="fill-accent" />
        <circle cx={9} cy={8.5} r={3.2} className="fill-accent/20 stroke-accent" strokeWidth="0.6" />
        <Lines rows={[[30, 6, 12], [33, 9, 9], [35, 12, 7]]} h={1.3} />
        {/* Recipient */}
        <Lines rows={[[6, 18, 14], [6, 21, 11], [6, 24, 13]]} className="fill-black/30" h={1.3} />
        <Lines rows={[[33, 29, 9]]} h={1.3} />
        {/* Subject */}
        <Lines rows={[[6, 33, 22]]} className="fill-black/45" h={1.6} />
        <Lines rows={para(6, 38, 4, 36, 3)} h={1.3} />
        <path d="M7 55 C9 51, 11 58, 13 54 S17 52, 19 55 S22 54, 24 53" className="fill-none stroke-black/50" strokeWidth="0.7" />
        <Lines rows={[[6, 58, 12]]} className="fill-black/30" h={1.3} />
      </Page>
    ),
  },
  {
    id: "cv",
    title: "CV",
    description: "A one-page résumé: experience, education, skills, publications.",
    category: "Personal",
    name: "CV",
    features: ["One page, standard packages only", "Experience and education", "Skills", "Publications"],
    thumb: (
      <Page>
        <Bar x={6} y={6} w={22} h={3.4} />
        <Lines rows={[[6, 12, 30]]} className="fill-black/20" h={1.2} />
        <rect x={6} y={16} width={36} height={0.5} className="fill-black/25" />
        {/* The rule down the left with a section marker for each heading */}
        <rect x={7} y={20} width={0.8} height={38} className="fill-accent/50" />
        {[20, 34, 46].map((y, i) => (
          <g key={y}>
            <circle cx={7.4} cy={y + 1} r={1.4} className="fill-accent" />
            <Lines rows={[[11, y, 12]]} className="fill-black/45" h={1.8} />
            <Lines rows={[[11, y + 4, 20], [36, y + 4, 6]]} className="fill-black/30" h={1.2} />
            <Lines rows={i === 2 ? [[11, y + 7, 26]] : [[11, y + 7, 28], [11, y + 10, 22]]} h={1.2} />
          </g>
        ))}
      </Page>
    ),
  },
];

const BY_ID = new Map(TEMPLATES.map((t) => [t.id, t]));

export function templateInfo(id: Template): TemplateInfo {
  return BY_ID.get(id) ?? TEMPLATES[0];
}

export function isTemplate(value: unknown): value is Template {
  return typeof value === "string" && BY_ID.has(value as Template);
}

/** A template's first-page drawing. Size it with `className`. */
export function TemplateThumb({ template, className = "h-16 w-14" }: { template: Template; className?: string }) {
  return (
    // Thumbnails are white paper in every theme, so they pin the accent to the
    // light theme's mid-tone; the dark theme's pale accent would vanish on white.
    <svg viewBox="0 0 60 68" className={`[--accent:#4f5fe8] ${className}`} aria-hidden="true">
      {templateInfo(template).thumb}
    </svg>
  );
}

// The template the user picked last time, so "New project" starts there.
const LAST_KEY = "texo.newProject.template";
export const DEFAULT_TEMPLATE: Template = "example";

export function lastTemplate(): Template {
  try {
    const saved = localStorage.getItem(LAST_KEY);
    return isTemplate(saved) ? saved : DEFAULT_TEMPLATE;
  } catch {
    return DEFAULT_TEMPLATE;
  }
}

export function rememberTemplate(template: Template) {
  try {
    localStorage.setItem(LAST_KEY, template);
  } catch {
    // Not important: next time starts from the default.
  }
}
