import {existsSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import * as XLSX from 'xlsx';
import {beforeAll,describe,expect,it} from 'vitest';
import {createEmptyWorkspace} from '../data/empty-workspace';
import type {Dataset,SourceRecord} from '../types';
import {feedbackTypes,getSourceInsights,sourceLocation} from './source-insights';

type OriginalRow=Record<string,unknown>&{sourceRow:number};
const filenames=['F70_feedback_hackathon.xlsx','G60_feedback_hackathon.xlsx','G70_feedback_hackathon.xlsx'];
const available=filenames.every(name=>existsSync(resolve('data/raw',name)));

// Read local supplied files at test time, keeping private customer text out of tracked fixtures.
describe.runIf(available)('Source insights counted against the supplied workbooks',()=>{
 const original=new Map<string,OriginalRow[]>();
 const datasets:Dataset[]=[];
 const projectId='source-count-check';

 beforeAll(()=>{
  for(const filename of filenames){
   const book=XLSX.read(readFileSync(resolve('data/raw',filename)),{type:'buffer'});
   const sheet=book.Sheets.Feedback_Explorer;
   const values=XLSX.utils.sheet_to_json<unknown[]>(sheet,{header:1,defval:null,blankrows:true});
   const columns=values[0].map(String);
   const rows=values.slice(1).map((values,index):OriginalRow=>({...Object.fromEntries(columns.map((column,col)=>[column,values[col]])),sourceRow:index+2})).filter(row=>row.ID&&row['Customer Feedback']);
   original.set(filename,rows);
   const groups=new Map<string,SourceRecord>();
   for(const row of rows){
    const key=JSON.stringify([row.Country,row.ID]);
    let record=groups.get(key);
    if(!record){
     record={id:`${filename}:${key}`,datasetId:filename,content:String(row['Customer Feedback']),row:row.sourceRow,sheet:'Feedback_Explorer',category:String(row['Vfc level2 Name']??''),fields:{
      source_file:filename,source_sheet:'Feedback_Explorer',source_row:row.sourceRow,source_vehicle_code:filename.slice(0,3),source_market_code:row.Country,_originalId:row.ID,annotations:[],original_row_count:0,
     }};
     groups.set(key,record);
    }
    (record.fields.annotations as unknown[]).push({row:row.sourceRow,feedback_type:row['Feedback Type'],category_level_2:row['Vfc level2 Name'],category_level_2_3:row['Vfc level2 3 Name'],category_level_3:row['Vfc level3 Name']});
    record.fields.original_row_count=Number(record.fields.original_row_count)+1;
   }
   datasets.push({id:filename,projectId,name:filename,type:'Customer verbatims',synthetic:false,status:'Ready',createdAt:'',errors:[],columns,records:[...groups.values()]});
  }
 });

 it('matches distinct customer IDs and all annotation rows in every workbook',()=>{
  const expected=[[2128,4076],[4000,5005],[4000,4690]];
  datasets.forEach((dataset,index)=>{
   const state=createEmptyWorkspace();state.datasets=[dataset];
   const insights=getSourceInsights(state,projectId);
   expect([insights.feedbackCount,insights.annotationCount]).toEqual(expected[index]);
  });
  const state=createEmptyWorkspace();state.datasets=datasets;
  const total=getSourceInsights(state,projectId);
  expect([total.feedbackCount,total.annotationCount]).toEqual([10128,13771]);
 });

 it('counts each original ID once per exact topic and retains the original row references',()=>{
  const dataset=datasets[1];
  const rows=original.get(dataset.id)!;
  const state=createEmptyWorkspace();state.datasets=[dataset];
  const topics=getSourceInsights(state,projectId).topics;
  const categories=new Map<string|null,OriginalRow[]>();
  for(const row of rows){
   const category=typeof row['Vfc level2 Name']==='string'&&String(row['Vfc level2 Name']).trim()?String(row['Vfc level2 Name']):null;
   categories.set(category,[...(categories.get(category)??[]),row]);
  }
  expect(topics).toHaveLength(categories.size);
  for(const topic of topics){
   const sourceRows=categories.get(topic.category)!;
   const unique=(filter:(row:OriginalRow)=>boolean)=>new Set(sourceRows.filter(filter).map(row=>JSON.stringify([row.Country,row.ID]))).size;
   expect(topic.feedbackCount).toBe(unique(()=>true));
   expect(topic.annotationCount).toBe(sourceRows.length);
   expect(topic.negativeCount).toBe(unique(row=>row['Feedback Type']==='Defect'||row['Feedback Type']==='Difficult to Use'));
   expect(topic.positiveCount).toBe(unique(row=>row['Feedback Type']==='Likes'));
   expect(topic.requestCount).toBe(unique(row=>row['Feedback Type']==='Wants'));
   expect(topic.locations.map(location=>location.row).sort((a,b)=>a-b)).toEqual(sourceRows.map(row=>row.sourceRow).sort((a,b)=>a-b));
   for(const location of topic.locations){
    const originalRow=sourceRows.find(row=>row.sourceRow===location.row)!;
    expect(location.quote).toBe(originalRow['Customer Feedback']);
    expect(location.feedbackType).toBe(originalRow['Feedback Type']||null);
   }
  }
  expect(topics.some(topic=>topic.annotationCount>topic.feedbackCount)).toBe(true);
  expect(topics.map(topic=>topic.feedbackCount)).toEqual(topics.map(topic=>topic.feedbackCount).sort((a,b)=>b-a));
 });

 it('keeps unlabeled comments unknown even when their wording sounds positive',()=>{
  const dataset=datasets[1];
  const first=dataset.records.find(record=>record.fields._originalId==='G60-0001')!;
  const state=createEmptyWorkspace();state.datasets=[{...dataset,records:[first]}];
  const insights=getSourceInsights(state,projectId);
  expect(feedbackTypes(first)).toEqual([]);
  expect(insights.unknownCount).toBe(1);
  expect(insights.positiveCount).toBe(0);
  expect(insights.negativeCount).toBe(0);
  expect(insights.topics[0].category).toBeNull();
  expect(sourceLocation(first)).toMatchObject({file:'G60_feedback_hackathon.xlsx',sheet:'Feedback_Explorer',row:2,quote:first.content});
 });

 it('does not count duplicate imports, reference datasets, synthetic records or another project',()=>{
  const dataset=datasets[1];
  const state=createEmptyWorkspace();state.datasets=[dataset];
  const expected=getSourceInsights(state,projectId);
  state.datasets.push(
   {...dataset,id:'duplicate-import',records:dataset.records.map(record=>({...record,id:`copy:${record.id}`,datasetId:'duplicate-import'}))},
   {...dataset,id:'reference',type:'Customer study'},
   {...dataset,id:'synthetic',synthetic:true},
   {...dataset,id:'other-project',projectId:'another-project'},
  );
  const actual=getSourceInsights(state,projectId);
  expect(actual).toEqual(expected);
  expect(actual.records[0].fields.annotations).toEqual(dataset.records[0].fields.annotations);
 });
});
