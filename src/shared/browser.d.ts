export {};
declare global {
  interface Window {
    __sceneReady?: { revision: number; objectIds: string[] };
    __sceneError?: string;
  }
}
