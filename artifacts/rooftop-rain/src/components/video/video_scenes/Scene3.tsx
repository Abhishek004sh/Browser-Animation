import { motion } from 'framer-motion';
export function Scene3() { return <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="hidden" />; }
