import type { SaveInfo, SaveStatus } from "./saveQueue";

export type SaveSnapshot = { status: SaveStatus; info: SaveInfo; error: string; uploading: boolean };
const empty: SaveSnapshot = { status: "idle", info: { localSaved: false }, error: "", uploading: false };
// One instance per authenticated workspace; never share status between accounts.
export class SaveSignals {
  private values = new Map<number, SaveSnapshot>();
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  get = (id: number) => this.values.get(id) ?? empty;
  update(id: number, patch: Partial<SaveSnapshot>) {
    this.values.set(id, { ...this.get(id), ...patch });
    this.listeners.forEach(listener => listener());
  }
}
