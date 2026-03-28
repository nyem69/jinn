import { describe, it, expect } from "vitest";
import { buildServiceRegistry, findCommonAncestor, buildRoutePath, resolveManagerChain } from "../services.js";
import { resolveOrgHierarchy } from "../org-hierarchy.js";
import type { Employee } from "../../shared/types.js";

function emp(name: string, opts: Partial<Employee> = {}): Employee {
  return {
    name,
    displayName: opts.displayName ?? name,
    department: opts.department ?? "default",
    rank: opts.rank ?? "employee",
    engine: opts.engine ?? "claude",
    model: opts.model ?? "opus",
    persona: opts.persona ?? `persona for ${name}`,
    reportsTo: opts.reportsTo,
    provides: opts.provides,
  };
}

function registry(...employees: Employee[]): Map<string, Employee> {
  const map = new Map<string, Employee>();
  for (const e of employees) map.set(e.name, e);
  return map;
}

// ═══════════════════════════════════════════════════════════════
// buildServiceRegistry
// ═══════════════════════════════════════════════════════════════

describe("buildServiceRegistry", () => {
  it("returns empty registry when no employees have provides", () => {
    const reg = registry(emp("a"), emp("b"));
    const services = buildServiceRegistry(reg);
    expect(services.size).toBe(0);
  });

  it("registers services from employees", () => {
    const reg = registry(
      emp("dev", { provides: [{ name: "code-review", description: "Review PRs" }] }),
    );
    const services = buildServiceRegistry(reg);
    expect(services.size).toBe(1);
    expect(services.get("code-review")?.provider.name).toBe("dev");
    expect(services.get("code-review")?.declaration.description).toBe("Review PRs");
  });

  it("registers multiple services from one employee", () => {
    const reg = registry(
      emp("dev", {
        provides: [
          { name: "code-review", description: "Review PRs" },
          { name: "web-dev", description: "Build web features" },
        ],
      }),
    );
    const services = buildServiceRegistry(reg);
    expect(services.size).toBe(2);
    expect(services.get("code-review")?.provider.name).toBe("dev");
    expect(services.get("web-dev")?.provider.name).toBe("dev");
  });

  it("higher-ranked employee wins on collision", () => {
    const reg = registry(
      emp("junior", { rank: "employee", provides: [{ name: "review", description: "Junior review" }] }),
      emp("senior", { rank: "senior", provides: [{ name: "review", description: "Senior review" }] }),
    );
    const services = buildServiceRegistry(reg);
    expect(services.get("review")?.provider.name).toBe("senior");
    expect(services.get("review")?.declaration.description).toBe("Senior review");
  });

  it("alphabetical wins on same-rank collision", () => {
    const reg = registry(
      emp("bob", { rank: "senior", provides: [{ name: "design", description: "Bob design" }] }),
      emp("alice", { rank: "senior", provides: [{ name: "design", description: "Alice design" }] }),
    );
    const services = buildServiceRegistry(reg);
    expect(services.get("design")?.provider.name).toBe("alice");
  });
});

// ═══════════════════════════════════════════════════════════════
// findCommonAncestor
// ═══════════════════════════════════════════════════════════════

describe("findCommonAncestor", () => {
  it("returns null for unknown employees", () => {
    const reg = registry(emp("a"));
    const hierarchy = resolveOrgHierarchy(reg);
    expect(findCommonAncestor("x", "y", hierarchy)).toBeNull();
  });

  it("returns the employee itself when both are the same", () => {
    const reg = registry(emp("coo", { rank: "executive" }));
    const hierarchy = resolveOrgHierarchy(reg);
    expect(findCommonAncestor("coo", "coo", hierarchy)).toBe("coo");
  });

  it("finds root as common ancestor for two siblings", () => {
    const reg = registry(
      emp("coo", { rank: "executive" }),
      emp("a", { reportsTo: "coo" }),
      emp("b", { reportsTo: "coo" }),
    );
    const hierarchy = resolveOrgHierarchy(reg);
    expect(findCommonAncestor("a", "b", hierarchy)).toBe("coo");
  });

  it("finds ancestor when one is deeper", () => {
    const reg = registry(
      emp("coo", { rank: "executive" }),
      emp("mgr", { rank: "manager", reportsTo: "coo" }),
      emp("dev", { reportsTo: "mgr" }),
      emp("other", { reportsTo: "coo" }),
    );
    const hierarchy = resolveOrgHierarchy(reg);
    expect(findCommonAncestor("dev", "other", hierarchy)).toBe("coo");
  });

  it("returns parent when one reports to the other", () => {
    const reg = registry(
      emp("coo", { rank: "executive" }),
      emp("mgr", { rank: "manager", reportsTo: "coo" }),
      emp("dev", { reportsTo: "mgr" }),
    );
    const hierarchy = resolveOrgHierarchy(reg);
    expect(findCommonAncestor("dev", "mgr", hierarchy)).toBe("mgr");
  });

  it("returns null when both are root-level with no common ancestor", () => {
    // No executive — both become root nodes
    const reg = registry(
      emp("a", { department: "eng" }),
      emp("b", { department: "mkt" }),
    );
    const hierarchy = resolveOrgHierarchy(reg);
    expect(findCommonAncestor("a", "b", hierarchy)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// buildRoutePath
// ═══════════════════════════════════════════════════════════════

describe("buildRoutePath", () => {
  it("returns single-element for same employee", () => {
    const reg = registry(emp("a"));
    const hierarchy = resolveOrgHierarchy(reg);
    expect(buildRoutePath("a", "a", hierarchy)).toEqual(["a"]);
  });

  it("builds path through common ancestor", () => {
    const reg = registry(
      emp("coo", { rank: "executive" }),
      emp("a", { reportsTo: "coo" }),
      emp("b", { reportsTo: "coo" }),
    );
    const hierarchy = resolveOrgHierarchy(reg);
    expect(buildRoutePath("a", "b", hierarchy)).toEqual(["a", "coo", "b"]);
  });

  it("builds path through deeper tree", () => {
    const reg = registry(
      emp("coo", { rank: "executive" }),
      emp("eng-lead", { rank: "manager", department: "eng", reportsTo: "coo" }),
      emp("dev", { department: "eng", reportsTo: "eng-lead" }),
      emp("mkt-lead", { rank: "manager", department: "mkt", reportsTo: "coo" }),
      emp("writer", { department: "mkt", reportsTo: "mkt-lead" }),
    );
    const hierarchy = resolveOrgHierarchy(reg);
    expect(buildRoutePath("dev", "writer", hierarchy)).toEqual([
      "dev", "eng-lead", "coo", "mkt-lead", "writer",
    ]);
  });

  it("builds direct path when one reports to the other", () => {
    const reg = registry(
      emp("mgr", { rank: "manager" }),
      emp("dev", { reportsTo: "mgr" }),
    );
    const hierarchy = resolveOrgHierarchy(reg);
    expect(buildRoutePath("dev", "mgr", hierarchy)).toEqual(["dev", "mgr"]);
  });
});

// ═══════════════════════════════════════════════════════════════
// resolveManagerChain
// ═══════════════════════════════════════════════════════════════

describe("resolveManagerChain", () => {
  it("returns empty for single employee", () => {
    const reg = registry(emp("a"));
    const hierarchy = resolveOrgHierarchy(reg);
    const chain = resolveManagerChain(["a"], hierarchy);
    expect(chain).toEqual([]);
  });

  it("returns managers (employees with direct reports) along the route", () => {
    const reg = registry(
      emp("coo", { rank: "executive" }),
      emp("eng-lead", { rank: "manager", department: "eng", reportsTo: "coo" }),
      emp("dev", { department: "eng", reportsTo: "eng-lead" }),
      emp("mkt-lead", { rank: "manager", department: "mkt", reportsTo: "coo" }),
      emp("writer", { department: "mkt", reportsTo: "mkt-lead" }),
    );
    const hierarchy = resolveOrgHierarchy(reg);
    const route = buildRoutePath("dev", "writer", hierarchy);
    const chain = resolveManagerChain(route, hierarchy);
    const names = chain.map((n) => n.employee.name);
    expect(names).toEqual(["eng-lead", "coo", "mkt-lead"]);
  });

  it("deduplicates managers", () => {
    const reg = registry(
      emp("coo", { rank: "executive" }),
      emp("a", { reportsTo: "coo" }),
    );
    const hierarchy = resolveOrgHierarchy(reg);
    // Route goes through coo twice conceptually
    const chain = resolveManagerChain(["a", "coo", "coo", "a"], hierarchy);
    const names = chain.map((n) => n.employee.name);
    expect(names).toEqual(["coo"]);
  });
});
