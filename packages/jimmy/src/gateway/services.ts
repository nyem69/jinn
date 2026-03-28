import type { Employee, ServiceDeclaration, OrgHierarchy, OrgNode } from "../shared/types.js";
import { logger } from "../shared/logger.js";

export interface ServiceEntry {
  provider: Employee;
  declaration: ServiceDeclaration;
}

/**
 * Build a service registry from the org employee map.
 * If two employees provide the same service, the higher-ranked one wins.
 * Ties broken alphabetically by name.
 */
export function buildServiceRegistry(
  employees: Map<string, Employee>,
): Map<string, ServiceEntry> {
  const RANK_PRIORITY: Record<string, number> = {
    executive: 0,
    manager: 1,
    senior: 2,
    employee: 3,
  };

  const registry = new Map<string, ServiceEntry>();

  for (const [, emp] of employees) {
    if (!emp.provides) continue;
    for (const decl of emp.provides) {
      const existing = registry.get(decl.name);
      if (existing) {
        const existingRank = RANK_PRIORITY[existing.provider.rank] ?? 3;
        const newRank = RANK_PRIORITY[emp.rank] ?? 3;
        if (newRank < existingRank || (newRank === existingRank && emp.name < existing.provider.name)) {
          logger.info(`Service "${decl.name}": "${emp.name}" overrides "${existing.provider.name}" (higher rank or alphabetical)`);
          registry.set(decl.name, { provider: emp, declaration: decl });
        } else {
          logger.info(`Service "${decl.name}": "${existing.provider.name}" retained over "${emp.name}"`);
        }
      } else {
        registry.set(decl.name, { provider: emp, declaration: decl });
      }
    }
  }

  return registry;
}

/**
 * Find the lowest common ancestor of two employees in the org tree.
 * Walks up parentName chains. Returns the ancestor name, or null if both are root-level.
 * Safe from infinite loops — resolveOrgHierarchy breaks cycles before this runs.
 */
export function findCommonAncestor(
  employeeA: string,
  employeeB: string,
  hierarchy: OrgHierarchy,
): string | null {
  const nodeA = hierarchy.nodes[employeeA];
  const nodeB = hierarchy.nodes[employeeB];
  if (!nodeA || !nodeB) return null;

  // Build ancestor set for A (including A itself)
  const ancestorsA = new Set<string>();
  let current: string | null = employeeA;
  while (current) {
    ancestorsA.add(current);
    const n: OrgNode | undefined = hierarchy.nodes[current];
    current = n?.parentName ?? null;
  }

  // Walk B upward until we hit an ancestor of A
  current = employeeB;
  while (current) {
    if (ancestorsA.has(current)) return current;
    const n: OrgNode | undefined = hierarchy.nodes[current];
    current = n?.parentName ?? null;
  }

  return null;
}

/**
 * Build the route path from source employee to target employee.
 * Returns an array of employee names: [source, ..., LCA, ..., target].
 */
export function buildRoutePath(
  from: string,
  to: string,
  hierarchy: OrgHierarchy,
): string[] {
  if (from === to) return [from];

  const ancestor = findCommonAncestor(from, to, hierarchy);

  // Build upward path from source to ancestor
  const upPath: string[] = [];
  let current: string | null = from;
  while (current && current !== ancestor) {
    upPath.push(current);
    current = hierarchy.nodes[current]?.parentName ?? null;
  }
  if (ancestor) upPath.push(ancestor);

  // Build downward path from ancestor to target
  const downPath: string[] = [];
  current = to;
  while (current && current !== ancestor) {
    downPath.unshift(current);
    current = hierarchy.nodes[current]?.parentName ?? null;
  }

  return [...upPath, ...downPath];
}

/**
 * Resolve the manager chain along a route path.
 * Returns employees that have direct reports (i.e., are actual managers).
 */
export function resolveManagerChain(
  routePath: string[],
  hierarchy: OrgHierarchy,
): OrgNode[] {
  const chain: OrgNode[] = [];
  const seen = new Set<string>();

  for (const name of routePath) {
    if (seen.has(name)) continue;
    const node = hierarchy.nodes[name];
    if (!node) continue;
    if (node.directReports.length > 0) {
      seen.add(name);
      chain.push(node);
    }
  }

  return chain;
}
