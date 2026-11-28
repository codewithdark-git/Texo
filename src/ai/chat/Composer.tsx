// The chat composer: Enter sends and Shift+Enter starts a new line; "@" suggests
// project files; "Include current file / selection"; attach button, paste and
// drag-drop for pictures and files (with previews and remove); the model
// picker; and Stop while an answer is written.

import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { ArrowUp, FileText, Loader2, Paperclip, Square, TextSelect, X } from "lucide-react";
import { aiApi, type AiModel, type AiProviderInfo } from "../../lib/api";
import { useWorkspace } from "../../workspace/store";
import { baseName } from "../../workspace/paths";
import { toast } from "../../ui";
import { useChat } from "./chatStore";
import { activeTextFile, attachFiles, CHAT_DROP_ATTR, currentFileContext, dirtyBuffers } from "./composerActions";
import { applyMention, mentionableFiles, mentionQuery, suggestMentions, type MentionQuery } from "./mentions";
import { buildSendInput } from "./sendInput";

const ACCEPT = "image/png,image/jpeg,image/gif,image/webp,image/bmp,.pdf,.tex,.ltx,.bib,.sty,.cls,.bst,.txt,.md,.markdown,.csv,.tsv,.json,.yaml,.yml,.xml,.svg,.log,.py,.r,.m";

/** The provider's live model list, fetched once per provider while Texo runs. */
const modelCache = new Map<string, Promise<AiModel[]>>();
function loadModels(provider: AiProviderInfo["id"]): Promise<AiModel[]> {
  let p = modelCache.get(provider);
  if (!p) {
    p = aiApi.listModels(provider).catch((err) => {
      modelCache.delete(provider);
      throw err;
    });
    modelCache.set(provider, p);
  }
  return p;
}

/** The model for the open chat; also used by the AI Chat bar under the editor. */
export function ModelPicker({ provider, disabled, className = "max-w-[50%]" }: { provider: AiProviderInfo; disabled: boolean; className?: string }) {
  const chat = useChat((s) => s.current);
  const choice = useChat((s) => s.modelChoice[s.current?.id ?? ""]);
  const setChoice = useChat((s) => s.setModelChoice);
  const [models, setModels] = useState<AiModel[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setModels(null);
    setFailed(false);
    loadModels(provider.id).then(
      (list) => live && setModels(list),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [provider.id]);

  const value = choice ?? chat?.model ?? "";
  const defaultLabel = provider.id === "nvidia" ? "Default (fast chat model)" : `Default${provider.model ? ` (${provider.model})` : ""}`;
  const known = models ?? [];
  const extra = value && !known.some((m) => m.id === value) ? [value] : [];
  return (
    <select
      aria-label="Model"
      title={failed ? "Texo couldn't load the model list. The default model is used." : "Model for this chat"}
      disabled={disabled}
      value={value}
      onChange={(e) => {
        const next = e.target.value;
        if (!next && chat?.model) {
          toast("This chat keeps the model it was given. Start a new chat to use the default.", "info");
          return;
        }
        setChoice(next);
      }}
      className={`h-7 min-w-0 ${className} flex-shrink truncate rounded-md border border-border bg-surface px-1.5 text-[11px] text-muted outline-none hover:text-text focus:border-accent`}
    >
      <option value="">{defaultLabel}</option>
      {extra.map((m) => (
        <option key={m} value={m}>
          {m}
        </option>
      ))}
      {models === null && !failed && <option disabled>Loading models…</option>}
      {known.map((m) => (
        <option key={m.id} value={m.id}>
          {m.label || m.id}
          {m.recommended ? " (suggested)" : ""}
          {m.free ? " · free" : ""}
        </option>
      ))}
    </select>
  );
}

function Attachments() {
  const items = useChat((s) => s.attachments);
  const remove = useChat((s) => s.removeAttachment);
  if (!items.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5 px-2 pt-2">
      {items.map((a) => (
        <div key={a.id} className="group relative flex h-12 max-w-44 items-center gap-1.5 rounded-md border border-border bg-surface-2 pr-6 text-[11px]" title={a.note ?? a.name}>
          {a.status === "reading" ? (
            <span className="flex h-12 w-10 items-center justify-center">
              <Loader2 size={14} className="animate-spin text-muted" />
            </span>
          ) : a.kind === "image" && a.dataUrl ? (
            <img src={a.dataUrl} alt="" className="h-12 w-12 rounded-l-md object-cover" />
          ) : (
            <span className="flex h-12 w-8 items-center justify-center text-muted">
              <FileText size={15} />
            </span>
          )}
          <span className="min-w-0">
            <span className="block truncate text-text">{a.name}</span>
            <span className="block truncate text-muted">{a.status === "reading" ? "Reading…" : a.note}</span>
          </span>
          <button
            type="button"
            aria-label={`Remove ${a.name}`}
            onClick={() => remove(a.id)}
            className="absolute right-1 top-1 rounded p-0.5 text-muted hover:bg-surface hover:text-text"
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function Composer({ provider, disabled, disabledReason }: { provider: AiProviderInfo | null; disabled: boolean; disabledReason?: string }) {
  const chatId = useChat((s) => s.current?.id ?? "");
  const draft = useChat((s) => s.drafts[chatId] ?? "");
  const setDraft = useChat((s) => s.setDraft);
  const pending = useChat((s) => (s.current ? s.pending[s.current.id] : undefined));
  const attachments = useChat((s) => s.attachments);
  const includeContext = useChat((s) => s.includeContext);
  const setIncludeContext = useChat((s) => s.setIncludeContext);
  const choice = useChat((s) => s.modelChoice[chatId]);
  const files = useWorkspace((s) => s.files);
  const active = useWorkspace((s) => s.active);
  const isText = useWorkspace((s) => (s.active ? s.views[s.active]?.kind === "text" : false));
  const input = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [mention, setMention] = useState<MentionQuery | null>(null);
  const [pick, setPick] = useState(0);
  const [dragging, setDragging] = useState(false);

  const paths = useMemo(() => mentionableFiles(files), [files]);
  const suggestions = useMemo(() => (mention ? suggestMentions(paths, mention.query) : []), [mention, paths]);
  const menuOpen = mention !== null && suggestions.length > 0;
  const reading = attachments.some((a) => a.status === "reading");
  const canSend = !disabled && !pending && !reading && (draft.trim().length > 0 || attachments.length > 0);
  const contextFile = isText ? active : null;

  // Grow with the text, up to about ten lines.
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(220, el.scrollHeight)}px`;
  }, [draft]);

  // Focus the box when a chat opens.
  useEffect(() => {
    if (!disabled) input.current?.focus();
  }, [chatId, disabled]);

  const updateMention = (text: string, caret: number) => {
    const q = mentionQuery(text, caret);
    setMention(q);
    setPick(0);
  };

  const choose = (path: string) => {
    const el = input.current;
    if (!el || !mention) return;
    const out = applyMention(draft, mention, el.selectionStart, path);
    setDraft(out.text);
    setMention(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(out.caret, out.caret);
    });
  };

  const submit = () => {
    if (!canSend) return;
    const file = includeContext && activeTextFile() ? currentFileContext() : undefined;
    void useChat.getState().send(
      buildSendInput({ text: draft, attachments: useChat.getState().attachments, currentFile: file, dirtyBuffers: dirtyBuffers(), model: choice }),
    );
    setMention(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (menuOpen) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setPick((i) => (i + step + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        choose(suggestions[pick] ?? suggestions[0]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setMention(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      submit();
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = [...e.clipboardData.files];
    if (!pasted.length) return;
    // A screenshot comes as a file only; keep any text that comes with it.
    if (!e.clipboardData.getData("text/plain")) e.preventDefault();
    attachFiles(pasted);
  };

  const hasFiles = (e: DragEvent) => [...e.dataTransfer.types].includes("Files");
  const onDrop = (e: DragEvent) => {
    setDragging(false);
    if (!hasFiles(e)) return;
    e.preventDefault();
    attachFiles([...e.dataTransfer.files]);
  };

  return (
    <div className="shrink-0 border-t border-border p-2">
      <div
        {...{ [CHAT_DROP_ATTR]: "" }}
        onDragOver={(e) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`relative rounded-xl border bg-bg transition ${dragging ? "border-accent" : "border-border focus-within:border-accent/70"} ${disabled ? "opacity-60" : ""}`}
      >
        {menuOpen && (
          <ul role="listbox" aria-label="Files" className="absolute inset-x-1 bottom-full z-20 mb-1 max-h-56 overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-xl">
            {suggestions.map((p, i) => (
              <li key={p}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === pick}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    choose(p);
                  }}
                  className={`flex w-full items-center gap-2 truncate rounded-md px-2 py-1 text-left text-xs ${i === pick ? "bg-surface-2 text-text" : "text-muted"}`}
                >
                  <FileText size={12} className="shrink-0" />
                  <span className="truncate">{p}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <Attachments />
        <textarea
          ref={input}
          rows={1}
          value={draft}
          disabled={disabled}
          placeholder={disabled ? (disabledReason ?? "") : "Ask about your paper. Type @ to add a file."}
          aria-label="Message"
          onChange={(e) => {
            setDraft(e.target.value);
            updateMention(e.target.value, e.target.selectionStart);
          }}
          onSelect={(e) => updateMention(e.currentTarget.value, e.currentTarget.selectionStart)}
          onBlur={() => setMention(null)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          className="block max-h-[220px] w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-[13px] leading-relaxed outline-none placeholder:text-muted/80"
        />
        <div className="flex items-center gap-1 px-1.5 pb-1.5">
          <input
            ref={picker}
            type="file"
            multiple
            accept={ACCEPT}
            className="hidden"
            onChange={(e) => {
              if (e.target.files) attachFiles([...e.target.files]);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            disabled={disabled}
            onClick={() => picker.current?.click()}
            aria-label="Attach pictures or files"
            title="Attach pictures, PDFs or text files (or paste / drop them here)"
            className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-text disabled:opacity-50"
          >
            <Paperclip size={14} />
          </button>
          <button
            type="button"
            disabled={disabled || !contextFile}
            aria-pressed={includeContext && !!contextFile}
            onClick={() => setIncludeContext(!includeContext)}
            title={contextFile ? "Send the open file (or the selected lines) with your message" : "Open a file to include it"}
            className={`inline-flex h-7 min-w-0 items-center gap-1 rounded-md px-1.5 text-[11px] disabled:opacity-50 ${
              includeContext && contextFile ? "bg-accent/15 text-text" : "text-muted hover:bg-surface-2 hover:text-text"
            }`}
          >
            {includeContext ? <TextSelect size={12} className="shrink-0" /> : <FileText size={12} className="shrink-0" />}
            <span className="truncate">{contextFile ? `Include ${baseName(contextFile)}` : "Include current file"}</span>
          </button>
          <span className="flex-1" />
          {provider && <ModelPicker provider={provider} disabled={disabled || !!pending} />}
          {pending ? (
            <button
              type="button"
              onClick={() => void useChat.getState().stop()}
              disabled={pending.stopping}
              aria-label="Stop the answer"
              title="Stop"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-text hover:brightness-110 disabled:opacity-50"
            >
              <Square size={12} className="fill-current" />
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!canSend}
              aria-label="Send"
              title={reading ? "Reading attachments…" : "Send (Enter)"}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-ink hover:bg-accent-strong disabled:opacity-40"
            >
              <ArrowUp size={14} />
            </button>
          )}
        </div>
      </div>
      <p className="mt-1 px-1 text-[10px] text-muted/80">Enter sends, Shift+Enter starts a new line. AI answers can be wrong; check them.</p>
    </div>
  );
}
