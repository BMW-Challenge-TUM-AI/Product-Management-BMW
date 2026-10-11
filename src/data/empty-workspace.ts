import type {Workspace, Project} from '../types';

export const DEFAULT_SOURCE_PROJECT: Project = {
 id: 'BMW-PROJECT-F70-EU',
 name: 'BMW supplied-source workspace',
 derivative: 'BMW 1 Series F70',
 market: 'Europe',
 horizon: 'Source review',
};

export function createEmptyWorkspace(project: Project = DEFAULT_SOURCE_PROJECT): Workspace {
 return {
  schemaVersion: 1,
  revision: 0,
  projects: [project],
  datasets: [],
  findings: [],
  requirements: [],
  audit: [],
  model: {
   version: 1,
   weights: {impact: 30, frequency: 20, strategy: 20, evidence: 20, feasibility: 10},
   thresholds: {p1: 75, p2: 55},
   updatedAt: new Date().toISOString(),
  },
  requests: [],
  runs: [],
 };
}
