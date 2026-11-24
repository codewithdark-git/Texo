// Page setup, as a word processor has it: paper, margins, font, spacing and
// columns, with no LaTeX in sight. Apply hands back the preamble with the
// smallest edit that makes the change (see pageSetup.ts); the preamble node
// takes it through setAttrs, so undo works like any other edit.

import { useMemo, useState, type ReactNode } from "react";
import { create } from "zustand";
import { ChevronDown, ChevronRight, Code2 } from "lucide-react";
import { Button, Modal } from "../../components/Dialog";
import {
  FONTS,
  MARGIN_PRESETS,
  marginPreset,
  PAPER_SIZES,
  classMargins,
  parseMarginCm,
  readPageSetup,
  writePageSetup,
  type FontChoice,
  type LineSpacing,
  type MarginPreset,
  type Margins,
  type PageSetup,
  type PaperSize,
} from "./pageSetup";

export interface PageSetupRequest {
  /** The preamble's source. */
  src: string;
  onApply(src: string): void;
  /** Opens the preamble as code (the Advanced section). */
  onEditCode(): void;
}

export const usePageSetup = create<{ req: PageSetupRequest | null; open(r: PageSetupRequest): void; close(): void }>((set) => ({
  req: null,
  open: (req) => set({ req }),
  close: () => set({ req: null }),
}));

export function PageSetupDialog() {
  const req = usePageSetup((s) => s.req);
  const close = usePageSetup((s) => s.close);
  if (!req) return null;
  return <Setup key={req.src} req={req} close={close} />;
}

const SPACINGS: [LineSpacing, string][] = [
  ["single", "Single"],
  ["1.15", "1.15"],
  ["1.5", "1.5"],
  ["double", "Double"],
];

const SIDES: [keyof Margins, string][] = [
  ["top", "Top"],
  ["bottom", "Bottom"],
  ["left", "Left"],
  ["right", "Right"],
];

const selectCls = "h-8 rounded-md border border-border bg-bg px-2 text-sm outline-none focus:border-accent disabled:opacity-50";

function Field({ label, id, children, help }: { label: string; id?: string; children: ReactNode; help?: string }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm">
          {label}
        </label>
        {help && <div className="mt-0.5 text-xs text-muted">{help}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** A small segmented control (radio group). */
function Segments<T extends string | number>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label={label} aria-disabled={disabled} className={`flex rounded-lg border border-border bg-surface-2/50 p-0.5 ${disabled ? "opacity-50" : ""}`}>
      {options.map(([v, name]) => (
        <button
          key={String(v)}
          type="button"
          role="radio"
          aria-checked={value === v}
          disabled={disabled}
          onClick={() => onChange(v)}
          className={`rounded-md px-2.5 py-1 text-xs ${value === v ? "bg-surface text-text shadow-sm" : "text-muted hover:text-text"}`}
        >
          {name}
        </button>
      ))}
    </div>
  );
}

/**
 * One custom margin, in cm. It keeps its own text while the user types, so
 * clearing the field or typing "1." on the way to "1.5" never snaps the
 * margin to 0; only a complete number in range reaches the settings, and the
 * field shows the real value again when it loses focus.
 */
function MarginInput({ value, onCommit }: { value: number; onCommit(cm: number): void }) {
  const shown = String(Math.round(value * 100) / 100);
  const [text, setText] = useState<string | null>(null);
  return (
    <input
      type="text"
      inputMode="decimal"
      value={text ?? shown}
      onFocus={() => setText(shown)}
      onChange={(e) => {
        setText(e.target.value);
        const cm = parseMarginCm(e.target.value);
        if (cm !== null) onCommit(cm);
      }}
      onBlur={() => setText(null)}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      className="h-8 w-full rounded-md border border-border bg-bg px-2 text-sm text-text outline-none focus:border-accent"
    />
  );
}

function Setup({ req, close }: { req: PageSetupRequest; close(): void }) {
  const info = useMemo(() => readPageSetup(req.src), [req.src]);
  const [s, setS] = useState<PageSetup>(info.settings);
  const [preset, setPreset] = useState<MarginPreset>(() => marginPreset(info.settings.margins));
  const [advanced, setAdvanced] = useState(false);
  const layoutOff = !!info.limits.layout;
  const set = (patch: Partial<PageSetup>) => setS((x) => ({ ...x, ...patch }));

  const choosePreset = (p: MarginPreset) => {
    setPreset(p);
    if (p === "default") set({ margins: null });
    else if (p === "custom") set({ margins: s.margins ?? classMargins(s) });
    else set({ margins: MARGIN_PRESETS[p].margins });
  };
  const setSide = (side: keyof Margins, cm: number) => {
    if (!Number.isFinite(cm) || cm < 0 || cm > 15) return;
    set({ margins: { ...(s.margins ?? classMargins(s)), [side]: cm } });
  };

  const next = useMemo(() => writePageSetup(req.src, s), [req.src, s]);
  const apply = () => {
    if (next !== req.src) req.onApply(next);
    close();
  };

  return (
    <Modal title="Page setup" onClose={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          apply();
        }}
      >
        {info.limits.layout && <p className="mb-2 rounded-md bg-surface-2 px-3 py-2 text-xs text-muted">{info.limits.layout}</p>}
        <Field label="Paper size" id="ps-paper">
          <select id="ps-paper" className={selectCls} disabled={layoutOff} value={s.paper} onChange={(e) => set({ paper: e.target.value as PaperSize })}>
            {Object.entries(PAPER_SIZES).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label} ({v.width} × {v.height} cm)
              </option>
            ))}
          </select>
        </Field>
        <Field label="Orientation">
          <Segments
            label="Orientation"
            disabled={layoutOff}
            value={s.orientation}
            options={[
              ["portrait", "Portrait"],
              ["landscape", "Landscape"],
            ]}
            onChange={(orientation) => set({ orientation })}
          />
        </Field>
        <Field label="Margins" id="ps-margins">
          <select id="ps-margins" className={selectCls} disabled={layoutOff} value={preset} onChange={(e) => choosePreset(e.target.value as MarginPreset)}>
            <option value="default">Class default</option>
            {Object.entries(MARGIN_PRESETS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
            <option value="custom">Custom…</option>
          </select>
        </Field>
        {preset === "custom" && !layoutOff && (
          <div className="mb-1 grid grid-cols-4 gap-2 pl-2" role="group" aria-label="Custom margins in centimetres">
            {SIDES.map(([side, name]) => (
              <label key={side} className="flex flex-col gap-1 text-xs text-muted">
                {name} (cm)
                <MarginInput value={(s.margins ?? classMargins(s))[side]} onCommit={(cm) => setSide(side, cm)} />
              </label>
            ))}
          </div>
        )}
        <Field label="Columns" help="In the PDF. You keep writing in one column here.">
          <Segments
            label="Columns"
            disabled={layoutOff}
            value={s.columns}
            options={[
              [1, "One"],
              [2, "Two"],
            ]}
            onChange={(columns) => set({ columns })}
          />
        </Field>
        <div className="my-2 border-t border-border" />
        <Field label="Font" id="ps-font" help={info.limits.font ?? undefined}>
          <select id="ps-font" className={selectCls} disabled={!!info.limits.font} value={s.font} onChange={(e) => set({ font: e.target.value as FontChoice })}>
            {Object.entries(FONTS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Font size">
          <Segments
            label="Font size"
            value={s.fontSize}
            options={[
              [10, "10 pt"],
              [11, "11 pt"],
              [12, "12 pt"],
            ]}
            onChange={(fontSize) => set({ fontSize })}
          />
        </Field>
        <Field label="Line spacing">
          <Segments label="Line spacing" value={s.lineSpacing} options={SPACINGS} onChange={(lineSpacing) => set({ lineSpacing })} />
        </Field>
        <Field label="Paragraphs">
          <Segments
            label="Paragraphs"
            value={s.parStyle}
            options={[
              ["indent", "Indent first line"],
              ["space", "Space between"],
            ]}
            onChange={(parStyle) => set({ parStyle })}
          />
        </Field>

        <div className="mt-3 border-t border-border pt-2">
          <button
            type="button"
            aria-expanded={advanced}
            onClick={() => setAdvanced((a) => !a)}
            className="flex items-center gap-1 text-xs text-muted hover:text-text"
          >
            {advanced ? <ChevronDown size={13} /> : <ChevronRight size={13} />} Advanced
          </button>
          {advanced && (
            <div className="mt-2 flex items-center justify-between gap-3 text-xs text-muted">
              <span>Packages, macros and anything else in the document's preamble.</span>
              <Button
                onClick={() => {
                  close();
                  req.onEditCode();
                }}
              >
                <Code2 size={14} /> Edit preamble as code
              </Button>
            </div>
          )}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={close}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={next === req.src}>
            Apply
          </Button>
        </div>
      </form>
    </Modal>
  );
}
