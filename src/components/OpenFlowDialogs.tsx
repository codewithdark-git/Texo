// The questions opening a project can raise: a read-only folder (make an
// editable copy?), several possible main documents (which one is the paper?)
// and a listed folder that has gone missing (find it, or remove it from the
// list?). Rendered once at the app level, over the dashboard or workspace.
import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FileText, Star } from "lucide-react";
import { api, errorText } from "../lib/api";
import { describeCandidate, lastKnownPlace } from "../lib/openProject";
import { useApp, type OpenPrompt } from "../store";
import { toast } from "../ui";
import { Button, Modal } from "./Dialog";

export function OpenFlowDialogs() {
  const prompt = useApp((s) => s.openPrompt);
  const close = useApp((s) => s.closeOpenPrompt);
  if (!prompt) return null;
  switch (prompt.kind) {
    case "readOnly":
      return <ReadOnlyDialog prompt={prompt} onClose={close} />;
    case "chooseMain":
      return <ChooseMainDialog prompt={prompt} onClose={close} />;
    case "missing":
      return <MissingDialog prompt={prompt} onClose={close} />;
  }
}

function ReadOnlyDialog({
  prompt,
  onClose,
}: {
  prompt: Extract<OpenPrompt, { kind: "readOnly" }>;
  onClose: () => void;
}) {
  const copyToProjects = useApp((s) => s.copyToProjects);
  return (
    <Modal title="This folder can't be changed" onClose={onClose}>
      <p className="text-sm leading-relaxed text-muted">{prompt.message}</p>
      <p className="mt-3 text-sm leading-relaxed text-muted">
        The copy goes into your projects folder. The original folder is left exactly as it is.
      </p>
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button
          autoFocus
          variant="primary"
          onClick={() => {
            onClose();
            void copyToProjects(prompt.path);
          }}
        >
          Make an editable copy
        </Button>
      </div>
    </Modal>
  );
}

function ChooseMainDialog({
  prompt,
  onClose,
}: {
  prompt: Extract<OpenPrompt, { kind: "chooseMain" }>;
  onClose: () => void;
}) {
  const { project } = prompt;
  const [busy, setBusy] = useState(false);
  const candidates = project.mainCandidates ?? [];

  const choose = async (file: string) => {
    if (file === project.mainDocument) return onClose();
    setBusy(true);
    try {
      // The workspace may already be showing this project; let it update
      // its own copy so the compile panel and file tree follow.
      const { useWorkspace } = await import("../workspace/store");
      const ws = useWorkspace.getState();
      if (ws.project?.path === project.path) await ws.setMainDocument(file);
      else {
        await api.setMainDocument(project.path, file);
        toast(`“${describeCandidate(file).name}” is now the main document`);
      }
      onClose();
    } catch (err) {
      toast(errorText(err), "error");
      setBusy(false);
    }
  };

  return (
    <Modal title="Which file is your document?" onClose={onClose}>
      <p className="text-sm leading-relaxed text-muted">
        This folder has several files that could each be compiled into a PDF. Texo picked the one that looks most
        like your paper. Choose another if it's wrong; you can change it later by right-clicking a file and choosing
        “Set as main document”.
      </p>
      <ul className="mt-4 flex flex-col gap-1.5" aria-label="Possible main documents">
        {candidates.map((file) => {
          const { name, folder } = describeCandidate(file);
          const current = file === project.mainDocument;
          return (
            <li key={file}>
              <button
                type="button"
                disabled={busy}
                onClick={() => void choose(file)}
                aria-current={current || undefined}
                className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left text-sm transition-colors disabled:opacity-60 ${current ? "border-accent bg-accent/10" : "border-border hover:border-accent/60 hover:bg-surface-2"}`}
              >
                {current ? <Star size={15} className="shrink-0 text-accent" /> : <FileText size={15} className="shrink-0 text-muted" />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium" title={file}>{name}</span>
                  {folder && <span className="block truncate text-xs text-muted">in {folder}</span>}
                </span>
                {current && <span className="text-xs text-muted">Texo's pick</span>}
              </button>
            </li>
          );
        })}
      </ul>
      <div className="mt-5 flex justify-end">
        <Button autoFocus onClick={onClose}>
          Keep Texo's pick
        </Button>
      </div>
    </Modal>
  );
}

function MissingDialog({
  prompt,
  onClose,
}: {
  prompt: Extract<OpenPrompt, { kind: "missing" }>;
  onClose: () => void;
}) {
  const { project } = prompt;
  const relocate = useApp((s) => s.relocate);
  const forget = useApp((s) => s.forget);

  const find = async () => {
    const picked = await openDialog({ directory: true, multiple: false, title: `Find the folder of “${project.name}”` });
    if (typeof picked !== "string") return;
    onClose();
    await relocate(project, picked);
  };

  return (
    <Modal title="Texo can't find this project" onClose={onClose}>
      <p className="text-sm leading-relaxed text-muted">
        <strong className="text-text">{project.name}</strong> was in{" "}
        <span className="break-all text-text">{lastKnownPlace(project)}</span>, but that folder isn't there any more.
        It may have been moved, renamed or deleted, or it's on a drive or network share that isn't connected right now.
      </p>
      <p className="mt-3 text-sm leading-relaxed text-muted">
        If you moved it, show Texo where it is now. Removing it from the list doesn't delete any files.
      </p>
      <div className="mt-5 flex justify-end gap-2">
        <Button
          onClick={() => {
            onClose();
            void forget(project);
          }}
        >
          Remove from list
        </Button>
        <Button autoFocus variant="primary" onClick={() => void find()}>
          Find folder…
        </Button>
      </div>
    </Modal>
  );
}
