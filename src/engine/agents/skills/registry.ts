import { AgentSkill } from '../types';

export class SkillRegistry {
  private skills: Map<string, AgentSkill> = new Map();

  register(skill: AgentSkill): void {
    if (!skill.id) throw new Error('Skill must have a non-empty id');
    if (this.skills.has(skill.id)) throw new Error(`Skill "${skill.id}" is already registered.`);
    if (!skill.name || !skill.description || !Array.isArray(skill.requiredCapabilities)) throw new Error(`Skill "${skill.id}" has an invalid definition.`);
    this.skills.set(skill.id, skill);
  }

  get(id: string): AgentSkill | undefined {
    return this.skills.get(id);
  }

  has(id: string): boolean {
    return this.skills.has(id);
  }

  list(): AgentSkill[] {
    return Array.from(this.skills.values());
  }

  /**
   * Resolves all required capabilities for an agent's configured skills.
   */
  resolveCapabilities(skillIds: string[]): string[] {
    const requiredSet = new Set<string>();
    for (const id of skillIds) {
      const skill = this.skills.get(id);
      if (skill?.enabled) {
        skill.requiredCapabilities.forEach((cap) => requiredSet.add(cap));
      }
    }
    return Array.from(requiredSet);
  }

  /**
   * Formats skill instructions into agent system prompt guidelines.
   */
  compileInstructions(skillIds: string[]): string {
    const lines: string[] = [];
    for (const id of skillIds) {
      const skill = this.skills.get(id);
      if (skill && skill.enabled) {
        lines.push(`### Skill: ${skill.name}`);
        lines.push(skill.instructions.trim());
        lines.push('');
      }
    }
    return lines.join('\n');
  }
}

export const skillRegistry = new SkillRegistry();
