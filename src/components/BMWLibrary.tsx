import {useEffect,useMemo,useState} from 'react';
import {ArrowRight,BookOpen,CarFront,Database,FileCheck2,FileSpreadsheet,FileText,Loader2,ShieldAlert} from 'lucide-react';
import {useApp} from '../context';
import type {Dataset} from '../types';
import {bmwDatasets,bmwProject,readProjectSourceFile,type BMWBundle,type BMWDataKind} from '../lib/bmw-library';
import {Badge,Panel} from './common';
import {Button} from './ui/button';
import {Modal} from './ui/dialog';
import {seriesChoices,seriesFor,type Series} from '../lib/vehicle-series';

type Kind=BMWDataKind;
type Scope={series:Series;model_code:string;vehicle:string;market_code:string;market:string;counts:Record<Kind,number>;feedback_annotation_rows:number};
type SourceFile={kind:string;name:string;format?:'xlsx'|'pdf';available:boolean};
type SourceDocument={file_name:string;format:'xlsx'|'pdf';warnings?:string[];sheets?:{name:string;header_row:number|null;columns:string[];records:{row:number;fields:Record<string,unknown>}[]}[];pages?:{page:number;text:string}[]};
type Manifest={files:SourceFile[];scopes:Scope[];notes:string[]};
const preferredMarket:Record<Series,string>={'1':'EU','5':'US','7':'US'};
const countLabels:Record<Kind,string>={feedback:'Distinct feedback comments',studies:'Study measures',sales:'Sales year values',equipment:'Catalog + equipment'};
const cellText=(value:unknown)=>value===null||value===undefined?'':typeof value==='object'?JSON.stringify(value):String(value);

export default function BMWLibrary(){
 const {state,project,run,setProject,notify,cloud,navigate}=useApp();
 const [manifest,setManifest]=useState<Manifest|null>(null),[error,setError]=useState(''),[series,setSeries]=useState<Series>(()=>seriesFor(project.derivative)??'1'),[market,setMarket]=useState(''),[loading,setLoading]=useState(false);
 const [sourceDocument,setSourceDocument]=useState<SourceDocument|null>(null),[readingFile,setReadingFile]=useState('');
 useEffect(()=>{if(cloud)return;let active=true;fetch('/api/bmw',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'manifest'})}).then(async response=>{const data=await response.json() as Manifest&{error?:string};if(!response.ok)throw new Error(data.error??'Could not read the local BMW files.');if(active){setManifest(data);const current=data.scopes.find(scope=>scope.vehicle===project.derivative&&scope.market===project.market);if(current){setSeries(current.series);setMarket(current.market_code);}}}).catch(e=>{if(active)setError((e as Error).message);});return()=>{active=false;};},[cloud,project.derivative,project.market]);
 const choices=useMemo(()=>manifest?.scopes.filter(scope=>scope.series===series)??[],[manifest,series]);
 const chosen=choices.find(scope=>scope.market_code===market)??choices.find(scope=>scope.market_code===preferredMarket[series])??choices[0];
 const imported=chosen?state.datasets.filter(d=>d.projectId===state.projects.find(p=>p.derivative===chosen.vehicle&&p.market===chosen.market&&p.name==='BMW supplied-source workspace')?.id&&d.id.startsWith(`BMW-DS-${chosen.model_code}-${chosen.market_code}-`)).length:0;
 const load=async()=>{
  if(!chosen||loading)return;setLoading(true);
  try{
   const response=await fetch('/api/bmw',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'load',model_code:chosen.model_code,market_code:chosen.market_code})});
   const bundle=await response.json() as BMWBundle&{error?:string};
   if(!response.ok)throw new Error(bundle.error??'The BMW source files could not be loaded.');
   if(bundle.model_code!==chosen.model_code||bundle.market_code!==chosen.market_code)throw new Error('The source scope changed during import. Please retry.');
   const existing=state.projects.find(p=>p.derivative===bundle.vehicle&&p.market===bundle.market&&p.name==='BMW supplied-source workspace');
   const target=existing??bmwProject(bundle);
   const datasets=bmwDatasets(bundle,target,state.datasets);
   if(!datasets.length){setProject(target.id);notify('This vehicle and market are already loaded.');return;}
   const ok=await run({type:'importBatch',project:existing?undefined:target,datasets});
   if(ok){setProject(target.id);const comments=datasets.find(d=>d.type==='Customer verbatims')?.records.length??0;const context=datasets.filter(d=>d.type!=='Customer verbatims').reduce((n,d)=>n+d.records.length,0);notify(`Loaded ${comments.toLocaleString()} distinct feedback comments and ${context.toLocaleString()} reference records into ${target.derivative} / ${target.market}.`);navigate('Data Sources');}
  }catch(e){notify((e as Error).message,true);}finally{setLoading(false);}
 };
 const readFile=async(file:SourceFile)=>{
  if(!file.available||readingFile)return;setReadingFile(file.name);
  try{setSourceDocument(await readProjectSourceFile(file.name) as SourceDocument);}
  catch(e){notify((e as Error).message,true);}
  finally{setReadingFile('');}
 };
 if(cloud)return <Panel title="Supplied BMW data library" subtitle="Local source files"><p className="small muted">The private source-file library is available in the local workspace. Import approved data into your shared deployment through its own controlled process.</p></Panel>;
 return <><section className="bmw-library" aria-label="BMW supplied data library"><div className="bmw-library-header"><div className="bmw-library-symbol"><CarFront size={25}/></div><div><span className="eyebrow">START WITH THE SOURCE DATA</span><h2>BMW data library</h2><p>Choose a vehicle series and market represented in the supplied files. European country records are grouped for analysis while their original country remains attached to each source.</p></div><Badge tone="blue">Local files only</Badge></div>
 {error&&<div className="notice notice-amber"><ShieldAlert size={17}/><p>{error} Put the supplied workbooks and catalog in the ignored <code>data/raw/</code> folder.</p></div>}
 {!manifest&&!error&&<p className="bmw-library-loading"><Loader2 size={17} className="spin"/> Reading available source files…</p>}
 {manifest&&<><div className="bmw-library-controls"><label className="field"><span>1 · Series</span><select aria-label="BMW library series" value={series} onChange={e=>{setSeries(e.target.value as Series);setMarket('');}}>{seriesChoices.map(value=><option key={value} value={value}>BMW {value} Series</option>)}</select></label><label className="field"><span>2 · Analysis market</span><select aria-label="BMW library market" value={chosen?.market_code??''} onChange={e=>setMarket(e.target.value)}>{choices.map(scope=><option key={scope.market_code} value={scope.market_code}>{scope.market}</option>)}</select></label><div className="bmw-library-action"><span>3 · Open the source workspace</span><Button onClick={()=>void load()} disabled={!chosen||loading}>{loading?<Loader2 size={15} className="spin"/>:<ArrowRight size={15}/>} {loading?'Loading source records…':'Load this series + market'}</Button></div></div>
 {chosen&&<><div className="bmw-library-scope"><div><strong>BMW {chosen.series} Series</strong><span>{chosen.market} · source code {chosen.model_code} · {chosen.counts.feedback.toLocaleString()} distinct feedback comments · {Object.entries(chosen.counts).filter(([kind])=>kind!=='feedback').reduce((n,[,count])=>n+count,0).toLocaleString()} reference records{imported?` · ${imported} dataset group(s) loaded`:''}</span></div><div className="bmw-library-counts">{(Object.keys(countLabels) as Kind[]).map(kind=><div key={kind} className={chosen.counts[kind]?'has-data':''}><b>{chosen.counts[kind].toLocaleString()}</b><span>{countLabels[kind]}</span>{kind==='feedback'&&chosen.counts.feedback>0&&<small>{chosen.feedback_annotation_rows.toLocaleString()} source annotation rows</small>}</div>)}</div></div>{chosen.market_code==='EU'&&<p className="small muted">Europe combines supplied European country feedback with Europe-wide study and sales measures. German-market catalogs are reference records; no German customer feedback is supplied. Every record retains its original source market and granularity.</p>}{!chosen.counts.feedback&&<div className="notice notice-blue"><BookOpen size={16}/><p>No customer feedback was supplied for this series and market. You can inspect its reference data, but feedback analysis needs separate, correctly scoped comments.</p></div>}{chosen.counts.sales>0&&chosen.series==='5'&&<p className="small muted">Sales in the source workbook are a <strong>combined G60/G68 total</strong>. They are shown with that warning and are never assigned as an individual model volume.</p>}{chosen.model_code==='F70'&&chosen.market_code!=='EU'&&<p className="small muted">This 1 Series scope contains only sales rows from the supplied workbook. The app has no customer feedback or verified market-specific model announcement for {chosen.market}.</p>}</>}
 <div className="bmw-library-footer"><span><FileCheck2 size={15}/>{manifest.files.filter(file=>file.available).length}/{manifest.files.length} source files available locally</span><span><Database size={15}/>{manifest.scopes.length} series/market scopes represented</span><button onClick={()=>navigate('Settings')}>Review projects <ArrowRight size={13}/></button></div></>}
 </section>
 {manifest&&<Panel title="Project XLSX and PDF files" subtitle="Files in data/raw are read on demand by the reusable backend source-file reader.">
  <div className="bmw-project-files">{manifest.files.filter(file=>file.available&&(file.format==='xlsx'||file.format==='pdf')).map(file=><div key={file.name} className="bmw-project-file"><span className="source-icon">{file.format==='xlsx'?<FileSpreadsheet size={18}/>:<FileText size={18}/>}</span><div><strong>{file.name}</strong><small>{file.format?.toUpperCase()} · {file.kind==='document'?'Project document':file.kind}</small></div><Button variant="outline" size="sm" disabled={!!readingFile} onClick={()=>void readFile(file)}>{readingFile===file.name?<Loader2 size={14} className="spin"/>:<BookOpen size={14}/>}Read file</Button></div>)}</div>
 </Panel>}
 {sourceDocument&&<Modal open onClose={()=>setSourceDocument(null)} title={sourceDocument.file_name} description={`${sourceDocument.format.toUpperCase()} · parsed by the shared project-file reader`} wide>
  {sourceDocument.warnings?.map(warning=><div key={warning} className="notice notice-amber"><ShieldAlert size={16}/><p>{warning}</p></div>)}
  {sourceDocument.sheets?.map(sheet=><section key={sheet.name} className="source-document-section"><h3>{sheet.name}</h3><p className="small muted">{sheet.records.length.toLocaleString()} data rows · header row {sheet.header_row??'not found'} · showing up to 100 rows</p><div className="table-scroll preview-table"><table><thead><tr><th>Source row</th>{sheet.columns.map(column=><th key={column}>{column}</th>)}</tr></thead><tbody>{sheet.records.slice(0,100).map(record=><tr key={record.row}><td>{record.row}</td>{sheet.columns.map(column=><td key={column}>{cellText(record.fields[column])}</td>)}</tr>)}</tbody></table></div></section>)}
  {sourceDocument.pages?.map(page=><section key={page.page} className="source-document-section"><h3>Page {page.page}</h3><pre className="source-page-text">{page.text||'No embedded text is available on this page.'}</pre></section>)}
  {!sourceDocument.sheets?.length&&!sourceDocument.pages?.length&&<p className="small muted">No readable sheets or pages were found.</p>}
 </Modal>}
 </>;
}
