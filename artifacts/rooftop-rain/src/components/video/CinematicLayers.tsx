import { motion } from 'framer-motion';
import { SCENE_DURATIONS } from './VideoTemplate';
import { RainEffect } from './RainEffect';

const CAM_STOPS = [
  // 0: Wide establishing shot (Night)
  { fg: { scale: 1.1, x: '0%', y: '2%' }, bg: { scale: 1.05, x: '0%', y: '1%' }, clouds: { scale: 1.15, x: '-8%', y: '1%' } },
  
  // 1: Medium shot slowly pushing in (Night)
  { fg: { scale: 1.4, x: '-2%', y: '12%' }, bg: { scale: 1.15, x: '-1%', y: '4%' }, clouds: { scale: 1.25, x: '-12%', y: '4%' } },
  
  // 2: Close-up on characters (Night)
  { fg: { scale: 1.8, x: '-3%', y: '18%' }, bg: { scale: 1.25, x: '-2%', y: '7%' }, clouds: { scale: 1.35, x: '-15%', y: '6%' } },
  
  // 3: Pan up to skyline (Sunset starting)
  { fg: { scale: 1.2, x: '0%', y: '-10%' }, bg: { scale: 1.1, x: '0%', y: '-5%' }, clouds: { scale: 1.2, x: '-5%', y: '-2%' } },
  
  // 4: Sunset Linger (Golden hour glow)
  { fg: { scale: 1.05, x: '0%', y: '-5%' }, bg: { scale: 1.05, x: '0%', y: '-2%' }, clouds: { scale: 1.1, x: '-2%', y: '-1%' } },
  
  // 5: Transition back to rain / loop start
  { fg: { scale: 1.0, x: '0%', y: '0%' }, bg: { scale: 1.0, x: '0%', y: '0%' }, clouds: { scale: 1.0, x: '0%', y: '0%' } }
];

const SUNSET_OPACITIES = [0, 0, 0, 0.8, 1, 0];

export function CinematicLayers({ currentScene }: { currentScene: number }) {
  const duration = SCENE_DURATIONS[currentScene] / 1000;
  const sunsetOpacity = SUNSET_OPACITIES[currentScene];

  return (
    <div className="absolute inset-0 bg-[#050814]">
      {/* Background Layer: Night Skyline */}
      <motion.div 
        className="absolute inset-0"
        animate={CAM_STOPS[currentScene].bg}
        transition={{ duration, ease: 'easeInOut' }}
      >
        <img 
          src={`${import.meta.env.BASE_URL}images/skyline_night.png`} 
          className="w-full h-full object-cover opacity-90" 
          alt="Night Skyline" 
        />
      </motion.div>

      {/* Sunset Skyline (crossfades over night) */}
      <motion.div 
        className="absolute inset-0"
        animate={{ ...CAM_STOPS[currentScene].bg, opacity: sunsetOpacity }}
        transition={{ duration, ease: 'easeInOut' }}
      >
        <img 
          src={`${import.meta.env.BASE_URL}images/skyline_sunset.png`} 
          className="w-full h-full object-cover" 
          alt="Sunset Skyline" 
        />
      </motion.div>

      {/* Clouds Layer */}
      <motion.div 
        className="absolute inset-0 opacity-30 mix-blend-screen"
        animate={CAM_STOPS[currentScene].clouds}
        transition={{ duration, ease: 'easeInOut' }}
      >
        <img 
          src={`${import.meta.env.BASE_URL}images/clouds.png`} 
          className="w-full h-full object-cover scale-150" 
          alt="Clouds" 
        />
      </motion.div>

      {/* Foreground Layer: Rooftop & Characters */}
      <motion.div 
        className="absolute inset-0 origin-bottom"
        animate={CAM_STOPS[currentScene].fg}
        transition={{ duration, ease: 'easeInOut' }}
      >
        {/* Rooftop Ledge */}
        <img 
          src={`${import.meta.env.BASE_URL}images/rooftop.png`} 
          className="absolute inset-0 w-full h-full object-cover" 
          alt="Rooftop" 
        />
        
        {/* Characters */}
        <img 
          src={`${import.meta.env.BASE_URL}images/characters.png`} 
          className="absolute bottom-[2%] left-[50%] -translate-x-[50%] w-[55%] md:w-[45%] object-contain drop-shadow-[0_20px_30px_rgba(0,0,0,0.8)]" 
          alt="Characters" 
        />
      </motion.div>

      {/* Atmospheric Effects Canvas (Rain, particles, flashes) */}
      <div className="absolute inset-0 pointer-events-none mix-blend-screen">
        <RainEffect scene={currentScene} />
      </div>

      {/* Global Color Grade / Vignette */}
      <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_center,transparent_20%,#000_150%)] opacity-80" />
      
      {/* Cinematic Bars (Letterbox) */}
      <div className="absolute top-0 w-full h-[8%] bg-black z-50 pointer-events-none" />
      <div className="absolute bottom-0 w-full h-[8%] bg-black z-50 pointer-events-none" />
    </div>
  );
}
