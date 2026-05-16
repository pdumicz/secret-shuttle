import { ShuttleError } from "../../shared/errors.js";
import { vercelEnvAdd } from "./builtin/vercel-env-add.js";

export interface TemplateDefinition {
  id: string;
  description: string;
  binary: string;
  args: string[];
  secret_delivery: "stdin";
  required_params: string[];
  requires_approval_when_production: boolean;
  validateParams?: (params: Record<string, string>) => void;
  destinationEnvironment?: (params: Record<string, string>) => string;
}

export class TemplateRegistry {
  private readonly map: Map<string, TemplateDefinition>;
  constructor() {
    this.map = new Map<string, TemplateDefinition>([[vercelEnvAdd.id, vercelEnvAdd]]);
  }
  list(): TemplateDefinition[] {
    return [...this.map.values()];
  }
  get(id: string): TemplateDefinition {
    const t = this.map.get(id);
    if (t === undefined) throw new ShuttleError("template_not_found", `Unknown template: ${id}`);
    return t;
  }
}
