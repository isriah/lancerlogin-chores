// Small pieces the Admin pages share, built on Core's dashboard classes: notices, status pills and a loading line.
import { useEffect, useRef, type ReactNode } from "react";

export type Tone = "success" | "warning" | "error" | "neutral";

export function Pill({ label, tone }: { label: string; tone: Tone }) {
  return tone === "neutral"
    ? <span className="status-pill ui-status ch-pill-neutral">{label}</span>
    : <span className="status-pill ui-status" data-tone={tone}>{label}</span>;
}

export type NoticeValue = { readonly tone?: "success" | "warning" | "error"; readonly content: ReactNode };

/** A status line. `focusKey` moves focus to it when it changes, for a result the person needs to meet at once. */
export function Notice({ notice, focusKey, action }: { notice: NoticeValue; focusKey?: unknown; action?: ReactNode }) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (focusKey) ref.current?.focus(); }, [focusKey]);
  return <p ref={ref} tabIndex={-1} className={`ui-status settings-notice ch-notice${action ? " ch-notice-action" : ""}`} data-tone={notice.tone} role={notice.tone === "error" ? "alert" : "status"}>
    {action ? <span>{notice.content}</span> : notice.content}{action}
  </p>;
}

/** A loading or failure line for a section, with Try again after a failure. */
export function LoadState({ loading, error, label, onRetry }: { loading: boolean; error: string; label: string; onRetry: () => void }) {
  if (error) return <Notice notice={{ tone: "error", content: error }} action={<button className="ui-button" type="button" onClick={onRetry}>Try again</button>} />;
  return loading ? <p className="ui-status settings-notice ch-notice" role="status">Loading {label}...</p> : null;
}
