import type { StatusLevel } from "@/data/verification";

export const statusMeta: Record<
  StatusLevel,
  { label: string; bar: string; text: string; dot: string }
> = {
  up: {
    label: "当前",
    bar: "bg-status-up",
    text: "text-status-up-ink",
    dot: "bg-status-up",
  },
  degraded: {
    label: "落后",
    bar: "bg-status-degraded",
    text: "text-status-degraded-ink",
    dot: "bg-status-degraded",
  },
  down: {
    label: "不可达",
    bar: "bg-status-down",
    text: "text-status-down-ink",
    dot: "bg-status-down",
  },
  unknown: {
    label: "无数据",
    bar: "bg-status-unknown",
    text: "text-muted-foreground",
    dot: "bg-status-unknown",
  },
};

export function formatDate(iso: string): string {
  return iso.slice(0, 10);
}

export function formatDateTime(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}