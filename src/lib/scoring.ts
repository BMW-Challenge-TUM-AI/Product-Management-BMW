import { dimensions, type Finding, type Priority, type Requirement, type ScoringModel, type Scores } from '../types';
export const DEFAULT_REQUIREMENT_SCORE=3;
export function scoreRequirement(scores:Scores, model:ScoringModel):number|null {
  if(dimensions.some(d=>scores[d]!==null&&(!Number.isFinite(scores[d]) || scores[d]!<1 || scores[d]!>5))) return null;
  return Math.round(dimensions.reduce((sum,d)=>sum+model.weights[d]*(scores[d]??DEFAULT_REQUIREMENT_SCORE)/5,0)*100)/100;
}
export function priorityFor(score:number|null, model:ScoringModel):Priority|null { return score===null?null:score>=model.thresholds.p1?'P1':score>=model.thresholds.p2?'P2':'P3'; }
export function evidenceLevel(req:Requirement, findings:Finding[]):'Strong'|'Moderate'|'Weak' {
  const linked=findings.filter(f=>req.findings.includes(f.id)&&f.status!=='Excluded');
  if(!linked.length || linked.some(f=>f.status==='Challenged') || (req.scores.evidence??0)<3) return 'Weak';
  return linked.every(f=>f.strength==='Strong') && (req.scores.evidence??0)>=4?'Strong':'Moderate';
}
export function validateModel(model:ScoringModel):string|null {
  if(dimensions.some(d=>!Number.isFinite(model.weights[d])||model.weights[d]<0)||Math.abs(dimensions.reduce((s,d)=>s+model.weights[d],0)-100)>0.01) return 'Weights must be non-negative and total 100%.';
  if(!(model.thresholds.p2>0&&model.thresholds.p1>model.thresholds.p2&&model.thresholds.p1<=100)) return 'Thresholds must satisfy 0 < P2 < P1 ≤ 100.';
  return null;
}
