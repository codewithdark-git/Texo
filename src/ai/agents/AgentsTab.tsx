// The AI panel's Agents tab: a "New task" menu (Fix compile errors, Review
// paper…, Respond to reviewers…, Custom task…, and the user's own profiles)
// and the open project's run cards. The panel shell (src/ai/panel/AiPanel.tsx)
// owns the finish badge and toast; this tab shows runs and opens the dialogs:
// new task, review setup, plan approval, changeset review and report.

import { useEffect, useState } from "react";
import { Bot, ChevronDown, ClipboardCheck, ListTodo, MessageSquareReply, Plus, UserCog, Wrench } from "lucide-react";
import { agentsApi, profilesApi, type AgentProfile } from "../../lib/agentsApi";
import { Button, ConfirmDialog } from "../../components/Dialog";
import { Menu, type MenuItem } from "../../components/Menu";
import { toast, useUi } from "../../ui";
import { useAiSettings } from "../aiPrefs";
import { useAccess, type Access } from "../aiAccess";
import { errorText, startFixerRun, startRun } from "./actions";
import { ChangesetDialog } from "./ChangesetDialog";
import { openAgentDialog, useAgentDialog } from "./dialogStore";
import { NewTaskDialog } from "./NewTaskDialog";
import { PlanDialog } from "./PlanDialog";
import { ReportDialog } from "./ReportDialog";
import { ReviewSetupDialog } from "../review/ReviewSetupDialog";
import { RunCard } from "./RunCard";
import { listenRunEvents, runsForProject, useRuns } from "./runsStore";

export interface AgentsTabProps {
  /** The open project's folder (runs are filtered by it). */
  project: string;
}

export { openAgentDialog, type AgentDialog } from "./dialogStore";

function useProfiles(project: string): AgentProfile[] {
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  useEffect(() => {
    let live = true;
    profilesApi.list(project).then(
      (v) => live && setProfiles(v.profiles),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [project]);
  return profiles;
}

export function AgentsTab({ project }: AgentsTabProps) {
  const runs = useRuns((s) => s.runs);
  const loading = useRuns((s) => s.loading);
  const error = useRuns((s) => s.error);
  const dialog = useAgentDialog((s) => s.dialog);
  const profiles = useProfiles(project);
  const [access, recheck] = useAccess();

  useEffect(() => listenRunEvents(), []);
  useEffect(() => {
    void useRuns.getState().load(project);
    useAgentDialog.getState().open(null);
  }, [project]);

  const list = runsForProject(runs, project);
  const own = profiles.filter((p) => p.source !== "builtin" && p.kind !== "chat");

  const startProfile = (p: AgentProfile) => {
    if (p.kind === "fixer") void startRun(project, { kind: "fixer", profileId: p.id, prompt: "", options: { title: p.name } });
    else if (p.kind === "reviewer") openAgentDialog({ type: "review", profile: p });
    else openAgentDialog({ type: "new", kind: p.kind === "rebuttal" ? "rebuttal" : "task", profile: p });
  };

  const items: (MenuItem | "divider")[] = [
    { label: "Fix compile errors", hint: "Compiles, fixes and checks again", icon: <Wrench size={14} />, onSelect: () => void startFixerRun() },
    { label: "Review paper…", hint: "Reviews it like a venue's reviewers", icon: <ClipboardCheck size={14} />, onSelect: () => openAgentDialog({ type: "review" }) },
    { label: "Respond to reviewers…", hint: "Plans and drafts your response letter", icon: <MessageSquareReply size={14} />, onSelect: () => openAgentDialog({ type: "new", kind: "rebuttal" }) },
    { label: "Custom task…", hint: "Tell it what to do, attach files", icon: <ListTodo size={14} />, onSelect: () => openAgentDialog({ type: "new", kind: "task" }) },
  ];
  if (own.length) {
    items.push("divider");
    for (const p of own) items.push({ label: p.name, hint: p.description || undefined, icon: <UserCog size={14} />, onSelect: () => startProfile(p) });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <Menu
          align="left"
          items={items}
          trigger={({ toggle, open }) => (
            <Button
              variant="primary"
              onClick={toggle}
              aria-expanded={open}
              aria-haspopup="menu"
              disabled={access.state !== "ready" && access.state !== "loading"}
              title={access.state !== "ready" && access.state !== "loading" ? "Set up AI first (see the note below)." : undefined}
            >
              <Plus size={14} /> New task <ChevronDown size={13} />
            </Button>
          )}
        />
        <span className="ml-auto text-xs text-muted">{list.length ? `${list.length} run${list.length === 1 ? "" : "s"}` : ""}</span>
      </div>
      <AccessNote access={access} onAccepted={recheck} />
      {error && <p className="border-b border-danger/40 bg-danger/10 px-3 py-2 text-xs">{error}</p>}
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {list.map((r) => (
          <RunCard key={r.id} project={project} run={r} />
        ))}
        {list.length === 0 && !loading && (
          <div className="flex flex-col items-center gap-2 px-6 py-10 text-center text-sm text-muted">
            <Bot size={22} className="text-accent" />
            <p>Agents work in the background on a private copy of your project. You review every change before it's written.</p>
            <p className="text-xs">Start one with New task.</p>
          </div>
        )}
      </div>

      {dialog?.type === "new" && <NewTaskDialog project={project} kind={dialog.kind} profile={dialog.profile ?? null} profiles={profiles} onClose={close} />}
      {dialog?.type === "review" && <ReviewSetupDialog project={project} initialProfileId={dialog.profile?.id ?? null} onClose={close} />}
      {dialog?.type === "changes" && <ChangesetDialog project={project} runId={dialog.runId} onClose={close} />}
      {dialog?.type === "plan" && <PlanDialog project={project} runId={dialog.runId} onClose={close} />}
      {dialog?.type === "report" && <ReportDialog project={project} runId={dialog.runId} onClose={close} />}
      {dialog?.type === "delete" && (
        <ConfirmDialog
          title="Delete this run?"
          danger
          confirmLabel="Delete"
          message={
            <>
              “{dialog.run.title || "This run"}” and its step list will be removed.
              {dialog.run.pendingFiles > 0 && " Its changes that you haven't applied will be lost."} Changes you already applied stay in the
              project and in History.
            </>
          }
          onClose={close}
          onConfirm={() => {
            const id = dialog.run.id;
            close();
            agentsApi.delete(project, id).then(
              () => useRuns.getState().forget(id),
              (e) => toast(errorText(e), "error"),
            );
          }}
        />
      )}
    </div>
  );
}

const toAiSettings = () => useUi.getState().openSettings("ai");

/** Stable, so dialogs that depend on onClose don't re-run their effects on every run update (FE-5). */
const close = () => openAgentDialog(null);

/** What stops agents from running (AI off, no key, privacy notice), with the way out. */
function AccessNote({ access, onAccepted }: { access: Access; onAccepted: () => void }) {
  const [busy, setBusy] = useState(false);
  if (access.state === "loading" || access.state === "ready") return null;
  const box = "m-2 rounded-lg border px-3 py-2.5 text-[13px]";
  if (access.state === "off")
    return (
      <section className={`${box} border-border bg-surface-2/60`}>
        <p>AI is turned off, so agents can't run.</p>
        <Button className="mt-2" onClick={toAiSettings}>
          Open AI settings
        </Button>
      </section>
    );
  if (access.state === "noKey")
    return (
      <section className={`${box} border-amber-500/40 bg-amber-500/10`}>
        <p>Agents need your own {access.provider.label} key. Add it in Settings ▸ AI{access.provider.id === "nvidia" ? " (NVIDIA keys are free)" : ""}.</p>
        <Button className="mt-2" onClick={toAiSettings}>
          Add a key
        </Button>
      </section>
    );
  const accept = async () => {
    setBusy(true);
    try {
      await useAiSettings.getState().update({ acceptNotice: access.provider.id });
      onAccepted();
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className={`${box} border-accent/30 bg-accent/10`}>
      <p className="font-medium">Before agents work with {access.provider.label}</p>
      <p className="mt-1 text-muted">While an agent runs, Texo sends {access.provider.label}:</p>
      <ul className="mt-1 list-disc pl-5 text-muted">
        <li>what you asked for, and the files and pictures you attach,</li>
        <li>the project files the agent reads (it changes them only on a private copy),</li>
        <li>compile errors and logs from its test compiles.</li>
      </ul>
      <p className="mt-1 text-muted">
        Paper and web lookups go to those services (arXiv, Crossref, Semantic Scholar, doi.org, OpenAlex, pages it opens, and a search service if you set one up). Your API key stays on
        this computer, and nothing in your files changes until you accept it.
      </p>
      <div className="mt-2 flex gap-2">
        <Button variant="primary" disabled={busy} onClick={() => void accept()}>
          OK, let agents work
        </Button>
        <Button variant="ghost" onClick={toAiSettings}>
          AI settings
        </Button>
      </div>
    </section>
  );
}
