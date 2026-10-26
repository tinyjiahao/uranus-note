import type { ContentNode, NoteDetail } from "../../shared/dto";
import { patchNote, uuidv7, type NotePatch } from "../api/client";
import { deleteDraftIfSequence, putDraft } from "./drafts";

export type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "error" | "conflict";
export type SaveInfo = { localSaved: boolean; localError?: boolean; confirmedAt?: number };
type Queued = { patch: NotePatch; sequence: number; operationId: string };

export class NoteSaveQueue {
  private revision: number;
  private pending: Queued | undefined;
  private failed: Queued | undefined;
  private running = false;
  private sequence = Date.now() * 1000;
  private draftTimer: number | undefined;
  private draftMaxTimer: number | undefined;
  private saveTimer: number | undefined;
  private syncInterval = 30_000;
  private localSequence = -1;
  private confirmedSequence = -1;
  private latestContent: ContentNode | undefined;
  private active: Promise<void> | undefined;
  private status: SaveStatus = "idle";
  private lastError: Error | undefined;
  private confirmedAt: number | undefined;
  private localError = false;

  constructor(private noteId: number, revision: number, private onStatus: (status: SaveStatus, note?: NoteDetail, error?: Error, info?: SaveInfo) => void) {
    this.revision = revision;
  }

  // Blur/unmount callbacks can still hold an earlier React render's note.
  // Never roll back a revision already confirmed by our own successful save.
  updateRevision(revision: number) { if (!this.running && !this.failed && !this.pending) this.revision = Math.max(this.revision, revision); }

  localContent() { return this.latestContent; }
  hasUnsaved() { return this.running || Boolean(this.pending || this.failed); }
  notify() { this.report(this.status, undefined, this.lastError); }
  setSyncInterval(milliseconds: number) {
    if (milliseconds === this.syncInterval) return;
    this.syncInterval = milliseconds;
    window.clearTimeout(this.saveTimer); this.saveTimer = undefined;
    this.scheduleSync();
  }
  private scheduleSync() {
    if (this.saveTimer !== undefined || this.running || !this.hasUnsaved() || this.status === "conflict") return;
    if (this.failed) {
      const status = (this.lastError as (Error & { status?: number }) | undefined)?.status;
      if (status !== undefined && status !== 429 && status !== 503) return;
    }
    this.saveTimer = window.setTimeout(() => { this.saveTimer = undefined; void this.flush(false, false); }, this.syncInterval);
  }
  retryOnline() { if (this.status === "error") { this.scheduleSync(); if (this.saveTimer !== undefined) void this.flush(false, false); } }
  async persistLocal() {
    window.clearTimeout(this.draftTimer); window.clearTimeout(this.draftMaxTimer);
    this.draftTimer = this.draftMaxTimer = undefined;
    if (this.latestContent && this.confirmedSequence < this.sequence) await this.persist(this.sequence, this.latestContent);
  }
  private report(status: SaveStatus, note?: NoteDetail, error?: Error) {
    this.status = status; this.lastError = error;
    this.onStatus(status, note, error, { localSaved: this.localSequence === this.sequence, localError: this.localError, ...(this.confirmedAt ? { confirmedAt: this.confirmedAt } : {}) });
  }
  private async persist(sequence: number, content: ContentNode) {
    try {
      const stored = await putDraft({ noteId: this.noteId, baseRevision: this.revision, contentSchemaVersion: 5, editSequence: sequence, updatedAt: Date.now(), content });
      if (sequence <= this.confirmedSequence) { await deleteDraftIfSequence(this.noteId, sequence); return; }
      if (stored) { this.localSequence = Math.max(this.localSequence, sequence); if (sequence === this.sequence) this.localError = false; }
      if (sequence === this.sequence) this.report(this.status, undefined, this.lastError);
    } catch { /* A failed local copy must not claim to be safely stored. Server saving still runs. */
      if (sequence === this.sequence) this.localError = true;
      if (sequence === this.sequence) this.report(this.status, undefined, this.lastError);
    }
  }

  resolveWithServer(revision: number) {
    window.clearTimeout(this.draftTimer); window.clearTimeout(this.draftMaxTimer); window.clearTimeout(this.saveTimer);
    this.draftTimer = this.draftMaxTimer = this.saveTimer = undefined;
    const sequences = [this.failed?.sequence, this.pending?.sequence].filter((value): value is number => value !== undefined);
    this.failed = undefined; this.pending = undefined; this.revision = revision;
    this.confirmedSequence = this.sequence;
    for (const sequence of sequences) void deleteDraftIfSequence(this.noteId, sequence);
    this.latestContent = undefined;
    this.report("saved");
  }

  enqueue(patch: NotePatch, debounce?: number) {
    const sequence = ++this.sequence;
    this.pending = { patch: { ...this.pending?.patch, ...patch }, sequence, operationId: this.pending?.operationId ?? uuidv7() };
    this.report(this.failed ? this.status : "dirty", undefined, this.failed ? this.lastError : undefined);
    if (patch.content) {
      window.clearTimeout(this.draftTimer);
      this.latestContent = patch.content as ContentNode;
      this.draftTimer = window.setTimeout(() => void this.persistLocal(), 800);
      if (this.draftMaxTimer === undefined) this.draftMaxTimer = window.setTimeout(() => void this.persistLocal(), 3000);
    }
    if (debounce !== undefined && this.status !== "conflict") {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = window.setTimeout(() => { this.saveTimer = undefined; void this.flush(); }, debounce);
    } else this.scheduleSync();
  }

  async flush(keepalive = false, drainPending = true) {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    await this.persistLocal();
    if (this.status === "conflict") return;
    const target = this.failed ?? this.pending;
    if (keepalive && target && new TextEncoder().encode(JSON.stringify(target.patch)).byteLength >= 60_000) { this.scheduleSync(); return; }
    if (this.active) await this.active;
    this.active = this.drain(keepalive, drainPending);
    await this.active; this.active = undefined;
    this.scheduleSync();
  }

  private async drain(keepalive = false, drainPending = true) {
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
        if (this.pending && this.latestContent) await this.persist(this.sequence, this.latestContent);
        this.report(this.pending ? "dirty" : "saved", result.note);
        if (!drainPending) break;
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
