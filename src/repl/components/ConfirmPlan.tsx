import { Box, Text } from "ink";
import type { PlanForConfirmation } from "../../agent/propose_edit_plan.js";
import { ui, panels, glyphs } from "../../ui/theme.js";

interface Props {
  plan: PlanForConfirmation;
}

/**
 * The confirm gate (3I): the one decision moment in the tool, framed as one.
 * The summary leads; operations align into a scannable verb/target/range
 * column; clip refs and time ranges — the load-bearing data — carry the
 * emphasis. Critic concerns (3G) sit below as a clearly subordinate caution.
 */

// A rendered operation line arrives as "Verb clip [ref] label → range" (built
// by the agent's renderPlanForConfirmation). Presentation-only tokenizing:
// verb column, then refs/times highlighted inside the rest.
const TOKEN = /(\[[^\]]+\]|\d+:\d{2}(?:\.\d)?)/g;

function OpLine({ line, verbWidth }: { line: string; verbWidth: number }) {
  const space = line.indexOf(" ");
  const verb = (space > 0 ? line.slice(0, space) : line).toLowerCase();
  const rest = (space > 0 ? line.slice(space + 1) : "").replace(/^clip /, "");
  const parts = rest.split(TOKEN);
  return (
    <Text>
      <Text {...ui.muted}>{glyphs.bullet} </Text>
      <Text {...ui.accent}>{verb.padEnd(verbWidth)}</Text>
      <Text> </Text>
      {parts.map((part, i) =>
        /^\[[^\]]+\]$/.test(part) ? (
          <Text key={i} {...ui.key}>{part}</Text>
        ) : /^\d+:\d{2}/.test(part) ? (
          <Text key={i} {...ui.emphasis}>{part}</Text>
        ) : (
          <Text key={i}>{part}</Text>
        ),
      )}
    </Text>
  );
}

function Concern({ severity, operationIndex, issue }: {
  severity: "minor" | "major";
  operationIndex?: number;
  issue: string;
}) {
  return (
    <Text>
      <Text {...(severity === "major" ? ui.dangerEmphasis : ui.warning)}>{`  ${severity}`}</Text>
      {operationIndex !== undefined && <Text {...ui.muted}>{` ${glyphs.bullet} op ${operationIndex + 1}`}</Text>}
      <Text {...ui.muted}>{`  ${issue}`}</Text>
    </Text>
  );
}

export function ConfirmPlan({ plan }: Props) {
  const concerns = plan.outstandingConcerns ?? [];
  const verbs = plan.renderedLines.map((l) => {
    const space = l.indexOf(" ");
    return space > 0 ? l.slice(0, space) : l;
  });
  const verbWidth = Math.max(...verbs.map((v) => v.length), 0);

  return (
    <Box flexDirection="column" {...panels.gate} paddingX={2} marginY={1}>
      <Text>
        <Text {...ui.warningEmphasis}>Plan</Text>
        <Text {...ui.muted}>{`  ${glyphs.bullet}  ${plan.operations.length} operation${plan.operations.length === 1 ? "" : "s"}`}</Text>
      </Text>
      <Text {...ui.emphasis}>{plan.summary}</Text>
      <Box flexDirection="column" marginTop={1}>
        {plan.renderedLines.map((line, i) => (
          <OpLine key={i} line={line} verbWidth={verbWidth} />
        ))}
      </Box>
      {concerns.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text {...ui.warning}>{`${glyphs.caution} Reviewer concerns (unresolved after revision)`}</Text>
          {concerns.map((c, i) => (
            <Concern key={i} severity={c.severity} operationIndex={c.operationIndex} issue={c.issue} />
          ))}
        </Box>
      )}
    </Box>
  );
}
