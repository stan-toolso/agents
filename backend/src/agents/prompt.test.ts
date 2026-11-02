import { describe, expect, it } from "vitest";
import { agentIdentityPrompt } from "./prompt.js";
import type { Agent } from "./types.js";

const agent = {
  id: "a1",
  projectId: "p1",
  name: "Ben",
  kind: "developer",
  description: "",
  instructions: "",
} as unknown as Agent;

describe("agentIdentityPrompt : comptes git prêtés", () => {
  it("lecture seule stricte : ni push ni pull request", () => {
    const text = agentIdentityPrompt(agent, { name: "Skipper" }, null, {
      githubReadOnly: true,
      githubPullRequests: false,
    });
    expect(text).toContain("Ton compte GitHub est prêté en lecture seule");
    expect(text).toContain("ni pousser une branche ni ouvrir de pull request");
    expect(text).not.toContain("pull requests permises");
  });

  it("lecture seule avec pull requests permises : tasks.pr_open seulement", () => {
    const text = agentIdentityPrompt(agent, { name: "Skipper" }, null, {
      githubReadOnly: true,
      githubPullRequests: true,
      gitlabReadOnly: true,
      gitlabPullRequests: false,
    });
    expect(text).toContain(
      "Ton compte GitHub est prêté en lecture seule, pull requests permises",
    );
    expect(text).toContain("tasks.pr_open");
    expect(text).toContain(
      "Ton compte GitLab est prêté en lecture seule : sur GitLab",
    );
  });

  it("comptes en écriture : rien à signaler", () => {
    expect(
      agentIdentityPrompt(agent, { name: "Skipper" }, null, {
        githubPullRequests: true,
      }),
    ).not.toContain("lecture seule");
  });
});
