# Agent Skills

A skill is a structured, registered definition containing an identifier, purpose, agent-facing instructions, required capability identifiers, optional input/output schema metadata and enabled state. A skill is not executable code and does not implement financial calculations.

Built-in skills: `market-observation`, `technical-analysis`, `risk-management`, `position-sizing`, `trade-entry`, and `trade-management`. Skill capability requirements are combined and intersected with the agent's explicit capability allowlist and registered capability set. Disabled skills do not contribute instructions. Unknown skills contribute no capabilities.

Add a skill in `src/engine/agents/skills/builtins.ts`, reference registered capability IDs, and include it in `BUILTIN_SKILLS`. Keep instructions declarative; enforce safety in policy and capability code, not prompts.
