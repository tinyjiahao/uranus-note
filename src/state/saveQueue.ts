import type { ContentNode, NoteDetail } from "../../shared/dto";
import { patchNote, uuidv7, type NotePatch } from "../api/client";
import { deleteDraftIfSequence, putDraft } from "./drafts";

export type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "error" | "conflict";
export type SaveInfo = { localSaved: boolean; confirmedAt?: number };
type Queued = { patch: NotePatch; sequence: number; operationId: string };

export class NoteSaveQueue {
  private revision: number;
  private pending: Queued | undefined;
  private failed: Queued | undefined;
  private running = false;
  private sequence = Date.now() * 1000;
  private draftTimer?: number;
  private saveTimer?: number;
  private localSequence = -1;
  private confirmedSequence = -1;
  private latestContent: ContentNode | undefined;
  private active: Promise<void> | undefined;
  private status: SaveStatus = "idle";
  private lastError: Error | undefined;
  private confirmedAt: number | undefined;

  constructor(private noteId: number, revision: number, private onStatus: (status: SaveStatus, note?: NoteDetail, error?: Error, info?: SaveInfo) => void) {
    this.revision = revision;
  }

  updateRevision(revision: number) { if (!this.running && !this.failed && !this.pending) this.revision = revision; }

  localContent() { return this.latestContent; }
  hasUnsaved() { return this.running || Boolean(this.pending || this.failed); }
  notify() { this.report(this.status, undefined, this.lastError); }
  private report(status: SaveStatus, note?: NoteDetail, error?: Error) {
    this.status = status; this.lastError = error;
    this.onStatus(status, note, error, { localSaved: this.localSequence === this.sequence, ...(this.confirmedAt ? { confirmedAt: this.confirmedAt } : {}) });
  }
  private async persist(sequence: number, content: ContentNode) {
    try {
      const stored = await putDraft({ noteId: this.noteId, baseRevision: this.revision, contentSchemaVersion: 4, editSequence: sequence, updatedAt: Date.now(), content });
      if (sequence <= this.confirmedSequence) { await deleteDraftIfSequence(this.noteId, sequence); return; }
      if (stored) this.localSequence = Math.max(this.localSequence, sequence);
      if (sequence === this.sequence) this.report(this.status, undefined, this.lastError);
    } catch { /* A failed local copy must not claim to be safely stored. Server saving still runs. */
      if (sequence === this.sequence) this.report(this.status, undefined, this.lastError);
    }
  }

  resolveWithServer(revision: number) {
    const sequences = [this.failed?.sequence, this.pending?.sequence].filter((value): value is number => value !== undefined);
    this.failed = undefined; this.pending = undefined; this.revision = revision;
    for (const sequence of sequences) void deleteDraftIfSequence(this.noteId, sequence);
    this.latestContent = undefined;
    this.report("saved");
  }

  enqueue(patch: NotePatch, debounce = 800) {
    const sequence = ++this.sequence;
    this.pending = { patch: { ...this.pending?.patch, ...patch }, sequence, operationId: this.pending?.operationId ?? uuidv7() };
    this.report("dirty");
    if (patch.content) {
      window.clearTimeout(this.draftTimer);
      this.latestContent = patch.content as ContentNode;
      this.draftTimer = window.setTimeout(() => void this.persist(sequence, patch.content as ContentNode), 300);
    }
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.flush(), debounce);
  }

  async flush(keepalive = false) {
    window.clearTimeout(this.draftTimer);
    window.clearTimeout(this.saveTimer);
    if (this.latestContent && this.confirmedSequence < this.sequence) await this.persist(this.sequence, this.latestContent);
    const target = this.failed ?? this.pending;
    if (keepalive && target && new TextEncoder().encode(JSON.stringify(target.patch)).byteLength >= 60_000) return;
    if (this.active) await this.active;
    this.active = this.drain(keepalive);
    await this.active; this.active = undefined;
  }

  private async drain(keepalive = false) {
    if (this.running || (!this.failed && !this.pending)) return;
    this.running = true;
    while (this.failed || this.pending) {
      const current = this.failed ?? this.pending!;
      if (this.failed) this.failed = undefined;
      else this.pending = undefined;
      this.report("saving", undefined, this.lastError);
      try {
        let result: Awaited<ReturnType<typeof patchNote>> | undefined;
        let lastError: unknown;
        for (let attempt = 0; attempt < 4; attempt++) {
          try { result = await patchNote(this.noteId, this.revision, current.patch, keepalive, current.operationId); break; }
          catch (error) {
            lastError = error;
            const status = (error as { status?: number }).status;
            if (status !== undefined && status !== 429 && status !== 503) break;
            if (attempt < 3) await new Promise((resolve) => window.setTimeout(resolve, 250 * 2 ** attempt + Math.random() * 100));
          }
        }
        if (!result) throw lastError;
        this.revision = result.applied_revision;
        this.confirmedSequence = Math.max(this.confirmedSequence, current.sequence);
        this.confirmedAt = Date.now();
        await deleteDraftIfSequence(this.noteId, current.sequence).catch(() => undefined);
        this.report(this.pending ? "dirty" : "saved", result.note);
      } catch (error) {
        this.failed = current;
        const typed = error as Error & { status?: number };
        this.report(typed.status === 409 ? "conflict" : "error", undefined, typed);
        break;
      }
    }
    this.running = false;
  }
}
