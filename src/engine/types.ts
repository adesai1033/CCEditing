export interface TrimOperation {
  type: "trim";
  input: string;   // absolute or relative file path
  start: number;   // seconds
  end: number;     // seconds
  output: string;  // file path
}

export interface ConcatOperation {
  type: "concat";
  segments: string[]; // absolute paths to pre-trimmed segment files, in order
  output: string;
}

export type EditOperation = TrimOperation | ConcatOperation;
