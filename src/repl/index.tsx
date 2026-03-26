import { render } from "ink";
import React from "react";
import { App } from "./App.js";

export function startRepl(): void {
  render(<App />);
}
