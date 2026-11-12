export type StatusLevel = "up" | "degraded" | "down" | "unknown";

export interface Channel {
  id: string;
  label: string;
  platform: string;
  version: string;
  runId: number;
  releaseDate: string;
  status: StatusLevel;
  lagVersions: number;
  strip: StatusLevel[];
}

export interface TimelineRow {
  date: string;
  upstream: string;
  versions: Record<string, string>;
}

export const PROBE_OBSERVED_AT = "2026-11-09T17:09:24Z";

export const channels: Channel[] = [
  {
    id: "win-x64",
    label: "Windows x64",
    platform: "win32-x64",
    version: "0.2.2-rc.1",
    runId: 293425336,
    releaseDate: "2026-11-04T09:31:49Z",
    status: "up",
    lagVersions: 0,
    strip: ["up", "up", "up", "up", "up", "up", "up", "up", "up", "up"],
  },
  {
    id: "mac-arm64",
    label: "macOS arm64",
    platform: "darwin-arm64",
    version: "0.2.2-rc.1",
    runId: 353501474,
    releaseDate: "2026-11-04T09:24:35Z",
    status: "up",
    lagVersions: 0,
    strip: ["up", "up", "up", "up", "up", "up", "up", "up", "up", "up"],
  },
  {
    id: "mac-x64",
    label: "macOS x64",
    platform: "darwin-x64",
    version: "0.2.1-rc.4",
    runId: 369524912,
    releaseDate: "2026-10-27T08:15:01Z",
    status: "degraded",
    lagVersions: 2,
    strip: ["degraded", "degraded", "degraded", "degraded", "degraded", "degraded", "degraded", "degraded", "degraded", "degraded"],
  },
];

export const timelineDates = [
  "2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04",
  "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08", "2026-11-09",
];

export const timeline: TimelineRow[] = timelineDates.map((date) => {
  const current = date >= "2026-11-05";
  const upstream = current ? "0.2.2-rc.1" : "0.2.1-rc.5";
  return {
    date,
    upstream,
    versions: {
      "win-x64": upstream,
      "mac-arm64": upstream,
      "mac-x64": "0.2.1-rc.4",
    },
  };
});

export const sha512Gate = {
  runId: 42017254510,
  runDate: "2026-11-05",
  sha512Prefix: "swcK0J6ofGkaAWLR",
  conclusion: "success" as const,
  artifactUrl: "https://github.com/TurnX-alt/actdsh/actions/runs/42017254510",
};

export interface ManifestDep {
  name: string;
  version: string;
}

export const manifest = {
  pinnedCount: 320,
  independent: [
    { name: "cordis", version: "4.1.0" },
    { name: "schemastery", version: "3.19.0" },
    { name: "cordis-plugin-timer", version: "1.2.0" },
    { name: "cordis-plugin-loader", version: "1.1.0" },
    { name: "cordis-plugin-include", version: "1.1.0" },
    { name: "cosmokit", version: "1.9.0" },
    { name: "cordis-plugin-group", version: "1.1.0" },
    { name: "libreoffice-kit", version: "0.1.5" },
    { name: "node-addon-system", version: "0.1.2" },
  ] as ManifestDep[],
};