export interface MediaInfo {
  filePath: string;
  fileName: string;
  duration: number;         // seconds
  width: number;
  height: number;
  fps: number;
  videoCodec: string;
  audioCodec: string | null;
  audioChannels: number | null;
  audioBitrate: number | null; // kbps
  fileSize: number;         // bytes
  bitrate: number;          // kbps
  containerFormat: string;
}

// Raw FFprobe output shapes — used only inside probe.ts
export interface FfprobeStream {
  codec_type: string;
  codec_name: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  channels?: number;
  bit_rate?: string;
}

export interface FfprobeFormat {
  filename: string;
  duration: string;
  size: string;
  bit_rate: string;
  format_name: string;
}

export interface FfprobeOutput {
  streams: FfprobeStream[];
  format: FfprobeFormat;
}
