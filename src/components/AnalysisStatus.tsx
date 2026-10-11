import {useEffect,useState} from 'react';
import {CheckCircle2,Loader2,TriangleAlert} from 'lucide-react';
import {useApp} from '../context';
import {analysisInProgress} from '../lib/analysis-progress';
import {Button} from './ui/button';

/** App-level status remains visible when an analysis page is unmounted. */
export default function AnalysisStatus(){
 const {analysis,state,setProject,navigate}=useApp();
 const [now,setNow]=useState(Date.now());
 const running=analysisInProgress(analysis);
 useEffect(()=>{
  setNow(Date.now());
  if(!running)return;
  const timer=window.setInterval(()=>setNow(Date.now()),1000);
  return ()=>window.clearInterval(timer);
 },[running,analysis?.startedAt]);
 if(!analysis)return null;
 const {progress}=analysis;
 const project=state.projects.find(p=>p.id===analysis.projectId);
 const failed=progress.stage==='failed';
 const seconds=Math.max(0,Math.floor(((analysis.finishedAt??now)-analysis.startedAt)/1000));
 const elapsed=`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;
 const title=running?'Analysis in progress':failed?'Analysis failed':'Analysis saved';
 return <section className={`analysis-status-banner ${failed?'analysis-status-error':running?'':'analysis-status-complete'}`} aria-label="Analysis status">
  {running?<Loader2 className="spin" size={19}/>:failed?<TriangleAlert size={19}/>:<CheckCircle2 size={19}/>}
  <div className="analysis-status-content">
   <div className="analysis-status-heading"><strong>{title}</strong><span>{project?.derivative} · {project?.market} · Batch {analysis.batchIndex+1}</span><time aria-label="Analysis elapsed time">{elapsed}</time></div>
   <p aria-live="polite">{progress.message}</p>
   {running?<><div className="coverage-track" role="progressbar" aria-label="Analysis progress" aria-valuenow={progress.progress} aria-valuemin={0} aria-valuemax={100}><span style={{width:`${progress.progress}%`}}/></div><small>Results appear after source checks and saving. You can switch pages or refresh; keep the local server running.</small></>:failed?<small>No results from this attempt were saved. Open Data Sources to retry the batch.</small>:<small>{progress.counts?.findings??0} new findings and {progress.counts?.requirements??0} new requirements saved with their source links.</small>}
  </div>
  <Button variant="outline" size="sm" onClick={()=>{setProject(analysis.projectId);navigate(running||failed?'Data Sources':'Evidence Explorer');}}>{running?'View analysis':failed?'Open Data Sources':'View findings'}</Button>
 </section>;
}
