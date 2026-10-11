import {z} from 'zod';
import type {Workspace,Finding,Requirement,AuditEvent,Dataset} from '../types';
import {uid} from './workspace';
import {assertFeedbackScope} from './scope';
import {isInternalDataset} from './internal-data';
import type {LiveAnalysisProgress} from './storage';
import {createPendingAnalysis,clearPendingAnalysis,startAnalysisJob,waitForAnalysisJob,type PendingAnalysis} from './analysis-jobs';
const findingSchema=z.object({finding_id:z.string(),source_id:z.string(),summary:z.string(),customer_need:z.string(),finding_type:z.string(),category:z.string(),evidence_quote:z.string(),evidence_valid:z.boolean(),needs_review:z.boolean(),uncertainties:z.array(z.string())});
const clusterSchema=z.object({cluster_id:z.string(),title:z.string(),summary:z.string(),category:z.string(),finding_ids:z.array(z.string()).min(1),source_ids:z.array(z.string()).min(1),uncertainty:z.string()});
const draftSchema=z.object({requirement_id:z.string(),description:z.string().min(1),category:z.string(),rationale:z.string(),confidence:z.enum(['low','medium','high']),linked_finding_ids:z.array(z.string()).min(1),linked_source_ids:z.array(z.string()).min(1),assumptions:z.array(z.string()),uncertainties:z.array(z.string()),decision_status:z.literal('pending'),validation_errors:z.array(z.string()).length(0)});
export const resultSchema=z.object({findings:z.array(findingSchema),clusters:z.array(clusterSchema),proposed_requirements:z.array(draftSchema),validation_errors:z.array(z.object({code:z.string()})),metrics:z.object({seconds:z.number(),api_calls:z.number(),input_tokens:z.number(),output_tokens:z.number(),reasoning_tokens:z.number(),model:z.string()}).optional()});
const categoryMap:Record<string,string>={'UX':'Usability','Charging':'Range and charging experience','Range & Charging':'Range and charging experience','Interior':'Interior and space','Storage':'Interior and space','Space & Practicality':'Interior and space','Digital Services':'Digital services','Infotainment & Digital Services':'Infotainment','Equipment & Packages':'Equipment and feature availability','Driving Experience':'Driving experience','Design & Perceived Quality':'Design and quality perception','Other':'Other customer-facing product experiences'};
const category=(s:string)=>categoryMap[s]??s;
export function selectFeedback(state:Workspace,projectId:string,datasetIds:string[],batchIndex=0){
 const project=state.projects.find(p=>p.id===projectId);if(!project)throw new Error('Project not found.');
 const datasets=datasetIds.map(id=>state.datasets.find(d=>d.id===id&&d.projectId===projectId));
 if(!datasets.length||datasets.some(d=>!d||d.status!=='Ready'||d.type!=='Customer verbatims'))throw new Error('For live AI, select only validated Customer verbatims datasets. Study, sales and equipment data remain reference context.');
 if(datasets.some(d=>d?.synthetic))throw new Error('AI analysis accepts source-backed customer feedback only.');
 assertFeedbackScope(datasets as Dataset[],project);
 const allRecords=datasets.flatMap(d=>d!.records);
 if(!allRecords.length)throw new Error('Select at least one feedback record.');
 if(new Set(allRecords.map(r=>r.id)).size!==allRecords.length)throw new Error('Duplicate record IDs.');
 const totalBatches=Math.ceil(allRecords.length/50);
 if(!Number.isInteger(batchIndex)||batchIndex<0||batchIndex>=totalBatches)throw new Error('Choose a valid 50-record AI batch.');
 const records=allRecords.slice(batchIndex*50,(batchIndex+1)*50);
 return {project,datasets:datasets.map(d=>d!),records,totalRecords:allRecords.length,batchIndex,totalBatches};
}
export function integratePythonResult(input:Workspace,projectId:string,datasetIds:string[],raw:unknown,batchIndex=0,jobId?:string):Workspace{
 if(jobId&&input.runs.some(run=>run.id===`RUN-${jobId}`))return input;
 const result=resultSchema.parse(raw);const {records,datasets,totalRecords,totalBatches}=selectFeedback(input,projectId,datasetIds,batchIndex);
 if(result.validation_errors.some(e=>!['no_findings','semantic_clustering_failed_fallback_used'].includes(e.code)))throw new Error('Analysis contains validation errors; nothing was saved.');
 const sources=new Map(records.map(r=>[r.id,r]));const byId=new Map(result.findings.map(f=>[f.finding_id,f]));
 if(byId.size!==result.findings.length||new Set(result.clusters.map(c=>c.cluster_id)).size!==result.clusters.length)throw new Error('Duplicate AI IDs.');
 for(const f of result.findings)if(!f.evidence_valid||!f.evidence_quote.trim()||!sources.get(f.source_id)?.content.includes(f.evidence_quote))throw new Error('AI evidence is not an exact source quote.');
 const assigned=new Set<string>();
 for(const c of result.clusters){const expected=new Set<string>();for(const id of c.finding_ids){const f=byId.get(id);if(!f||assigned.has(id)||f.finding_type==='unclear'||f.category!==c.category)throw new Error('Invalid cluster evidence.');assigned.add(id);expected.add(f.source_id);}
 if(expected.size!==c.source_ids.length||c.source_ids.some(id=>!expected.has(id)))throw new Error('Cluster source mismatch.');}
 if(result.findings.some(f=>f.finding_type!=='unclear'&&!assigned.has(f.finding_id)))throw new Error('Unassigned AI finding.');
 const s=structuredClone(input),runId=jobId?`RUN-${jobId}`:uid('RUN'),now=new Date().toISOString();const mapped=new Map<string,string>();const createdF:string[]=[],createdR:string[]=[];
 const log=(entityType:string,entityId:string,after:unknown,relatedIds:string[],rationale:string)=>s.audit.push({id:uid('EVT'),projectId,at:now,actor:'AI',actorId:'Python AI pipeline',action:entityType+' generated',entityType,entityId,before:null,after:structuredClone(after),rationale,relatedIds,runId} satisfies AuditEvent);
 for(const c of result.clusters){
 const members=c.finding_ids.map(id=>byId.get(id)!);const description=c.summary+'\n\n'+members.map(f=>`${f.source_id}: “${f.evidence_quote}”`).join('\n');
 const existing=s.findings.find(f=>f.projectId===projectId&&f.description===description&&JSON.stringify([...f.sources].sort())===JSON.stringify([...c.source_ids].sort()));
 if(existing){mapped.set(c.cluster_id,existing.id);continue;}
 const f:Finding={id:uid('FND'),projectId,title:c.title,description,need:members.map(f=>f.customer_need).join('; '),type:members[0].finding_type,category:category(c.category),sources:c.source_ids,contradictions:[],confidence:Math.min(70,20+c.source_ids.length*10),strength:c.source_ids.length>=5?'Strong':c.source_ids.length>=2?'Moderate':'Weak',implication:[c.uncertainty,...members.flatMap(f=>f.uncertainties),'Validate representativeness and counterevidence before planning.'].filter(Boolean).join(' '),status:'New',createdAt:now,synthetic:false,runId};
 s.findings.push(f);mapped.set(c.cluster_id,f.id);createdF.push(f.id);log('Finding',f.id,f,f.sources,'Exact quotations verified against the selected records. Confidence is an illustrative qualitative mapping, not statistical certainty.');}
 for(const d of result.proposed_requirements){const c=result.clusters.find(c=>JSON.stringify([...c.finding_ids].sort())===JSON.stringify([...d.linked_finding_ids].sort()));if(!c||c.category!==d.category||JSON.stringify([...c.source_ids].sort())!==JSON.stringify([...d.linked_source_ids].sort()))throw new Error('Requirement evidence mismatch.');
 const fid=mapped.get(c.cluster_id)!;if(s.requirements.some(r=>r.projectId===projectId&&r.findings.includes(fid)&&r.statement===d.description))continue;
 const n=c.source_ids.length,ratio=n/records.length;const frequency=ratio<.01?1:ratio<.03?2:ratio<.08?3:ratio<.15?4:5;const evidence=n<=1?1:n===2?2:n<=4?3:n<=9?4:5;
 const r:Requirement={id:uid('REQ'),projectId,title:d.description.slice(0,100),statement:d.description,category:category(d.category),findings:[fid],scores:{impact:3,frequency,strategy:3,evidence,feasibility:3},status:'Awaiting review',assumptions:d.assumptions.join('\n'),uncertainty:[...d.uncertainties,`Evidence ratings: ${n} distinct linked record(s) from ${records.length} selected records. Frequency is a batch heuristic, not population prevalence.`, 'Impact, strategic relevance and feasibility default to a neutral 3/5 until the PM changes them.', 'Model confidence: '+d.confidence+'. Displayed percentage is a qualitative mapping, not a statistical probability.'].join('\n'),rationale:d.rationale,confidence:{low:30,medium:60,high:80}[d.confidence],createdAt:now,updatedAt:now,createdBy:'Python AI pipeline',version:1,history:[],synthetic:false};s.requirements.push(r);createdR.push(r.id);log('Requirement',r.id,r,[fid],d.rationale);}
 s.runs.push({id:runId,projectId,datasets:datasetIds,contextDatasets:s.datasets.filter(d=>d.projectId===projectId&&d.type!=='Customer verbatims'&&isInternalDataset(d)).map(d=>d.id),at:now,mode:'AI',findingIds:createdF,requirementIds:createdR,metrics:result.metrics,coverage:{first:batchIndex*50+1,last:batchIndex*50+records.length,total:totalRecords,batch:batchIndex+1,batches:totalBatches}});log('Analysis',runId,{findings:createdF.length,requirements:createdR.length,warnings:result.validation_errors,batch:batchIndex+1,totalBatches},[...createdF,...createdR],'Source-checked extraction, scope-isolated semantic clustering and requirements. Human review required.');s.revision++;return s;
}
export async function pythonAnalysis(state:Workspace,projectId:string,datasetIds:string[],onProgress:(p:LiveAnalysisProgress)=>void,batchIndex=0,resume?:PendingAnalysis){
 let selection:ReturnType<typeof selectFeedback>;
 try{selection=selectFeedback(state,projectId,datasetIds,batchIndex);}catch(error){if(resume)clearPendingAnalysis(resume.jobId);throw error;}
 const {project,records,datasets}=selection;
 const pending=resume??createPendingAnalysis(projectId,datasetIds,batchIndex);
 const jobId=pending.jobId;
 onProgress({jobId,stage:'extracting',progress:0,message:resume?'Reconnecting to the saved analysis…':`Starting analysis of ${records.length} source comments…`});
 if(!resume)await startAnalysisJob(pending,records.map(r=>({source_id:r.id,vehicle:project.derivative,market:project.market,text:r.content,source_type:'customer_feedback',source_file:String(r.fields.source_file??datasets.find(d=>d.id===r.datasetId)?.name??'Unknown source'),source_location:`${r.fields.source_sheet??r.sheet??'sheet'}!row ${r.fields.source_row??r.row}`,metadata:{synthetic:false,source_market_code:r.fields.source_market_code??null,source_market_label:r.fields.source_market_label??null,source_market_granularity:r.fields.source_market_granularity??null}})));
 const raw=await waitForAnalysisJob(pending,onProgress);
 let data:z.infer<typeof resultSchema>,next:Workspace;
 try{
  data=resultSchema.parse(raw);
  onProgress({jobId,stage:'committing',progress:95,message:'Checking exact source quotes and evidence links…'});
  next=integratePythonResult(state,projectId,datasetIds,data,batchIndex,jobId);
 }catch(error){clearPendingAnalysis(jobId);throw error;}
 const savedRun=next.runs.find(run=>run.id===`RUN-${jobId}`)!;
 onProgress({jobId,stage:'committing',progress:98,message:'Saving validated findings and requirements…',counts:{signals:data.findings.length,clusters:data.clusters.length,findings:savedRun.findingIds.length,requirements:savedRun.requirementIds.length}});
 return next;
}
