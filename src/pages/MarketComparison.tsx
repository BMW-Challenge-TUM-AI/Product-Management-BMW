import {useMemo, useState} from 'react';
import {ArrowDownRight, ArrowUpRight, BadgeEuro, CarFront, Gauge, Info, Sparkles, Star} from 'lucide-react';
import {Bar, BarChart, CartesianGrid, Cell, PolarAngleAxis, PolarGrid, Radar, RadarChart, ResponsiveContainer, Tooltip, XAxis, YAxis} from 'recharts';
import {PageHeading} from '../components/common';

type Vehicle = {model:string;brand:string;price:number;range:number;acceleration:number;share:number;satisfaction:number;scores:[number,number,number,number,number]};

const comparisonSets:Record<string,Vehicle[]> = {
 'BMW 1 Series':[
  {model:'BMW 1 Series',brand:'BMW',price:39.8,range:650,acceleration:7.8,share:24,satisfaction:84,scores:[86,83,85,78,75]},
  {model:'A-Class',brand:'Mercedes-Benz',price:41.2,range:620,acceleration:8.2,share:21,satisfaction:82,scores:[84,80,78,84,72]},
  {model:'A3',brand:'Audi',price:40.5,range:640,acceleration:8.1,share:19,satisfaction:81,scores:[82,82,80,81,74]},
  {model:'Golf',brand:'Volkswagen',price:32.9,range:680,acceleration:8.5,share:36,satisfaction:79,scores:[75,77,73,76,88]},
 ],
 'BMW 3 Series':[
  {model:'BMW 3 Series',brand:'BMW',price:52.6,range:720,acceleration:5.9,share:31,satisfaction:88,scores:[88,86,93,84,78]},
  {model:'C-Class',brand:'Mercedes-Benz',price:54.8,range:700,acceleration:6.2,share:28,satisfaction:86,scores:[89,85,84,92,73]},
  {model:'A4',brand:'Audi',price:51.9,range:710,acceleration:6.3,share:18,satisfaction:83,scores:[82,84,86,85,76]},
  {model:'Model 3',brand:'Tesla',price:46.9,range:629,acceleration:4.4,share:23,satisfaction:85,scores:[79,96,95,77,86]},
 ],
 'BMW 5 Series':[
  {model:'BMW 5 Series',brand:'BMW',price:65.2,range:760,acceleration:5.8,share:29,satisfaction:90,scores:[91,91,90,91,77]},
  {model:'E-Class',brand:'Mercedes-Benz',price:67.4,range:745,acceleration:6.1,share:32,satisfaction:89,scores:[92,89,84,96,73]},
  {model:'A6',brand:'Audi',price:63.8,range:750,acceleration:6.0,share:22,satisfaction:86,scores:[85,87,87,89,78]},
  {model:'S90',brand:'Volvo',price:61.5,range:730,acceleration:6.2,share:17,satisfaction:85,scores:[88,83,81,92,80]},
 ],
 'BMW i4':[
  {model:'BMW i4',brand:'BMW',price:59.2,range:590,acceleration:5.6,share:27,satisfaction:89,scores:[91,90,93,87,80]},
  {model:'Model 3',brand:'Tesla',price:46.9,range:629,acceleration:4.4,share:34,satisfaction:85,scores:[79,97,96,77,91]},
  {model:'Polestar 2',brand:'Polestar',price:50.7,range:655,acceleration:6.2,share:16,satisfaction:84,scores:[90,88,84,82,83]},
  {model:'IONIQ 6',brand:'Hyundai',price:49.9,range:614,acceleration:7.4,share:23,satisfaction:87,scores:[88,91,78,86,90]},
 ],
 'BMW iX':[
  {model:'BMW iX',brand:'BMW',price:83.5,range:633,acceleration:4.6,share:26,satisfaction:91,scores:[90,94,91,95,75]},
  {model:'Q8 e-tron',brand:'Audi',price:79.9,range:582,acceleration:5.6,share:24,satisfaction:87,scores:[87,88,84,93,78]},
  {model:'EQE SUV',brand:'Mercedes-Benz',price:86.8,range:596,acceleration:4.9,share:28,satisfaction:89,scores:[91,92,88,96,70]},
  {model:'Model X',brand:'Tesla',price:99.9,range:625,acceleration:3.9,share:22,satisfaction:86,scores:[84,98,99,85,72]},
 ],
};

const dimensions=['Design','Technology','Performance','Comfort','Value'];
const colors=['#1d5778','#79a3b9','#a7bdc8','#d0dce2'];
const formatPrice=(value:number)=>`€${value.toFixed(1)}k`;

export default function MarketComparison(){
 const [series,setSeries]=useState('BMW 3 Series');
 const vehicles=comparisonSets[series],bmw=vehicles[0],competitors=vehicles.slice(1);
 const averagePrice=competitors.reduce((sum,vehicle)=>sum+vehicle.price,0)/competitors.length;
 const averageSatisfaction=competitors.reduce((sum,vehicle)=>sum+vehicle.satisfaction,0)/competitors.length;
 const bestRange=Math.max(...vehicles.map(vehicle=>vehicle.range));
 const radarData=useMemo(()=>dimensions.map((dimension,index)=>({dimension,BMW:bmw.scores[index],Competitors:Math.round(competitors.reduce((sum,vehicle)=>sum+vehicle.scores[index],0)/competitors.length)})),[series]);
 return <>
  <PageHeading eyebrow="ILLUSTRATIVE COMPETITIVE INTELLIGENCE" title="Market Comparison" description="Compare BMW series with key competitors across market and product indicators."/>
  <div className="comparison-disclaimer"><Info size={15}/><span>Demo dataset: all figures on this page are generated for design and workflow testing. They are not verified market facts.</span></div>
  <section className="comparison-hero"><div><span className="comparison-kicker"><Sparkles size={14}/> COMPETITIVE SET</span><h2>{series} market position</h2><p>Germany · Premium passenger vehicles · Illustrative 2026 snapshot</p></div><label className="comparison-select"><span>BMW SERIES</span><select value={series} onChange={event=>setSeries(event.target.value)}>{Object.keys(comparisonSets).map(name=><option key={name}>{name}</option>)}</select></label></section>
  <div className="comparison-kpis">
   <article><span><BadgeEuro size={17}/>Starting price</span><strong>{formatPrice(bmw.price)}</strong><p className={bmw.price<=averagePrice?'positive':'negative'}>{bmw.price<=averagePrice?<ArrowDownRight size={14}/>:<ArrowUpRight size={14}/>} {formatPrice(Math.abs(bmw.price-averagePrice))} vs competitor average</p></article>
   <article><span><Gauge size={17}/>Estimated range</span><strong>{bmw.range} km</strong><p className={bmw.range===bestRange?'positive':''}>{bmw.range===bestRange?'Category leader':`${bestRange-bmw.range} km behind category leader`}</p></article>
   <article><span><Star size={17}/>Customer satisfaction</span><strong>{bmw.satisfaction}%</strong><p className={bmw.satisfaction>=averageSatisfaction?'positive':'negative'}>{bmw.satisfaction>=averageSatisfaction?'+':''}{Math.round(bmw.satisfaction-averageSatisfaction)} pts vs competitor average</p></article>
   <article><span><CarFront size={17}/>Segment share</span><strong>{bmw.share}%</strong><p>Illustrative competitive-set share</p></article>
  </div>
  <div className="comparison-grid">
   <section className="comparison-panel"><header><div><h2>Product profile</h2><p>BMW versus the competitor average</p></div><span className="comparison-tag">INDEX / 100</span></header><div className="comparison-radar"><ResponsiveContainer width="100%" height="100%"><RadarChart data={radarData} outerRadius="68%"><PolarGrid stroke="#dfe7eb"/><PolarAngleAxis dataKey="dimension" tick={{fill:'#657987',fontSize:10}}/><Radar name="BMW" dataKey="BMW" stroke="#185979" fill="#286f91" fillOpacity={.28} strokeWidth={2}/><Radar name="Competitor avg." dataKey="Competitors" stroke="#a5b8c3" fill="#bccbd2" fillOpacity={.18} strokeWidth={1.5}/><Tooltip/></RadarChart></ResponsiveContainer></div><div className="comparison-legend"><span><i className="bmw"/>BMW</span><span><i/>Competitor average</span></div></section>
   <section className="comparison-panel"><header><div><h2>Market share</h2><p>Share within the selected competitive set</p></div><span className="comparison-tag">%</span></header><div className="comparison-bars"><ResponsiveContainer width="100%" height="100%"><BarChart data={vehicles} layout="vertical" margin={{left:8,right:24,top:12,bottom:4}}><CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#edf1f3"/><XAxis type="number" domain={[0,40]} tick={{fontSize:10,fill:'#82909a'}} axisLine={false} tickLine={false}/><YAxis type="category" dataKey="model" width={86} tick={{fontSize:10,fill:'#5d6f7c'}} axisLine={false} tickLine={false}/><Tooltip formatter={(value)=>[`${value}%`,'Market share']}/><Bar dataKey="share" radius={[0,4,4,0]} barSize={22}>{vehicles.map((vehicle,index)=><Cell key={vehicle.model} fill={colors[index]}/>)}</Bar></BarChart></ResponsiveContainer></div></section>
  </div>
  <section className="comparison-panel comparison-table-panel"><header><div><h2>Model benchmark</h2><p>Core product and commercial indicators</p></div><span className="comparison-tag">GENERATED DATA</span></header><div className="comparison-table-wrap"><table className="comparison-table"><thead><tr><th>Model</th><th>Brand</th><th>Starting price</th><th>Est. range</th><th>0–100 km/h</th><th>Satisfaction</th><th>Position</th></tr></thead><tbody>{vehicles.map((vehicle,index)=><tr key={vehicle.model} className={index===0?'bmw-row':''}><td><span className="comparison-model-mark" style={{background:colors[index]}}/>{vehicle.model}</td><td>{vehicle.brand}</td><td>{formatPrice(vehicle.price)}</td><td>{vehicle.range} km</td><td>{vehicle.acceleration.toFixed(1)} sec</td><td>{vehicle.satisfaction}%</td><td><span className={index===0?'position-badge leader':'position-badge'}>{index===0?'BMW benchmark':vehicle.share===Math.max(...vehicles.map(item=>item.share))?'Share leader':'Competitor'}</span></td></tr>)}</tbody></table></div></section>
 </>;
}
