import type { Document } from "mongodb";

export interface Plan {
  /** Stage names of the winning plan, outermost first. */
  stages: string[];
  indexes: string[];
  keysExamined: number;
  docsExamined: number;
  returned: number;
}

/**
 * Reduces `explain("executionStats")` to the facts the studies assert on. Counts of keys and documents
 * examined depend on the data and the index, not on how fast the machine is.
 */
export function readPlan(explain: Document): Plan {
  const stages: string[] = [];
  const indexes: string[] = [];
  const walk = (node: Document | undefined): void => {
    if (!node) return;
    if (typeof node.stage === "string") stages.push(node.stage);
    if (typeof node.indexName === "string") indexes.push(node.indexName);
    walk(node.inputStage as Document | undefined);
    for (const child of (node.inputStages as Document[] | undefined) ?? []) walk(child);
  };
  const winning = (explain.queryPlanner as Document).winningPlan as Document;
  // The slot-based engine wraps the classic tree in `queryPlan`.
  walk((winning.queryPlan as Document | undefined) ?? winning);
  const stats = explain.executionStats as Document;
  return {
    stages,
    indexes,
    keysExamined: stats.totalKeysExamined as number,
    docsExamined: stats.totalDocsExamined as number,
    returned: stats.nReturned as number,
  };
}
