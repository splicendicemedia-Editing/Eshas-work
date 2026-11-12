// Shared loader for the MediaPipe body tracker (runs locally in the browser).
// One instance per option set: the body scan needs the person mask, the live mirror does not.
const VISION_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task';
const cache = {};

export function getLandmarker({ masks = false } = {}) {
  const key = masks ? 'masks' : 'plain';
  if (!cache[key]) {
    cache[key] = (async () => {
      const vision = await import(`${VISION_URL}/vision_bundle.mjs`);
      const files = await vision.FilesetResolver.forVisionTasks(`${VISION_URL}/wasm`);
      const opts = (delegate) => ({ baseOptions: { modelAssetPath: MODEL_URL, delegate }, runningMode: 'VIDEO', numPoses: 1, outputSegmentationMasks: masks });
      try { return await vision.PoseLandmarker.createFromOptions(files, opts('GPU')); }
      catch { return vision.PoseLandmarker.createFromOptions(files, opts('CPU')); }
    })().catch((e) => { delete cache[key]; throw e; });
  }
  return cache[key];
}
