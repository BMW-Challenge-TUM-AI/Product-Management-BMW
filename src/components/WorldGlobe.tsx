import {useEffect, useRef} from 'react';

type Point = [longitude: number, latitude: number];
type Projected = {x: number; y: number; depth: number};

// Simplified continent outlines keep the globe self-contained and quick to render.
const continents: Point[][] = [
  [[-168, 71], [-154, 70], [-141, 62], [-132, 55], [-125, 49], [-124, 42], [-117, 32], [-111, 31], [-106, 24], [-97, 16], [-91, 17], [-87, 21], [-82, 24], [-81, 29], [-80, 34], [-74, 41], [-67, 45], [-61, 52], [-54, 55], [-53, 60], [-62, 66], [-79, 71], [-96, 73], [-111, 70], [-125, 73], [-141, 69]],
  [[-52, 83], [-34, 80], [-39, 70], [-44, 60], [-51, 59], [-59, 66], [-61, 76]],
  [[-81, 12], [-74, 8], [-62, 10], [-51, 4], [-49, -1], [-35, -8], [-37, -15], [-41, -22], [-48, -29], [-53, -34], [-56, -40], [-66, -55], [-72, -51], [-73, -42], [-70, -33], [-76, -21], [-81, -6]],
  [[-11, 36], [-10, 43], [-6, 43], [-9, 51], [-6, 58], [5, 60], [11, 55], [20, 58], [24, 66], [33, 69], [49, 68], [61, 72], [81, 72], [94, 76], [112, 73], [127, 67], [142, 60], [158, 59], [170, 65], [179, 63], [177, 52], [145, 48], [142, 42], [135, 34], [127, 35], [121, 25], [117, 21], [109, 18], [106, 10], [103, 1], [111, -2], [109, -7], [100, -6], [100, 4], [94, 16], [87, 22], [80, 27], [74, 20], [72, 8], [78, 6], [78, 17], [73, 22], [68, 23], [62, 25], [55, 25], [49, 30], [45, 34], [35, 33], [31, 36], [25, 39], [18, 40], [13, 45], [7, 43], [-1, 43], [-6, 37]],
  [[-17, 37], [-5, 36], [10, 37], [25, 32], [33, 31], [35, 22], [43, 12], [51, 11], [45, 2], [42, -11], [35, -18], [33, -26], [26, -34], [18, -35], [12, -29], [10, -18], [4, -6], [-2, 5], [-10, 6], [-17, 15], [-17, 28]],
  [[113, -11], [128, -12], [138, -12], [152, -24], [153, -29], [146, -38], [137, -38], [130, -32], [115, -34], [113, -23]],
  [[47, -13], [50, -17], [49, -25], [45, -26], [44, -19]],
  [[129, 32], [135, 35], [141, 42], [145, 43], [140, 35], [134, 33]],
  [[166, -35], [175, -40], [178, -45], [172, -43]],
];

const size = 600;
const center = size / 2;
const radius = 232;
const toRadians = Math.PI / 180;

function project([longitude, latitude]: Point, rotation: number): Projected {
  const lat = latitude * toRadians;
  const delta = longitude * toRadians - rotation;
  const centerLat = 12 * toRadians;
  return {
    x: Math.cos(lat) * Math.sin(delta),
    y: Math.cos(centerLat) * Math.sin(lat) - Math.sin(centerLat) * Math.cos(lat) * Math.cos(delta),
    depth: Math.sin(centerLat) * Math.sin(lat) + Math.cos(centerLat) * Math.cos(lat) * Math.cos(delta),
  };
}

function visibleOutline(points: Point[], rotation: number): Projected[] {
  const projected = points.map(point => project(point, rotation));
  const visible: Projected[] = [];
  for (let index = 0; index < projected.length; index++) {
    const current = projected[index];
    const previous = projected[(index + projected.length - 1) % projected.length];
    if ((previous.depth >= 0) !== (current.depth >= 0)) {
      const fraction = previous.depth / (previous.depth - current.depth);
      visible.push({
        x: previous.x + (current.x - previous.x) * fraction,
        y: previous.y + (current.y - previous.y) * fraction,
        depth: 0,
      });
    }
    if (current.depth >= 0) visible.push(current);
  }
  return visible;
}

function drawGlobe(context: CanvasRenderingContext2D, rotation: number) {
  context.clearRect(0, 0, size, size);

  const atmosphere = context.createRadialGradient(center, center, radius - 12, center, center, radius + 23);
  atmosphere.addColorStop(0, 'rgba(62, 166, 210, 0)');
  atmosphere.addColorStop(0.58, 'rgba(75, 177, 219, 0.17)');
  atmosphere.addColorStop(1, 'rgba(75, 177, 219, 0)');
  context.fillStyle = atmosphere;
  context.beginPath();
  context.arc(center, center, radius + 23, 0, Math.PI * 2);
  context.fill();

  context.save();
  context.beginPath();
  context.arc(center, center, radius, 0, Math.PI * 2);
  context.clip();

  const ocean = context.createLinearGradient(center - radius, center - radius, center + radius, center + radius);
  ocean.addColorStop(0, '#327da0');
  ocean.addColorStop(0.52, '#1c5a79');
  ocean.addColorStop(1, '#102f4c');
  context.fillStyle = ocean;
  context.fillRect(center - radius, center - radius, radius * 2, radius * 2);

  context.lineWidth = 0.7;
  context.strokeStyle = 'rgba(183, 220, 226, 0.18)';
  const drawGridLine = (points: Point[]) => {
    context.beginPath();
    let started = false;
    for (const point of points) {
      const value = project(point, rotation);
      if (value.depth > 0) {
        if (started) context.lineTo(center + value.x * radius, center - value.y * radius);
        else context.moveTo(center + value.x * radius, center - value.y * radius);
        started = true;
      } else started = false;
    }
    context.stroke();
  };
  for (let latitude = -60; latitude <= 60; latitude += 30) {
    drawGridLine(Array.from({length: 181}, (_, index) => [-180 + index * 2, latitude] as Point));
  }
  for (let longitude = -180; longitude < 180; longitude += 30) {
    drawGridLine(Array.from({length: 85}, (_, index) => [longitude, -84 + index * 2] as Point));
  }

  for (const continent of continents) {
    const outline = visibleOutline(continent, rotation);
    if (outline.length < 3) continue;
    context.beginPath();
    outline.forEach((point, index) => {
      const x = center + point.x * radius;
      const y = center - point.y * radius;
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.closePath();
    context.fillStyle = '#9acbbc';
    context.fill();
    context.strokeStyle = 'rgba(217, 247, 226, 0.42)';
    context.lineWidth = 0.7;
    context.stroke();
  }

  const shade = context.createLinearGradient(center - radius, center - radius, center + radius, center + radius);
  shade.addColorStop(0, 'rgba(236, 255, 252, 0.17)');
  shade.addColorStop(0.48, 'rgba(17, 49, 70, 0)');
  shade.addColorStop(1, 'rgba(6, 22, 43, 0.58)');
  context.fillStyle = shade;
  context.fillRect(center - radius, center - radius, radius * 2, radius * 2);
  context.restore();

  context.beginPath();
  context.arc(center, center, radius, 0, Math.PI * 2);
  context.strokeStyle = 'rgba(173, 223, 236, 0.45)';
  context.lineWidth = 1;
  context.stroke();
}

export default function WorldGlobe() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * ratio;
    canvas.height = size * ratio;
    context.scale(ratio, ratio);

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let rotation = -12 * toRadians;
    let previousFrame = 0;
    let lastDraw = 0;
    let frame = 0;
    let inView = true;
    const render = (time: number) => {
      rotation += Math.min(time - (previousFrame || time), 80) * 0.00013;
      previousFrame = time;
      if (time - lastDraw >= 32) {
        drawGlobe(context, rotation);
        lastDraw = time;
      }
      frame = requestAnimationFrame(render);
    };
    const updateAnimation = () => {
      cancelAnimationFrame(frame);
      previousFrame = 0;
      drawGlobe(context, rotation);
      if (!reducedMotion.matches && inView && !document.hidden) frame = requestAnimationFrame(render);
    };
    const observer = new IntersectionObserver(entries => {
      inView = entries[0]?.isIntersecting ?? false;
      updateAnimation();
    });
    observer.observe(canvas);
    reducedMotion.addEventListener('change', updateAnimation);
    document.addEventListener('visibilitychange', updateAnimation);
    updateAnimation();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      reducedMotion.removeEventListener('change', updateAnimation);
      document.removeEventListener('visibilitychange', updateAnimation);
    };
  }, []);

  return <div className="world-globe-scene" role="img" aria-label="Rotating model of Earth">
    <span className="world-globe-orbit" aria-hidden="true" />
    <canvas ref={canvasRef} width={size} height={size} aria-hidden="true" />
    <span className="world-globe-caption" aria-hidden="true">GLOBAL PERSPECTIVE</span>
  </div>;
}
