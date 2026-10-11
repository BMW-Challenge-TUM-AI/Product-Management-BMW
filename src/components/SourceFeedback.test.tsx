import {existsSync,readFileSync} from 'node:fs';
import {renderToStaticMarkup} from 'react-dom/server';
import * as XLSX from 'xlsx';
import {describe,expect,it,vi} from 'vitest';
import {AppContext,type AppContextValue} from '../context';
import {createEmptyWorkspace} from '../data/empty-workspace';
import {getSourceInsights} from '../lib/source-insights';
import {SourceFeedbackExplorer} from './SourceFeedback';

const file='data/raw/F70_feedback_hackathon.xlsx';
describe.runIf(existsSync(file))('Source feedback view with supplied workbook annotations',()=>{
 it('shows only the selected topic labels for a comment with praise on a different topic',()=>{
  const book=XLSX.read(readFileSync(file),{type:'buffer'});
  const all=XLSX.utils.sheet_to_json<Record<string,unknown>>(book.Sheets.Feedback_Explorer);
  const first=all.find(row=>row.ID==='F70-0008')!;
  const rows=all.flatMap((row,index):Array<Record<string,unknown>&{sourceRow:number}>=>row.ID===first.ID&&row.Country===first.Country?[{...row,sourceRow:index+2}]:[]);
  const state=createEmptyWorkspace(),project=state.projects[0];
  const record={id:'source-view-test',datasetId:'source-view-dataset',content:String(first['Customer Feedback']),row:rows[0].sourceRow,sheet:'Feedback_Explorer',fields:{source_file:'F70_feedback_hackathon.xlsx',_originalId:first.ID,annotations:rows.map(row=>({row:row.sourceRow,category_level_2:row['Vfc level2 Name'],feedback_type:row['Feedback Type']}))}};
  state.datasets=[{id:record.datasetId,projectId:project.id,name:'F70_feedback_hackathon.xlsx',type:'Customer verbatims',synthetic:false,status:'Ready',createdAt:'',errors:[],columns:[],records:[record]}];
  const context={state,project,setProject:vi.fn(),page:'Evidence Explorer',navigate:vi.fn(),run:async()=>false,runLive:async()=>false,analysis:null,aiAvailable:false,pmName:'',setPmName:vi.fn(),notify:vi.fn(),openRequirement:vi.fn(),openFinding:vi.fn(),openSource:vi.fn(),openAudit:vi.fn(),cloud:false,busy:false} satisfies AppContextValue;
  const topic=getSourceInsights(state,project.id).topics.find(item=>item.negativeCount>0&&item.positiveCount===0)!;
  expect(topic).toBeDefined();
  const scoped=renderToStaticMarkup(<AppContext.Provider value={context}><SourceFeedbackExplorer topic={topic}/></AppContext.Provider>);
  expect(scoped).toContain('>Defect<');
  expect(scoped).not.toContain('>Likes<');
  const unfiltered=renderToStaticMarkup(<AppContext.Provider value={context}><SourceFeedbackExplorer/></AppContext.Provider>);
  expect(unfiltered).toContain('>Defect<');
  expect(unfiltered).toContain('>Likes<');
 });
});
