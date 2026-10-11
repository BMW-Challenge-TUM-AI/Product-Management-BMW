type TrainingExample = {text:string;categories:string[]};
type Prediction = {category:string|null;similarity:number;origin:'inferred'|'general'};
type Vector = Map<string,number>;

const stopWords=new Set('a an and are as at be been but by can could did do does for from had has have he her here hers him his how i if in into is it its me my of on or our she so than that the their them then there they this to too was we were what when where which who will with would you your'.split(' '));
const general:Prediction={category:null,similarity:0,origin:'general'};

function features(text:string):Vector {
 const tokens=(text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu)??[]).filter(token=>token.length>2&&!stopWords.has(token));
 const result=new Map<string,number>();
 const add=(key:string,weight:number)=>result.set(key,(result.get(key)??0)+weight);
 for(const token of tokens){
  add(`w:${token}`,1);
  for(const size of [3,4,5])for(let index=0;index<=token.length-size;index++)add(`c${size}:${token.slice(index,index+size)}`,0.25);
 }
 for(let index=0;index<tokens.length-1;index++)add(`b:${tokens[index]}_${tokens[index+1]}`,1);
 return result;
}

function weightedVector(raw:Vector,documentCount:number,documentFrequency:Map<string,number>):Vector {
 const result=new Map<string,number>();
 let squared=0;
 for(const [feature,count] of raw){
  const frequency=documentFrequency.get(feature);
  if(!frequency)continue;
  const weight=(1+Math.log(count))*(Math.log(1+documentCount/(1+frequency))+1);
  result.set(feature,weight);
  squared+=weight*weight;
 }
 const norm=Math.sqrt(squared);
 if(norm)for(const [feature,weight] of result)result.set(feature,weight/norm);
 return result;
}

/** Local TF-IDF nearest-centroid classifier trained only on supplied source labels. */
export function createSourceCategoryClassifier(examples:TrainingExample[]):(text:string)=>Prediction {
 const training=examples.flatMap(example=>{
  const categories=[...new Set(example.categories.filter(Boolean))];
  if(!categories.length)return [];
  const terms=features(example.text);
  return terms.size?[{categories,terms}]:[];
 });
 if(!training.length)return ()=>general;

 const documentFrequency=new Map<string,number>();
 for(const example of training)for(const feature of example.terms.keys())documentFrequency.set(feature,(documentFrequency.get(feature)??0)+1);
 const centroids=new Map<string,Map<string,number>>();
 for(const example of training){
  const vector=weightedVector(example.terms,training.length,documentFrequency);
  for(const category of example.categories){
   const centroid=centroids.get(category)??new Map<string,number>();
   for(const [feature,weight] of vector)centroid.set(feature,(centroid.get(feature)??0)+weight);
   centroids.set(category,centroid);
  }
 }
 for(const centroid of centroids.values()){
  const norm=Math.sqrt([...centroid.values()].reduce((sum,weight)=>sum+weight*weight,0));
  if(norm)for(const [feature,weight] of centroid)centroid.set(feature,weight/norm);
 }

 return text=>{
  const query=weightedVector(features(text),training.length,documentFrequency);
  if(!query.size)return general;
  const ranked=[...centroids].map(([category,centroid])=>[
   category,[...query].reduce((sum,[feature,weight])=>sum+weight*(centroid.get(feature)??0),0),
  ] as const).sort((a,b)=>b[1]-a[1]);
  const [category,similarity]=ranked[0]??['',0];
  const margin=similarity-(ranked[1]?.[1]??0);
  // Require both topical overlap and separation from the next category.
  if(!category||similarity<0.18||margin<0.05)return general;
  return {category,similarity,origin:'inferred'};
 };
}
