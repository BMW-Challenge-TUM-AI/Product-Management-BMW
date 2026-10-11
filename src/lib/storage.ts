import {createClient} from '@supabase/supabase-js';
import {createEmptyWorkspace} from '../data/empty-workspace';
import type {Workspace} from '../types';
import type {Command} from './workspace';
import {requestBMWScope,workspaceFromBMWBundle} from './bmw-library';
const env=import.meta.env;
export const supabase=env.VITE_SUPABASE_URL&&env.VITE_SUPABASE_ANON_KEY?createClient(env.VITE_SUPABASE_URL,env.VITE_SUPABASE_ANON_KEY):null;
export const STORAGE_KEY='insightpilot.workspace.v1';
const DB_NAME='insightpilot-local-workspace';
const DB_STORE='snapshots';
function database():Promise<IDBDatabase>{return new Promise((resolve,reject)=>{const request=indexedDB.open(DB_NAME,1);request.onupgradeneeded=()=>request.result.createObjectStore(DB_STORE);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}
async function readSnapshot():Promise<Workspace|undefined>{const db=await database();try{return await new Promise((resolve,reject)=>{const request=db.transaction(DB_STORE,'readonly').objectStore(DB_STORE).get(STORAGE_KEY);request.onsuccess=()=>resolve(request.result as Workspace|undefined);request.onerror=()=>reject(request.error);});}finally{db.close();}}
async function writeSnapshot(value:Workspace):Promise<void>{const db=await database();try{await new Promise<void>((resolve,reject)=>{const transaction=db.transaction(DB_STORE,'readwrite');transaction.objectStore(DB_STORE).put(value,STORAGE_KEY);transaction.oncomplete=()=>resolve();transaction.onerror=()=>reject(transaction.error);transaction.onabort=()=>reject(transaction.error);});}finally{db.close();}}
function validateSnapshot(data:Workspace):Workspace{if(data.schemaVersion!==1||!Array.isArray(data.projects)||!Array.isArray(data.datasets)||!Array.isArray(data.requirements)||!Array.isArray(data.audit))throw new Error('The saved workspace is incompatible. Export your browser data before clearing storage.');return data;}
function removeSyntheticWorkspace(data:Workspace):Workspace|null{
 const hasSynthetic=data.datasets.some(d=>d.synthetic)||data.findings.some(f=>f.synthetic)||data.requirements.some(r=>r.synthetic);
 if(!hasSynthetic)return data;
 const datasets=data.datasets.filter(d=>!d.synthetic);
 if(!datasets.length)return null;
 const datasetIds=new Set(datasets.map(d=>d.id));
 const recordIds=new Set(datasets.flatMap(d=>d.records.map(r=>r.id)));
 const findings=data.findings.filter(f=>!f.synthetic&&f.sources.every(id=>recordIds.has(id)));
 const findingIds=new Set(findings.map(f=>f.id));
 const requirements=data.requirements.filter(r=>!r.synthetic&&r.findings.every(id=>findingIds.has(id)));
 const requirementIds=new Set(requirements.map(r=>r.id));
 const requests=data.requests.filter(r=>requirementIds.has(r.requirementId));
 const projects=data.projects.filter(p=>datasets.some(d=>d.projectId===p.id)||findings.some(f=>f.projectId===p.id)||requirements.some(r=>r.projectId===p.id));
 const projectIds=new Set(projects.map(p=>p.id));
 const validIds=new Set([...datasetIds,...recordIds,...findingIds,...requirementIds,...requests.map(r=>r.id)]);
 const audit=data.audit.filter(e=>projectIds.has(e.projectId)&&(validIds.has(e.entityId)||e.relatedIds.some(id=>validIds.has(id))));
 const runs=data.runs.filter(r=>projectIds.has(r.projectId)&&r.datasets.every(id=>datasetIds.has(id)));
 if(!projects.length)return null;
 return {...data,projects,datasets,findings,requirements,requests,audit,runs};
}
async function sourceWorkspace():Promise<Workspace>{
 try{return workspaceFromBMWBundle(await requestBMWScope('F70','EU','bootstrap'));}
 catch{return createEmptyWorkspace();}
}
export async function loadWorkspace():Promise<Workspace>{
 let stored:Workspace|undefined;
 try{stored=await readSnapshot();}catch{/* Older browsers can still use their existing local-storage snapshot. */}
 if(!stored){const raw=localStorage.getItem(STORAGE_KEY);if(raw)stored=validateSnapshot(JSON.parse(raw) as Workspace);}
 if(stored){const cleaned=removeSyntheticWorkspace(validateSnapshot(stored));if(cleaned){if(cleaned!==stored)await saveWorkspace(cleaned);if(!cleaned.datasets.length){const sourced=await sourceWorkspace();if(sourced.datasets.length){await saveWorkspace(sourced);return sourced;}}return cleaned;}}
 const initial=await sourceWorkspace();await saveWorkspace(initial);return initial;
}
export async function saveWorkspace(s:Workspace):Promise<void>{const json=JSON.stringify(s);try{await writeSnapshot(JSON.parse(json) as Workspace);}catch(error){try{localStorage.setItem(STORAGE_KEY,json);return;}catch{throw error;}}if(json.length<1_000_000){try{localStorage.setItem(STORAGE_KEY,json);}catch{localStorage.removeItem(STORAGE_KEY);}}else localStorage.removeItem(STORAGE_KEY);}
export async function loadRemote():Promise<Workspace|null>{if(!supabase)return null;const {data,error}=await supabase.functions.invoke('workspace',{body:{operation:'load'}});if(error)throw new Error('Cloud workspace could not load. Check your session and Edge Function deployment.');if(data.error)throw new Error(data.error);return data.workspace??null;}
export async function remoteCommand(command:Command,revision:number):Promise<Workspace>{if(!supabase)throw new Error('Supabase is not configured.');const {data,error}=await supabase.functions.invoke('workspace',{body:{operation:'command',command,revision}});if(error||data.error)throw new Error(data?.error??'Cloud change failed. Reload to check for concurrent edits.');return data.workspace;}
export interface LiveAnalysisProgress {jobId:string;stage:'extracting'|'clustering'|'generating'|'committing'|'complete'|'failed';progress:number;message:string;error?:string;counts?:{signals:number;clusters:number;findings:number;requirements:number}}
async function invokeAnalysis(body:Record<string,unknown>){if(!supabase)throw new Error('Supabase is not configured.');const {data,error}=await supabase.functions.invoke('analyze',{body});if(data?.job)return data.job as {id:string;stage:LiveAnalysisProgress['stage'];progress:number;message:string;error?:string;result?:{workspace:Workspace;counts:LiveAnalysisProgress['counts']}};if(error||data?.error)throw new Error(data?.error??'Live analysis request failed. No partial results were saved.');throw new Error('Analysis server returned an invalid response.');}
export async function liveAnalysis(projectId:string,datasetIds:string[],revision:number,onProgress:(progress:LiveAnalysisProgress)=>void):Promise<Workspace>{let job=await invokeAnalysis({operation:'start',projectId,datasetIds,revision});onProgress({jobId:job.id,stage:job.stage,progress:job.progress,message:job.message});for(let step=0;step<5&&job.stage!=='complete'&&job.stage!=='failed';step++){job=await invokeAnalysis({operation:'advance',jobId:job.id});onProgress({jobId:job.id,stage:job.stage,progress:job.progress,message:job.message,error:job.error,counts:job.result?.counts});}if(job.stage!=='complete'||!job.result?.workspace)throw new Error(job.error??'AI analysis stopped before completion. Check the source records and server configuration, then retry.');return job.result.workspace;}
