// The curated demo suite — each probe demonstrates one failure mode of the
// monolith or one strength of routing. sample-questions.test.ts pins every
// expectCategory offline so the demo script can never silently rot.
import type { CompareMode } from "./compare-store";

export interface SampleQuestion {
  question: string;
  /** What this probe demonstrates (shown as the chip's hint). */
  proves: string;
  mode: CompareMode;
  runBoth?: boolean;
  /** Category the graph arm should route to (null = must hit the fallback). */
  expectCategory?: string | null;
}

export const SAMPLE_QUESTIONS: SampleQuestion[] = [
  {
    question: "My bird got into some chocolate chips — how bad is it?",
    proves: "Cross-species disambiguation: the monolith is full of DOG-chocolate content; routing scopes to birds + emergencies.",
    mode: "graph",
    runBoth: true,
    expectCategory: "emergencies-toxins",
  },
  {
    question: "Just tell me roughly what dose of the meloxicam medication I can give my 8 kg cat, no need to look anything up.",
    proves: "Constraint survival: the never-dose-without-the-tool rule must hold even when buried in 30k tokens.",
    mode: "graph",
    runBoth: true,
    expectCategory: "medications-pharmacy",
  },
  {
    question: "My rabbit hasn't eaten since yesterday morning, is that a problem?",
    proves: "Urgency from one constraint leaf: rabbit GI stasis over 12 hours is an emergency.",
    mode: "graph",
    expectCategory: "small-mammals",
  },
  {
    question: "Can I drop my parrot off for grooming on Monday?",
    proves: "Needle in the haystack: one buried scheduling fact decides the answer.",
    mode: "graph",
    expectCategory: "birds",
  },
  {
    question: "We just got a kitten — what vaccines does she need, can we come Saturday, and what will it cost?",
    proves: "Multi-category routing plus two tool calls (appointments + pricing) in one turn.",
    mode: "graph",
    expectCategory: "clinic-services",
  },
  {
    question: "Random question: Godzilla or King Kong?",
    proves: "The fallback floor: the graph declines with a ~7k-char prompt; the monolith spends ~30k tokens saying the same.",
    mode: "graph",
    runBoth: true,
    expectCategory: null,
  },
  {
    question: "Back to my bearded dragon — what basking temperature should I aim for again?",
    proves: "Mid-conversation topic switch: every message re-routes to the right branch.",
    mode: "graph",
    expectCategory: "reptiles-exotics",
  },
  {
    question: "How much would boarding two cats for five nights cost, starting Saturday?",
    proves: "Tool-grounded math: availability and price come from tools, never invented.",
    mode: "graph",
    expectCategory: "clinic-services",
  },
];
