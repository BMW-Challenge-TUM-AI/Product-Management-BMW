import {Globe2, Orbit, Sparkles} from 'lucide-react';
import WorldGlobe from '../components/WorldGlobe';
import {PageHeading} from '../components/common';
import {useApp} from '../context';

export default function WorldView() {
  const {project} = useApp();

  return <>
    <PageHeading
      eyebrow="GLOBAL PRODUCT PERSPECTIVE"
      title="World View"
      description="Explore the world through a continuously rotating global model."
    />
    <section className="world-view-stage">
      <div className="world-view-copy">
        <span><Globe2 size={14}/> LIVE GLOBAL MODEL</span>
        <h2>A wider view of product intelligence.</h2>
        <p>{project.name} · {project.market}</p>
      </div>
      <WorldGlobe/>
      <div className="world-view-footer" aria-hidden="true">
        <span><Orbit size={14}/> CONTINUOUS ROTATION</span>
        <span><Sparkles size={14}/> GLOBAL PERSPECTIVE</span>
      </div>
    </section>
  </>;
}
