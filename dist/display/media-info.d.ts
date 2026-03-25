import type { MediaInfo } from "../media/types.js";
export declare function formatDuration(seconds: number): string;
export declare function formatFileSize(bytes: number): string;
export declare function formatBitrate(kbps: number): string;
export declare function formatResolution(width: number, height: number): string;
export declare function resolutionLabel(width: number, height: number): string;
export declare function formatVideoCodec(codec: string): string;
export declare function formatAudioCodec(codec: string): string;
export declare function formatChannels(channels: number): string;
export declare function formatAudio(info: MediaInfo): string;
export declare function formatContainer(formatName: string): string;
export declare function formatFps(fps: number): string;
export declare function renderMediaInfo(info: MediaInfo): string;
//# sourceMappingURL=media-info.d.ts.map