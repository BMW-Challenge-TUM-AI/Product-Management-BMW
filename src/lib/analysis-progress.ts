import type {LiveAnalysisProgress} from './storage';

export interface AnalysisSession {
 projectId:string;
 datasetIds:string[];
 batchIndex:number;
 startedAt:number;
 finishedAt?:number;
 progress:LiveAnalysisProgress;
}

export function analysisInProgress(analysis:AnalysisSession|null):boolean{
 return !!analysis&&!['complete','failed'].includes(analysis.progress.stage);
}
