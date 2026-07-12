import { useEffect } from 'react';
import { useVideoPlayer } from '@/lib/video';
import { AnimatePresence } from 'framer-motion';
import { CinematicLayers } from './CinematicLayers';

import { Scene0 } from './video_scenes/Scene0';
import { Scene1 } from './video_scenes/Scene1';
import { Scene2 } from './video_scenes/Scene2';
import { Scene3 } from './video_scenes/Scene3';
import { Scene4 } from './video_scenes/Scene4';
import { Scene5 } from './video_scenes/Scene5';

export const SCENE_DURATIONS: Record<string, number> = {
  wide:    6000, // Wide establishing shot (Night)
  medium:  6000, // Medium shot pushing in (Night)
  closeup: 6000, // Close-up on characters (Night)
  panup:   6000, // Pan up to skyline (Sunset starting)
  sunset:  6000, // Sunset linger (Golden hour)
  loop:    4000, // Transition back to rain / loop start
};

const SCENE_COMPONENTS: Record<string, React.ComponentType> = {
  wide:    Scene0,
  medium:  Scene1,
  closeup: Scene2,
  panup:   Scene3,
  sunset:  Scene4,
  loop:    Scene5,
};

export default function VideoTemplate({
  durations = SCENE_DURATIONS,
  loop = true,
  onSceneChange,
}: {
  durations?: Record<string, number>;
  loop?: boolean;
  onSceneChange?: (sceneKey: string) => void;
} = {}) {
  const { currentScene, currentSceneKey } = useVideoPlayer({ durations, loop });

  useEffect(() => {
    onSceneChange?.(currentSceneKey);
  }, [currentSceneKey, onSceneChange]);

  // Strip _r1/_r2 suffixes to resolve the base scene key and its index
  const baseSceneKey = currentSceneKey.replace(/_r[12]$/, '') as keyof typeof SCENE_DURATIONS;
  const sceneIndex = Object.keys(SCENE_DURATIONS).indexOf(baseSceneKey);

  const SceneComponent = SCENE_COMPONENTS[baseSceneKey];

  return (
    <div className="w-full h-screen overflow-hidden relative bg-[#050814]">
      {/*
        CinematicLayers receives sceneIndex (not currentScene) so persistent
        camera positions are always index-stable, even when durations are rotated.
      */}
      <CinematicLayers currentScene={sceneIndex} />

      <AnimatePresence mode="popLayout">
        {/* key = currentSceneKey (with suffix) so AnimatePresence re-mounts on lock-loop alternation */}
        {SceneComponent && <SceneComponent key={currentSceneKey} />}
      </AnimatePresence>
    </div>
  );
}
