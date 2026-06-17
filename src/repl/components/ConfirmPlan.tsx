import { Box, Text } from "ink";
import type { PlanForConfirmation } from "../../agent/propose_edit_plan.js";

interface Props {
  plan: PlanForConfirmation;
}

export function ConfirmPlan({ plan }: Props) {
  return (
    <Box flexDirection="column" marginY={1}>
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
