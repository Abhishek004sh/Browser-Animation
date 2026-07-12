import { motion } from 'framer-motion';
export function Scene2() { return <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="hidden" />; }
