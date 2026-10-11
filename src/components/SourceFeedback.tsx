import {useMemo,useState} from 'react';
import {ArrowRight,ChevronLeft,ChevronRight,FileText,MessageSquare} from 'lucide-react';
import {useApp} from '../context';
import {getSourceInsights,sourceLocation,feedbackTypes} from '../lib/source-insights';
import type {SourceTopic} from '../lib/source-insights';
import type {SourceRecord} from '../types';
import {Badge,Empty,Panel,SearchInput,Select} from './common';
import {Button} from './ui/button';
import {Modal} from './ui/dialog';
import './source-feedback.css';

const PAGE_SIZE=20;
const count=(value:number)=>value.toLocaleString();

export function SourceFeedbackExplorer({topic,initialTopicId}:{topic?:SourceTopic;initialTopicId?:string}){
 const {state,project,openSource,navigate}=useApp();
 const insights=useMemo(()=>getSourceInsights(state,project.id),[state.datasets,project.id]);
 const [search,setSearch]=useState(''),[category,setCategory]=useState(()=>initialTopicId&&insights.topics.some(item=>item.id===initialTopicId)?initialTopicId:''),[type,setType]=useState(''),[file,setFile]=useState(''),[page,setPage]=useState(0);
 const sourceRecords=topic?.records??insights.records;
 const scopedTypes=useMemo(()=>{
  const selected=topic??insights.topics.find(item=>item.id===category);
  if(!selected)return null;
  const labels=new Map<string,Set<string>>();
  for(const location of selected.locations){if(!location.feedbackType)continue;const values=labels.get(location.recordId)??new Set<string>();values.add(location.feedbackType);labels.set(location.recordId,values);}
  return labels;
 },[topic,insights.topics,category]);
 const typesFor=(record:SourceRecord)=>scopedTypes?[...(scopedTypes.get(record.id)??[])].sort():feedbackTypes(record);
 const availableTypes=useMemo(()=>[...new Set(sourceRecords.flatMap(record=>scopedTypes?[...(scopedTypes.get(record.id)??[])]:feedbackTypes(record)))].sort(),[sourceRecords,scopedTypes]);
 const availableFiles=useMemo(()=>[...new Set(sourceRecords.map(record=>sourceLocation(record).file))].sort(),[sourceRecords]);
 const topicRecordIds=useMemo(()=>new Set(insights.topics.find(item=>item.id===category)?.recordIds??[]),[insights.topics,category]);
 const rows=useMemo(()=>sourceRecords.filter(record=>{
  const location=sourceLocation(record);
  const labels=scopedTypes?[...(scopedTypes.get(record.id)??[])]:feedbackTypes(record);
  return (!category||topicRecordIds.has(record.id))&&(!type||labels.includes(type))&&(!file||location.file===file)&&(!search||`${record.content} ${record.id} ${record.fields._originalId??''} ${location.file} ${location.sheet??''}`.toLowerCase().includes(search.toLowerCase()));
 }),[sourceRecords,category,topicRecordIds,type,file,search,scopedTypes]);
 const pageCount=Math.max(1,Math.ceil(rows.length/PAGE_SIZE)),currentPage=Math.min(page,pageCount-1);
 const visible=rows.slice(currentPage*PAGE_SIZE,(currentPage+1)*PAGE_SIZE);
 const update=(setter:(value:string)=>void)=>(value:string)=>{setter(value);setPage(0);};
 const clear=()=>{setSearch('');setCategory('');setType('');setFile('');setPage(0);};
 if(!sourceRecords.length)return <Panel><Empty title="Load customer feedback for this vehicle and market" description="Original customer comments will appear here as soon as a feedback dataset is loaded." action={<Button onClick={()=>navigate('Data Sources')}>Open Data Sources<ArrowRight size={14}/></Button>}/></Panel>;
 return <div className="source-feedback-explorer">
  <div className="source-feedback-filters">
   <SearchInput value={search} onChange={update(setSearch)} placeholder="Search original comments, IDs or filenames…"/>
   {!topic&&<Select label="Source topic" value={category} onChange={value=>{setCategory(value);setType('');setPage(0);}} options={[{value:'',label:'All source topics'},...insights.topics.map(item=>({value:item.id,label:`${item.name} (${count(item.feedbackCount)})`}))]}/>}
   <Select label="Source feedback type" value={type} onChange={update(setType)} options={[{value:'',label:'All source feedback types'},...availableTypes]}/>
   {availableFiles.length>1&&<Select label="Source feedback file" value={file} onChange={update(setFile)} options={[{value:'',label:'All source files'},...availableFiles]}/>}
  </div>
  <div className="section-meta source-feedback-meta"><span><strong>{count(rows.length)}</strong> matching comments · {count(sourceRecords.length)} available{topic?` for ${topic.name}`:''}</span><span>Original wording · Click a comment for its source rows</span></div>
  <div className="source-comment-list">
   {visible.map(record=><SourceComment key={record.id} record={record} types={typesFor(record)} onOpen={()=>openSource(record)}/>)}
  </div>
  {!rows.length&&<Panel><Empty title="No comments match these filters" description="Search another word or clear the filters to see the supplied feedback." action={<Button variant="outline" onClick={clear}>Clear filters</Button>}/></Panel>}
  <div className="source-feedback-pagination">
   <span>{rows.length?`${count(currentPage*PAGE_SIZE+1)}–${count(Math.min((currentPage+1)*PAGE_SIZE,rows.length))}`:'0'} of {count(rows.length)} comments</span>
   <div><Button variant="outline" size="sm" disabled={currentPage===0} onClick={()=>setPage(currentPage-1)} aria-label="Previous comments page"><ChevronLeft size={14}/>Previous</Button><span>Page {currentPage+1} of {pageCount}</span><Button variant="outline" size="sm" disabled={currentPage+1>=pageCount} onClick={()=>setPage(currentPage+1)} aria-label="Next comments page">Next<ChevronRight size={14}/></Button></div>
  </div>
 </div>;
}

function SourceComment({record,types,onOpen}:{record:SourceRecord;types:string[];onOpen:()=>void}){
 const location=sourceLocation(record);
 return <button className="source-comment" onClick={onOpen}>
  <div className="source-comment-heading"><span><MessageSquare size={15}/><strong>{String(record.fields._originalId??record.id)}</strong></span><div>{types.map(type=><Badge key={type}>{type}</Badge>)}</div><ChevronRight size={16}/></div>
  <blockquote>{record.content}</blockquote>
  <div className="source-comment-provenance"><FileText size={12}/><span>{location.file}</span><span>· {location.sheet?`${location.sheet} · `:''}Row {location.row}</span>{Number(record.fields.original_row_count)>1&&<span>· {String(record.fields.original_row_count)} annotation rows</span>}{record.fields.source_market_label?<span>· {String(record.fields.source_market_label)}</span>:null}</div>
 </button>;
}

export function SourceTopicsPanel({mode='cards',title='Source topics awaiting requirement drafting'}:{mode?:'cards'|'ranking';title?:string}){
 const {state,project,navigate}=useApp();
 const insights=useMemo(()=>getSourceInsights(state,project.id),[state.datasets,project.id]);
 const [search,setSearch]=useState(''),[selectedTopic,setSelectedTopic]=useState<SourceTopic|null>(null);
 const rows=insights.topics.filter(topic=>topic.name.toLowerCase().includes(search.toLowerCase()));
 const percentage=(topic:SourceTopic)=>insights.feedbackCount?`${(topic.feedbackCount/insights.feedbackCount*100).toFixed(1)}%`:'0%';
 return <>
  <Panel title={title} subtitle={`${count(insights.feedbackCount)} distinct comments · ${count(insights.annotationCount)} source annotation rows · ${project.derivative} / ${project.market}`} action={<Button variant="outline" size="sm" onClick={()=>navigate('Data Sources')}>Analyze feedback<ArrowRight size={14}/></Button>}>
   {insights.feedbackCount?<>
    <div className="source-topic-intro"><p>{mode==='ranking'?'Topics are ranked by how many distinct comments carry each category in the source spreadsheet.':'These topics come from the categories recorded in the source spreadsheet. Open a topic to inspect the original comments, then run analysis to draft requirements for review.'} A comment can belong to several topics. Counts include praise, complaints and requests; frequency alone does not set a product priority.</p><SearchInput value={search} onChange={setSearch} placeholder="Find a source topic…"/></div>
    {mode==='ranking'?<div className="table-scroll"><table className="source-topic-ranking"><thead><tr><th>Rank</th><th>Source topic</th><th>Distinct comments</th><th>Share of loaded comments</th><th>Negative labels</th><th>Requests</th><th/></tr></thead><tbody>{rows.map(topic=><tr key={topic.id}><td><span className="rank-number">{insights.topics.indexOf(topic)+1}</span></td><td><button className="requirement-link" onClick={()=>setSelectedTopic(topic)}>{topic.name}</button></td><td><strong>{count(topic.feedbackCount)}</strong></td><td><div className="source-topic-share"><span style={{width:percentage(topic)}}/><strong>{percentage(topic)}</strong></div></td><td>{count(topic.negativeCount)}</td><td>{count(topic.requestCount)}</td><td><Button size="sm" variant="ghost" onClick={()=>setSelectedTopic(topic)}>Inspect comments<ChevronRight size={14}/></Button></td></tr>)}</tbody></table></div>:<div className="source-topic-grid">{rows.map(topic=><div className="source-topic-card" key={topic.id}>
     <div className="source-topic-card-top"><span className="source-topic-label">Source category</span><strong>{count(topic.feedbackCount)} comments</strong></div>
     <h3>{topic.name}</h3><p className="source-topic-breakdown">{percentage(topic)} of loaded comments · {count(topic.negativeCount)} with negative labels · {count(topic.requestCount)} with request labels</p>
     {topic.records[0]&&<button className="source-topic-quote" onClick={()=>setSelectedTopic(topic)}><span>Original comment</span><blockquote>{topic.records[0].content}</blockquote><small>{topic.locations[0]?.file??sourceLocation(topic.records[0]).file} · Row {topic.locations[0]?.row??sourceLocation(topic.records[0]).row}</small></button>}
     <Button variant="outline" size="sm" onClick={()=>setSelectedTopic(topic)}>Inspect {count(topic.feedbackCount)} comments<ChevronRight size={14}/></Button>
    </div>)}</div>}
    {!rows.length&&<Empty title="No matching source topics" description="Try another category name." action={<Button variant="outline" onClick={()=>setSearch('')}>Clear search</Button>}/>}
    <p className="source-count-note">Each comment counts once within a topic. A comment can carry multiple feedback labels. Negative labels are “Defect” and “Difficult to Use”; request labels are “Wants”. These counts cover the loaded feedback sample.</p>
   </>:<Empty title="No customer feedback loaded for this scope" description="Load feedback for the current vehicle and market to inspect its topics and counts." action={<Button onClick={()=>navigate('Data Sources')}>Load source feedback<ArrowRight size={14}/></Button>}/>}
  </Panel>
  {selectedTopic&&<Modal open onClose={()=>setSelectedTopic(null)} title={selectedTopic.name} description={`${count(selectedTopic.feedbackCount)} original comments in ${project.derivative} · ${project.market}`} wide><SourceFeedbackExplorer topic={selectedTopic}/><div className="form-actions"><Button variant="outline" onClick={()=>setSelectedTopic(null)}>Close</Button><Button onClick={()=>{setSelectedTopic(null);navigate('Data Sources');}}>Go to feedback analysis<ArrowRight size={14}/></Button></div></Modal>}
 </>;
}
