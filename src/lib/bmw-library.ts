import type {Dataset, Project, SourceRecord, Workspace} from '../types';
import {createEmptyWorkspace} from '../data/empty-workspace';

export type BMWDataKind = 'feedback'|'studies'|'sales'|'equipment';
export interface BMWBundle {
 model_code:string;
 vehicle:string;
 market_code:string;
 market:string;
 datasets:{kind:BMWDataKind;type:Dataset['type'];name:string;sources:string[];records:Omit<SourceRecord,'datasetId'>[]}[];
 counts?:Partial<Record<BMWDataKind,number>>;
 feedback_annotation_rows?:number;
 record_count:number;
}

export function bmwProjectId(model:string,market:string):string {
 return `BMW-PROJECT-${model}-${market}`;
}

export function bmwDatasetId(model:string,market:string,kind:BMWDataKind):string {
 return `BMW-DS-${model}-${market}-${kind}`;
}

export function bmwProject(bundle:Pick<BMWBundle,'model_code'|'vehicle'|'market_code'|'market'>):Project {
 return {id:bmwProjectId(bundle.model_code,bundle.market_code),name:'BMW supplied-source workspace',
  derivative:bundle.vehicle,market:bundle.market,horizon:'Source review'};
}

export function bmwDatasets(bundle:BMWBundle,project:Project,existing:Dataset[]=[]):Dataset[] {
 return bundle.datasets.map(source=>{
  const id=bmwDatasetId(bundle.model_code,bundle.market_code,source.kind);
  const records=source.records.map(record=>({...record,datasetId:id}));
  if(records.some(record=>record.fields.source_vehicle_code!==bundle.model_code||record.fields.analysis_market_code!==bundle.market_code))
   throw new Error('A source record does not match the selected vehicle and market.');
  return {id,projectId:project.id,name:source.name,type:source.type,synthetic:false,status:'Ready' as const,
   createdAt:new Date().toISOString(),errors:[],columns:['source_file','source_sheet','source_row','source_market_label',
    'source_market_granularity','source_model_scope','category','measure','value','year','volume','source_pdf_page'],records};
 }).filter(dataset=>!existing.some(item=>item.id===dataset.id));
}

export function workspaceFromBMWBundle(bundle:BMWBundle):Workspace {
 const project=bmwProject(bundle);
 const workspace=createEmptyWorkspace(project);
 workspace.datasets=bmwDatasets(bundle,project);
 return workspace;
}

export async function requestBMWScope(modelCode:string,marketCode:string,action:'load'|'bootstrap'='load'):Promise<BMWBundle> {
 const response=await fetch('/api/bmw',{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({action,model_code:modelCode,market_code:marketCode})});
 const data=await response.json() as BMWBundle&{error?:string};
 if(!response.ok)throw new Error(data.error??'The local BMW source files could not be read.');
 return data;
}

export async function readProjectSourceFile(fileName:string):Promise<Record<string,unknown>> {
 const response=await fetch('/api/bmw',{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({action:'read-file',file_name:fileName})});
 const data=await response.json() as Record<string,unknown>&{error?:string};
 if(!response.ok)throw new Error(data.error??'The project source file could not be read.');
 return data;
}
