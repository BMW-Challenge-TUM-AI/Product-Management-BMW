import type {SourceRecord, Workspace} from '../types';

export interface SourceLocation {
 recordId:string;
 file:string;
 sheet:string;
 row:number;
 quote:string;
 feedbackType:string|null;
}

/** Counts are distinct comments, and can overlap when a comment has multiple source labels. */
export interface SourceLabelCounts {
 negativeCount:number;
 positiveCount:number;
 requestCount:number;
 /** Comments without any recognized source label; text is never used to infer sentiment. */
 unknownCount:number;
}

export interface SourceTopic extends SourceLabelCounts {
 id:string;
 category:string|null;
 name:string;
 records:SourceRecord[];
 recordIds:string[];
 feedbackCount:number;
 annotationCount:number;
 locations:SourceLocation[];
}

export interface SourceInsights extends SourceLabelCounts {
 records:SourceRecord[];
 feedbackCount:number;
 annotationCount:number;
 topics:SourceTopic[];
 files:string[];
}

type Annotation = {row:number; category:string|null; feedbackType:string|null; original:Record<string,unknown>};
type AccumulatedRecord = {record:SourceRecord; annotations:Map<string,Annotation>; reportedRows:number};
const asText=(value:unknown):string|null=>typeof value==='string'&&value.trim()?value:null;
const asRow=(value:unknown,fallback:number):number=>typeof value==='number'&&Number.isInteger(value)&&value>0?value:fallback;
const labels={negative:new Set(['Defect','Difficult to Use']),positive:new Set(['Likes']),request:new Set(['Wants'])};

export function sourceLocation(record:SourceRecord):SourceLocation {
 return {
  recordId:record.id,
  file:asText(record.fields.source_file)??asText(record.fields._filename)??'Source file not recorded',
  sheet:asText(record.fields.source_sheet)??record.sheet??'',
  row:asRow(record.fields.source_row,record.row),
  quote:record.content,
  feedbackType:null,
 };
}

function sourceAnnotations(record:SourceRecord):Annotation[] {
 const annotations=Array.isArray(record.fields.annotations)?record.fields.annotations:[];
 const parsed=annotations.flatMap((value:unknown,index:number)=>{
  if(!value||typeof value!=='object')return [];
  const annotation=value as Record<string,unknown>;
  return [{row:asRow(annotation.row,record.row+index),category:asText(annotation.category_level_2),feedbackType:asText(annotation.feedback_type),original:annotation}];
 });
 if(parsed.length)return parsed;
 return [{row:sourceLocation(record).row,category:asText(record.category),feedbackType:asText(record.fields['Feedback Type'])??asText(record.fields.feedback_type),original:{}}];
}

/** Exact labels supplied in the workbook; these are not AI sentiment predictions. */
export function feedbackTypes(record:SourceRecord):string[] {
 return [...new Set(sourceAnnotations(record).flatMap(annotation=>annotation.feedbackType?[annotation.feedbackType]:[]))];
}

function identity(record:SourceRecord):string {
 const file=asText(record.fields.source_file)??asText(record.fields._filename);
 const originalId=record.fields._originalId;
 if(file&&originalId!==undefined&&originalId!==null&&String(originalId).trim()) {
  return JSON.stringify([file,asText(record.fields.source_sheet)??record.sheet??'',record.fields.source_vehicle_code??'',record.fields.source_market_code??record.fields.Country??'',String(originalId)]);
 }
 return record.id;
}

function countLabels(groups:Iterable<Annotation[]>):SourceLabelCounts {
 const result:SourceLabelCounts={negativeCount:0,positiveCount:0,requestCount:0,unknownCount:0};
 for(const annotations of groups){
  const types=new Set(annotations.flatMap(annotation=>annotation.feedbackType?[annotation.feedbackType]:[]));
  const negative=[...types].some(type=>labels.negative.has(type));
  const positive=[...types].some(type=>labels.positive.has(type));
  const request=[...types].some(type=>labels.request.has(type));
  result.negativeCount+=Number(negative);
  result.positiveCount+=Number(positive);
  result.requestCount+=Number(request);
  result.unknownCount+=Number(!negative&&!positive&&!request);
 }
 return result;
}

/** Summarize source annotations only. Never creates findings, requirements, or inferred scores. */
export function getSourceInsights(state:Workspace,projectId:string):SourceInsights {
 const distinct=new Map<string,AccumulatedRecord>();
 for(const dataset of state.datasets){
  if(dataset.projectId!==projectId||dataset.type!=='Customer verbatims'||dataset.synthetic)continue;
  for(const record of dataset.records){
   const key=identity(record);
   let entry=distinct.get(key);
   if(!entry){entry={record,annotations:new Map(),reportedRows:0};distinct.set(key,entry);}
   const annotations=sourceAnnotations(record);
   for(const annotation of annotations){
    // A repeated import of a source row is still a single annotation.
    const annotationKey=JSON.stringify([annotation.row,annotation.category,annotation.feedbackType]);
    entry.annotations.set(annotationKey,annotation);
   }
   entry.reportedRows=Math.max(entry.reportedRows,asRow(record.fields.original_row_count,annotations.length));
  }
 }

 const topicGroups=new Map<string,Map<string,{record:SourceRecord;annotations:Annotation[]}>>();
 const records:SourceRecord[]=[];
 let annotationCount=0;
 for(const [key,entry] of distinct){
  const annotations=[...entry.annotations.values()];
  // Merge source annotations across duplicate imports without mutating the workspace.
  const record={...entry.record,fields:{...entry.record.fields,annotations:annotations.map(annotation=>Object.keys(annotation.original).length?annotation.original:{row:annotation.row,category_level_2:annotation.category,feedback_type:annotation.feedbackType})}};
  records.push(record);
  annotationCount+=Math.max(new Set(annotations.map(annotation=>annotation.row)).size,entry.reportedRows);
  for(const annotation of annotations){
   const categoryKey=JSON.stringify(annotation.category);
   let members=topicGroups.get(categoryKey);
   if(!members){members=new Map();topicGroups.set(categoryKey,members);}
   let member=members.get(key);
   if(!member){member={record,annotations:[]};members.set(key,member);}
   member.annotations.push(annotation);
  }
 }

 const topics:SourceTopic[]=[...topicGroups].map(([categoryKey,members])=>{
  const category=JSON.parse(categoryKey) as string|null;
  const values=[...members.values()];
  return {
   id:`source-topic:${categoryKey}`,category,name:category??'No source category',
   records:values.map(member=>member.record),recordIds:values.map(member=>member.record.id),feedbackCount:members.size,
   annotationCount:values.reduce((sum,member)=>sum+new Set(member.annotations.map(annotation=>annotation.row)).size,0),
   ...countLabels(values.map(member=>member.annotations)),
   locations:values.flatMap(member=>member.annotations.map(annotation=>({...sourceLocation(member.record),row:annotation.row,feedbackType:annotation.feedbackType}))),
  };
 }).sort((a,b)=>b.feedbackCount-a.feedbackCount||b.negativeCount-a.negativeCount||a.name.localeCompare(b.name));
 return {
  records,feedbackCount:records.length,annotationCount,topics,
  ...countLabels([...distinct.values()].map(entry=>[...entry.annotations.values()])),
  files:[...new Set(records.map(record=>sourceLocation(record).file))].sort(),
 };
}
