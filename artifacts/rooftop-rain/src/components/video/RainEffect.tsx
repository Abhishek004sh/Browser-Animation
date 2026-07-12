import { useEffect, useRef } from 'react';

const SCENE_CONFIGS = [
  { intensity: 1.0, color: 'rgba(150, 180, 255, 0.4)', lightning: 0.008 }, // 0
  { intensity: 1.0, color: 'rgba(150, 180, 255, 0.4)', lightning: 0.004 }, // 1
  { intensity: 1.0, color: 'rgba(150, 180, 255, 0.4)', lightning: 0.012 }, // 2
  { intensity: 0.3, color: 'rgba(255, 200, 150, 0.3)', lightning: 0.0 },   // 3
  { intensity: 0.0, color: 'rgba(255, 220, 100, 0.1)', lightning: 0.0 },   // 4
  { intensity: 0.6, color: 'rgba(150, 180, 255, 0.3)', lightning: 0.0 }    // 5
];

export function RainEffect({ scene }: { scene: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef(scene);
  
  useEffect(() => {
    sceneRef.current = scene;
  }, [scene]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let w = canvas.width = window.innerWidth;
    let h = canvas.height = window.innerHeight;

    const handleResize = () => {
      w = canvas.width = window.innerWidth;
      h = canvas.height = window.innerHeight;
    };
    window.addEventListener('resize', handleResize);

    const maxDrops = 1500;
    const drops: any[] = [];
    for(let i=0; i<maxDrops; i++) {
      drops.push({
        x: Math.random() * w,
        y: Math.random() * h,
        l: Math.random() * 2 + 1,
        xs: -3 + Math.random() * 2,
        ys: Math.random() * 15 + 15
      });
    }

    const particles: any[] = [];
    for(let i=0; i<200; i++) {
      particles.push({
        x: Math.random() * w,
        y: Math.random() * h,
        s: Math.random() * 2 + 0.5,
        a: Math.random() * 0.5 + 0.1,
        xs: -0.5 + Math.random(),
        ys: -1 + Math.random() * 0.5
      });
    }

    let currentIntensity = SCENE_CONFIGS[0].intensity;
    let flash = 0;
    let animationId: number;

    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      
      const config = SCENE_CONFIGS[sceneRef.current];
      
      // Smoothly transition intensity
      currentIntensity += (config.intensity - currentIntensity) * 0.01;

      // Draw particles (ambient dust/bokeh)
      particles.forEach(p => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.s, 0, Math.PI * 2);
        const isSunset = sceneRef.current >= 3 && sceneRef.current <= 4;
        ctx.fillStyle = isSunset 
          ? `rgba(255, 180, 100, ${p.a * 0.6})` 
          : `rgba(180, 200, 255, ${p.a * 0.4})`;
        ctx.fill();
        
        p.x += p.xs + (isSunset ? 0.2 : -0.5);
        p.y += p.ys;
        
        if(p.x > w) p.x = 0;
        if(p.x < 0) p.x = w;
        if(p.y > h) p.y = 0;
        if(p.y < 0) p.y = h;
      });

      // Draw rain
      if (currentIntensity > 0.01) {
        const activeDrops = Math.floor(maxDrops * currentIntensity);
        ctx.strokeStyle = config.color;
        ctx.lineWidth = 1.5;
        ctx.lineCap = 'round';
        ctx.beginPath();
        
        for(let i=0; i<activeDrops; i++) {
          const drop = drops[i];
          ctx.moveTo(drop.x, drop.y);
          ctx.lineTo(drop.x + drop.xs * drop.l, drop.y + drop.ys * drop.l);
          
          drop.x += drop.xs;
          drop.y += drop.ys;
          
          if (drop.y > h) {
            drop.x = Math.random() * w;
            drop.y = -20;
          }
          if (drop.x > w) drop.x = 0;
          if (drop.x < 0) drop.x = w;
        }
        ctx.stroke();
      }

      // Lightning flashes
      if (Math.random() < config.lightning && currentIntensity > 0.5) {
        flash = 1.0;
      }
      
      if (flash > 0) {
        ctx.fillStyle = `rgba(220, 230, 255, ${flash * 0.25})`;
        ctx.fillRect(0, 0, w, h);
        flash -= 0.04;
      }

      animationId = requestAnimationFrame(draw);
    };

    draw();

    return () => {
      window.removeEventListener('resize', handleResize);
      cancelAnimationFrame(animationId);
    };
  }, []);

  return <canvas ref={canvasRef} className="w-full h-full block" />;
}
