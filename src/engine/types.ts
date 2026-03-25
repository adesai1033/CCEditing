export interface TrimOperation {
  type: "trim";
  input: string;   // absolute or relative file path
  start: number;   // seconds
  end: number;     // seconds
  output: string;  // file path
}

// Union grows in future slices (concat, overlay, etc.)
export type EditOperation = TrimOperation;
