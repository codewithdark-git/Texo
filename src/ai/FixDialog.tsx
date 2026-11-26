// The "Explain & fix" panel: the privacy notice, progress with Cancel, the
// AI's plain-language explanation and steps, a diff of each proposed edit to
// accept or reject, Apply, the recompile, and up to three rounds.

import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AlertCircle, Check, CheckCircle2, Copy, Download, Loader2, RotateCcw, Settings, Sparkles, X } from "lucide-react";
import { Button, Modal } from "../components/Dialog";
import { parseHint } from "../editor/biblatexFix";
import { aiApi, errorText } from "../lib/api";
import { toast, useUi } from "../ui";
import { useCompile } from "../workspace/compileStore";
import { revealSource } from "../workspace/EditorPane";
import { previewEdit, type ProposedEdit } from "./fixEdits";
import { canRetry, MAX_ROUNDS, needsSettings, retryable, type AiError, type EnvAction, type FixProposal } from "./fixModel";
import { useFix } from "./fixStore";

/** Mounted once in the workspace; shows while a fix session is open. */
export function FixDialog() {
  const open = useFix((s) => s.open);
  const close = useFix((s) => s.close);
  if (!open) return null;
  return (
    <Modal title="Explain & fix" onClose={close} wide>
      <FixBody />
    </Modal>
  );
}

function FixBody() {
  const s = useFix();
  const phase = s.phase;
  const providerName = s.provider?.label ?? "the AI provider";
  return (
    <div className="flex max-h-[70vh] flex-col gap-3 text-sm">
      <div className="min-h-0 flex-1 overflow-auto pr-1">
        <Found />
        {phase.kind === "notice" && <Notice providerName={providerName} />}
        {(phase.kind === "asking" || phase.kind === "idle") && (
          <Progress text={`${s.progress ?? `Asking ${providerName}…`} This usually takes under a minute.`} />
        )}
        {phase.kind === "applying" && <Progress text="Applying the changes…" />}
        {phase.kind === "recompiling" && <Progress text="Compiling again to check the fix…" />}
        {phase.kind === "proposal" && <ProposalView proposal={phase.proposal} />}
        {phase.kind === "outcome" && <OutcomeView />}
        {phase.kind === "error" && <ErrorView error={phase.error} />}
      </div>
      <Footer />
    </div>
  );
}

/** What Texo itself found, shown whatever the AI does (and when it can't run). */
function Found() {
  const scope = useFix((s) => s.scope);
  const round = useFix((s) => s.round);
  const result = useCompile((s) => s.result);
  const hints = (result?.hints ?? []).map((h) => parseHint(h).text);
  const errors = result?.issues.filter((i) => i.severity === "error") ?? [];
  const issue = scope.kind === "issue" ? scope.issue : errors[0];
  return (
    <section className="mb-3 rounded-lg border border-border bg-bg px-3 py-2">
      <div className="mb-1 flex items-center justify-between text-xs text-muted">
        <span>{scope.kind === "issue" ? "The problem" : `${errors.length || "No"} ${errors.length === 1 ? "error" : "errors"} in the last compile`}</span>
        {round > 0 && <span>Round {round} of {MAX_ROUNDS}</span>}
      </div>
      {issue ? (
        <p className="break-words">
          {issue.message}
          {issue.file && (
            <span className="ml-1.5 font-mono text-[11px] text-muted">
              {issue.file}
              {issue.line ? `:${issue.line}` : ""}
            </span>
          )}
        </p>
      ) : (
        <p className="text-muted">The compile didn't list a specific error.</p>
      )}
      {hints.slice(0, 2).map((h) => (
        <p key={h} className="mt-1 text-xs text-muted">
          {h}
        </p>
      ))}
    </section>
  );
}

/** Closes the fix panel and opens Settings > AI (one dialog at a time). */
function toAiSettings() {
  useFix.getState().close();
  useUi.getState().openSettings("ai");
}

function Notice({ providerName }: { providerName: string }) {
  return (
    <section className="rounded-lg border border-accent/30 bg-accent/10 px-3 py-2.5">
      <p className="font-medium">Before Texo asks {providerName}</p>
      <p className="mt-1 text-muted">To explain this error, Texo sends {providerName} these parts of your project:</p>
      <ul className="mt-1 list-disc pl-5 text-muted">
        <li>the error messages and a short part of the compile log,</li>
        <li>the lines around each error (about 40 lines before and after),</li>
        <li>the start of your main file, up to \begin{"{document}"},</li>
        <li>other files the error names, and the bibliography entries it mentions.</li>
      </ul>
      <p className="mt-1 text-muted">
        Never your whole project, and nothing outside the project folder. Your API key stays on this computer and only goes to {providerName}. Texo only sends
        something when you press a button; you can turn the AI helper off in Settings.
      </p>
      <div className="mt-1 -ml-2 flex gap-1">
        <Button variant="ghost" onClick={toAiSettings}>
          <Settings size={14} /> AI settings
        </Button>
        <SentPreview />
      </div>
    </section>
  );
}

/** "Show exactly what will be sent": the backend's preview; nothing is sent to load it. */
function SentPreview() {
  const preview = useFix((s) => s.preview);
  const loadPreview = useFix((s) => s.loadPreview);
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        onClick={() => {
          setOpen((o) => !o);
          if (!preview) void loadPreview();
        }}
      >
        {open ? "Hide" : "Show"} exactly what will be sent
      </Button>
      {open && (
        <div className="fixed inset-x-0 bottom-0 z-[60] mx-auto mb-4 w-full max-w-2xl rounded-lg border border-border bg-surface p-3 shadow-2xl">
          <div className="mb-1 flex items-center justify-between text-xs text-muted">
            <span>
              {preview
                ? `${preview.summary.excerpts.length} excerpts, ${preview.summary.chars.toLocaleString()} characters${preview.summary.truncated ? " (shortened to fit)" : ""}`
                : "Loading…"}
            </span>
            <Button variant="ghost" aria-label="Close preview" onClick={() => setOpen(false)}>
              <X size={13} />
            </Button>
          </div>
          <pre className="max-h-64 overflow-auto rounded bg-bg px-2 py-1 font-mono text-[11px] whitespace-pre-wrap select-text">{preview?.text ?? ""}</pre>
        </div>
      )}
    </>
  );
}

function Progress({ text }: { text: string }) {
  return (
    <p className="flex items-center gap-2 py-6 text-muted" role="status">
      <Loader2 size={16} className="animate-spin" /> {text}
    </p>
  );
}

function ProposalView({ proposal }: { proposal: FixProposal }) {
  return (
    <section className="space-y-3">
      <div>
        <h3 className="mb-1 flex items-center gap-1.5 font-medium">
          <Sparkles size={14} className="text-accent" /> What went wrong
          {proposal.confidence && <span className="ml-auto text-xs font-normal text-muted">{CONFIDENCE[proposal.confidence]}</span>}
        </h3>
        <p>{proposal.summary || "The AI didn't give a summary."}</p>
        {proposal.cause && <p className="mt-1 text-muted">{proposal.cause}</p>}
        {proposal.notes.map((n) => (
          <p key={n} className="mt-1 text-xs text-muted">
            {n}
          </p>
        ))}
      </div>
      {proposal.steps.length > 0 && (
        <div>
          <h3 className="mb-1 font-medium">How to fix it</h3>
          <ol className="list-decimal space-y-0.5 pl-5">
            {proposal.steps.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
        </div>
      )}
      {proposal.envActions.length > 0 && (
        <div>
          <h3 className="mb-1 font-medium">Missing from your LaTeX installation</h3>
          {proposal.envActions.map((a) => (
            <EnvActionRow key={`${a.manager}:${a.package}`} action={a} />
          ))}
        </div>
      )}
      <div>
        <h3 className="mb-1 font-medium">Changes to your files</h3>
        {proposal.edits.length === 0 ? (
          <p className="text-muted">The AI didn't suggest changes to your files. Follow the steps above instead.</p>
        ) : (
          <EditList edits={proposal.edits} />
        )}
        {proposal.rejected.length > 0 && (
          <div className="mt-2 rounded-lg border border-border px-3 py-2 text-xs text-muted">
            <p className="mb-1">Texo left out {proposal.rejected.length === 1 ? "one suggestion" : `${proposal.rejected.length} suggestions`}:</p>
            <ul className="list-disc pl-4">
              {proposal.rejected.map((r, i) => (
                <li key={i}>
                  <span className="font-mono">{r.edit.file || "?"}</span>: {r.reason}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}

const CONFIDENCE = { low: "The AI isn't sure", medium: "The AI is fairly sure", high: "The AI is confident" } as const;

function EditList({ edits }: { edits: ProposedEdit[] }) {
  const phase = useFix((s) => s.phase);
  const texts = useFix((s) => s.texts);
  const toggle = useFix((s) => s.toggle);
  if (phase.kind !== "proposal") return null;
  return (
    <ul className="space-y-2">
      {edits.map((edit, i) => {
        const problem = phase.problems[i];
        const accepted = phase.decisions[i] === "accepted";
        const text = texts[edit.file];
        const preview = text !== undefined && !problem ? previewEdit(text, edit) : null;
        return (
          <li key={i} className={`rounded-lg border ${accepted ? "border-accent/50" : "border-border opacity-80"}`}>
            <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
              <button
                type="button"
                className="min-w-0 truncate font-mono text-xs hover:underline"
                title="Show in the editor"
                onClick={() => void revealSource(edit.file, preview?.firstLine ?? 1)}
              >
                {edit.file}
                {preview ? `:${preview.firstLine}` : ""}
              </button>
              <span className="ml-auto" />
              {problem ? (
                <span className="text-xs text-amber-400">Can't apply</span>
              ) : (
                <div role="radiogroup" aria-label={`Change ${i + 1}`} className="flex rounded-md border border-border p-0.5 text-xs">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={accepted}
                    onClick={() => !accepted && toggle(i)}
                    className={`flex items-center gap-1 rounded px-2 py-0.5 ${accepted ? "bg-accent text-accent-ink" : "text-muted hover:text-text"}`}
                  >
                    <Check size={12} /> Accept
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={!accepted}
                    onClick={() => accepted && toggle(i)}
                    className={`flex items-center gap-1 rounded px-2 py-0.5 ${!accepted ? "bg-surface-2 text-text" : "text-muted hover:text-text"}`}
                  >
                    <X size={12} /> Reject
                  </button>
                </div>
              )}
            </div>
            {edit.why && <p className="px-3 pt-1.5 text-xs text-muted">{edit.why}</p>}
            {problem ? (
              <p className="px-3 py-2 text-xs text-amber-400">{problem}</p>
            ) : preview ? (
              <DiffView lines={preview.lines} />
            ) : (
              <DiffView
                lines={[
                  ...edit.find.split("\n").map((t) => ({ kind: "del" as const, text: t, line: 0 })),
                  ...edit.replace.split("\n").map((t) => ({ kind: "add" as const, text: t, line: 0 })),
                ]}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** A light unified diff: removed lines in red, added in green. */
function DiffView({ lines }: { lines: { kind: "same" | "add" | "del"; text: string; line: number }[] }) {
  return (
    <pre className="m-2 max-h-56 overflow-auto rounded bg-bg py-1 font-mono text-[11px] leading-relaxed select-text">
      {lines.map((l, i) => (
        <div
          key={i}
          className={`flex px-2 ${l.kind === "add" ? "bg-emerald-500/15 text-emerald-300" : l.kind === "del" ? "bg-danger/15 text-danger" : "text-muted"}`}
        >
          <span className="w-8 shrink-0 pr-2 text-right opacity-60 select-none">{l.line || ""}</span>
          <span className="w-3 shrink-0 select-none" aria-label={l.kind === "add" ? "added" : l.kind === "del" ? "removed" : undefined}>
            {l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}
          </span>
          <span className="whitespace-pre-wrap break-all">{l.text || " "}</span>
        </div>
      ))}
    </pre>
  );
}

/** An "install this package" suggestion: nothing runs until the user confirms. */
function EnvActionRow({ action }: { action: EnvAction }) {
  const [state, setState] = useState<"idle" | "confirm" | "running" | "done" | "manual">(action.available ? "idle" : "manual");
  const [note, setNote] = useState("");
  const [output, setOutput] = useState("");
  const managerName = action.manager === "miktex" ? "MiKTeX" : "TeX Live";

  const install = async () => {
    setState("running");
    try {
      const result = await aiApi.installPackage(action.manager, action.package);
      setNote(result.message);
      setOutput(result.output);
      setState(result.ok ? "done" : "manual");
    } catch (err) {
      setNote(errorText(err));
      setState("manual");
    }
  };

  return (
    <div className="mb-2 rounded-lg border border-border px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1">
          Install <span className="font-mono">{action.package}</span> with {managerName}
          {action.why && <span className="block text-xs text-muted">{action.why}</span>}
        </span>
        {state === "idle" && (
          <Button onClick={() => setState("confirm")}>
            <Download size={14} /> Install…
          </Button>
        )}
        {state === "running" && (
          <span className="flex items-center gap-1.5 text-xs text-muted">
            <Loader2 size={14} className="animate-spin" /> Installing…
          </span>
        )}
        {state === "done" && (
          <Button onClick={() => void useCompile.getState().compile()}>
            <RotateCcw size={14} /> Compile again
          </Button>
        )}
      </div>
      {state === "confirm" && (
        <div className="mt-2 rounded-md bg-bg px-3 py-2 text-xs">
          <p>
            Texo will run <span className="font-mono">{action.command}</span>. It downloads the package from the {managerName} servers and adds it to
            your LaTeX installation. This can take a few minutes.
          </p>
          <div className="mt-2 flex justify-end gap-2">
            <Button onClick={() => setState("idle")}>Cancel</Button>
            <Button variant="primary" onClick={() => void install()}>
              Install {action.package}
            </Button>
          </div>
        </div>
      )}
      {note && <p className="mt-1 text-xs text-muted">{note}</p>}
      {output && (
        <details className="mt-1 text-xs text-muted">
          <summary className="cursor-pointer">Details</summary>
          <pre className="mt-1 max-h-32 overflow-auto rounded bg-bg px-2 py-1 font-mono text-[11px] whitespace-pre-wrap">{output}</pre>
        </details>
      )}
      {state === "manual" && (
        <div className="mt-1 text-xs text-muted">
          <p>
            {action.manager === "miktex"
              ? `You can install it yourself: open MiKTeX Console, go to Packages, search for ${action.package} and install it. Or run:`
              : "You can install it yourself by running this in a terminal:"}
          </p>
          <div className="mt-1 flex items-center gap-2">
            <code className="rounded bg-bg px-2 py-0.5 font-mono">{action.command}</code>
            <Button
              variant="ghost"
              aria-label="Copy command"
              onClick={() =>
                void navigator.clipboard.writeText(action.command).then(
                  () => toast("Command copied."),
                  () => {},
                )
              }
            >
              <Copy size={13} />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function OutcomeView() {
  const s = useFix();
  if (s.phase.kind !== "outcome") return null;
  const { outcome, applied } = s.phase;
  const errors = useCompile.getState().result?.issues.filter((i) => i.severity === "error").length ?? 0;
  const changes = `${applied} ${applied === 1 ? "change" : "changes"}`;
  if (outcome === "fixed") {
    return (
      <p className="flex items-center gap-2 py-4">
        <CheckCircle2 size={18} className="text-emerald-400" /> Fixed. Texo applied {changes} and the document compiles now. Ctrl+Z in the file undoes a change.
      </p>
    );
  }
  if (outcome === "progress") {
    return (
      <div className="py-2">
        <p>
          Texo applied {changes}. That helped, but {errors || "some"} {errors === 1 ? "error remains" : "errors remain"}.
        </p>
        <p className="mt-1 text-muted">
          {canRetry(s)
            ? "Try again to ask the AI about what's left. It will see what was already changed."
            : `Texo stopped after ${MAX_ROUNDS} rounds. Look at the remaining errors in the Issues panel.`}
        </p>
      </div>
    );
  }
  return (
    <div className="py-2">
      <p>Texo applied {changes}, but the same errors are still there.</p>
      <p className="mt-1 text-muted">
        Texo stopped here rather than keep guessing. Press Ctrl+Z in the changed file to undo the change, and follow the steps from the plain explanation above.
      </p>
    </div>
  );
}

function ErrorView({ error }: { error: AiError }) {
  return (
    <div className="flex gap-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2.5">
      <AlertCircle size={16} className="mt-0.5 shrink-0 text-danger" />
      <div>
        <p>{error.kind === "cancelled" ? "Stopped. Nothing was changed." : error.message}</p>
        {error.kind === "rateLimited" && error.retryAfter && <p className="mt-1 text-xs text-muted">Wait about {error.retryAfter} seconds.</p>}
        {error.kind === "refused" && <p className="mt-1 text-xs text-muted">Try another model or provider in Settings &gt; AI.</p>}
        {error.kind === "noKey" && (
          <p className="mt-1 text-xs text-muted">
            NVIDIA gives free keys:{" "}
            <button type="button" className="text-accent hover:underline" onClick={() => void openUrl("https://build.nvidia.com/")}>
              build.nvidia.com
            </button>
          </p>
        )}
      </div>
    </div>
  );
}

function Footer() {
  const s = useFix();
  const phase = s.phase;
  const accepted = phase.kind === "proposal" ? phase.decisions.filter((d) => d === "accepted").length : 0;
  const applicable = phase.kind === "proposal" ? phase.problems.filter((p) => !p).length : 0;
  return (
    <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
      {phase.kind === "notice" && (
        <>
          <Button onClick={s.close}>Cancel</Button>
          <Button autoFocus variant="primary" onClick={s.acceptNotice}>
            <Sparkles size={14} /> Send and explain
          </Button>
        </>
      )}
      {phase.kind === "asking" && <Button onClick={() => void s.cancel()}>Cancel</Button>}
      {phase.kind === "proposal" && (
        <>
          {applicable > 1 && (
            <Button variant="ghost" className="mr-auto" onClick={() => s.setAll(accepted === applicable ? "rejected" : "accepted")}>
              {accepted === applicable ? "Reject all" : "Accept all"}
            </Button>
          )}
          <Button onClick={s.close}>Close</Button>
          {phase.proposal.edits.length > 0 && (
            <Button variant="primary" disabled={!accepted} onClick={() => void s.apply()}>
              <Check size={14} /> Apply {accepted || ""} {accepted === 1 ? "change" : "changes"} and compile
            </Button>
          )}
        </>
      )}
      {(phase.kind === "outcome" || phase.kind === "error") && (
        <>
          {phase.kind === "error" && needsSettings(phase.error.kind) && (
            <Button onClick={toAiSettings}>
              <Settings size={14} /> AI settings
            </Button>
          )}
          <Button onClick={s.close}>Close</Button>
          {canRetry(s) && (phase.kind === "outcome" || retryable(phase.error.kind) || phase.error.kind === "cancelled") && (
            <Button variant="primary" onClick={() => void s.retry()}>
              <RotateCcw size={14} /> Try again
              {phase.kind === "outcome" ? ` (round ${s.round + 1} of ${MAX_ROUNDS})` : ""}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
