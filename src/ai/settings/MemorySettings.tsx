// Settings > AI > Memory: the open project's notes for the agents
// (.texo/ai/memory.md). Agents read them and add to them ("remember …").
// View, edit, save or clear them here.

import { useEffect, useState } from "react";
import { Eraser, Loader2, Save } from "lucide-react";
import { Button } from "../../components/Dialog";
import { Heading } from "../../components/settingsControls";
import { errorText } from "../../lib/api";
import { memoryApi, utf8Bytes, type MemoryInfo } from "../../lib/agentsApi";
import { toast } from "../../ui";
import { useWorkspace } from "../../workspace/store";
import { memorySizeText, memoryUsage } from "./agentSettingsLogic";
import { InlineConfirm } from "./InlineConfirm";

export function MemorySettings() {
  const project = useWorkspace((s) => s.project);
  return (
    <>
      <Heading>Project memory</Heading>
      <p className="mb-2 text-xs text-muted">
        Notes the agents read before they start and add to when you ask them to remember something, like “we use British spelling” or “never
        change the abstract”. They are kept in the project, in <span className="font-mono">.texo/ai/memory.md</span>, and sent to the AI with
        each agent run and chat.
      </p>
      {project ? <MemoryEditor key={project.path} project={project.path} name={project.name} /> : <p className="text-sm text-muted">Open a project to see its memory.</p>}
    </>
  );
}

function MemoryEditor({ project, name }: { project: string; name: string }) {
  const [info, setInfo] = useState<MemoryInfo | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    let live = true;
    memoryApi.get(project).then(
      (m) => {
        if (!live) return;
        setInfo(m);
        setText(m.text);
      },
      (err) => live && setError(errorText(err)),
    );
    return () => {
      live = false;
    };
  }, [project]);

  if (error) return <p className="text-sm text-muted">The memory couldn't be loaded: {error}</p>;
  if (!info)
    return (
      <p className="flex items-center gap-2 text-sm text-muted">
        <Loader2 size={14} className="animate-spin" /> Loading…
      </p>
    );

  const usage = memoryUsage(utf8Bytes(text), info.maxBytes);
  const changed = text !== info.text;

  const save = async () => {
    if (usage.over || busy) return;
    setBusy(true);
    try {
      const m = await memoryApi.set(project, text);
      setInfo(m);
      setText(m.text);
      toast("Memory saved.", "success");
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setConfirmClear(false);
    setBusy(true);
    try {
      const m = await memoryApi.clear(project);
      setInfo(m);
      setText(m.text);
      toast("Memory cleared.", "success");
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <textarea
        aria-label={`Memory of ${name}`}
        className="h-48 w-full rounded-lg border border-border bg-bg px-2.5 py-2 font-mono text-xs outline-none focus:border-accent"
        spellCheck={false}
        value={text}
        placeholder="Nothing remembered yet."
        onChange={(e) => setText(e.target.value)}
      />
      <div className="mt-1 flex items-center gap-2">
        <div className="h-1.5 w-28 overflow-hidden rounded-full bg-surface-2" aria-hidden>
          <div className={`h-full ${usage.over ? "bg-danger" : "bg-accent"}`} style={{ width: `${usage.percent}%` }} />
        </div>
        <span className={`text-xs ${usage.over ? "text-danger" : "text-muted"}`}>
          {memorySizeText(usage)}
          {usage.over ? ". Shorten it to save." : ""}
        </span>
        <span className="flex-1" />
        <Button variant="ghost" onClick={() => setConfirmClear(true)} disabled={busy || (!info.text && !text)}>
          <Eraser size={13} /> Clear
        </Button>
        {changed && (
          <Button onClick={() => setText(info.text)} disabled={busy}>
            Undo changes
          </Button>
        )}
        <Button variant="primary" onClick={() => void save()} disabled={busy || !changed || usage.over}>
          <Save size={13} /> Save
        </Button>
      </div>
      <p className="mt-1 text-xs text-muted">When it gets full, the oldest notes are dropped to make room for new ones.</p>
      {confirmClear && (
        <InlineConfirm
          message="Clear the memory? Everything the agents remembered for this project is deleted, and agents start from nothing next time."
          confirmLabel="Clear memory"
          danger
          onConfirm={() => void clear()}
          onCancel={() => setConfirmClear(false)}
        />
      )}
    </div>
  );
}
