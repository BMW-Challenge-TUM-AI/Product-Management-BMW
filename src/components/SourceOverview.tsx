import {useMemo} from 'react';
import {ArrowUpRight,Database,FileText,Layers3,MessageSquare} from 'lucide-react';
import {useApp} from '../context';
import {getSourceInsights} from '../lib/source-insights';
import {Panel,Empty,LinkButton} from './common';
import './source-feedback.css';

export default function SourceOverview(){
 const {state,project,navigate}=useApp();
 const source=useMemo(()=>getSourceInsights(state,project.id),[state.datasets,project.id]);
 const referenceCount=state.datasets.filter(d=>d.projectId===project.id&&!d.synthetic&&d.type!=='Customer verbatims'&&d.type!=='External research').reduce((total,d)=>total+d.records.length,0);
 const openTopic=(topicId:string)=>{try{sessionStorage.setItem('insightpilot.source-topic',JSON.stringify({projectId:project.id,topicId}));}catch{/* Original feedback remains accessible when browser storage is unavailable. */}navigate('Evidence Explorer');};
 return <section aria-label="Supplied source statistics">
  <div className="kpi-grid">{[
   {label:'Customer comments',value:source.feedbackCount,note:'Distinct source feedback records',icon:MessageSquare},
   {label:'Source annotation rows',value:source.annotationCount,note:'Original workbook annotations',icon:FileText},
   {label:'Source topics',value:source.topics.length,note:'Workbook categories, including unlabeled',icon:Layers3},
   {label:'Reference records',value:referenceCount,note:'Studies, sales, and equipment',icon:Database},
  ].map(item=><button key={item.label} className="kpi-card" onClick={()=>navigate(item.label==='Reference records'?'Data Sources':'Evidence Explorer')}><div className="kpi-top"><span>{item.label}</span><item.icon size={17}/></div><div className="kpi-value">{item.value.toLocaleString()}<ArrowUpRight size={17}/></div><p>{item.note}</p></button>)}</div>
  <Panel title="What customers mention" subtitle="Counted immediately from the supplied workbook categories" action={<LinkButton onClick={()=>navigate('Evidence Explorer')}>Explore original comments</LinkButton>}>
   {source.feedbackCount?<><div className="source-topic-ranking table-scroll"><table><thead><tr><th>Source topic</th><th>Distinct comments</th><th>Reported issues</th><th>Requests</th><th>Likes</th></tr></thead><tbody>{source.topics.slice(0,8).map(topic=><tr key={topic.id} onClick={()=>openTopic(topic.id)}><td><button className="requirement-link" onClick={event=>{event.stopPropagation();openTopic(topic.id);}}>{topic.name}</button></td><td>{topic.feedbackCount.toLocaleString()}</td><td>{topic.negativeCount.toLocaleString()}</td><td>{topic.requestCount.toLocaleString()}</td><td>{topic.positiveCount.toLocaleString()}</td></tr>)}</tbody></table></div><div className="table-footer">Issues use the source labels “Defect” and “Difficult to Use”. One comment can mention several topics or have several labels.</div></>:<Empty title="Load feedback to see source statistics" description="Choose a vehicle and market in Data Sources."/>}
  </Panel>
 </section>;
}
