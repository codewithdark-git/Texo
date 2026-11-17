import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, FlaskConical, Heart, Server, Sparkles, Star, Wrench } from "lucide-react";
import { useUi } from "../ui";
import { Button, Modal } from "./Dialog";

/** The contribution section of the studio's support page. */
export const SUPPORT_URL = "https://xcollab.pages.dev/support#contribute";
const REPO = "https://github.com/codewithdark-git/Texo";

const FUNDS: [typeof Wrench, string, string][] = [
  [Wrench, "Maintenance", "Fixing bugs and keeping Texo working as systems change"],
  [Server, "Infrastructure", "The services needed to build, test and publish"],
  [FlaskConical, "Research", "Time to try an idea properly before it ships"],
  [Sparkles, "New features", "What comes next in Texo and the next product"],
];

/** The sidebar button: "Support us", with the supporters line underneath. */
export function SupportButton() {
  const openDialog = useUi((s) => s.openDialog);
  return (
    <button
      type="button"
      onClick={() => openDialog("support")}
      className="group flex w-full items-center gap-3 rounded-xl border border-accent/25 bg-gradient-to-br from-accent/15 to-accent/5 px-3 py-2.5 text-left transition hover:border-accent/50 hover:from-accent/25"
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent/20 text-accent transition group-hover:scale-105">
        <Heart size={16} className="fill-current" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">Support us</span>
        <span className="block truncate text-xs text-muted">Join the supporters</span>
      </span>
    </button>
  );
}

export function SupportDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Support Texo" onClose={onClose}>
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent/15 text-accent">
          <Heart size={20} className="fill-current" />
        </span>
        <p className="text-sm leading-relaxed text-muted">
          Texo is free and has no ads. It keeps getting better because the people who use it choose to support the
          project with funds. Every contribution goes straight to development.
        </p>
      </div>

      <div className="mt-4 rounded-lg border border-border bg-bg/60 p-3">
        <div className="mb-2 text-xs font-medium text-muted">What supporters fund</div>
        <ul className="grid grid-cols-2 gap-x-3 gap-y-2.5">
          {FUNDS.map(([Icon, title, detail]) => (
            <li key={title} className="flex gap-2">
              <Icon size={14} className="mt-0.5 shrink-0 text-accent" />
              <div>
                <div className="text-xs font-medium">{title}</div>
                <div className="text-[11px] leading-snug text-muted">{detail}</div>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <p className="mt-3 text-xs leading-relaxed text-muted">
        Pick any amount from $20, paid once. The support page takes you through payment, which Polar processes
        securely and sends you a receipt.
      </p>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => void openUrl(REPO)}
          className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-text"
          title="Starring the repository on GitHub helps too"
        >
          <Star size={13} /> Star on GitHub
        </button>
        <div className="flex gap-2">
          <Button onClick={onClose}>Not now</Button>
          <Button
            autoFocus
            variant="primary"
            onClick={() => {
              void openUrl(SUPPORT_URL);
              onClose();
            }}
          >
            <Heart size={14} className="fill-current" /> Support Texo <ExternalLink size={13} />
          </Button>
        </div>
      </div>
    </Modal>
  );
}
