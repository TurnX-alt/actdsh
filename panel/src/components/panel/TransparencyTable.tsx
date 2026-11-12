import { PROBE_OBSERVED_AT } from "@/data/verification";
import { formatDateTime } from "@/lib/status";

const rows = [
  {
    item: "探针快照",
    source: "probe-upstream workflow",
    note: `HEAD 探测官方 feed，观测于 ${formatDateTime(PROBE_OBSERVED_AT)}`,
  },
  {
    item: "sha512 门禁",
    source: "release-desktop workflow",
    note: "对官方字节做 sha512 校验，失败即中止（fail-closed）",
  },
  {
    item: "依赖清单",
    source: "构建 lockfile + 独立补充表",
    note: "320 个钉死 + 9 个独立固定，逐项可核对",
  },
];

export function TransparencyTable() {
  return (
    <section aria-label="数据来源" className="flex flex-col gap-4">
      <h2 className="text-base font-medium text-muted-foreground">数据来源</h2>
      <div className="overflow-hidden rounded-2xl bg-card ring-1 ring-foreground/10">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-border text-xs text-muted-foreground">
              <th className="px-5 py-3 font-medium">证据</th>
              <th className="px-5 py-3 font-medium">来源</th>
              <th className="px-5 py-3 font-medium">说明</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.item} className="border-b border-border last:border-0">
                <td className="px-5 py-3 font-medium whitespace-nowrap">{row.item}</td>
                <td className="px-5 py-3 font-mono text-xs text-muted-foreground">
                  {row.source}
                </td>
                <td className="px-5 py-3 text-xs text-muted-foreground">{row.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        本面板为独立校验视图，不代表官方立场；所列三类证据均可由任何人独立核对。
      </p>
    </section>
  );
}