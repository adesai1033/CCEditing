import { unlink } from "node:fs/promises";
import type { ProjectState } from "../project/types.js";
import { renderDraft } from "../engine/draft.js";
import { reviewCut, type CutReview } from "./backends/gemini.js";
import { renderShotList, shotList } from "../edit/program.js";
import { measureCut, describeCutFacts } from "../edit/cut-facts.js";

/**
 * The reviewer WATCHES the cut. It renders a draft of the would-be timeline
 * (from the 720p proxies — seconds, not minutes) and hands it to a video
 * model with the user's request and the intended shot list, the way an editor
 * reviews a rough cut. Its notes are timestamped observations of what a
 * viewer would see and hear, which the director turns into a revised program.
 *
 * It replaces, for story edits, both the rule-based checks (which counted
 * seconds and ranges) and the JSON critic (which read operations): neither
 * could see a flash cut, a picture out of step with the sound, or a cropped
 * screen — this can.
 *
 * Fails open: if the draft can't be rendered or the model can't be reached,
 * the edit goes to the user unreviewed rather than being blocked.
 */

export interface ReviewInput {
  userRequest: string;
  /** The would-be timeline (after the program is applied). */
  state: ProjectState;
}

export type ReviewerFn = (input: ReviewInput) => Promise<CutReview & { shots: string[]; facts?: string[] }>;

export function reviewBrief(userRequest: string, shots: string[], facts: string[] = []): string {
  return [
    "You are a film editor reviewing a rough cut that an assistant editor made for a client.",
    "",
    "The client asked for:",
    userRequest,
    "",
    "The assistant's intended shot list (timecodes are the cut's own; quotes are what is heard):",
    ...shots.map((s) => `- ${s}`),
    "",
    ...(facts.length > 0
      ? ["Measured from the cut's audio (exact, so you don't have to judge silence by ear):", ...facts.map((f) => `- ${f}`), ""]
      : []),
    "Judge the length the way the client will: is there anything a professional editor would trim — a lead-in before the story starts, a tail after it ends, waiting where nothing happens on screen or in the sound? Name it with its times.",
    "",
    "Watch the cut from start to finish, picture and sound, as the client will. Report what would make the client unhappy or that a professional editor would fix:",
    "the picture not showing what is being talked about at that moment, cuts that feel random or jarring, content that is cropped or unreadable,",
    "the story not coming across or not finishing, dead air, or anything else you notice. Be concrete: give the time (seconds into the cut) and what you see or hear.",
    "Severity \"major\" means the client would reject the cut over it; \"minor\" means worth fixing but acceptable.",
    "If the cut works, approve it — don't invent problems. Respond with JSON: { verdict: \"approve\" | \"revise\", notes: [{ time, severity, issue }] }.",
  ].join("\n");
}

export const defaultReviewer: ReviewerFn = async ({ userRequest, state }) => {
  const shots = renderShotList(shotList(state));
  const facts = describeCutFacts(measureCut(state));
  let draftPath: string | null = null;
  try {
    const draft = await renderDraft(state);
    if (!draft.ok) return { verdict: "approve", notes: [], shots, facts };
    draftPath = draft.path;
    const review = await reviewCut(draft.path, reviewBrief(userRequest, shots, facts));
    return { ...review, shots, facts };
  } catch {
    return { verdict: "approve", notes: [], shots, facts };
  } finally {
    if (draftPath) await unlink(draftPath).catch(() => {});
  }
};
