import {dimensions, dimensionLabels, type Finding, type SourceRecord, type Workspace} from '../types';
import {isInternalDataset} from './internal-data';
import {evidenceLevel, priorityFor, scoreRequirement} from './scoring';
import {getSourceInsights} from './source-insights';

const limits = {requirements:20, findings:20, quotesPerFinding:2, counterQuotesPerFinding:1, quoteCharacters:1000, runs:10, decisions:15, requests:15,datasets:40,filesPerDataset:5,errorsPerDataset:3,sourceIds:12,topics:20,proseCharacters:1400,payloadBytes:800_000};
const byNewest = (a:{at:string}, b:{at:string}) => b.at.localeCompare(a.at);
const excerpt = (text:string, length:number) => ({text:text.slice(0,length), truncated:text.length>length});
const bounded=(value:unknown,limit=limits.proseCharacters)=>{const text=String(value??'');return text.length>limit?`${text.slice(0,limit)} [shortened]`:text;};
const ids=(values:string[])=>values.slice(0,limits.sourceIds).map(value=>bounded(value,160));

function sourceQuote(finding:Finding, record:SourceRecord) {
  // Analysis integration stores verified quotations as source-ID-prefixed lines.
  // Re-check against the current original record before labelling one an exact quote.
  const marker=`${record.id}: “`;
  const start=finding.description.indexOf(marker);
  let quote:string|undefined;
  if(start>=0){
    const remainder=finding.description.slice(start+marker.length);
    const end=remainder.search(/”(?:\r?\n|$)/);
    const candidate=end>=0?remainder.slice(0,end):'';
    if(candidate&&record.content.includes(candidate))quote=candidate;
  }
  return {...excerpt(quote??record.content,limits.quoteCharacters),kind:quote?'Verified evidence quotation':'Linked source excerpt'};
}

/** A bounded, project-only snapshot: never sends the complete customer-comment library. */
export function buildReportPayload(state:Workspace, projectId:string) {
  const project=state.projects.find(item=>item.id===projectId);
  if(!project)throw new Error('Choose a project before exporting its report.');
  const projectDatasets=state.datasets.filter(item=>item.projectId===projectId&&isInternalDataset(item));
  const datasets=projectDatasets.filter(item=>!item.synthetic);
  const sourceInsights=getSourceInsights(state,projectId);
  const sources=new Map(datasets.flatMap(dataset=>dataset.records.map(record=>[record.id,{record,dataset}] as const)));
  const projectFindings=state.findings.filter(item=>item.projectId===projectId);
  const projectRequirements=state.requirements.filter(item=>item.projectId===projectId);
  const findings=projectFindings.filter(item=>!item.synthetic);
  const requirements=projectRequirements.filter(item=>!item.synthetic);
  const syntheticIds=new Set([...projectDatasets,...projectFindings,...projectRequirements].filter(item=>item.synthetic).map(item=>item.id));
  const runs=state.runs.filter(item=>item.projectId===projectId&&item.mode==='AI').sort(byNewest);
  const decisions=state.audit.filter(item=>item.projectId===projectId&&item.actor==='PM'&&!syntheticIds.has(item.entityId)).sort(byNewest);
  const requests=state.requests.filter(item=>item.projectId===projectId&&item.status==='Open'&&!syntheticIds.has(item.requirementId));
  const priorityRank:Record<string,number>={P1:0,P2:1,P3:2,Unscored:3};
  const preparedRequirements=requirements.map(item=>{
    const score=scoreRequirement(item.scores,state.model);
    const priority=item.priorityOverride??priorityFor(score,state.model)??'Unscored';
    return {id:bounded(item.id,160),title:bounded(item.title,180),statement:bounded(item.statement),category:bounded(item.category,160),status:item.status,
      version:item.version,updatedAt:item.updatedAt,findings:ids(item.findings),omittedFindingIds:Math.max(0,item.findings.length-limits.sourceIds),score,priority,scores:item.scores,
      unknownDimensions:dimensions.filter(d=>item.scores[d]===null).map(d=>dimensionLabels[d]),
      evidence:evidenceLevel(item,findings),rationale:bounded(item.rationale),assumptions:bounded(item.assumptions),
      uncertainty:bounded(item.uncertainty),priorityOverride:item.priorityOverride??null,overrideReason:item.overrideReason?bounded(item.overrideReason):null,
      synthetic:item.synthetic};
  }).sort((a,b)=>priorityRank[a.priority]-priorityRank[b.priority]||(b.score??-1)-(a.score??-1)||b.updatedAt.localeCompare(a.updatedAt)||a.id.localeCompare(b.id));
  const selectedRequirements=preparedRequirements.slice(0,limits.requirements);
  const requiredFindingIds=new Set(selectedRequirements.flatMap(item=>item.findings));
  const selectedFindings=[...findings].sort((a,b)=>Number(requiredFindingIds.has(b.id))-Number(requiredFindingIds.has(a.id))
    ||Number(a.status==='Excluded')-Number(b.status==='Excluded')||b.sources.length-a.sources.length||a.id.localeCompare(b.id)).slice(0,limits.findings);
  const analyzedSources=new Set<string>();
  let runsWithoutCoverage=0;
  for(const run of runs.filter(item=>item.mode==='AI')){
    if(!run.coverage){runsWithoutCoverage++;continue;}
    const runRecords=run.datasets.flatMap(id=>datasets.find(dataset=>dataset.id===id)?.records??[]);
    const {first,last}=run.coverage;
    if(first>=1&&last>=first&&last<=runRecords.length)runRecords.slice(first-1,last).forEach(record=>analyzedSources.add(record.id));
    else runsWithoutCoverage++;
  }
  const linkedSources=new Set(findings.filter(item=>item.status!=='Excluded').flatMap(item=>item.sources).filter(id=>sources.has(id)));
  const analyzedInsights=getSourceInsights({...state,datasets:datasets.map(dataset=>({...dataset,records:dataset.records.filter(record=>analyzedSources.has(record.id))}))},projectId);
  const quoteFor=(finding:Finding,id:string,counter=false)=>{
    const source=sources.get(id);if(!source)return [];
    const {record,dataset}=source;
    return [{sourceId:bounded(id,160),datasetId:bounded(dataset.id,160),...(counter?{...excerpt(record.content,limits.quoteCharacters),kind:'Counterevidence - linked source excerpt'}:sourceQuote(finding,record)),
      file:bounded(record.fields.source_file??dataset.name,180),sheet:bounded(record.fields.source_sheet??record.sheet??'',120),
      row:bounded(record.fields.source_row??record.row,30),page:record.fields.source_pdf_page?bounded(record.fields.source_pdf_page,30):null,
      market:record.fields.source_market_label?bounded(record.fields.source_market_label,100):null,synthetic:false}];
  };
  const referenceRecords=datasets.filter(item=>item.type!=='Customer verbatims').reduce((total,item)=>total+item.records.length,0);
  const payload={
    schemaVersion:1,generatedAt:new Date().toISOString(),workspaceRevision:state.revision,
    project:{id:bounded(project.id,160),name:bounded(project.name,180),derivative:bounded(project.derivative,120),market:bounded(project.market,120),horizon:bounded(project.horizon,120)},
    summary:{datasets:datasets.length,readyDatasets:datasets.filter(item=>item.status==='Ready').length,
      sourceRecords:sourceInsights.feedbackCount+referenceRecords,feedbackRecords:sourceInsights.feedbackCount,annotationRows:sourceInsights.annotationCount,
      topics:sourceInsights.topics.length,negativeFeedback:sourceInsights.negativeCount,positiveFeedback:sourceInsights.positiveCount,requestedFeedback:sourceInsights.requestCount,unknownFeedback:sourceInsights.unknownCount,
      referenceRecords,
      findings:findings.length,activeFindings:findings.filter(item=>item.status!=='Excluded').length,
      requirements:requirements.length,approvedRequirements:requirements.filter(item=>item.status==='Approved').length,
      unscoredRequirements:preparedRequirements.filter(item=>item.score===null).length,
      linkedSourceRecords:linkedSources.size,analyzedSourceRecords:analyzedInsights.feedbackCount,runsWithoutCoverage,
      analysisRuns:runs.length,openEvidenceRequests:requests.length,
      statuses:Object.fromEntries([...new Set(requirements.map(item=>item.status))].map(status=>[status,requirements.filter(item=>item.status===status).length])),
      priorities:Object.fromEntries(['P1','P2','P3','Unscored'].map(priority=>[priority,preparedRequirements.filter(item=>item.priority===priority).length]))},
    sourceTopics:sourceInsights.topics.slice(0,limits.topics).map(item=>({name:bounded(item.name,160),comments:item.feedbackCount,annotations:item.annotationCount,negative:item.negativeCount,positive:item.positiveCount,requests:item.requestCount,unknown:item.unknownCount})),
    excludedSynthetic:{datasets:projectDatasets.filter(item=>item.synthetic).length,records:projectDatasets.filter(item=>item.synthetic).reduce((total,item)=>total+item.records.length,0),findings:projectFindings.filter(item=>item.synthetic).length,requirements:projectRequirements.filter(item=>item.synthetic).length,
      demoRuns:state.runs.filter(item=>item.projectId===projectId&&item.mode==='Demo').length},
    datasets:datasets.slice(0,limits.datasets).map(item=>{
      const files=[...new Set(item.records.map(record=>String(record.fields.source_file??item.name)))];
      return {id:bounded(item.id,160),name:bounded(item.name,180),type:item.type,status:item.status,records:item.records.length,synthetic:false,
        files:files.slice(0,limits.filesPerDataset).map(file=>bounded(file,180)),omittedFiles:Math.max(0,files.length-limits.filesPerDataset),
        errors:item.errors.slice(0,limits.errorsPerDataset).map(error=>bounded(error,220)),omittedErrors:Math.max(0,item.errors.length-limits.errorsPerDataset)};
    }),
    runs:runs.slice(0,limits.runs).map(item=>({id:bounded(item.id,160),at:item.at,mode:item.mode,datasets:ids(item.datasets),
      findings:item.findingIds.filter(id=>!syntheticIds.has(id)).length,requirements:item.requirementIds.filter(id=>!syntheticIds.has(id)).length,coverage:item.coverage??null,
      metrics:item.metrics?{...item.metrics,model:bounded(item.metrics.model,100)}:null})),
    findings:selectedFindings.map(item=>({id:bounded(item.id,160),title:bounded(item.title,180),category:bounded(item.category,160),need:bounded(item.need),
      summary:bounded(item.description.split(/\n\n(?=[^\n]+: “)/)[0]),status:item.status,strength:item.strength,implication:bounded(item.implication),
      rationale:item.rationale?bounded(item.rationale):null,sourceIds:ids(item.sources),sourceCount:item.sources.length,omittedSourceIds:Math.max(0,item.sources.length-limits.sourceIds),synthetic:false,
      missingSources:ids(item.sources.filter(id=>!sources.has(id))),missingSourceCount:item.sources.filter(id=>!sources.has(id)).length,
      contradictionSourceIds:ids(item.contradictions),contradictionCount:item.contradictions.length,omittedContradictionIds:Math.max(0,item.contradictions.length-limits.sourceIds),
      quotes:[...new Set(item.sources)].filter(id=>sources.has(id)).slice(0,limits.quotesPerFinding).flatMap(id=>quoteFor(item,id)),
      counterQuotes:[...new Set(item.contradictions)].filter(id=>sources.has(id)).slice(0,limits.counterQuotesPerFinding).flatMap(id=>quoteFor(item,id,true))})),
    requirements:selectedRequirements,scoring:state.model,
    decisions:decisions.slice(0,limits.decisions).map(item=>({id:bounded(item.id,160),at:item.at,action:bounded(item.action,180),actor:bounded(item.actorId,160),entityId:bounded(item.entityId,160),rationale:bounded(item.rationale)})),
    evidenceRequests:requests.slice(0,limits.requests).map(item=>({id:bounded(item.id,160),requirementId:bounded(item.requirementId,160),text:bounded(item.text),createdAt:item.createdAt})),
    selection:{limits,requirements:requirements.length,findings:findings.length,runs:runs.length,decisions:decisions.length,requests:requests.length,datasets:datasets.length,topics:sourceInsights.topics.length,payloadTrimmed:false},
  };
  const bytes=()=>new TextEncoder().encode(JSON.stringify(payload)).byteLength;
  while(bytes()>limits.payloadBytes&&(payload.requirements.length||payload.findings.length)){
    if(payload.requirements.length>=payload.findings.length)payload.requirements.pop();else payload.findings.pop();
    payload.selection.payloadTrimmed=true;
  }
  return payload;
}

export type ProjectReportPayload=ReturnType<typeof buildReportPayload>;

/** Generate a real PDF locally and download it without opening a print dialog. */
export async function downloadProjectReport(state:Workspace, projectId:string):Promise<void> {
  const response=await fetch('/api/report',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(buildReportPayload(state,projectId))});
  let data:{pdf_base64?:string;filename?:string;error?:string};
  try{data=await response.json() as typeof data;}
  catch{throw new Error('PDF export needs the local app server. Start it and try again.');}
  if(!response.ok)throw new Error(data.error??'The project PDF could not be generated.');
  if(!data.pdf_base64||!data.filename?.endsWith('.pdf'))throw new Error('The report service did not return a PDF.');
  let bytes:Uint8Array<ArrayBuffer>;
  try{bytes=Uint8Array.from(atob(data.pdf_base64),character=>character.charCodeAt(0));}
  catch{throw new Error('The report service returned an unreadable PDF.');}
  if(new TextDecoder().decode(bytes.slice(0,5))!=='%PDF-')throw new Error('The report service returned an invalid PDF.');
  const url=URL.createObjectURL(new Blob([bytes],{type:'application/pdf'}));
  const anchor=document.createElement('a');
  anchor.href=url;anchor.download=data.filename;document.body.append(anchor);anchor.click();anchor.remove();
  setTimeout(()=>URL.revokeObjectURL(url),60_000);
}
