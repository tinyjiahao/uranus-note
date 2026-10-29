import { useQuery } from "@tanstack/react-query";
import { Braces, CheckSquare, FileSymlink, Heading, Image as ImageIcon, Link2, Paperclip, Pilcrow, Table2, Tag } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import type { ContentNode, FolderDto, NoteListItem } from "../../shared/dto";
import { computeContentStats, formatBytes } from "../../shared/noteStats";
import { getNote, getNoteStats } from "../api/client";
import { Popup, type PopupAnchor } from "./Popup";

const full = (value: number) => new Date(value).toLocaleString();
const ago = (value: number) => {
  const seconds = Math.round((value - Date.now()) / 1000), abs = Math.abs(seconds);
  const [amount, unit] = abs < 60 ? [seconds, "second"] as const : abs < 3600 ? [Math.round(seconds / 60), "minute"] as const : abs < 86400 ? [Math.round(seconds / 3600), "hour"] as const : [Math.round(seconds / 86400), "day"] as const;
  return new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" }).format(amount, unit);
};
const Row = ({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) => <div className="note-info-row" title={hint}><dt>{label}</dt><dd>{children}</dd></div>;
const Section = ({ title, children }: { title: string; children: ReactNode }) => <section><h3>{title}</h3>{children}</section>;
const Tile = ({ label, value, unit }: { label: string; value: string; unit?: string }) => <div className="note-info-tile"><strong>{value}{unit && <small>{unit}</small>}</strong><span>{label}</span></div>;
const Chip = ({ icon, label, value }: { icon: ReactNode; label: string; value: string | number }) => <li className="note-info-chip" title={label}>{icon}<span>{label}</span><b>{value}</b></li>;
const size = (value: { count: number; size: number }) => `${value.count} 个 · ${formatBytes(value.size)}`;

export function NoteInfo({ userId, note, folder, localContent, anchor, close }: { userId: string; note: NoteListItem; folder?: FolderDto | undefined; localContent?: (() => ContentNode | undefined) | undefined; anchor: PopupAnchor; close: () => void }) {
  const detail = useQuery({ queryKey: ["user", userId, "note", note.id], queryFn: () => getNote(note.id) });
  const stats = useQuery({ queryKey: ["user", userId, "note", note.id, "stats"], queryFn: () => getNoteStats(note.id), staleTime: 0, gcTime: 0 });
  const content = localContent?.() ?? detail.data?.content;
  const summary = useMemo(() => content ? computeContentStats(content) : null, [content]);
  const meta = detail.data ?? note;
  const states = [meta.pinned && "已置顶", meta.starred && "已加星标", meta.deletedAt && "最近删除"].filter(Boolean) as string[];
  const chips = summary ? [
    [<Pilcrow key="p" />, "段落", summary.paragraphs], [<Heading key="h" />, "标题", summary.headings], [<ImageIcon key="i" />, "图片", summary.images],
    [<Paperclip key="f" />, "文件", summary.files], [<Table2 key="t" />, "表格", summary.tables], [<Braces key="c" />, "代码块", summary.codeBlocks],
    [<Link2 key="l" />, "链接", summary.links], [<FileSymlink key="n" />, "笔记链接", summary.noteLinks], [<Tag key="g" />, "标签", summary.labels],
    [<CheckSquare key="k" />, "任务", summary.tasks.total ? `${summary.tasks.done}/${summary.tasks.total}` : 0],
  ] as const : [];
  return <Popup anchor={anchor} title="笔记信息" close={close} className="note-info-popup">
    <div className="note-info" role="group" aria-label="笔记信息">
      {detail.isError && <p role="alert">正文读取失败，部分信息不可用。</p>}
      {!summary && !detail.isError && <p role="status">正在读取…</p>}
      {summary && <div className="note-info-tiles">
        <Tile label="字数" value={summary.words.toLocaleString()} />
        <Tile label={`字符（不含空白 ${summary.charactersNoSpace.toLocaleString()}）`} value={summary.characters.toLocaleString()} />
        <Tile label="预计阅读" value={summary.readingMinutes ? String(summary.readingMinutes) : "—"} unit={summary.readingMinutes ? " 分钟" : ""} />
        <Tile label="正文大小" value={formatBytes(summary.bytes)} />
      </div>}
      <Section title="时间与位置">
        <dl>
          <Row label="创建">{full(meta.createdAt)}</Row>
          <Row label="更新">{full(meta.updatedAt)}<small>{ago(meta.updatedAt)}</small></Row>
          {meta.deletedAt && <Row label="删除">{full(meta.deletedAt)}<small>{ago(meta.deletedAt)}</small></Row>}
          <Row label="文件夹">{folder?.name ?? "—"}</Row>
          <Row label="状态">{states.length ? <span className="note-info-states">{states.map(state => <em key={state}>{state}</em>)}</span> : "正常"}</Row>
        </dl>
      </Section>
      {summary && <Section title="内容元素">
        {chips.some(([, , value]) => value) ? <ul className="note-info-chips">{chips.filter(([, , value]) => value).map(([icon, label, value]) => <Chip key={label} icon={icon} label={label} value={value} />)}</ul> : <p>没有特殊元素</p>}
      </Section>}
      <Section title="附件">
        {stats.isError ? <p role="alert">附件统计读取失败。</p> : !stats.data ? <p role="status">正在统计…</p> : !stats.data.attachments.count ? <p>没有附件</p> : <dl>
          <Row label="合计">{size(stats.data.attachments)}</Row>
          {stats.data.attachments.images.count > 0 && <Row label="图片">{size(stats.data.attachments.images)}</Row>}
          {stats.data.attachments.files.count > 0 && <Row label="文件">{size(stats.data.attachments.files)}</Row>}
          {stats.data.attachments.historyOnly.count > 0 && <Row label="仅历史引用" hint="当前正文已不再使用，但历史版本仍引用，不会被清理">{size(stats.data.attachments.historyOnly)}</Row>}
          {stats.data.attachments.awaitingCleanup.count > 0 && <Row label="待清理" hint="没有任何引用，宽限期后自动清理">{size(stats.data.attachments.awaitingCleanup)}</Row>}
        </dl>}
      </Section>
      <Section title="版本">
        {stats.data ? <dl><Row label="历史版本">{stats.data.versions.count ? `${stats.data.versions.count} 个` : "无"}</Row>{stats.data.versions.latestAt && <Row label="最近一个">{full(stats.data.versions.latestAt)}<small>{ago(stats.data.versions.latestAt)}</small></Row>}</dl> : <p role="status">正在统计…</p>}
      </Section>
      <details className="note-info-tech">
        <summary>技术信息</summary>
        <dl>
          <Row label="版本号">r{meta.revision}</Row>
          {detail.data && <Row label="内容格式">schema {detail.data.contentSchemaVersion}</Row>}
          <Row label="笔记 ID">{note.id}</Row>
        </dl>
      </details>
    </div>
  </Popup>;
}
