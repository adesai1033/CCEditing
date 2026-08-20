import { Box, Text } from "ink";
import type { PlanForConfirmation } from "../../agent/propose_edit_plan.js";

interface Props {
  plan: PlanForConfirmation;
}

export function ConfirmPlan({ plan }: Props) {
  const concerns = plan.outstandingConcerns ?? [];
  return (
    <Box flexDirection="column" marginY={1}>
      {/* 3G: concerns left standing when the revision cap was exhausted — the
          user arbitrates with the critic's flags visible. */}
      {concerns.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="yellow" dimColor>Reviewer concerns (unresolved after revision):</Text>
          {concerns.map((c, i) => (
            <Text key={i} dimColor>
              {`  ⚠ ${c.severity}${c.operationIndex !== undefined ? ` (op ${c.operationIndex + 1})` : ""}: ${c.issue}`}
            </Text>
          ))}
        </Box>
      )}
      <Text bold color="yellow">Plan:</Text>
      <Text>  {plan.summary}</Text>
      <Box flexDirection="column" marginLeft={2} marginTop={1}>
        {plan.renderedLines.map((line, i) => (
          <Text key={i}>• {line}</Text>
        ))}
      </Box>
    </Box>
  );
}
