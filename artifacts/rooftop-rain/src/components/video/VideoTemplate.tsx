import { useEffect } from 'react';
import { useVideoPlayer } from '@/lib/video';
import { AnimatePresence } from 'framer-motion';
import { RooftopScene } from './RooftopScene';

export const SCENE_DURATIONS: Record<string, number> = {
  flyin: 60000,
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
  const { currentSceneKey } = useVideoPlayer({ durations, loop });

  useEffect(() => {
    onSceneChange?.(currentSceneKey);
  }, [currentSceneKey, onSceneChange]);

  return (
    <div className="w-full h-screen overflow-hidden relative bg-[#050814]">
      <AnimatePresence mode="popLayout">
        <RooftopScene key={currentSceneKey} />
      </AnimatePresence>
    </div>
  );
}