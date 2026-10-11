import {dimensions,type Workspace,type Project,type SourceRecord,type Dataset,type Requirement,type AuditEvent} from '../types';
import {priorityFor,scoreRequirement} from './scoring';
import {isInternalDataset} from './internal-data';
import {feedbackTypes,getSourceInsights,sourceLocation,type SourceCategoryOrigin} from './source-insights';
import type {AnalysisSession} from './analysis-progress';

export interface AssistantCitation {source_id:string;quote:string}
export interface AssistantReference {type:'requirement'|'finding'|'audit'|'run';id:string;label?:string}
export interface AssistantAnswer {
 answer:string;
 citations:AssistantCitation[];
 uncertainty:string;
 references?:AssistantReference[];
 mode?:'ai'|'local';
 metrics?:{input_tokens:number;output_tokens:number;model:string};
}
export interface AssistantHistoryMessage {role:'user'|'assistant';content:string}
export interface AssistantContextOptions {history?:AssistantHistoryMessage[];currentPage?:string;analysis?:AnalysisSession|null}
interface AssistantRequirement {
 id:string;title:string;statement:string;status:string;category:string;score:number|null;priority:string|null;
 calculated_priority:string|null;priority_override:string|null;override_reason:string;unknown_dimensions:string[];
 scores:Requirement['scores'];uncertainty:string;rationale:string;assumptions:string;finding_ids:string[];
 valid_support_source_ids:string[];valid_support_count:number;invalid_finding_ids:string[];created_at:string;updated_at:string;version:number;
 history:{version:number;at:string;reason:string;status:string;scores:Requirement['scores'];model_version:number}[];
 history_total:number;
}
interface AssistantFinding {
 id:string;title:string;description:string;need:string;status:string;category:string;source_ids:string[];contradictions:string[];
 valid_source_ids:string[];invalid_source_ids:string[];valid_contradiction_ids:string[];strength:string;confidence:number;
 implication:string;rationale:string;run_id:string|null;created_at:string;
}
interface AssistantSource {
 id:string;text:string;source_type:Dataset['type'];synthetic:boolean;url:string|null;dataset:string;dataset_id:string;
 original_id:string;file:string;sheet:string;row:number;category:string|null;category_origin:SourceCategoryOrigin|null;feedback_types:string[];
 text_truncated:boolean;original_text_characters:number;dataset_status:Dataset['status'];
}
interface AssistantDataset {
 id:string;name:string;type:Dataset['type'];synthetic:boolean;external:boolean;included_as_evidence:boolean;
 status:Dataset['status'];record_count:number;created_at:string;files:string[];sheets:string[];validation_error_count:number;
}
interface AssistantRun {
 id:string;at:string;mode:'Demo'|'AI';dataset_ids:string[];context_dataset_ids:string[];
 finding_ids:string[];requirement_ids:string[];finding_count:number;requirement_count:number;
 coverage:Workspace['runs'][number]['coverage']|null;metrics:Workspace['runs'][number]['metrics']|null;
}
interface AssistantAudit {
 id:string;at:string;actor:string;actor_id:string;action:string;entity_type:string;entity_id:string;
 rationale:string;related_ids:string[];version:number|null;run_id:string|null;
 before:Record<string,unknown>|null;after:Record<string,unknown>|null;
}
export interface AssistantContext {
 question:string;
 project:{id:string;name:string;derivative:string;market:string;horizon:string};
 current_page:string|null;
 workspace_revision:number;
 history:AssistantHistoryMessage[];
 analysis:{stage:string;progress:number;message:string;started_at:number;finished_at:number|null;dataset_ids:string[];batch:number;counts:AnalysisSession['progress']['counts']|null}|null;
 overview:{
  datasets:{total:number;internal:number;external:number;synthetic:number;by_type:Record<string,number>;records_by_type:Record<string,number>;ready:number;needs_mapping:number;validation_errors:number};
  feedback:{distinct_comments:number;annotation_rows:number;negative_comments:number;positive_comments:number;request_comments:number;unlabeled_comments:number;topic_count:number;inferred_topic_comments:number;general_feedback_comments:number};
  requirements:{total:number;by_status:Record<string,number>;by_priority:Record<string,number>;scored:number;unscored:number;unknown_dimensions:Record<string,number>;awaiting_review:number;with_valid_evidence:number;without_valid_evidence:number;evidence_coverage_percent:number|null;top_scored:{id:string;title:string;score:number;priority:string|null}[]};
  findings:{total:number;by_status:Record<string,number>;active:number;with_valid_support:number;invalid_source_links:number};
  analysis:{total_runs:number;ai_runs:number;demo_runs:number;latest_run_id:string|null;latest_at:string|null;coverage_known_runs:number};
  evidence_requests:{open:number;resolved:number};
  excluded:{synthetic_requirements:number;synthetic_findings:number;synthetic_datasets:number;external_datasets:number};
 };
 datasets:AssistantDataset[];
 source_topics:{id:string;name:string;category:string|null;feedback_count:number;annotation_count:number;source_count:number;inferred_count:number;general_count:number;negative_count:number;positive_count:number;request_count:number;unknown_count:number}[];
 requirements:AssistantRequirement[];
 findings:AssistantFinding[];
 sources:AssistantSource[];
 runs:AssistantRun[];
 audit:AssistantAudit[];
 evidence_requests:{id:string;requirement_id:string;text:string;status:string;created_at:string}[];
 retrieval_coverage:{
  query:string;selection:string;aggregates_cover_entire_project:boolean;
  requirements:{included:number;total:number};findings:{included:number;total:number};sources:{included:number;total:number;text_characters:number;text_budget:number;truncated:number};
  datasets:{included:number;total:number};source_topics:{included:number;total:number};runs:{included:number;total:number};audit:{included:number;total:number};
  evidence_requests:{included:number;total:number};limitations:string[];
 };
 scoring_model:Workspace['model'];
}

const LIMITS={requirements:12,findings:20,sources:24,sourceCharacters:4000,totalSourceCharacters:30000,datasets:40,topics:24,runs:12,audit:16,requests:12};
const clip=(value:string,limit:number)=>value.slice(0,limit);
const counts=<T,>(items:T[],key:(item:T)=>string):Record<string,number>=>items.reduce<Record<string,number>>((result,item)=>{const name=key(item);result[name]=(result[name]??0)+1;return result;},{});
const ignoredWords=new Set(['the','and','for','from','with','that','this','what','which','where','when','why','how','are','was','were','our','your','you','about','please','show','tell','give','have','has','can','does','there','project','current','currently','all','any','more','some','these','those','them','they','its','into']);
const words=(value:string)=>[...new Set((value.toLowerCase().match(/[\p{L}\p{N}-]+/gu)??[]).filter(word=>word.length>2&&!ignoredWords.has(word)))];
const relevance=(query:string,value:string)=>{const hay=value.toLowerCase();return words(query).reduce((score,term)=>score+(hay.includes(term)?1:0),0);};
const mentions=(query:string,id:string)=>!!id&&new RegExp(`(^|[^\\p{L}\\p{N}_-])${id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}($|[^\\p{L}\\p{N}_-])`,'iu').test(query);
const unique=(ids:string[])=>[...new Set(ids)];
const validRating=(value:number|null)=>value!==null&&Number.isFinite(value)&&value>=1&&value<=5;
const unknownDimensions=(requirement:Requirement)=>dimensions.filter(dimension=>!validRating(requirement.scores[dimension]));
const byRecent=<T extends {at:string}>(a:T,b:T)=>b.at.localeCompare(a.at);
const sourceText=(record:SourceRecord,dataset:Dataset)=>`${record.id} ${record.fields._originalId??''} ${record.content} ${record.category??''} ${dataset.type} ${dataset.name} ${feedbackTypes(record).join(' ')} ${record.fields.source_file??record.fields._filename??''}`;

function boundedHistory(history:AssistantHistoryMessage[]=[]):AssistantHistoryMessage[]{
 let remaining=10000;
 return history.filter(message=>message.role==='user'||message.role==='assistant').slice(-8).reverse().map(message=>{
  const content=clip(message.content,Math.min(1600,remaining));remaining-=content.length;
  return {role:message.role,content};
 }).filter(message=>message.content.trim()).reverse();
}
function auditSnapshot(value:unknown):Record<string,unknown>|null {
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 const snapshot=value as Record<string,unknown>,result:Record<string,unknown>={};
 // Audit records can contain complete datasets or findings; only decision fields belong in the prompt.
 for(const key of ['status','title','statement','category','scores','priorityOverride','version','modelVersion','findings','requirements','records','batch','totalBatches']){
  const item=snapshot[key];
  if(typeof item==='string')result[key]=clip(item,800);
  else if(typeof item==='number'||typeof item==='boolean'||item===null)result[key]=item;
  else if(key==='scores'&&item&&typeof item==='object')result[key]=Object.fromEntries(dimensions.map(d=>[d,(item as Record<string,unknown>)[d]??null]));
  else if(Array.isArray(item))result[`${key}_count`]=item.length;
 }
 return result;
}

/** Counts cover the full project. Text retrieval is bounded, with its scope declared in retrieval_coverage. */
export function buildAssistantContext(state:Workspace,project:Project,question:string,options:AssistantContextOptions={}):AssistantContext {
 const query=clip(question.trim(),2000),history=boundedHistory(options.history);
 const previousUsers=history.filter(message=>message.role==='user'&&message.content.trim()!==query).slice(-2).map(message=>message.content).join(' ');
 const followUp=!!previousUsers&&(/\b(it|its|that|those|these|them|they|same|more|again|why)\b|^(and|also|what about|how about)\b/i.test(query)||words(query).length<=3);
 const previousAnswer=followUp?history.filter(message=>message.role==='assistant').at(-1)?.content??'':'';
 const retrievalQuery=followUp&&previousUsers?`${query}\nPrevious user questions: ${previousUsers}`:query;
 const scoreText=(text:string)=>relevance(query,text)+(followUp?relevance(previousUsers,text)*0.35:0);
 const exactId=(id:string)=>mentions(query,id)?1000:followUp&&mentions(previousAnswer,id)?100:followUp&&mentions(previousUsers,id)?80:0;
 const projectDatasets=state.datasets.filter(dataset=>dataset.projectId===project.id);
 const datasets=projectDatasets.filter(dataset=>isInternalDataset(dataset)&&!dataset.synthetic);
 const records=datasets.flatMap(dataset=>dataset.records.map(record=>({record,dataset})));
 const sourceById=new Map(records.map(entry=>[entry.record.id,entry]));
 const validSupport=new Set(records.filter(({record,dataset})=>dataset.status==='Ready'&&dataset.type==='Customer verbatims'&&record.content.trim()).map(({record})=>record.id));
 const validInternal=new Set(records.filter(({record,dataset})=>dataset.status==='Ready'&&record.content.trim()).map(({record})=>record.id));
 const reqs=state.requirements.filter(requirement=>requirement.projectId===project.id&&!requirement.synthetic);
 const findings=state.findings.filter(finding=>finding.projectId===project.id&&!finding.synthetic);
 const findingsById=new Map(findings.map(finding=>[finding.id,finding]));
 const activeFindings=findings.filter(finding=>finding.status!=='Excluded');
 const activeFindingIds=new Set(activeFindings.map(finding=>finding.id));
 const evidenceFor=(requirement:Requirement)=>unique(requirement.findings.filter(id=>activeFindingIds.has(id)).flatMap(id=>findingsById.get(id)?.sources.filter(sourceId=>validSupport.has(sourceId))??[]));
 const scores=new Map(reqs.map(requirement=>[requirement.id,scoreRequirement(requirement.scores,state.model)]));
 const insights=getSourceInsights(state,project.id);
 const insightRecords=new Map(insights.records.map(record=>[record.id,record]));
 const runs=state.runs.filter(run=>run.projectId===project.id).sort(byRecent);
 const syntheticIds=new Set([...state.requirements.filter(r=>r.projectId===project.id&&r.synthetic),...state.findings.filter(f=>f.projectId===project.id&&f.synthetic),...projectDatasets.filter(d=>d.synthetic)].map(item=>item.id));
 const audit=state.audit.filter(event=>event.projectId===project.id&&!syntheticIds.has(event.entityId)).sort(byRecent);
 const requests=state.requests.filter(request=>request.projectId===project.id&&reqs.some(requirement=>requirement.id===request.requirementId));
 const asksTop=/\b(top|highest|rank|priority|priorities)\b/i.test(query);
 const asksUnknown=/\b(unknown|unscored|missing|gap|gaps)\b|need.*judgment/i.test(query);
 const asksHistory=/\b(change|changed|decision|decisions|audit|history|approved|rejected|deferred|review)\b/i.test(query);
 const sourceScores=new Map(records.map(({record,dataset})=>[record.id,scoreText(sourceText(record,dataset))+exactId(record.id)+(mentions(query,String(record.fields._originalId??''))?1000:0)]));
 const findingRelevance=new Map(findings.map(finding=>[finding.id,scoreText(`${finding.id} ${finding.title} ${finding.description} ${finding.need} ${finding.category}`)+exactId(finding.id)+Math.max(0,...finding.sources.map(id=>Math.min(10,sourceScores.get(id)??0)))]));
 const rankedReqs=reqs.map(requirement=>({requirement,score:scoreText(`${requirement.id} ${requirement.title} ${requirement.statement} ${requirement.category} ${requirement.status}`)+exactId(requirement.id)+Math.max(0,...requirement.findings.map(id=>Math.min(10,findingRelevance.get(id)??0)))})).sort((a,b)=>{
  const exact=exactId(b.requirement.id)-exactId(a.requirement.id);if(exact)return exact;
  if(asksTop){const priority=(scores.get(b.requirement.id)??-1)-(scores.get(a.requirement.id)??-1);if(priority)return priority;}
  if(asksUnknown){const unknown=Number(scores.get(a.requirement.id)!==null)-Number(scores.get(b.requirement.id)!==null);if(unknown)return unknown;}
  return b.score-a.score||b.requirement.updatedAt.localeCompare(a.requirement.updatedAt)||a.requirement.id.localeCompare(b.requirement.id);
 });
 const selectedReqs=rankedReqs.slice(0,LIMITS.requirements).map(entry=>entry.requirement);
 const linkedFindingIds=new Set(selectedReqs.flatMap(requirement=>requirement.findings));
 const selectedFindings=[...findings].sort((a,b)=>(findingRelevance.get(b.id)??0)+(linkedFindingIds.has(b.id)?20:0)-(findingRelevance.get(a.id)??0)-(linkedFindingIds.has(a.id)?20:0)||b.createdAt.localeCompare(a.createdAt)).slice(0,LIMITS.findings);
 const linkedSourceIds=new Set(selectedFindings.flatMap(finding=>[...finding.sources,...finding.contradictions]));
 const referenceType=/\bsales\b/i.test(query)?'Sales volumes':/\b(equipment|catalog|catalogue|feature availability)\b/i.test(query)?'Equipment list':/\b(study|studies|survey)\b/i.test(query)?'Customer study':null;
 const rankedSources=[...records].sort((a,b)=>(sourceScores.get(b.record.id)??0)+(linkedSourceIds.has(b.record.id)?20:0)+(referenceType===b.dataset.type?100:0)-(sourceScores.get(a.record.id)??0)-(linkedSourceIds.has(a.record.id)?20:0)-(referenceType===a.dataset.type?100:0)||a.record.id.localeCompare(b.record.id));
 let sourceCharacters=0;
 const selectedSources:AssistantSource[]=[];
 for(const {record,dataset} of rankedSources){
  if(selectedSources.length>=LIMITS.sources||sourceCharacters>=LIMITS.totalSourceCharacters)break;
  if(selectedSources.some(source=>source.id===record.id))continue;
  const text=clip(record.content,Math.min(LIMITS.sourceCharacters,LIMITS.totalSourceCharacters-sourceCharacters));
  const location=sourceLocation(record);sourceCharacters+=text.length;
  const insightRecord=insightRecords.get(record.id);
  const insightAnnotations=Array.isArray(insightRecord?.fields.annotations)?insightRecord.fields.annotations.filter((item):item is Record<string,unknown>=>Boolean(item)&&typeof item==='object'):[];
  const derived=insightAnnotations.find(item=>typeof item.insight_category==='string');
  const rawCategory=record.category?.trim();
  const hasSourceCategory=!!rawCategory&&!['no_class_found','no class found','unclassified'].includes(rawCategory.toLowerCase());
  const category=derived?.insight_category??(hasSourceCategory?rawCategory:null);
  const categoryOrigin=derived?.insight_origin==='inferred'||derived?.insight_origin==='general'?derived.insight_origin:hasSourceCategory?'source':null;
  selectedSources.push({id:record.id,text,source_type:dataset.type,synthetic:false,url:typeof record.fields.url==='string'?clip(record.fields.url,1000):null,dataset:clip(dataset.name,240),dataset_id:dataset.id,original_id:clip(String(record.fields._originalId??record.id),240),file:clip(location.file,240),sheet:clip(location.sheet,120),row:location.row,category:typeof category==='string'?clip(category,160):null,category_origin:categoryOrigin,feedback_types:feedbackTypes(record).slice(0,10),text_truncated:text.length<record.content.length,original_text_characters:record.content.length,dataset_status:dataset.status});
 }
 const selectedReqIds=new Set(selectedReqs.map(requirement=>requirement.id));
 const relevantAudit=(event:AuditEvent)=>exactId(event.id)+exactId(event.entityId)+scoreText(`${event.action} ${event.rationale} ${event.entityId}`)+(asksHistory&&(selectedReqIds.has(event.entityId)||linkedFindingIds.has(event.entityId))?10:0);
 const selectedAudit=[...audit].sort((a,b)=>exactId(b.id)-exactId(a.id)||(asksHistory?relevantAudit(b)-relevantAudit(a):0)||byRecent(a,b)).slice(0,LIMITS.audit);
 const linkedRuns=runs.filter(run=>exactId(run.id)>0||run.requirementIds.some(id=>selectedReqIds.has(id))||run.findingIds.some(id=>linkedFindingIds.has(id))).sort((a,b)=>exactId(b.id)-exactId(a.id)||byRecent(a,b));
 const selectedRuns=unique([...runs.slice(0,4).map(run=>run.id),...linkedRuns.map(run=>run.id),...runs.map(run=>run.id)]).slice(0,LIMITS.runs).flatMap(id=>runs.find(run=>run.id===id)??[]);
 const selectedDatasets=[...projectDatasets].sort((a,b)=>exactId(b.id)-exactId(a.id)||Number(a.synthetic||!isInternalDataset(a))-Number(b.synthetic||!isInternalDataset(b))||scoreText(`${b.name} ${b.type}`)-scoreText(`${a.name} ${a.type}`)||b.createdAt.localeCompare(a.createdAt)).slice(0,LIMITS.datasets);
 const selectedTopics=[...insights.topics].sort((a,b)=>scoreText(b.name)-scoreText(a.name)||b.feedbackCount-a.feedbackCount).slice(0,LIMITS.topics);
 const selectedRequests=[...requests].sort((a,b)=>Number(selectedReqIds.has(b.requirementId))-Number(selectedReqIds.has(a.requirementId))||b.createdAt.localeCompare(a.createdAt)).slice(0,LIMITS.requests);
 const validEvidenceCount=reqs.filter(requirement=>evidenceFor(requirement).length>0).length;
 const scoredReqs=reqs.filter(requirement=>scores.get(requirement.id)!==null).sort((a,b)=>(scores.get(b.id)??0)-(scores.get(a.id)??0)||a.id.localeCompare(b.id));
 const analysis=options.analysis?.projectId===project.id?options.analysis:null;
 const overview:AssistantContext['overview']={
  datasets:{total:projectDatasets.length,internal:datasets.length,external:projectDatasets.filter(dataset=>!isInternalDataset(dataset)).length,synthetic:projectDatasets.filter(dataset=>dataset.synthetic).length,by_type:counts(datasets,dataset=>dataset.type),records_by_type:datasets.reduce<Record<string,number>>((result,dataset)=>{result[dataset.type]=(result[dataset.type]??0)+dataset.records.length;return result;},{}),ready:datasets.filter(dataset=>dataset.status==='Ready').length,needs_mapping:datasets.filter(dataset=>dataset.status==='Needs mapping').length,validation_errors:datasets.filter(dataset=>dataset.status==='Validation errors').length},
  feedback:{distinct_comments:insights.feedbackCount,annotation_rows:insights.annotationCount,negative_comments:insights.negativeCount,positive_comments:insights.positiveCount,request_comments:insights.requestCount,unlabeled_comments:insights.unknownCount,topic_count:insights.topics.length,inferred_topic_comments:insights.inferredCommentCount,general_feedback_comments:insights.generalFeedbackCount},
  requirements:{total:reqs.length,by_status:counts(reqs,requirement=>requirement.status),by_priority:counts(reqs,requirement=>requirement.priorityOverride??priorityFor(scores.get(requirement.id)??null,state.model)??'Unscored'),scored:scoredReqs.length,unscored:reqs.length-scoredReqs.length,unknown_dimensions:Object.fromEntries(dimensions.map(dimension=>[dimension,reqs.filter(requirement=>!validRating(requirement.scores[dimension])).length])),awaiting_review:reqs.filter(requirement=>['Awaiting review','Proposed','Challenged'].includes(requirement.status)).length,with_valid_evidence:validEvidenceCount,without_valid_evidence:reqs.length-validEvidenceCount,evidence_coverage_percent:reqs.length?Math.round(validEvidenceCount/reqs.length*100):null,top_scored:scoredReqs.slice(0,5).map(requirement=>({id:requirement.id,title:clip(requirement.title,300),score:scores.get(requirement.id)!,priority:requirement.priorityOverride??priorityFor(scores.get(requirement.id)??null,state.model)}))},
  findings:{total:findings.length,by_status:counts(findings,finding=>finding.status),active:activeFindings.length,with_valid_support:activeFindings.filter(finding=>finding.sources.some(id=>validSupport.has(id))).length,invalid_source_links:findings.reduce((sum,finding)=>sum+unique([...finding.sources,...finding.contradictions]).filter(id=>!validInternal.has(id)).length,0)},
  analysis:{total_runs:runs.length,ai_runs:runs.filter(run=>run.mode==='AI').length,demo_runs:runs.filter(run=>run.mode==='Demo').length,latest_run_id:runs[0]?.id??null,latest_at:runs[0]?.at??null,coverage_known_runs:runs.filter(run=>!!run.coverage).length},
  evidence_requests:{open:requests.filter(request=>request.status==='Open').length,resolved:requests.filter(request=>request.status==='Resolved').length},
  excluded:{synthetic_requirements:state.requirements.filter(requirement=>requirement.projectId===project.id&&requirement.synthetic).length,synthetic_findings:state.findings.filter(finding=>finding.projectId===project.id&&finding.synthetic).length,synthetic_datasets:projectDatasets.filter(dataset=>dataset.synthetic).length,external_datasets:projectDatasets.filter(dataset=>!isInternalDataset(dataset)).length},
 };
 const context:AssistantContext={
  question:query,project:{id:project.id,name:clip(project.name,240),derivative:project.derivative,market:project.market,horizon:project.horizon},workspace_revision:state.revision,current_page:options.currentPage?clip(options.currentPage,80):null,history,
  analysis:analysis?{stage:analysis.progress.stage,progress:analysis.progress.progress,message:clip(analysis.progress.message,1000),started_at:analysis.startedAt,finished_at:analysis.finishedAt??null,dataset_ids:analysis.datasetIds.filter(id=>datasets.some(dataset=>dataset.id===id)).slice(0,40),batch:analysis.batchIndex+1,counts:analysis.progress.counts??null}:null,
  overview,
  datasets:selectedDatasets.map(dataset=>({id:dataset.id,name:clip(dataset.name,240),type:dataset.type,synthetic:dataset.synthetic,external:!isInternalDataset(dataset),included_as_evidence:isInternalDataset(dataset)&&!dataset.synthetic&&dataset.status==='Ready'&&dataset.type==='Customer verbatims',status:dataset.status,record_count:dataset.records.length,created_at:dataset.createdAt,files:unique(dataset.records.map(record=>sourceLocation(record).file)).slice(0,8).map(file=>clip(file,240)),sheets:unique(dataset.records.map(record=>sourceLocation(record).sheet)).slice(0,8).map(sheet=>clip(sheet,120)),validation_error_count:dataset.errors.length})),
  source_topics:selectedTopics.map(topic=>({id:topic.id,name:clip(topic.name,160),category:topic.category?clip(topic.category,160):null,feedback_count:topic.feedbackCount,annotation_count:topic.annotationCount,source_count:topic.sourceCount,inferred_count:topic.inferredCount,general_count:topic.generalCount,negative_count:topic.negativeCount,positive_count:topic.positiveCount,request_count:topic.requestCount,unknown_count:topic.unknownCount})),
  requirements:selectedReqs.map(requirement=>({id:requirement.id,title:clip(requirement.title,300),statement:clip(requirement.statement,2400),status:requirement.status,category:requirement.category,score:scores.get(requirement.id)??null,priority:requirement.priorityOverride??priorityFor(scores.get(requirement.id)??null,state.model),calculated_priority:priorityFor(scores.get(requirement.id)??null,state.model),priority_override:requirement.priorityOverride??null,override_reason:clip(requirement.overrideReason??'',800),unknown_dimensions:unknownDimensions(requirement),scores:requirement.scores,uncertainty:clip(requirement.uncertainty,1800),rationale:clip(requirement.rationale,1800),assumptions:clip(requirement.assumptions,1200),finding_ids:requirement.findings.filter(id=>findingsById.has(id)).slice(0,80),valid_support_source_ids:evidenceFor(requirement).slice(0,80),valid_support_count:evidenceFor(requirement).length,invalid_finding_ids:requirement.findings.filter(id=>!findingsById.has(id)).slice(0,40),created_at:requirement.createdAt,updated_at:requirement.updatedAt,version:requirement.version,history_total:requirement.history.length,history:[...requirement.history].sort((a,b)=>b.version-a.version).slice(0,3).map(version=>({version:version.version,at:version.at,reason:clip(version.reason,800),status:version.status,scores:version.scores,model_version:version.modelVersion}))})),
  findings:selectedFindings.map(finding=>({id:finding.id,title:clip(finding.title,300),description:clip(finding.description,3000),need:clip(finding.need,1000),status:finding.status,category:finding.category,source_ids:finding.sources.filter(id=>sourceById.has(id)).slice(0,80),contradictions:finding.contradictions.filter(id=>sourceById.has(id)).slice(0,40),valid_source_ids:finding.sources.filter(id=>validSupport.has(id)).slice(0,80),invalid_source_ids:unique([...finding.sources,...finding.contradictions]).filter(id=>!validInternal.has(id)).slice(0,40),valid_contradiction_ids:finding.contradictions.filter(id=>validInternal.has(id)).slice(0,40),strength:finding.strength,confidence:finding.confidence,implication:clip(finding.implication,1000),rationale:clip(finding.rationale??'',800),run_id:finding.runId??null,created_at:finding.createdAt})),
  sources:selectedSources,
  runs:selectedRuns.map(run=>({id:run.id,at:run.at,mode:run.mode,dataset_ids:run.datasets.filter(id=>datasets.some(dataset=>dataset.id===id)).slice(0,40),context_dataset_ids:(run.contextDatasets??[]).filter(id=>datasets.some(dataset=>dataset.id===id)).slice(0,40),finding_ids:run.findingIds.filter(id=>findingsById.has(id)).slice(0,80),requirement_ids:run.requirementIds.filter(id=>reqs.some(requirement=>requirement.id===id)).slice(0,80),finding_count:run.findingIds.length,requirement_count:run.requirementIds.length,coverage:run.coverage??null,metrics:run.metrics??null})),
  audit:selectedAudit.map(event=>({id:event.id,at:event.at,actor:event.actor,actor_id:clip(event.actorId,160),action:clip(event.action,200),entity_type:event.entityType,entity_id:event.entityId,rationale:clip(event.rationale,1000),related_ids:event.relatedIds.filter(id=>!syntheticIds.has(id)).slice(0,40),version:event.version??null,run_id:event.runId??null,before:auditSnapshot(event.before),after:auditSnapshot(event.after)})),
  evidence_requests:selectedRequests.map(request=>({id:request.id,requirement_id:request.requirementId,text:clip(request.text,1200),status:request.status,created_at:request.createdAt})),
  retrieval_coverage:{query:clip(retrievalQuery,4000),selection:'Question and exact-ID relevance, linked findings and sources, recent records; prior user questions and referenced IDs inform follow-ups.',aggregates_cover_entire_project:true,requirements:{included:selectedReqs.length,total:reqs.length},findings:{included:selectedFindings.length,total:findings.length},sources:{included:selectedSources.length,total:sourceById.size,text_characters:sourceCharacters,text_budget:LIMITS.totalSourceCharacters,truncated:selectedSources.filter(source=>source.text_truncated).length},datasets:{included:selectedDatasets.length,total:projectDatasets.length},source_topics:{included:selectedTopics.length,total:insights.topics.length},runs:{included:selectedRuns.length,total:runs.length},audit:{included:selectedAudit.length,total:audit.length},evidence_requests:{included:selectedRequests.length,total:requests.length},limitations:[
   'Overview counts are computed from the whole selected project. Detailed text is a bounded retrieval, not an exhaustive review of every record.',
   'Synthetic requirements, findings and source text are excluded. External research is inventory metadata only and is not product evidence. Dataset type and record totals describe real internal imports unless explicitly marked otherwise.',
   'Feedback counts are distinct original comments; annotation rows can repeat a comment. Negative, positive and request labels come from the workbook. Topic counts combine source categories with local text-similarity inferences; ambiguous comments remain in General feedback. These counts can overlap and are not population prevalence.',
   'Valid requirement evidence means a non-excluded, non-synthetic finding linked to a nonempty customer-feedback record in a Ready internal dataset in this project. Challenged findings remain active but require review.',
   'Equipment, sales and studies are reference context, not individual customer complaints. Source text in datasets awaiting mapping or validation is unvalidated.',
   'Run coverage describes its recorded batch at run time. Overlapping runs must not be added to infer unique analysis coverage; missing coverage is unknown. Demo runs are explicitly labeled.',
   'Scores need all five valid PM ratings. A manual priority override does not fill missing ratings. Confidence and frequency may be qualitative or batch heuristics.',
   'History is conversational context, not evidence; all current facts must come from the current project snapshot. Requirement history and audit snapshots are abbreviated.',
  ]},
  scoring_model:state.model,
 };
 // Keep a byte budget as well as record limits: multilingual source text can be much larger in UTF-8.
 const encoder=new TextEncoder(),byteLength=(value:unknown)=>encoder.encode(JSON.stringify(value)).length;
 const detailKeys=['requirements','findings','sources','datasets','source_topics','runs','audit','evidence_requests'] as const;
 let bounded=false;
 while(byteLength(context)>240000){
  const candidates=detailKeys.filter(key=>context[key].length>1);
  const largest=(candidates.length?candidates:detailKeys.filter(key=>context[key].length>0)).sort((a,b)=>byteLength(context[b])-byteLength(context[a]))[0];
  if(!largest)break;
  context[largest].pop();bounded=true;
 }
 for(const key of detailKeys)context.retrieval_coverage[key].included=context[key].length;
 context.retrieval_coverage.sources.text_characters=context.sources.reduce((sum,source)=>sum+source.text.length,0);
 context.retrieval_coverage.sources.truncated=context.sources.filter(source=>source.text_truncated).length;
 if(bounded)context.retrieval_coverage.limitations.push('Some selected detail records were omitted to keep the full context within its byte budget; project aggregates remain complete.');
 return context;
}

/** A deterministic answer for local fallback; it never claims to be an AI interpretation. */
export function offlineAssistantAnswer(context:AssistantContext):AssistantAnswer {
 const overview=context.overview,question=context.question;
 const local=(answer:string,citations:AssistantCitation[]=[],references:AssistantReference[]=[],uncertainty='This is a local project summary, not an AI response. Source counts do not establish market prevalence.'):AssistantAnswer=>({answer:`Local project summary (not AI). ${answer}`,citations,references,uncertainty,mode:'local'});
 const cite=(sources:AssistantSource[])=>sources.slice(0,3).filter(source=>source.text.trim()).map(source=>({source_id:source.id,quote:source.text.slice(0,180)}));
 const requirementReference=(requirement:{id:string;title:string}):AssistantReference=>({type:'requirement',id:requirement.id,label:requirement.title});
 const explicit=context.requirements.find(requirement=>mentions(question,requirement.id));
 const followUp=/\b(it|its|that|those|them|same|why)\b/i.test(question);
 const priorReference=followUp?[...context.history].reverse().map(message=>context.requirements.filter(requirement=>mentions(message.content,requirement.id))).find(matches=>matches.length===1)?.[0]:undefined;
 if(explicit||priorReference){
  const requirement=(explicit??priorReference)!;
  const linkedIds=new Set(requirement.valid_support_source_ids),sources=context.sources.filter(source=>linkedIds.has(source.id));
  const priority=requirement.score===null?`Its score is unknown; ratings are missing or invalid for ${requirement.unknown_dimensions.join(', ')}.`:`Its documented score is ${requirement.score} (${requirement.calculated_priority}).`;
  return local(`${requirement.id}: ${requirement.title}. ${requirement.statement} Status: ${requirement.status}. ${priority}${requirement.priority_override?` The PM priority override is ${requirement.priority_override}.`:''} ${requirement.valid_support_count} valid linked feedback record(s) are recorded.${/\b(why|rationale|reason)\b/i.test(question)&&requirement.rationale?` Recorded rationale: ${requirement.rationale}`:''}`,cite(sources),[requirementReference(requirement)],requirement.uncertainty||'The source excerpts shown are a selection. Review the linked findings and any challenged evidence before deciding.');
 }
 const explicitSource=context.sources.find(source=>mentions(question,source.id)||mentions(question,source.original_id));
 if(explicitSource)return local(`${explicitSource.original_id} — ${explicitSource.file}${explicitSource.sheet?` / ${explicitSource.sheet}`:''}, row ${explicitSource.row}. Type: ${explicitSource.source_type}. ${explicitSource.text}`,cite([explicitSource]),[],explicitSource.text_truncated?'The displayed text is an excerpt of the original record.':'The text is taken directly from the imported source record.');
 const explicitFinding=context.findings.find(finding=>mentions(question,finding.id));
 if(explicitFinding)return local(`${explicitFinding.id}: ${explicitFinding.title}. ${explicitFinding.description} Status: ${explicitFinding.status}.`,cite(context.sources.filter(source=>explicitFinding.source_ids.includes(source.id))),[{type:'finding',id:explicitFinding.id,label:explicitFinding.title}],explicitFinding.implication||'Review the source records and any contradicting evidence.');
 const explicitAudit=context.audit.find(event=>mentions(question,event.id));
 if(explicitAudit)return local(`${explicitAudit.at}: ${explicitAudit.action} (${explicitAudit.entity_id}). ${explicitAudit.rationale}`,[],[{type:'audit',id:explicitAudit.id,label:explicitAudit.action}]);
 if(/\b(run|runs|analy[sz]ed|analysis|analy[sz]ing|batch|batches|progress)\b/i.test(question)){
  const explicitRun=context.runs.find(item=>mentions(question,item.id));
  const run=explicitRun??context.runs.find(item=>item.id===overview.analysis.latest_run_id),active=context.analysis;
  const live=active?` Current analysis: ${active.stage}, ${active.progress}% — ${active.message}`:'';
  const latest=run?` ${explicitRun?'Requested':'Latest saved'} run: ${run.id} (${run.mode}) at ${run.at}, with ${run.finding_count} findings and ${run.requirement_count} requirement proposals.${run.coverage?` Recorded batch ${run.coverage.batch} of ${run.coverage.batches}: records ${run.coverage.first}–${run.coverage.last} of ${run.coverage.total}.`:' Batch coverage was not recorded.'}`:overview.analysis.total_runs?` Latest saved run: ${overview.analysis.latest_run_id} at ${overview.analysis.latest_at}; its details were not included in this retrieval.`:' No saved analysis runs are recorded.';
  return local(`${overview.analysis.total_runs} saved run(s): ${overview.analysis.ai_runs} AI and ${overview.analysis.demo_runs} Demo.${live}${latest}`,[],run?[{type:'run',id:run.id,label:explicitRun?'Requested analysis run':'Latest saved analysis'}]:[],'Batch totals may overlap across runs. Unique overall analysis coverage cannot be inferred by adding them.');
 }
 if(/\b(audit|decision|decisions|changed|changes|history|recent activity)\b/i.test(question)){
  const recent=context.audit.slice(0,4);
  return local(recent.length?recent.map(event=>`${event.at}: ${event.action} (${event.entity_id})${event.rationale?` — ${event.rationale}`:''}.`).join('\n'):'No matching audit events are recorded for this project.',[],recent.map(event=>({type:'audit',id:event.id,label:event.action})));
 }
 if(/\b(equipment|catalog|catalogue|sales|study|studies|dataset|datasets|files|sources|market data)\b/i.test(question)){
  const type=/\bsales\b/i.test(question)?'Sales volumes':/\b(equipment|catalog|catalogue)\b/i.test(question)?'Equipment list':/\b(study|studies)\b/i.test(question)?'Customer study':null;
  const records=type?overview.datasets.records_by_type[type]??0:Object.values(overview.datasets.records_by_type).reduce((sum,count)=>sum+count,0);
  const inventory=Object.entries(overview.datasets.records_by_type).map(([name,count])=>`${name}: ${count} imported record(s)`).join('; ');
  return local(type?`${records} ${type.toLowerCase()} record(s) are imported in this project.`:`${overview.datasets.internal} real internal dataset(s). ${inventory||'No real internal source records are imported.'} ${overview.datasets.external} external and ${overview.datasets.synthetic} synthetic dataset(s) are excluded from evidence.`,cite(context.sources.filter(source=>type?source.source_type===type:true)),[],'Sales, equipment and studies are reference context. Imported record counts may include repeated imports; only the distinct feedback count is deduplicated.');
 }
 if(/\b(top|highest|rank|priority|priorities|unscored|unknown|scor(?:e|es|ing))\b/i.test(question)&&!/\b(topic|topics|theme|themes|feedback|comment|comments)\b/i.test(question)){
  const top=overview.requirements.top_scored;
  const missing=Object.entries(overview.requirements.unknown_dimensions).filter(([,count])=>count).map(([dimension,count])=>`${dimension}: ${count}`).join(', ');
  return local(`${overview.requirements.scored} of ${overview.requirements.total} requirements have complete scores; ${overview.requirements.unscored} are unscored.${missing?` Missing or invalid ratings by dimension: ${missing}.`:''} ${top.length?`Highest documented scores: ${top.map(requirement=>`${requirement.id} (${requirement.score})`).join(', ')}.`:'There is no scored top requirement yet.'}`,[],top.filter(requirement=>context.requirements.some(selected=>selected.id===requirement.id)).map(requirementReference),'This uses recorded scores and the current scoring model. A manual priority override is distinct from a complete calculated score.');
 }
 if(/\b(coverage|support|evidence|gap|gaps)\b/i.test(question)&&!/(negative|positive|topic|theme)/i.test(question)){
  return local(`${overview.requirements.with_valid_evidence} of ${overview.requirements.total} requirements have valid linked customer feedback${overview.requirements.evidence_coverage_percent===null?'':` (${overview.requirements.evidence_coverage_percent}%)`}; ${overview.requirements.without_valid_evidence} have no valid support. ${overview.evidence_requests.open} evidence request(s) are open.`,[],[],'Valid support requires an active finding and an existing nonempty feedback record in a Ready internal dataset in this project. Challenged evidence still requires review.');
 }
 if(/\b(topic|topics|theme|themes|feedback|comments|negative|positive|requests|annotation|annotations)\b/i.test(question)){
  const feedback=overview.feedback,topics=context.source_topics.slice(0,5);
  return local(`${feedback.distinct_comments} distinct source comments correspond to ${feedback.annotation_rows} annotation rows. Workbook labels mark ${feedback.negative_comments} negative, ${feedback.positive_comments} positive and ${feedback.request_comments} request comment(s); ${feedback.unlabeled_comments} have no recognized feedback-type label. Local text similarity assigned topics to ${feedback.inferred_topic_comments} comments; ${feedback.general_feedback_comments} ambiguous comments remain under General feedback.${topics.length?` ${relevance(question,topics.map(topic=>topic.name).join(' '))?'Matching':'Largest'} topics: ${topics.map(topic=>`${topic.name} (${topic.feedback_count} comments${topic.inferred_count?`, ${topic.inferred_count} inferred`:''})`).join('; ')}.`:''}`,cite(context.sources.filter(source=>source.source_type==='Customer verbatims')),[],'Issue, praise and request labels come from the workbook. Inferred topics are local text-similarity matches, are marked separately, and can overlap with source topics. Counts do not represent population prevalence.');
 }
 const status=Object.entries(overview.requirements.by_status).map(([name,count])=>`${count} ${name.toLowerCase()}`).join(', ');
 const requirements=overview.requirements.total?`${overview.requirements.total} requirements (${status}), including ${overview.requirements.unscored} unscored.`:'There are no requirements and no drafted requirements yet.';
 return local(`${context.project.derivative} / ${context.project.market}: ${overview.feedback.distinct_comments} distinct source comments, ${overview.feedback.annotation_rows} annotation rows, ${overview.findings.total} findings. ${requirements} ${overview.analysis.total_runs} analysis run(s) are saved; ${overview.evidence_requests.open} evidence request(s) are open.`,cite(context.sources),[],'This is a factual snapshot of the project. The selected source excerpts do not constitute an exhaustive review; interpretation requires the connected AI assistant or PM review.');
}

export function lookupAssistantSource(state:Workspace,projectId:string,id:string):SourceRecord|undefined {
 return state.datasets.filter(dataset=>dataset.projectId===projectId&&isInternalDataset(dataset)&&!dataset.synthetic).flatMap(dataset=>dataset.records).find(record=>record.id===id);
}
