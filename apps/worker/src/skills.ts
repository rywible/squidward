export type SkillIntent = "ops" | "code" | "perf" | "incident" | "policy" | "meta";

export interface SkillSelection {
  id: string;
  title: string;
  reason: string;
  confidence: number;
  playbook: string[];
  successCriteria: string[];
}

interface SkillDefinition {
  id: string;
  title: string;
  intents: SkillIntent[];
  taskTypes?: string[];
  keywords: string[];
  playbook: string[];
  successCriteria: string[];
}

const normalize = (value: string): string => value.toLowerCase().trim();
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

const SKILLS: SkillDefinition[] = [
  {
    id: "repo-orient",
    title: "Repo Orient",
    intents: ["ops", "code", "perf", "incident", "meta"],
    keywords: ["repo", "project", "codebase", "where", "layout", "context", "understand"],
    playbook: [
      "Map the current objective to concrete files and directories before editing.",
      "Establish repo health quickly: build/test command and current branch/worktree state.",
      "Prefer small, focused changes; summarize touched paths and why.",
    ],
    successCriteria: [
      "Response includes the concrete repo area impacted by the task.",
      "Proposed actions are scoped to specific files/modules, not generic suggestions.",
    ],
  },
  {
    id: "bug-repro-first",
    title: "Bug Repro First",
    intents: ["code", "incident"],
    keywords: ["bug", "error", "failing", "failure", "regression", "flaky", "crash", "fix"],
    playbook: [
      "Reproduce first with a failing test or deterministic repro step.",
      "Do the smallest fix that turns repro green.",
      "Add/adjust regression coverage so the issue stays fixed.",
    ],
    successCriteria: [
      "A clear repro or failing check is identified before the fix.",
      "Outcome references validation (tests/checks) after change.",
    ],
  },
  {
    id: "perf-scientist",
    title: "Perf Scientist",
    intents: ["perf", "code"],
    taskTypes: ["perf_baseline_nightly", "perf_detect_change_smoke", "perf_generate_candidates", "perf_run_candidate", "perf_score_decide", "perf_open_draft_pr"],
    keywords: ["perf", "latency", "throughput", "benchmark", "optimize", "hotspot", "p95", "p99"],
    playbook: [
      "Form one performance hypothesis at a time and keep diffs narrow.",
      "Use benchmark evidence (before/after) and reject noisy deltas.",
      "Document impact and risk of the optimization clearly.",
    ],
    successCriteria: [
      "A measurable performance delta is provided with context.",
      "No claimed win is presented without benchmark evidence.",
    ],
  },
  {
    id: "pr-shipper",
    title: "PR Shipper",
    intents: ["code", "perf", "ops"],
    keywords: ["pr", "pull request", "ship", "merge", "draft", "review"],
    playbook: [
      "Bias to draft-ready changes with clear rationale and rollback notes.",
      "Call out risk level and validation checks run.",
      "Keep PR scope narrow and operationally safe.",
    ],
    successCriteria: [
      "Output includes a concise ship/review summary.",
      "Risk and validation are explicitly stated.",
    ],
  },
  {
    id: "cto-memo-writer",
    title: "CTO Memo Writer",
    intents: ["meta", "ops", "policy"],
    keywords: ["memo", "summary", "strategy", "weekly", "cto", "what next", "recommendation"],
    playbook: [
      "Summarize what moved, what is stuck, and what decisions are needed.",
      "Prioritize recommendations by impact and risk.",
      "Keep recommendations concrete and action-oriented.",
    ],
    successCriteria: [
      "Summary includes clear recommendations, not just narrative.",
      "At least one decision-oriented next step is provided.",
    ],
  },
];

const scoreSkill = (
  skill: SkillDefinition,
  input: { intent: SkillIntent; taskType?: string; requestText: string; objective: string }
): number => {
  let score = 0;
  if (skill.intents.includes(input.intent)) {
    score += 0.55;
  }
  if (skill.taskTypes?.includes(input.taskType ?? "")) {
    score += 0.35;
  }

  const text = `${normalize(input.requestText)} ${normalize(input.objective)}`;
  for (const keyword of skill.keywords) {
    if (text.includes(keyword)) {
      score += 0.12;
    }
  }

  if (skill.id === "repo-orient") {
    score += 0.1;
  }

  return score;
};

const reasonFor = (skillId: string, intent: SkillIntent): string => {
  if (skillId === "repo-orient") return "Foundational repo grounding for safer, faster execution.";
  if (skillId === "bug-repro-first") return "Issue/fix intent detected; enforce repro-first bug workflow.";
  if (skillId === "perf-scientist") return "Performance intent detected; require benchmark-backed optimization.";
  if (skillId === "pr-shipper") return "Delivery intent detected; shape output for draft PR readiness.";
  if (skillId === "cto-memo-writer") return `Strategic ${intent} context detected; produce decision-oriented summary.`;
  return "Skill matched by intent and request context.";
};

export const selectMissionSkills = (input: {
  intent: SkillIntent;
  taskType?: string;
  requestText: string;
  objective: string;
  maxSkills?: number;
}): SkillSelection[] => {
  const maxSkills = Math.max(1, Math.min(5, input.maxSkills ?? 2));

  const ranked = SKILLS.map((skill) => ({
    skill,
    score: scoreSkill(skill, input),
  }))
    .filter((row) => row.score >= 0.5)
    .sort((a, b) => {
      if (Math.abs(b.score - a.score) > 0.0001) {
        return b.score - a.score;
      }
      return a.skill.id.localeCompare(b.skill.id);
    });

  const selected = ranked.slice(0, maxSkills).map(({ skill, score }) => ({
    id: skill.id,
    title: skill.title,
    reason: reasonFor(skill.id, input.intent),
    confidence: clamp(score, 0, 1),
    playbook: skill.playbook,
    successCriteria: skill.successCriteria,
  }));

  if (!selected.some((entry) => entry.id === "repo-orient")) {
    const repoOrient = SKILLS.find((skill) => skill.id === "repo-orient");
    if (repoOrient) {
      selected.unshift({
        id: repoOrient.id,
        title: repoOrient.title,
        reason: reasonFor(repoOrient.id, input.intent),
        confidence: 0.7,
        playbook: repoOrient.playbook,
        successCriteria: repoOrient.successCriteria,
      });
    }
  }

  return selected.slice(0, maxSkills);
};

