import {createContext,useContext} from 'react';
import type {Workspace,Project,Page,Requirement,Finding,SourceRecord,AuditEvent} from './types';
import type {Command} from './lib/workspace';
import type {AnalysisSession} from './lib/analysis-progress';
export interface AppContextValue {state:Workspace;project:Project;setProject:(id:string)=>void;page:Page;navigate:(page:Page)=>void;run:(command:Command)=>Promise<boolean>;runLive:(projectId:string,datasetIds:string[],batchIndex?:number)=>Promise<boolean>;analysis:AnalysisSession|null;aiAvailable:boolean;pmName:string;setPmName:(name:string)=>void;notify:(message:string,error?:boolean)=>void;openRequirement:(r:Requirement)=>void;openFinding:(f:Finding)=>void;openSource:(r:SourceRecord)=>void;openAudit:(e:AuditEvent)=>void;cloud:boolean;busy:boolean}
export const AppContext=createContext<AppContextValue>(null!);
export const useApp=()=>useContext(AppContext);
