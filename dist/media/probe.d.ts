import type { MediaInfo } from "./types.js";
export type ProbeResult = {
    ok: true;
    data: MediaInfo;
} | {
    ok: false;
    error: string;
    code: "NOT_FOUND" | "NO_FFPROBE" | "PARSE_ERROR" | "PROBE_FAILED";
};
export declare function probeFile(filePath: string): Promise<ProbeResult>;
//# sourceMappingURL=probe.d.ts.map