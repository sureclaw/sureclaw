import { validateCatalogTool, type CatalogTool } from './types.js';

export class ToolCatalog {
  private tools = new Map<string, CatalogTool>();
  private frozen = false;

  register(input: CatalogTool): void {
    if (this.frozen) {
      throw new Error(`ToolCatalog is frozen — cannot register ${input.name}`);
    }
    const tool = validateCatalogTool(input);
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool ${tool.name} already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): CatalogTool | undefined {
    return this.tools.get(name);
  }

  list(): CatalogTool[] {
    return [...this.tools.values()];
  }

  listBySkill(skill: string): CatalogTool[] {
    return this.list().filter((t) => t.skill === skill);
  }

  freeze(): void {
    this.frozen = true;
  }
}
