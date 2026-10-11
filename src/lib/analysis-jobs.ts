import {z} from 'zod';
import type {LiveAnalysisProgress} from './storage';

const pendingSchema=z.object({jobId:z.string().uuid(),projectId:z.string().min(1),datasetIds:z.array(z.string().min(1)).min(1),batchIndex:z.number().int().min(0),startedAt:z.number().int().min(0)});
export type PendingAnalysis=z.infer<typeof pendingSchema>;
const pendingKey='insightpilot.pending-analysis.v1';
export function getPendingAnalysis():PendingAnalysis|null{
 try{const raw=localStorage.getItem(pendingKey);return raw?pendingSchema.parse(JSON.parse(raw)):null;}catch{try{localStorage.removeItem(pendingKey);}catch{/* Storage may be unavailable. */}return null;}
}
export function clearPendingAnalysis(jobId:string){if(getPendingAnalysis()?.jobId===jobId)localStorage.removeItem(pendingKey);}
export function createPendingAnalysis(projectId:string,datasetIds:string[],batchIndex:number):PendingAnalysis{
 const pending=pendingSchema.parse({jobId:crypto.randomUUID(),projectId,datasetIds:[...datasetIds],batchIndex,startedAt:Date.now()});
 localStorage.setItem(pendingKey,JSON.stringify(pending));return pending;
}
const jobSchema=z.object({jobId:z.string().uuid(),stage:z.enum(['extracting','clustering','generating','committing','complete','failed']),progress:z.number().min(0).max(100),message:z.string(),result:z.unknown().optional(),error:z.string().optional()});
const delay=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
const errorMessage=(data:unknown,fallback:string)=>data&&typeof data==='object'&&'error' in data&&typeof data.error==='string'?data.error:fallback;
function terminalError(pending:PendingAnalysis,message:string):never{clearPendingAnalysis(pending.jobId);throw new Error(message);}
async function readResponse(response:Response,pending:PendingAnalysis):Promise<unknown>{
 try{return await response.json();}catch{return terminalError(pending,'The analysis server returned invalid JSON. Retry the selected batch.');}
}

export async function startAnalysisJob(pending:PendingAnalysis,records:unknown[]){
 const response=await fetch('/api/analyze',{method:'POST',headers:{'Content-Type':'application/json','Prefer':'respond-async','Accept':'application/json'},body:JSON.stringify({jobId:pending.jobId,records}),signal:AbortSignal.timeout(20_000)});
 const data=await readResponse(response,pending);
 if(!response.ok)terminalError(pending,errorMessage(data,'Could not start analysis.'));
 const acknowledgment=z.object({jobId:z.string().uuid()}).safeParse(data);
 if(!acknowledgment.success||acknowledgment.data.jobId!==pending.jobId)terminalError(pending,'The analysis server returned a different or invalid job ID.');
}

/** Polling reconnects to the same server job after a reload; it never resends feedback. */
export async function waitForAnalysisJob(pending:PendingAnalysis,onProgress:(progress:LiveAnalysisProgress)=>void):Promise<unknown>{
 let failures=0;
 while(true){
  let response:Response;
  try{response=await fetch(`/api/analysis/${pending.jobId}`,{signal:AbortSignal.timeout(15_000)});}
  catch{
   if(++failures>=15)throw new Error('Connection to the analysis server was lost. Reload the app to reconnect to this run.');
   onProgress({jobId:pending.jobId,stage:'extracting',progress:0,message:'Reconnecting to the running analysis…'});await delay(1500);continue;
  }
  if(response.status===404&&failures<10){failures++;await delay(1000);continue;}
  const data=await readResponse(response,pending);
  if(!response.ok)terminalError(pending,errorMessage(data,'The saved analysis job could not be found. Retry the batch.'));
  const parsed=jobSchema.safeParse(data);
  if(!parsed.success)terminalError(pending,'The analysis server returned an invalid job status. Retry the selected batch.');
  const job=parsed.data;failures=0;
  if(job.jobId!==pending.jobId)terminalError(pending,'The server returned another analysis job.');
  if(job.stage==='failed')terminalError(pending,job.error??job.message);
  if(job.stage==='complete'){
   if(job.result===undefined||job.result===null)terminalError(pending,'Analysis completed without a result.');
   return job.result;
  }
  // A completed disk result remains recoverable even after a long browser absence.
  if(Date.now()-pending.startedAt>=900_000)terminalError(pending,'The saved analysis has exceeded its time limit. Retry the selected batch.');
  onProgress({jobId:job.jobId,stage:job.stage,progress:job.progress,message:job.message});
  await delay(1000);
 }
}
